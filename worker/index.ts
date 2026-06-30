interface Env {
  ASSETS: Fetcher;
  SIGNALING_LOBBY: DurableObjectNamespace;
}

type PeerRole = "host" | "joiner";
type EncryptionProfileId = "standard" | "high_assurance";

interface PeerSocket extends WebSocket {
  roomCode?: string;
  role?: PeerRole;
  messageWindowStartedAt?: number;
  messageCount?: number;
}

interface Room {
  code: string;
  host: PeerSocket;
  encryptionProfile: EncryptionProfileId;
  joiner?: PeerSocket;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

type ClientSignal =
  | { type: "create_room"; encryptionProfile: EncryptionProfileId }
  | { type: "join_room"; code: string; encryptionProfile: EncryptionProfileId }
  | { type: "offer"; payload: unknown }
  | { type: "answer"; payload: unknown }
  | { type: "ice_candidate"; payload: unknown }
  | { type: "leave" };

const ROOM_TTL_MS = 2 * 60 * 1000;
const MAX_SIGNAL_BYTES = 256 * 1024;
const MAX_MESSAGES_PER_MINUTE = 120;
const ROOM_CODE_MODULUS = 10_000_000_000n;
const UINT64_LIMIT = 1n << 64n;
const UINT64_REJECTION_LIMIT = UINT64_LIMIT - (UINT64_LIMIT % ROOM_CODE_MODULUS);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (url.pathname === "/signal") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }

      const durableObjectId = env.SIGNALING_LOBBY.idFromName("global");
      return env.SIGNALING_LOBBY.get(durableObjectId).fetch(request);
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  }
} satisfies ExportedHandler<Env>;

export class SignalingLobby {
  private readonly rooms = new Map<string, Room>();

  fetch(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname !== "/signal") {
      return new Response("Not found", { status: 404 });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, PeerSocket];

    server.accept();
    server.messageWindowStartedAt = Date.now();
    server.messageCount = 0;
    server.addEventListener("message", (event) => this.handleSocketMessage(server, event.data));
    server.addEventListener("close", () => this.leaveRoom(server));
    server.addEventListener("error", () => this.leaveRoom(server));

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  private handleSocketMessage(socket: PeerSocket, raw: string | ArrayBuffer): void {
    try {
      if (!this.allowSocketMessage(socket)) {
        sendError(socket, "Rate limit exceeded");
        socket.close(1008, "Rate limit exceeded");
        return;
      }

      const message = parseClientSignal(raw);
      this.handleSignal(socket, message);
    } catch {
      sendError(socket, "Invalid signaling message");
    }
  }

  private handleSignal(socket: PeerSocket, message: ClientSignal): void {
    switch (message.type) {
      case "create_room":
        this.createRoom(socket, message.encryptionProfile);
        return;
      case "join_room":
        this.joinRoom(socket, message.code, message.encryptionProfile);
        return;
      case "offer":
      case "answer":
      case "ice_candidate":
        this.relayToPeer(socket, message);
        return;
      case "leave":
        this.leaveRoom(socket);
        return;
    }
  }

  private createRoom(host: PeerSocket, encryptionProfile: EncryptionProfileId): void {
    this.leaveRoom(host);
    const code = this.createUniqueCode();
    const expiresAt = Date.now() + ROOM_TTL_MS;
    const room: Room = {
      code,
      host,
      encryptionProfile,
      expiresAt,
      timeout: setTimeout(() => {
        this.closeRoom(code, "Pairing code expired");
      }, ROOM_TTL_MS)
    };

    host.roomCode = code;
    host.role = "host";
    this.rooms.set(code, room);
    send(host, { type: "room_created", code, expiresAt });
  }

  private joinRoom(joiner: PeerSocket, code: string, encryptionProfile: EncryptionProfileId): void {
    this.leaveRoom(joiner);
    const room = this.rooms.get(code);
    if (!room || room.expiresAt <= Date.now()) {
      if (room) {
        this.closeRoom(code, "Pairing code expired");
      }
      sendError(joiner, "Pairing code is expired or unknown");
      return;
    }

    if (room.encryptionProfile !== encryptionProfile) {
      sendError(joiner, "Encryption profile does not match this room");
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

  private relayToPeer(socket: PeerSocket, message: ClientSignal): void {
    const room = this.currentRoom(socket);
    if (!room || !room.joiner) {
      sendError(socket, "No connected peer");
      return;
    }

    const peer = socket.role === "host" ? room.joiner : room.host;
    send(peer, message);
  }

  private leaveRoom(socket: PeerSocket): void {
    const code = socket.roomCode;
    if (!code) {
      return;
    }

    const room = this.rooms.get(code);
    if (!room) {
      socket.roomCode = undefined;
      socket.role = undefined;
      return;
    }

    const peer = socket.role === "host" ? room.joiner : room.host;
    if (peer && peer.readyState === WebSocket.READY_STATE_OPEN) {
      send(peer, { type: "error", message: "Peer disconnected" });
    }

    this.closeRoom(code, "Room closed");
  }

  private closeRoom(code: string, reason: string): void {
    const room = this.rooms.get(code);
    if (!room) {
      return;
    }

    clearTimeout(room.timeout);
    this.rooms.delete(code);
    for (const socket of [room.host, room.joiner]) {
      if (!socket) {
        continue;
      }
      socket.roomCode = undefined;
      socket.role = undefined;
      if (socket.readyState === WebSocket.READY_STATE_OPEN) {
        send(socket, { type: "error", message: reason });
      }
    }
  }

  private currentRoom(socket: PeerSocket): Room | undefined {
    return socket.roomCode ? this.rooms.get(socket.roomCode) : undefined;
  }

  private createUniqueCode(): string {
    for (let attempts = 0; attempts < 10; attempts += 1) {
      const code = createRoomCode();
      if (!this.rooms.has(code)) {
        return code;
      }
    }
    throw new Error("Unable to allocate pairing code");
  }

  private allowSocketMessage(socket: PeerSocket): boolean {
    const now = Date.now();
    if (!socket.messageWindowStartedAt || now - socket.messageWindowStartedAt > 60_000) {
      socket.messageWindowStartedAt = now;
      socket.messageCount = 0;
    }

    socket.messageCount = (socket.messageCount ?? 0) + 1;
    return socket.messageCount <= MAX_MESSAGES_PER_MINUTE;
  }
}

function parseClientSignal(raw: string | ArrayBuffer): ClientSignal {
  if (typeof raw !== "string") {
    throw new Error("Invalid signaling message");
  }

  if (new TextEncoder().encode(raw).byteLength > MAX_SIGNAL_BYTES) {
    throw new Error("Invalid signaling message");
  }

  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Invalid signaling message");
  }

  switch (value.type) {
    case "create_room":
      if (isEncryptionProfileId(value.encryptionProfile)) {
        return { type: "create_room", encryptionProfile: value.encryptionProfile };
      }
      break;
    case "join_room":
      if (
        typeof value.code === "string" &&
        /^\d{10}$/.test(value.code) &&
        isEncryptionProfileId(value.encryptionProfile)
      ) {
        return { type: "join_room", code: value.code, encryptionProfile: value.encryptionProfile };
      }
      break;
    case "offer":
    case "answer":
    case "ice_candidate":
      if ("payload" in value) {
        return { type: value.type, payload: value.payload };
      }
      break;
    case "leave":
      return { type: "leave" };
  }

  throw new Error("Invalid signaling message");
}

function createRoomCode(): string {
  for (let attempts = 0; attempts < 10; attempts += 1) {
    const value = randomUint64();
    if (value < UINT64_REJECTION_LIMIT) {
      return (value % ROOM_CODE_MODULUS).toString().padStart(10, "0");
    }
  }

  throw new Error("Unable to create unbiased room code");
}

function randomUint64(): bigint {
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  return (BigInt(bytes[0]) << 32n) | BigInt(bytes[1]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEncryptionProfileId(value: unknown): value is EncryptionProfileId {
  return value === "standard" || value === "high_assurance";
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.READY_STATE_OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function sendError(socket: WebSocket, message: string): void {
  send(socket, { type: "error", message });
}

function json(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "permissions-policy": "camera=(), microphone=(self)",
      ...init?.headers
    }
  });
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("permissions-policy", "camera=(), microphone=(self)");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
