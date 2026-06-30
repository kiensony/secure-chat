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

export type PeerRole = "host" | "joiner";

export interface SessionHello {
  type: "session_hello";
  protocol: "secure-chat-v1";
  role: PeerRole;
  identityPublicJwk: JsonWebKey;
  identityFingerprint: string;
  ecdhPublicKey: string;
  nonce: string;
  signature: string;
}

export interface EncryptedEnvelope {
  type: "encrypted";
  version: 1;
  seq: number;
  nonce: string;
  senderFingerprint: string;
  aad: string;
  ciphertext: string;
}

export interface PlainFrame {
  kind: "chat" | "file_offer" | "file_accept" | "file_reject" | "file_chunk" | "file_complete" | "file_cancel";
  payload: unknown;
}

export interface SecureSession {
  peerFingerprint: string;
  peerPublicJwk: JsonWebKey;
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
}> {
  const ecdh = await crypto.subtle.generateKey(
    {
      name: "ECDH",
      namedCurve: "P-384"
    },
    true,
    ["deriveBits"]
  );
  const publicRaw = await crypto.subtle.exportKey("raw", ecdh.publicKey);
  const unsigned = {
    type: "session_hello",
    protocol: "secure-chat-v1",
    role,
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

  const remoteEcdh = await crypto.subtle.importKey(
    "raw",
    bytesToArrayBuffer(base64ToBytes(state.remoteHello.ecdhPublicKey)),
    {
      name: "ECDH",
      namedCurve: "P-384"
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
    384
  );

  const transcriptHash = await sha384(transcriptBytes(state.localHello, state.remoteHello));
  const keyMaterial = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  const sendKey = await deriveAesKey(keyMaterial, transcriptHash, keyInfo(state.identity.fingerprint, state.remoteHello.identityFingerprint));
  const receiveKey = await deriveAesKey(
    keyMaterial,
    transcriptHash,
    keyInfo(state.remoteHello.identityFingerprint, state.identity.fingerprint)
  );

  let sendSeq = 0;
  let highestReceivedSeq = -1;

  return {
    peerFingerprint: state.remoteHello.identityFingerprint,
    peerPublicJwk: state.remoteHello.identityPublicJwk,
    async encrypt(frame: PlainFrame): Promise<EncryptedEnvelope> {
      sendSeq += 1;
      const nonce = randomBytes(12);
      const aad = JSON.stringify({
        version: 1,
        seq: sendSeq,
        senderFingerprint: state.identity.fingerprint
      });
      const plaintext = utf8ToBytes(JSON.stringify(frame));
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: bytesToArrayBuffer(nonce),
          additionalData: bytesToArrayBuffer(utf8ToBytes(aad))
        },
        sendKey,
        bytesToArrayBuffer(plaintext)
      );

      return {
        type: "encrypted",
        version: 1,
        seq: sendSeq,
        nonce: bytesToBase64(nonce),
        senderFingerprint: state.identity.fingerprint,
        aad,
        ciphertext: bytesToBase64(arrayBufferToBytes(ciphertext))
      };
    },
    async decrypt(envelope: EncryptedEnvelope): Promise<PlainFrame> {
      if (envelope.version !== 1 || envelope.senderFingerprint !== state.remoteHello.identityFingerprint) {
        throw new Error("Encrypted frame metadata does not match this session");
      }

      if (envelope.seq <= highestReceivedSeq) {
        throw new Error("Replay or out-of-order encrypted frame rejected");
      }

      const expectedAad = JSON.stringify({
        version: 1,
        seq: envelope.seq,
        senderFingerprint: envelope.senderFingerprint
      });

      if (envelope.aad !== expectedAad) {
        throw new Error("Encrypted frame AAD mismatch");
      }

      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bytesToArrayBuffer(base64ToBytes(envelope.nonce)),
          additionalData: bytesToArrayBuffer(utf8ToBytes(envelope.aad))
        },
        receiveKey,
        bytesToArrayBuffer(base64ToBytes(envelope.ciphertext))
      );
      highestReceivedSeq = envelope.seq;
      return JSON.parse(bytesToUtf8(arrayBufferToBytes(plaintext))) as PlainFrame;
    }
  };
}

export async function validateRemoteHello(hello: SessionHello): Promise<void> {
  if (hello.protocol !== "secure-chat-v1") {
    throw new Error("Unsupported peer protocol");
  }

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
    identityPublicJwk: hello.identityPublicJwk,
    identityFingerprint: hello.identityFingerprint,
    ecdhPublicKey: hello.ecdhPublicKey,
    nonce: hello.nonce
  };
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

async function sha384(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-384", bytesToArrayBuffer(bytes));
  return arrayBufferToBytes(digest);
}

function keyInfo(senderFingerprint: string, receiverFingerprint: string): Uint8Array {
  return utf8ToBytes(`secure-chat-v1:${senderFingerprint}->${receiverFingerprint}`);
}

function transcriptBytes(first: SessionHello, second: SessionHello): Uint8Array {
  const hostHello = first.role === "host" ? first : second;
  const joinerHello = first.role === "joiner" ? first : second;
  if (hostHello.role !== "host" || joinerHello.role !== "joiner") {
    throw new Error("Handshake transcript must include one host and one joiner");
  }
  return concatBytes(canonicalBytes(hostHello), canonicalBytes(joinerHello));
}

async function deriveAesKey(keyMaterial: CryptoKey, salt: Uint8Array, info: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-384",
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
