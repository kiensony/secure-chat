import { describe, expect, it } from "vitest";
import { validateCallControlFrame } from "../src/callFrames";

describe("call control frames", () => {
  it("accepts the audio-only call controls used by v1", () => {
    expect(validateCallControlFrame("call_invite", { media: "audio" })).toEqual({
      kind: "call_invite",
      payload: { media: "audio" }
    });
    expect(validateCallControlFrame("call_accept", { media: "audio" })).toEqual({
      kind: "call_accept",
      payload: { media: "audio" }
    });
    expect(validateCallControlFrame("call_reject", { reason: "busy" })).toEqual({
      kind: "call_reject",
      payload: { reason: "busy" }
    });
    expect(validateCallControlFrame("call_end", { reason: "ended" })).toEqual({
      kind: "call_end",
      payload: { reason: "ended" }
    });
    expect(validateCallControlFrame("call_mute", { muted: true })).toEqual({
      kind: "call_mute",
      payload: { muted: true }
    });
  });

  it("rejects malformed or metadata-bearing call controls", () => {
    expect(() => validateCallControlFrame("call_invite", { media: "video" })).toThrow(/Invalid call/);
    expect(() => validateCallControlFrame("call_accept", { media: "audio", label: "microphone" })).toThrow(
      /Invalid call/
    );
    expect(() => validateCallControlFrame("call_reject", { reason: "later" })).toThrow(/Invalid call/);
    expect(() => validateCallControlFrame("call_end", { reason: "declined" })).toThrow(/Invalid call/);
    expect(() => validateCallControlFrame("call_mute", { muted: "yes" })).toThrow(/Invalid call/);
    expect(() => validateCallControlFrame("chat", { text: "hello" })).toThrow(/Unknown call/);
  });
});
