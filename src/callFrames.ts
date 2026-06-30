export const CALL_INVITE_TIMEOUT_MS = 60_000;

export type CallFrameKind = "call_invite" | "call_accept" | "call_reject" | "call_end" | "call_mute";
export type CallRejectReason = "declined" | "busy" | "timeout" | "failed";
export type CallEndReason = "ended" | "timeout" | "failed";

export type CallControlFrame =
  | { kind: "call_invite"; payload: { media: "audio" } }
  | { kind: "call_accept"; payload: { media: "audio" } }
  | { kind: "call_reject"; payload: { reason: CallRejectReason } }
  | { kind: "call_end"; payload: { reason: CallEndReason } }
  | { kind: "call_mute"; payload: { muted: boolean } };

const CALL_FRAME_KINDS = new Set<string>([
  "call_invite",
  "call_accept",
  "call_reject",
  "call_end",
  "call_mute"
]);

const REJECT_REASONS = new Set<string>(["declined", "busy", "timeout", "failed"]);
const END_REASONS = new Set<string>(["ended", "timeout", "failed"]);

export function isCallFrameKind(kind: string): kind is CallFrameKind {
  return CALL_FRAME_KINDS.has(kind);
}

export function validateCallControlFrame(kind: string, payload: unknown): CallControlFrame {
  if (!isCallFrameKind(kind)) {
    throw new Error("Unknown call control frame");
  }

  if (!isRecord(payload)) {
    throw new Error("Invalid call control frame");
  }

  switch (kind) {
    case "call_invite":
    case "call_accept":
      if (Object.keys(payload).length === 1 && payload.media === "audio") {
        return { kind, payload: { media: "audio" } };
      }
      break;
    case "call_reject":
      if (Object.keys(payload).length === 1 && typeof payload.reason === "string" && REJECT_REASONS.has(payload.reason)) {
        return { kind, payload: { reason: payload.reason as CallRejectReason } };
      }
      break;
    case "call_end":
      if (Object.keys(payload).length === 1 && typeof payload.reason === "string" && END_REASONS.has(payload.reason)) {
        return { kind, payload: { reason: payload.reason as CallEndReason } };
      }
      break;
    case "call_mute":
      if (Object.keys(payload).length === 1 && typeof payload.muted === "boolean") {
        return { kind, payload: { muted: payload.muted } };
      }
      break;
  }

  throw new Error("Invalid call control frame");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
