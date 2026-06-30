import { describe, expect, it } from "vitest";
import { createChatExportFileName, createChatExportZip, type ChatExportData } from "../src/chatExport";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

describe("chat export zip", () => {
  it("creates a valid zip with readable and structured transcripts", async () => {
    const zip = createChatExportZip(baseExportData());
    const bytes = new Uint8Array(await zip.arrayBuffer());
    const entries = readStoredZipEntries(bytes);

    expect(zip.type).toBe("application/zip");
    expect(bytesIncludesSignature(bytes, 0x06054b50)).toBe(true);
    expect(entries.get("transcript.md")).toContain("hello secure world");
    expect(entries.get("transcript.md")).toContain("SENT");
    expect(entries.get("transcript.json")).toContain("\"version\": 1");
    expect(entries.get("transcript.json")).toContain("hello secure world");
  });

  it("keeps UTF-8 chat text and completed attachments", async () => {
    const zip = createChatExportZip(baseExportData());
    const entries = readStoredZipEntries(new Uint8Array(await zip.arrayBuffer()));

    expect(entries.get("transcript.md")).toContain("cafe secure chat");
    expect(entries.get("attachments/sent/notes.txt")).toBe("sent attachment");
    expect(entries.get("attachments/received/secret.txt")).toBe("received attachment");
  });

  it("sanitizes attachment names, prevents traversal, and deduplicates paths", async () => {
    const data = baseExportData();
    data.transfers.push({
      direction: "received",
      fileId: "duplicate",
      name: "secret.txt",
      size: 9,
      mimeType: "text/plain",
      sha256: "sha-duplicate",
      status: "complete",
      offeredAt: Date.UTC(2026, 0, 1, 0, 0, 3),
      completedAt: Date.UTC(2026, 0, 1, 0, 0, 4),
      attachment: {
        fileName: "../secret.txt",
        mimeType: "text/plain",
        bytes: ENCODER.encode("duplicate")
      }
    });

    const entries = readStoredZipEntries(new Uint8Array(await createChatExportZip(data).arrayBuffer()));
    const transcript = JSON.parse(entries.get("transcript.json") ?? "{}") as {
      transfers: Array<{ attachmentPath?: string }>;
    };

    expect(entries.has("attachments/received/secret.txt")).toBe(true);
    expect(entries.has("attachments/received/secret-2.txt")).toBe(true);
    expect([...entries.keys()].some((path) => path.includes(".."))).toBe(false);
    expect(transcript.transfers.map((transfer) => transfer.attachmentPath).filter(Boolean)).toEqual([
      "attachments/sent/notes.txt",
      "attachments/received/secret.txt",
      "attachments/received/secret-2.txt"
    ]);
  });

  it("excludes rejected or incomplete attachment bytes while keeping metadata", async () => {
    const data = baseExportData();
    data.transfers.push({
      direction: "sent",
      fileId: "rejected",
      name: "reject-me.txt",
      size: 9,
      mimeType: "text/plain",
      sha256: "sha-rejected",
      status: "rejected",
      offeredAt: Date.UTC(2026, 0, 1, 0, 0, 5),
      attachment: {
        fileName: "reject-me.txt",
        mimeType: "text/plain",
        bytes: ENCODER.encode("reject me")
      }
    });

    const entries = readStoredZipEntries(new Uint8Array(await createChatExportZip(data).arrayBuffer()));
    const joined = [...entries.values()].join("\n");

    expect(entries.has("attachments/sent/reject-me.txt")).toBe(false);
    expect(joined).toContain("reject-me.txt");
    expect(joined).not.toContain("reject me");
  });

  it("creates deterministic export filenames", () => {
    expect(createChatExportFileName(Date.UTC(2026, 5, 30, 13, 5, 9))).toBe(
      "secure-chat-export-20260630-130509.zip"
    );
  });
});

function baseExportData(): ChatExportData {
  return {
    exportedAt: Date.UTC(2026, 0, 1, 0, 0, 0),
    role: "host",
    verified: true,
    ownFingerprint: "own",
    peerFingerprint: "peer",
    messages: [
      {
        id: "message-1",
        direction: "sent",
        text: "hello secure world",
        at: Date.UTC(2026, 0, 1, 0, 0, 1)
      },
      {
        id: "message-2",
        direction: "received",
        text: "cafe secure chat",
        at: Date.UTC(2026, 0, 1, 0, 0, 2)
      }
    ],
    transfers: [
      {
        direction: "sent",
        fileId: "sent-file",
        name: "notes.txt",
        size: 15,
        mimeType: "text/plain",
        sha256: "sha-sent",
        status: "complete",
        offeredAt: Date.UTC(2026, 0, 1, 0, 0, 1),
        completedAt: Date.UTC(2026, 0, 1, 0, 0, 2),
        attachment: {
          fileName: "notes.txt",
          mimeType: "text/plain",
          bytes: ENCODER.encode("sent attachment")
        }
      },
      {
        direction: "received",
        fileId: "received-file",
        name: "secret.txt",
        size: 19,
        mimeType: "text/plain",
        sha256: "sha-received",
        status: "complete",
        offeredAt: Date.UTC(2026, 0, 1, 0, 0, 2),
        completedAt: Date.UTC(2026, 0, 1, 0, 0, 3),
        attachment: {
          fileName: "../../secret.txt",
          mimeType: "text/plain",
          bytes: ENCODER.encode("received attachment")
        }
      }
    ]
  };
}

function readStoredZipEntries(bytes: Uint8Array): Map<string, string> {
  const entries = new Map<string, string>();
  let offset = 0;
  while (offset + 4 <= bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const signature = view.getUint32(0, true);
    if (signature === 0x02014b50 || signature === 0x06054b50) {
      return entries;
    }

    expect(signature).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0);
    const compressedSize = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = DECODER.decode(bytes.slice(nameStart, nameStart + nameLength));
    const data = bytes.slice(dataStart, dataStart + compressedSize);
    entries.set(name, DECODER.decode(data));
    offset = dataStart + compressedSize;
  }
  return entries;
}

function bytesIncludesSignature(bytes: Uint8Array, signature: number): boolean {
  for (let offset = 0; offset + 4 <= bytes.byteLength; offset += 1) {
    if (new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true) === signature) {
      return true;
    }
  }
  return false;
}
