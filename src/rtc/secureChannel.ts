import {
  ENCRYPTION_PROFILES,
  createLocalHello,
  establishSecureSession,
  type EncryptionProfileId,
  type EncryptedEnvelope,
  type PeerRole,
  type PlainFrame,
  type SecureSession,
  type SessionHello
} from "../crypto/session";
import type { Identity } from "../crypto/identity";

export interface SecureChannelEvents {
  onReady(peerFingerprint: string): void;
  onFrame(frame: PlainFrame): void;
  onError(error: Error): void;
}

export class SecureChannel {
  private localHello?: SessionHello;
  private localEcdh?: CryptoKeyPair;
  private remoteHello?: SessionHello;
  private session?: SecureSession;
  private readonly pendingEncrypted: EncryptedEnvelope[] = [];
  private readonly highWaterMark = 1 * 1024 * 1024;

  constructor(
    private readonly channel: RTCDataChannel,
    private readonly identity: Identity,
    private readonly role: PeerRole,
    private readonly encryptionProfile: EncryptionProfileId,
    private readonly events: SecureChannelEvents
  ) {
    this.channel.binaryType = "arraybuffer";
    this.channel.addEventListener("open", () => {
      void this.sendLocalHello();
    });
    this.channel.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
  }

  get ready(): boolean {
    return Boolean(this.session);
  }

  async send(frame: PlainFrame): Promise<void> {
    if (!this.session) {
      throw new Error("Secure session is not ready");
    }
    await this.waitForBackpressure();
    this.channel.send(JSON.stringify(await this.session.encrypt(frame)));
  }

  async close(): Promise<void> {
    this.channel.close();
  }

  private async sendLocalHello(): Promise<void> {
    try {
      const local = await createLocalHello(this.identity, this.role, this.encryptionProfile);
      this.localHello = local.hello;
      this.localEcdh = local.ecdh;
      this.channel.send(JSON.stringify(local.hello));
      await this.tryEstablish();
    } catch (error) {
      this.events.onError(toError(error));
    }
  }

  private async handleMessage(data: unknown): Promise<void> {
    try {
      if (typeof data !== "string") {
        throw new Error("Unsupported DataChannel payload type");
      }

      const parsed = JSON.parse(data) as unknown;
      if (isSessionHello(parsed)) {
        this.remoteHello = parsed;
        await this.tryEstablish();
        return;
      }

      if (isEncryptedEnvelope(parsed)) {
        if (!this.session) {
          this.pendingEncrypted.push(parsed);
          return;
        }
        this.events.onFrame(await this.session.decrypt(parsed));
        return;
      }

      throw new Error("Unknown DataChannel frame");
    } catch (error) {
      this.events.onError(toError(error));
    }
  }

  private async tryEstablish(): Promise<void> {
    if (this.session || !this.localHello || !this.localEcdh || !this.remoteHello) {
      return;
    }

    this.session = await establishSecureSession({
      identity: this.identity,
      role: this.role,
      localEcdh: this.localEcdh,
      localHello: this.localHello,
      remoteHello: this.remoteHello
    });

    this.events.onReady(this.session.peerFingerprint);

    while (this.pendingEncrypted.length > 0) {
      const envelope = this.pendingEncrypted.shift();
      if (envelope) {
        this.events.onFrame(await this.session.decrypt(envelope));
      }
    }
  }

  private async waitForBackpressure(): Promise<void> {
    if (this.channel.bufferedAmount <= this.highWaterMark) {
      return;
    }

    this.channel.bufferedAmountLowThreshold = Math.floor(this.highWaterMark / 4);
    await new Promise<void>((resolve) => {
      const onLow = (): void => {
        this.channel.removeEventListener("bufferedamountlow", onLow);
        resolve();
      };
      this.channel.addEventListener("bufferedamountlow", onLow);
    });
  }
}

function isSessionHello(value: unknown): value is SessionHello {
  const frame = value as SessionHello;
  const expectedProfile = frame ? ENCRYPTION_PROFILES[frame.encryptionProfile] : undefined;
  return (
    frame?.type === "session_hello" &&
    frame.protocol === "secure-chat-v2" &&
    (frame.role === "host" || frame.role === "joiner") &&
    Boolean(expectedProfile) &&
    frame.layerCount === expectedProfile?.layerCount &&
    typeof frame.identityFingerprint === "string" &&
    typeof frame.ecdhPublicKey === "string" &&
    typeof frame.nonce === "string" &&
    typeof frame.signature === "string" &&
    typeof frame.identityPublicJwk === "object"
  );
}

function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  const frame = value as EncryptedEnvelope;
  return (
    frame?.type === "encrypted" &&
    frame.version === 2 &&
    typeof frame.seq === "number" &&
    Array.isArray(frame.nonces) &&
    frame.nonces.every((nonce) => typeof nonce === "string") &&
    typeof frame.senderFingerprint === "string" &&
    (frame.encryptionProfile === "standard" || frame.encryptionProfile === "high_assurance") &&
    typeof frame.layerCount === "number" &&
    typeof frame.aad === "string" &&
    typeof frame.ciphertext === "string"
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
