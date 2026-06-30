import { bytesToBase64, base64ToBytes } from "./crypto/encoding";
import { sha256Hex, type PlainFrame } from "./crypto/session";

export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
export const FILE_CHUNK_SIZE = 32 * 1024;

export interface FileOfferPayload {
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
  chunkSize: number;
  sha256: string;
}

export interface FileChunkPayload {
  fileId: string;
  index: number;
  total: number;
  data: string;
}

export interface IncomingFileState {
  offer: FileOfferPayload;
  chunks: Uint8Array[];
  receivedBytes: number;
}

export interface OutgoingFileProgress {
  fileId: string;
  sentBytes: number;
  totalBytes: number;
}

export async function createFileOffer(file: File): Promise<{ offer: FileOfferPayload; bytes: Uint8Array }> {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new Error("File is larger than the 100 MB v1 limit");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    bytes,
    offer: {
      fileId: crypto.randomUUID(),
      name: sanitizeFileName(file.name),
      size: file.size,
      mimeType: file.type || "application/octet-stream",
      chunkSize: FILE_CHUNK_SIZE,
      sha256: await sha256Hex(bytes)
    }
  };
}

export async function sendFileChunks(
  offer: FileOfferPayload,
  bytes: Uint8Array,
  send: (frame: PlainFrame) => Promise<void>,
  onProgress: (progress: OutgoingFileProgress) => void
): Promise<void> {
  const total = Math.ceil(bytes.byteLength / offer.chunkSize);
  for (let index = 0; index < total; index += 1) {
    const start = index * offer.chunkSize;
    const end = Math.min(start + offer.chunkSize, bytes.byteLength);
    const chunk = bytes.slice(start, end);
    await send({
      kind: "file_chunk",
      payload: {
        fileId: offer.fileId,
        index,
        total,
        data: bytesToBase64(chunk)
      } satisfies FileChunkPayload
    });
    onProgress({
      fileId: offer.fileId,
      sentBytes: end,
      totalBytes: bytes.byteLength
    });
  }

  await send({
    kind: "file_complete",
    payload: {
      fileId: offer.fileId
    }
  });
}

export function appendIncomingChunk(state: IncomingFileState, chunk: FileChunkPayload): IncomingFileState {
  if (chunk.fileId !== state.offer.fileId) {
    throw new Error("Chunk does not belong to this file transfer");
  }

  if (chunk.index !== state.chunks.length) {
    throw new Error("File chunk order mismatch");
  }

  const bytes = base64ToBytes(chunk.data);
  const nextBytes = state.receivedBytes + bytes.byteLength;
  if (nextBytes > state.offer.size) {
    throw new Error("Received more bytes than promised by file offer");
  }

  return {
    offer: state.offer,
    chunks: [...state.chunks, bytes],
    receivedBytes: nextBytes
  };
}

export async function completeIncomingFile(state: IncomingFileState): Promise<Blob> {
  if (state.receivedBytes !== state.offer.size) {
    throw new Error("File transfer completed before all bytes were received");
  }

  const bytes = new Uint8Array(state.receivedBytes);
  let offset = 0;
  for (const chunk of state.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const digest = await sha256Hex(bytes);
  if (digest !== state.offer.sha256) {
    throw new Error("Received file hash does not match the offer");
  }

  return new Blob([bytes], {
    type: safeDownloadMimeType(state.offer.mimeType)
  });
}

export function sanitizeFileName(name: string): string {
  const fallback = "download.bin";
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, "_")
    .split("")
    .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function safeDownloadMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (
    normalized.includes("html") ||
    normalized.includes("svg") ||
    normalized.includes("javascript") ||
    normalized.includes("xml")
  ) {
    return "application/octet-stream";
  }
  return mimeType || "application/octet-stream";
}
