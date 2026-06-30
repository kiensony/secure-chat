import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

const DEFAULT_ROOM_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_SIGNAL_BYTES = 256 * 1024;
const DEFAULT_MAX_MESSAGES_PER_MINUTE = 120;

export interface SignalingServerOptions {
  ttlMs?: number;
  maxPayloadBytes?: number;
  maxMessagesPerMinute?: number;
  httpRateLimit?: {
    windowMs: number;
    limit: number;
  };
}

export interface SignalingServerHandle {
  app: express.Express;
  server: http.Server;
  wss: WebSocketServer;
  start(port?: number, host?: string): Promise<number>;
  stop(): Promise<void>;
}

type PeerRole = "host" | "joiner";

interface PeerSocket extends WebSocket {
  roomCode?: string;
  role?: PeerRole;
  messageWindowStartedAt?: number;
  messageCount?: number;
}

interface Room {
  code: string;
  host: PeerSocket;
  joiner?: PeerSocket;
  expiresAt: number;
  timeout: NodeJS.Timeout;
}

const signalPayloadSchema = z.union([
  z.object({ type: z.literal("create_room") }),
  z.object({ type: z.literal("join_room"), code: z.string().regex(/^\d{10}$/) }),
  z.object({ type: z.literal("offer"), payload: z.unknown() }),
  z.object({ type: z.literal("answer"), payload: z.unknown() }),
  z.object({ type: z.literal("ice_candidate"), payload: z.unknown() }),
  z.object({ type: z.literal("leave") })
]);

export function createSignalingServer(options: SignalingServerOptions = {}): SignalingServerHandle {
  const ttlMs = options.ttlMs ?? DEFAULT_ROOM_TTL_MS;
  const maxMessagesPerMinute = options.maxMessagesPerMinute ?? DEFAULT_MAX_MESSAGES_PER_MINUTE;
  const rooms = new Map<string, Room>();
  const app = express();

  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: false
    })
  );
  app.use(
    rateLimit({
      windowMs: options.httpRateLimit?.windowMs ?? 60_000,
      limit: options.httpRateLimit?.limit ?? 120,
      standardHeaders: true,
      legacyHeaders: false
    })
  );

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("Unhandled server error", err.name);
    res.status(500).json({ error: "Internal server error" });
  });

  const server = http.createServer(app);
  server.requestTimeout = 15_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 10_000;

  const wss = new WebSocketServer({
    server,
    path: "/signal",
    maxPayload: options.maxPayloadBytes ?? DEFAULT_MAX_SIGNAL_BYTES
  });

  wss.on("connection", (socket: PeerSocket) => {
    socket.messageWindowStartedAt = Date.now();
    socket.messageCount = 0;

    socket.on("message", (raw) => {
      try {
        if (!allowSocketMessage(socket, maxMessagesPerMinute)) {
          sendError(socket, "Rate limit exceeded");
          socket.close(1008, "Rate limit exceeded");
          return;
        }

        const parsed = signalPayloadSchema.parse(JSON.parse(raw.toString("utf8")));
        handleSignal(socket, parsed);
      } catch {
        sendError(socket, "Invalid signaling message");
      }
    });

    socket.on("close", () => {
      leaveRoom(socket);
    });
  });

  function handleSignal(socket: PeerSocket, message: z.infer<typeof signalPayloadSchema>): void {
    switch (message.type) {
      case "create_room":
        createRoom(socket);
        return;
      case "join_room":
        joinRoom(socket, message.code);
        return;
      case "offer":
      case "answer":
      case "ice_candidate":
        relayToPeer(socket, message);
        return;
      case "leave":
        leaveRoom(socket);
        return;
    }
  }

  function createRoom(host: PeerSocket): void {
    leaveRoom(host);
    const code = createUniqueCode(rooms);
    const expiresAt = Date.now() + ttlMs;
    const room: Room = {
      code,
      host,
      expiresAt,
      timeout: setTimeout(() => {
        closeRoom(code, "Pairing code expired");
      }, ttlMs)
    };

    host.roomCode = code;
    host.role = "host";
    rooms.set(code, room);
    send(host, { type: "room_created", code, expiresAt });
  }

  function joinRoom(joiner: PeerSocket, code: string): void {
    leaveRoom(joiner);
    const room = rooms.get(code);
    if (!room || room.expiresAt <= Date.now()) {
      sendError(joiner, "Pairing code is expired or unknown");
      return;
    }

    if (room.joiner) {
      sendError(joiner, "Pairing code already used");
      return;
    }

    joiner.roomCode = code;
    joiner.role = "joiner";
    room.joiner = joiner;
    clearTimeout(room.timeout);
    send(room.host, { type: "peer_joined" });
    send(joiner, { type: "peer_joined" });
  }

  function relayToPeer(socket: PeerSocket, message: z.infer<typeof signalPayloadSchema>): void {
    const room = currentRoom(socket);
    if (!room || !room.joiner) {
      sendError(socket, "No connected peer");
      return;
    }

    const peer = socket.role === "host" ? room.joiner : room.host;
    send(peer, message);
  }

  function leaveRoom(socket: PeerSocket): void {
    const code = socket.roomCode;
    if (!code) {
      return;
    }

    const room = rooms.get(code);
    if (!room) {
      socket.roomCode = undefined;
      socket.role = undefined;
      return;
    }

    const peer = socket.role === "host" ? room.joiner : room.host;
    if (peer && peer.readyState === WebSocket.OPEN) {
      send(peer, { type: "error", message: "Peer disconnected" });
    }

    closeRoom(code, "Room closed");
  }

  function closeRoom(code: string, reason: string): void {
    const room = rooms.get(code);
    if (!room) {
      return;
    }

    clearTimeout(room.timeout);
    rooms.delete(code);
    for (const socket of [room.host, room.joiner]) {
      if (!socket) {
        continue;
      }
      socket.roomCode = undefined;
      socket.role = undefined;
      if (socket.readyState === WebSocket.OPEN) {
        send(socket, { type: "error", message: reason });
      }
    }
  }

  function currentRoom(socket: PeerSocket): Room | undefined {
    return socket.roomCode ? rooms.get(socket.roomCode) : undefined;
  }

  return {
    app,
    server,
    wss,
    start(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Unable to determine signaling server port"));
            return;
          }
          resolve(address.port);
        });
      });
    },
    async stop() {
      for (const room of rooms.values()) {
        clearTimeout(room.timeout);
      }
      rooms.clear();
      for (const client of wss.clients) {
        client.close();
      }
      await new Promise<void>((resolve, reject) => {
        wss.close((wsError) => {
          if (wsError) {
            reject(wsError);
            return;
          }
          server.close((serverError) => {
            if (serverError) {
              reject(serverError);
              return;
            }
            resolve();
          });
        });
      });
    }
  };
}

function createUniqueCode(rooms: Map<string, Room>): string {
  for (let attempts = 0; attempts < 10; attempts += 1) {
    const code = crypto.randomInt(0, 10_000_000_000).toString().padStart(10, "0");
    if (!rooms.has(code)) {
      return code;
    }
  }
  throw new Error("Unable to allocate pairing code");
}

function allowSocketMessage(socket: PeerSocket, maxMessagesPerMinute: number): boolean {
  const now = Date.now();
  if (!socket.messageWindowStartedAt || now - socket.messageWindowStartedAt > 60_000) {
    socket.messageWindowStartedAt = now;
    socket.messageCount = 0;
  }

  socket.messageCount = (socket.messageCount ?? 0) + 1;
  return socket.messageCount <= maxMessagesPerMinute;
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function sendError(socket: WebSocket, message: string): void {
  send(socket, { type: "error", message });
}
