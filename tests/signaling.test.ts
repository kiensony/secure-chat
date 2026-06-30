import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createSignalingServer, type SignalingServerHandle } from "../server/signalingServer";

const STANDARD_PROFILE = "standard";

describe("signaling server", () => {
  let server: SignalingServerHandle;
  let url: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    server = createSignalingServer({
      ttlMs: 75,
      maxMessagesPerMinute: 3,
      httpRateLimit: {
        windowMs: 1_000,
        limit: 100
      }
    });
    const port = await server.start(0);
    url = `ws://127.0.0.1:${port}/signal`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
    await server.stop();
  });

  it("creates a short-lived 10-digit room and joins it once", async () => {
    const host = await openSocket(url, sockets);
    host.send(JSON.stringify({ type: "create_room", encryptionProfile: STANDARD_PROFILE }));
    const created = await nextJson(host);

    expect(created).toMatchObject({ type: "room_created" });
    expect(created.code).toMatch(/^\d{10}$/);

    const joiner = await openSocket(url, sockets);
    joiner.send(JSON.stringify({ type: "join_room", code: created.code, encryptionProfile: STANDARD_PROFILE }));

    await expect(nextJson(host)).resolves.toMatchObject({ type: "peer_joined" });
    await expect(nextJson(joiner)).resolves.toMatchObject({ type: "peer_joined" });

    const secondJoiner = await openSocket(url, sockets);
    secondJoiner.send(JSON.stringify({ type: "join_room", code: created.code, encryptionProfile: STANDARD_PROFILE }));
    await expect(nextJson(secondJoiner)).resolves.toMatchObject({
      type: "error",
      message: "Pairing code already used"
    });
  });

  it("rejects joiners that choose a different encryption profile", async () => {
    const host = await openSocket(url, sockets);
    host.send(JSON.stringify({ type: "create_room", encryptionProfile: "high_assurance" }));
    const created = await nextJson(host);

    const joiner = await openSocket(url, sockets);
    joiner.send(JSON.stringify({ type: "join_room", code: created.code, encryptionProfile: STANDARD_PROFILE }));
    await expect(nextJson(joiner)).resolves.toMatchObject({
      type: "error",
      message: "Encryption profile does not match this room"
    });
  });

  it("rejects expired, malformed, and invalid messages without crashing", async () => {
    const host = await openSocket(url, sockets);
    host.send(JSON.stringify({ type: "create_room", encryptionProfile: STANDARD_PROFILE }));
    const created = await nextJson(host);
    await nextJson(host);

    const lateJoiner = await openSocket(url, sockets);
    lateJoiner.send(JSON.stringify({ type: "join_room", code: created.code, encryptionProfile: STANDARD_PROFILE }));
    await expect(nextJson(lateJoiner)).resolves.toMatchObject({
      type: "error",
      message: "Pairing code is expired or unknown"
    });

    lateJoiner.send("{not-json");
    await expect(nextJson(lateJoiner)).resolves.toMatchObject({
      type: "error",
      message: "Invalid signaling message"
    });
  });

  it("relays offer, answer, and ICE only after both peers join", async () => {
    const host = await openSocket(url, sockets);
    host.send(JSON.stringify({ type: "create_room", encryptionProfile: STANDARD_PROFILE }));
    const created = await nextJson(host);

    host.send(JSON.stringify({ type: "offer", payload: { type: "offer", sdp: "before-peer" } }));
    await expect(nextJson(host)).resolves.toMatchObject({ type: "error", message: "No connected peer" });

    const joiner = await openSocket(url, sockets);
    joiner.send(JSON.stringify({ type: "join_room", code: created.code, encryptionProfile: STANDARD_PROFILE }));
    await nextJson(host);
    await nextJson(joiner);

    host.send(JSON.stringify({ type: "offer", payload: { type: "offer", sdp: "offer-sdp" } }));
    await expect(nextJson(joiner)).resolves.toMatchObject({
      type: "offer",
      payload: { type: "offer", sdp: "offer-sdp" }
    });

    joiner.send(JSON.stringify({ type: "answer", payload: { type: "answer", sdp: "answer-sdp" } }));
    await expect(nextJson(host)).resolves.toMatchObject({
      type: "answer",
      payload: { type: "answer", sdp: "answer-sdp" }
    });

    joiner.send(JSON.stringify({ type: "ice_candidate", payload: { candidate: "candidate:1" } }));
    await expect(nextJson(host)).resolves.toMatchObject({
      type: "ice_candidate",
      payload: { candidate: "candidate:1" }
    });
  });

  it("rate limits noisy sockets", async () => {
    const socket = await openSocket(url, sockets);

    for (let index = 0; index < 4; index += 1) {
      socket.send(JSON.stringify({ type: "join_room", code: "0000000000", encryptionProfile: STANDARD_PROFILE }));
    }

    await expect(nextJson(socket)).resolves.toMatchObject({ type: "error" });
    await expect(waitForClose(socket)).resolves.toBe(1008);
  });
});

async function openSocket(url: string, sockets: WebSocket[]): Promise<WebSocket> {
  const socket = new WebSocket(url);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  const raw = await new Promise<WebSocket.RawData>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for WebSocket message"));
    }, 1_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(data);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return JSON.parse(raw.toString()) as Record<string, unknown>;
}

async function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for WebSocket close"));
    }, 1_000);
    socket.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
