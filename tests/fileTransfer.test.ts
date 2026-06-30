import { describe, expect, it } from "vitest";
import {
  appendIncomingChunk,
  completeIncomingFile,
  createFileOffer,
  MAX_FILE_SIZE_BYTES,
  safeDownloadMimeType,
  sanitizeFileName,
  sendFileChunks,
  type FileChunkPayload,
  type IncomingFileState
} from "../src/fileTransfer";
import type { PlainFrame } from "../src/crypto/session";

describe("file transfer", () => {
  it("chunks, reassembles, and verifies a file", async () => {
    const source = new File(["hello encrypted file"], "note.txt", { type: "text/plain" });
    const { offer, bytes } = await createFileOffer(source);
    const frames: PlainFrame[] = [];

    await sendFileChunks(
      offer,
      bytes,
      async (frame) => {
        frames.push(frame);
      },
      () => undefined
    );

    let state: IncomingFileState = {
      offer,
      chunks: [],
      receivedBytes: 0
    };

    for (const frame of frames) {
      if (frame.kind === "file_chunk") {
        state = appendIncomingChunk(state, frame.payload as FileChunkPayload);
      }
    }

    const completed = await completeIncomingFile(state);
    await expect(completed.text()).resolves.toBe("hello encrypted file");
  });

  it("handles empty files and exact chunk boundaries", async () => {
    const empty = await createFileOffer(new File([], "empty.txt"));
    expect(empty.offer.size).toBe(0);
    expect(empty.offer.sha256).toMatch(/^[0-9a-f]{64}$/);

    const exactBoundary = new File([new Uint8Array(32 * 1024)], "boundary.bin");
    const { offer, bytes } = await createFileOffer(exactBoundary);
    const frames: PlainFrame[] = [];
    await sendFileChunks(offer, bytes, async (frame) => void frames.push(frame), () => undefined);

    expect(frames.filter((frame) => frame.kind === "file_chunk")).toHaveLength(1);
  });

  it("rejects unsafe file states", async () => {
    const source = new File(["abc"], "safe.txt");
    const { offer } = await createFileOffer(source);
    const state: IncomingFileState = { offer, chunks: [], receivedBytes: 0 };

    expect(() =>
      appendIncomingChunk(state, {
        fileId: "wrong",
        index: 0,
        total: 1,
        data: "YQ=="
      })
    ).toThrow(/belong/);

    await expect(completeIncomingFile(state)).rejects.toThrow(/before all bytes/);
    expect(sanitizeFileName("../bad<script>.svg")).toBe(".._bad_script_.svg");
    expect(safeDownloadMimeType("image/svg+xml")).toBe("application/octet-stream");
  });

  it("rejects files over the 100 MB limit without reading them", async () => {
    const file = {
      name: "large.bin",
      type: "application/octet-stream",
      size: MAX_FILE_SIZE_BYTES + 1,
      arrayBuffer: async () => new ArrayBuffer(0)
    } as File;

    await expect(createFileOffer(file)).rejects.toThrow(/100 MB/);
  });
});
