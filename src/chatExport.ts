export interface ChatExportMessage {
  id: string;
  direction: "sent" | "received" | "system";
  text: string;
  at: number;
}

export interface ChatExportAttachment {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface ChatExportTransfer {
  direction: "sent" | "received";
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
  sha256: string;
  status: string;
  offeredAt: number;
  completedAt?: number;
  attachment?: ChatExportAttachment;
}

export interface ChatExportData {
  exportedAt: number;
  role: "host" | "joiner" | null;
  verified: boolean;
  ownFingerprint: string;
  peerFingerprint: string;
  messages: ChatExportMessage[];
  transfers: ChatExportTransfer[];
}

interface ZipEntry {
  path: string;
  data: Uint8Array;
}

interface StructuredTransfer extends Omit<ChatExportTransfer, "attachment"> {
  attachmentPath?: string;
}

interface StructuredExport {
  version: 1;
  exportedAt: string;
  role: ChatExportData["role"];
  verified: boolean;
  ownFingerprint: string;
  peerFingerprint: string;
  messages: Array<ChatExportMessage & { atIso: string }>;
  transfers: StructuredTransfer[];
}

const ZIP_TEXT_ENCODER = new TextEncoder();
let crcTable: Uint32Array | undefined;

export function createChatExportZip(data: ChatExportData): Blob {
  const usedAttachmentPaths = new Set<string>();
  const transfers = data.transfers.map((transfer): StructuredTransfer => {
    const attachmentPath =
      transfer.status === "complete" && transfer.attachment
        ? uniqueAttachmentPath(transfer.direction, transfer.attachment.fileName, usedAttachmentPaths)
        : undefined;

    return {
      direction: transfer.direction,
      fileId: transfer.fileId,
      name: transfer.name,
      size: transfer.size,
      mimeType: transfer.mimeType,
      sha256: transfer.sha256,
      status: transfer.status,
      offeredAt: transfer.offeredAt,
      completedAt: transfer.completedAt,
      attachmentPath
    };
  });

  const structured: StructuredExport = {
    version: 1,
    exportedAt: new Date(data.exportedAt).toISOString(),
    role: data.role,
    verified: data.verified,
    ownFingerprint: data.ownFingerprint,
    peerFingerprint: data.peerFingerprint,
    messages: data.messages.map((message) => ({
      ...message,
      atIso: new Date(message.at).toISOString()
    })),
    transfers
  };

  const entries: ZipEntry[] = [
    {
      path: "transcript.md",
      data: utf8Bytes(renderMarkdownTranscript(structured))
    },
    {
      path: "transcript.json",
      data: utf8Bytes(`${JSON.stringify(structured, null, 2)}\n`)
    }
  ];

  for (let index = 0; index < data.transfers.length; index += 1) {
    const attachmentPath = transfers[index].attachmentPath;
    const attachment = data.transfers[index].attachment;
    if (attachmentPath && attachment) {
      entries.push({
        path: attachmentPath,
        data: attachment.bytes
      });
    }
  }

  return createZip(entries, new Date(data.exportedAt));
}

export function createChatExportFileName(exportedAt = Date.now()): string {
  const stamp = new Date(exportedAt)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "")
    .replace("T", "-");
  return `secure-chat-export-${stamp}.zip`;
}

function renderMarkdownTranscript(data: StructuredExport): string {
  const lines = [
    "# Secure Chat Export",
    "",
    `Exported: ${data.exportedAt}`,
    `Role: ${data.role ?? "none"}`,
    `Peer verified: ${data.verified ? "yes" : "no"}`,
    `Own fingerprint: ${data.ownFingerprint || "unknown"}`,
    `Peer fingerprint: ${data.peerFingerprint || "unknown"}`,
    "",
    "## Messages",
    ""
  ];

  if (data.messages.length === 0) {
    lines.push("_No messages._", "");
  } else {
    for (const message of data.messages) {
      lines.push(`- ${message.atIso} ${message.direction.toUpperCase()}: ${indentMultiline(message.text)}`);
    }
    lines.push("");
  }

  lines.push("## File Transfers", "");
  if (data.transfers.length === 0) {
    lines.push("_No file transfers._", "");
  } else {
    for (const transfer of data.transfers) {
      const completed = transfer.completedAt ? ` completed ${new Date(transfer.completedAt).toISOString()}` : "";
      const attachment = transfer.attachmentPath ? ` attachment ${transfer.attachmentPath}` : " no attachment";
      lines.push(
        `- ${new Date(transfer.offeredAt).toISOString()} ${transfer.direction.toUpperCase()} ${transfer.name} ` +
          `(${transfer.size} bytes, ${transfer.status}${completed}, sha256 ${transfer.sha256},${attachment})`
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function indentMultiline(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n/g, "\n  ");
}

function uniqueAttachmentPath(direction: ChatExportTransfer["direction"], name: string, usedPaths: Set<string>): string {
  const safeName = sanitizeZipFileName(name);
  const dotIndex = safeName.lastIndexOf(".");
  const stem = dotIndex > 0 ? safeName.slice(0, dotIndex) : safeName;
  const extension = dotIndex > 0 ? safeName.slice(dotIndex) : "";
  let counter = 1;
  let candidate = `attachments/${direction}/${safeName}`;

  while (usedPaths.has(candidate)) {
    counter += 1;
    candidate = `attachments/${direction}/${stem}-${counter}${extension}`;
  }

  usedPaths.add(candidate);
  return candidate;
}

function sanitizeZipFileName(name: string): string {
  const lastSegment = name.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  const cleaned = lastSegment
    .replace(/[\\/:*?"<>|]/g, "_")
    .split("")
    .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "attachment.bin";
  }

  return cleaned;
}

function createZip(entries: ZipEntry[], date: Date): Blob {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const { dosTime, dosDate } = toDosDateTime(date);
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = utf8Bytes(entry.path);
    const crc = crc32(entry.data);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    writeLocalHeader(localView, nameBytes.length, entry.data.byteLength, crc, dosTime, dosDate);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, entry.data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeCentralHeader(centralView, nameBytes.length, entry.data.byteLength, crc, dosTime, dosDate, offset);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.byteLength + entry.data.byteLength;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((total, part) => total + part.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);

  return new Blob([...localParts, ...centralParts, end].map(toBlobPart), { type: "application/zip" });
}

function writeLocalHeader(
  view: DataView,
  nameLength: number,
  size: number,
  crc: number,
  dosTime: number,
  dosDate: number
): void {
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, dosTime, true);
  view.setUint16(12, dosDate, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, nameLength, true);
}

function writeCentralHeader(
  view: DataView,
  nameLength: number,
  size: number,
  crc: number,
  dosTime: number,
  dosDate: number,
  offset: number
): void {
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, dosTime, true);
  view.setUint16(14, dosDate, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, nameLength, true);
  view.setUint32(42, offset, true);
}

function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function crc32(bytes: Uint8Array): number {
  const table = (crcTable ??= createCrcTable());
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function utf8Bytes(value: string): Uint8Array {
  return ZIP_TEXT_ENCODER.encode(value);
}

function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
