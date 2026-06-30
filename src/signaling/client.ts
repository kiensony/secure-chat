export type ClientSignal =
  | { type: "create_room" }
  | { type: "join_room"; code: string }
  | { type: "offer"; payload: RTCSessionDescriptionInit }
  | { type: "answer"; payload: RTCSessionDescriptionInit }
  | { type: "ice_candidate"; payload: RTCIceCandidateInit }
  | { type: "leave" };

export type ServerSignal =
  | { type: "room_created"; code: string; expiresAt: number }
  | { type: "peer_joined" }
  | { type: "offer"; payload: RTCSessionDescriptionInit }
  | { type: "answer"; payload: RTCSessionDescriptionInit }
  | { type: "ice_candidate"; payload: RTCIceCandidateInit }
  | { type: "error"; message: string };

export interface SignalingClientEvents {
  onOpen(): void;
  onSignal(signal: ServerSignal): void;
  onClose(): void;
  onError(message: string): void;
}

export class SignalingClient {
  private socket?: WebSocket;

  constructor(private readonly events: SignalingClientEvents) {}

  connect(): void {
    this.close();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/signal`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("open", () => this.events.onOpen());
    socket.addEventListener("message", (event) => {
      try {
        if (typeof event.data !== "string") {
          throw new Error("Unsupported signaling payload");
        }
        this.events.onSignal(parseServerSignal(JSON.parse(event.data) as unknown));
      } catch {
        this.events.onError("Invalid signaling response");
      }
    });
    socket.addEventListener("close", () => this.events.onClose());
    socket.addEventListener("error", () => this.events.onError("Signaling connection failed"));
  }

  send(signal: ClientSignal): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Signaling socket is not connected");
    }
    this.socket.send(JSON.stringify(signal));
  }

  close(): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "leave" }));
      this.socket.close();
    }
    this.socket = undefined;
  }
}

function parseServerSignal(value: unknown): ServerSignal {
  const signal = value as ServerSignal;
  if (!signal || typeof signal !== "object" || typeof signal.type !== "string") {
    throw new Error("Invalid signal");
  }

  switch (signal.type) {
    case "room_created":
      if (typeof signal.code === "string" && typeof signal.expiresAt === "number") {
        return signal;
      }
      break;
    case "peer_joined":
      return signal;
    case "offer":
    case "answer":
      if (signal.payload && typeof signal.payload.type === "string" && typeof signal.payload.sdp === "string") {
        return signal;
      }
      break;
    case "ice_candidate":
      if (signal.payload && typeof signal.payload.candidate === "string") {
        return signal;
      }
      break;
    case "error":
      if (typeof signal.message === "string") {
        return signal;
      }
      break;
  }

  throw new Error("Invalid signal");
}
