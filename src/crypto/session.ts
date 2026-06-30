import {
  arrayBufferToBytes,
  base64ToBytes,
  bytesToArrayBuffer,
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  concatBytes,
  randomBytes,
  utf8ToBytes
} from "./encoding";
import {
  fingerprintPublicKey,
  importPublicSigningKey,
  signBytes,
  verifyBytes,
  type Identity
} from "./identity";
import type { CallFrameKind } from "../callFrames";

export type PeerRole = "host" | "joiner";
export type EncryptionProfileId = "standard" | "high_assurance";

export interface EncryptionProfile {
  id: EncryptionProfileId;
  label: string;
  ecdhCurve: "P-384" | "P-521";
  ecdhBits: 384 | 521;
  hash: "SHA-384" | "SHA-512";
  layerCount: 1 | 7;
}

export const DEFAULT_ENCRYPTION_PROFILE: EncryptionProfileId = "standard";

export const ENCRYPTION_PROFILES: Record<EncryptionProfileId, EncryptionProfile> = {
  standard: {
    id: "standard",
    label: "Standard",
    ecdhCurve: "P-384",
    ecdhBits: 384,
    hash: "SHA-384",
    layerCount: 1
  },
  high_assurance: {
    id: "high_assurance",
    label: "High Assurance (7-layer)",
    ecdhCurve: "P-521",
    ecdhBits: 521,
    hash: "SHA-512",
    layerCount: 7
  }
};

const SESSION_PROTOCOL = "secure-chat-v2";
const ENVELOPE_VERSION = 2;

export interface SessionHello {
  type: "session_hello";
  protocol: "secure-chat-v2";
  role: PeerRole;
  encryptionProfile: EncryptionProfileId;
  layerCount: number;
  identityPublicJwk: JsonWebKey;
  identityFingerprint: string;
  ecdhPublicKey: string;
  nonce: string;
  signature: string;
}

export interface EncryptedEnvelope {
  type: "encrypted";
  version: 2;
  seq: number;
  nonces: string[];
  senderFingerprint: string;
  encryptionProfile: EncryptionProfileId;
  layerCount: number;
  aad: string;
  ciphertext: string;
}

export interface PlainFrame {
  kind:
    | "chat"
    | "file_offer"
    | "file_accept"
    | "file_reject"
    | "file_chunk"
    | "file_complete"
    | "file_cancel"
    | CallFrameKind;
  payload: unknown;
}

export interface SecureSession {
  peerFingerprint: string;
  peerPublicJwk: JsonWebKey;
  encryptionProfile: EncryptionProfileId;
  layerCount: number;
  encrypt(frame: PlainFrame): Promise<EncryptedEnvelope>;
  decrypt(envelope: EncryptedEnvelope): Promise<PlainFrame>;
}

interface HandshakeState {
  identity: Identity;
  role: PeerRole;
  localEcdh: CryptoKeyPair;
  localHello: SessionHello;
  remoteHello: SessionHello;
}

export async function createLocalHello(identity: Identity, role: PeerRole): Promise<{
  hello: SessionHello;
  ecdh: CryptoKeyPair;
}>;
export async function createLocalHello(
  identity: Identity,
  role: PeerRole,
  encryptionProfile: EncryptionProfileId
): Promise<{
  hello: SessionHello;
  ecdh: CryptoKeyPair;
}>;
export async function createLocalHello(
  identity: Identity,
  role: PeerRole,
  encryptionProfile: EncryptionProfileId = DEFAULT_ENCRYPTION_PROFILE
): Promise<{
  hello: SessionHello;
  ecdh: CryptoKeyPair;
}> {
  const profile = encryptionProfileConfig(encryptionProfile);
  const ecdh = await crypto.subtle.generateKey(
    {
      name: "ECDH",
      namedCurve: profile.ecdhCurve
    },
    true,
    ["deriveBits"]
  );
  const publicRaw = await crypto.subtle.exportKey("raw", ecdh.publicKey);
  const unsigned = {
    type: "session_hello",
    protocol: SESSION_PROTOCOL,
    role,
    encryptionProfile: profile.id,
    layerCount: profile.layerCount,
    identityPublicJwk: identity.publicJwk,
    identityFingerprint: identity.fingerprint,
    ecdhPublicKey: bytesToBase64(arrayBufferToBytes(publicRaw)),
    nonce: bytesToBase64(randomBytes(32))
  } satisfies Omit<SessionHello, "signature">;

  const signature = await signBytes(identity.privateKey, canonicalBytes(unsigned));

  return {
    hello: {
      ...unsigned,
      signature: bytesToBase64(signature)
    },
    ecdh
  };
}

export async function establishSecureSession(state: HandshakeState): Promise<SecureSession> {
  const profile = encryptionProfileConfig(state.localHello.encryptionProfile);
  validateHelloProfile(state.localHello, profile);
  await validateRemoteHello(state.remoteHello);
  const remotePublicKey = await importPublicSigningKey(state.remoteHello.identityPublicJwk);
  const signatureOk = await verifyBytes(
    remotePublicKey,
    canonicalBytes(withoutSignature(state.remoteHello)),
    base64ToBytes(state.remoteHello.signature)
  );

  if (!signatureOk) {
    throw new Error("Peer identity signature is invalid");
  }

  if (state.remoteHello.encryptionProfile !== state.localHello.encryptionProfile) {
    throw new Error("Peer encryption profile does not match this session");
  }
  validateHelloProfile(state.remoteHello, profile);

  const remoteEcdh = await crypto.subtle.importKey(
    "raw",
    bytesToArrayBuffer(base64ToBytes(state.remoteHello.ecdhPublicKey)),
    {
      name: "ECDH",
      namedCurve: profile.ecdhCurve
    },
    true,
    []
  );

  const sharedBits = await crypto.subtle.deriveBits(
    {
      name: "ECDH",
      public: remoteEcdh
    },
    state.localEcdh.privateKey,
    profile.ecdhBits
  );

  const transcriptHash = await digest(profile.hash, transcriptBytes(state.localHello, state.remoteHello));
  const keyMaterial = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  const sendKeys = await deriveAesKeys(
    keyMaterial,
    transcriptHash,
    profile,
    state.identity.fingerprint,
    state.remoteHello.identityFingerprint
  );
  const receiveKeys = await deriveAesKeys(
    keyMaterial,
    transcriptHash,
    profile,
    state.remoteHello.identityFingerprint,
    state.identity.fingerprint
  );

  let sendSeq = 0;
  let highestReceivedSeq = -1;

  return {
    peerFingerprint: state.remoteHello.identityFingerprint,
    peerPublicJwk: state.remoteHello.identityPublicJwk,
    encryptionProfile: profile.id,
    layerCount: profile.layerCount,
    async encrypt(frame: PlainFrame): Promise<EncryptedEnvelope> {
      sendSeq += 1;
      const metadata = {
        version: ENVELOPE_VERSION,
        seq: sendSeq,
        senderFingerprint: state.identity.fingerprint,
        encryptionProfile: profile.id,
        layerCount: profile.layerCount
      } satisfies EncryptedFrameMetadata;
      const nonces: string[] = [];
      let ciphertext = utf8ToBytes(JSON.stringify(frame));

      for (let layerIndex = 0; layerIndex < sendKeys.length; layerIndex += 1) {
        const nonce = randomBytes(12);
        const encrypted = await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: bytesToArrayBuffer(nonce),
            additionalData: layerAad(metadata, layerIndex)
          },
          sendKeys[layerIndex],
          bytesToArrayBuffer(ciphertext)
        );
        nonces.push(bytesToBase64(nonce));
        ciphertext = arrayBufferToBytes(encrypted);
      }

      return {
        type: "encrypted",
        version: ENVELOPE_VERSION,
        seq: sendSeq,
        nonces,
        senderFingerprint: state.identity.fingerprint,
        encryptionProfile: profile.id,
        layerCount: profile.layerCount,
        aad: frameAad(metadata),
        ciphertext: bytesToBase64(ciphertext)
      };
    },
    async decrypt(envelope: EncryptedEnvelope): Promise<PlainFrame> {
      if (
        envelope.version !== ENVELOPE_VERSION ||
        envelope.senderFingerprint !== state.remoteHello.identityFingerprint ||
        envelope.encryptionProfile !== profile.id ||
        envelope.layerCount !== profile.layerCount ||
        envelope.nonces.length !== profile.layerCount
      ) {
        throw new Error("Encrypted frame metadata does not match this session");
      }

      if (envelope.seq <= highestReceivedSeq) {
        throw new Error("Replay or out-of-order encrypted frame rejected");
      }

      const metadata = {
        version: ENVELOPE_VERSION,
        seq: envelope.seq,
        senderFingerprint: envelope.senderFingerprint,
        encryptionProfile: envelope.encryptionProfile,
        layerCount: envelope.layerCount
      } satisfies EncryptedFrameMetadata;
      const expectedAad = frameAad(metadata);

      if (envelope.aad !== expectedAad) {
        throw new Error("Encrypted frame AAD mismatch");
      }

      let plaintext = base64ToBytes(envelope.ciphertext);
      for (let layerIndex = receiveKeys.length - 1; layerIndex >= 0; layerIndex -= 1) {
        const decrypted = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: bytesToArrayBuffer(base64ToBytes(envelope.nonces[layerIndex])),
            additionalData: layerAad(metadata, layerIndex)
          },
          receiveKeys[layerIndex],
          bytesToArrayBuffer(plaintext)
        );
        plaintext = arrayBufferToBytes(decrypted);
      }

      highestReceivedSeq = envelope.seq;
      return JSON.parse(bytesToUtf8(plaintext)) as PlainFrame;
    }
  };
}

export async function validateRemoteHello(hello: SessionHello): Promise<void> {
  if (hello.protocol !== SESSION_PROTOCOL) {
    throw new Error("Unsupported peer protocol");
  }

  const profile = encryptionProfileConfig(hello.encryptionProfile);
  validateHelloProfile(hello, profile);
  const key = await importPublicSigningKey(hello.identityPublicJwk);
  const fingerprint = await fingerprintPublicKey(key);
  if (fingerprint !== hello.identityFingerprint) {
    throw new Error("Peer fingerprint does not match the public key");
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytesToArrayBuffer(bytes));
  return bytesToHex(arrayBufferToBytes(digest));
}

function withoutSignature(hello: SessionHello): Omit<SessionHello, "signature"> {
  return {
    type: hello.type,
    protocol: hello.protocol,
    role: hello.role,
    encryptionProfile: hello.encryptionProfile,
    layerCount: hello.layerCount,
    identityPublicJwk: hello.identityPublicJwk,
    identityFingerprint: hello.identityFingerprint,
    ecdhPublicKey: hello.ecdhPublicKey,
    nonce: hello.nonce
  };
}

interface EncryptedFrameMetadata {
  version: 2;
  seq: number;
  senderFingerprint: string;
  encryptionProfile: EncryptionProfileId;
  layerCount: number;
}

function canonicalBytes(value: unknown): Uint8Array {
  return utf8ToBytes(stableStringify(value));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

async function digest(hash: EncryptionProfile["hash"], bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(hash, bytesToArrayBuffer(bytes));
  return arrayBufferToBytes(digest);
}

function keyInfo(
  profile: EncryptionProfile,
  senderFingerprint: string,
  receiverFingerprint: string,
  layerIndex: number
): Uint8Array {
  return utf8ToBytes(
    `${SESSION_PROTOCOL}:${profile.id}:${profile.layerCount}:layer-${layerIndex}:${senderFingerprint}->${receiverFingerprint}`
  );
}

function transcriptBytes(first: SessionHello, second: SessionHello): Uint8Array {
  const hostHello = first.role === "host" ? first : second;
  const joinerHello = first.role === "joiner" ? first : second;
  if (hostHello.role !== "host" || joinerHello.role !== "joiner") {
    throw new Error("Handshake transcript must include one host and one joiner");
  }
  return concatBytes(canonicalBytes(hostHello), canonicalBytes(joinerHello));
}

async function deriveAesKeys(
  keyMaterial: CryptoKey,
  salt: Uint8Array,
  profile: EncryptionProfile,
  senderFingerprint: string,
  receiverFingerprint: string
): Promise<CryptoKey[]> {
  const keys: CryptoKey[] = [];
  for (let layerIndex = 0; layerIndex < profile.layerCount; layerIndex += 1) {
    keys.push(
      await deriveAesKey(
        keyMaterial,
        salt,
        keyInfo(profile, senderFingerprint, receiverFingerprint, layerIndex),
        profile.hash
      )
    );
  }
  return keys;
}

async function deriveAesKey(
  keyMaterial: CryptoKey,
  salt: Uint8Array,
  info: Uint8Array,
  hash: EncryptionProfile["hash"]
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash,
      salt: bytesToArrayBuffer(salt),
      info: bytesToArrayBuffer(info)
    },
    keyMaterial,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"]
  );
}

function encryptionProfileConfig(id: EncryptionProfileId): EncryptionProfile {
  return ENCRYPTION_PROFILES[id];
}

function validateHelloProfile(hello: SessionHello, profile: EncryptionProfile): void {
  if (hello.encryptionProfile !== profile.id || hello.layerCount !== profile.layerCount) {
    throw new Error("Unsupported encryption profile");
  }
}

function frameAad(metadata: EncryptedFrameMetadata): string {
  return JSON.stringify(metadata);
}

function layerAad(metadata: EncryptedFrameMetadata, layerIndex: number): ArrayBuffer {
  return bytesToArrayBuffer(utf8ToBytes(JSON.stringify({ ...metadata, layerIndex })));
}
