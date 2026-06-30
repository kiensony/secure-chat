import type { ClientSignal } from "../signaling/client";
import { SecureChannel } from "./secureChannel";
import type { Identity } from "../crypto/identity";
import type { PeerRole, PlainFrame } from "../crypto/session";

const ICE_GATHERING_TIMEOUT_MS = 5000;

export interface PeerConnectionEvents {
  onSecureReady(peerFingerprint: string): void;
  onFrame(frame: PlainFrame): void;
  onStatus(status: string): void;
  onError(error: Error): void;
}

export interface IceServerConfig {
  urls: string;
  username?: string;
  credential?: string;
}

export interface ManualSessionPackage {
  version: 1;
  type: "offer" | "answer";
  description: RTCSessionDescriptionInit;
  iceCandidates: RTCIceCandidateInit[];
}

export class SecurePeerConnection {
  private readonly pc: RTCPeerConnection;
  private secureChannel?: SecureChannel;
  private dataChannel?: RTCDataChannel;
  private readonly iceCandidates: RTCIceCandidateInit[] = [];
  private iceGatheringComplete?: Promise<void>;
  private resolveIceGathering?: () => void;

  constructor(
    private readonly role: PeerRole,
    private readonly identity: Identity,
    private readonly relaySignal: ((signal: ClientSignal) => void) | null,
    private readonly events: PeerConnectionEvents,
    iceServers: IceServerConfig[]
  ) {
    this.pc = new RTCPeerConnection({
      iceServers
    });
    this.pc.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        const candidate = event.candidate.toJSON();
        this.iceCandidates.push(candidate);
        this.relaySignal?.({ type: "ice_candidate", payload: candidate });
      } else {
        this.resolveIceGathering?.();
      }
    });
    this.pc.addEventListener("connectionstatechange", () => {
      this.events.onStatus(`WebRTC ${this.pc.connectionState}`);
    });
    this.pc.addEventListener("datachannel", (event) => {
      this.attachDataChannel(event.channel);
    });

    if (role === "host") {
      this.attachDataChannel(this.pc.createDataChannel("secure-chat", { ordered: true }));
    }
  }

  async createOffer(): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.relaySignal?.({ type: "offer", payload: offer });
  }

  async createManualOffer(): Promise<ManualSessionPackage> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.waitForIceGathering();
    const description = this.pc.localDescription?.toJSON();
    if (!description) {
      throw new Error("Unable to create local offer");
    }
    return {
      version: 1,
      type: "offer",
      description,
      iceCandidates: [...this.iceCandidates]
    };
  }

  async acceptOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.relaySignal?.({ type: "answer", payload: answer });
  }

  async acceptManualOffer(offerPackage: ManualSessionPackage): Promise<ManualSessionPackage> {
    if (offerPackage.version !== 1 || offerPackage.type !== "offer") {
      throw new Error("Paste a valid Secure Chat offer package");
    }

    await this.pc.setRemoteDescription(offerPackage.description);
    for (const candidate of offerPackage.iceCandidates) {
      await this.pc.addIceCandidate(candidate);
    }

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.waitForIceGathering();
    const description = this.pc.localDescription?.toJSON();
    if (!description) {
      throw new Error("Unable to create local answer");
    }

    return {
      version: 1,
      type: "answer",
      description,
      iceCandidates: [...this.iceCandidates]
    };
  }

  async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(answer);
  }

  async acceptManualAnswer(answerPackage: ManualSessionPackage): Promise<void> {
    if (answerPackage.version !== 1 || answerPackage.type !== "answer") {
      throw new Error("Paste a valid Secure Chat answer package");
    }

    await this.pc.setRemoteDescription(answerPackage.description);
    for (const candidate of answerPackage.iceCandidates) {
      await this.pc.addIceCandidate(candidate);
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.pc.addIceCandidate(candidate);
  }

  async send(frame: PlainFrame): Promise<void> {
    if (!this.secureChannel?.ready) {
      throw new Error("Secure peer channel is not ready");
    }
    await this.secureChannel.send(frame);
  }

  close(): void {
    void this.secureChannel?.close();
    this.dataChannel?.close();
    this.pc.close();
  }

  private attachDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;
    channel.addEventListener("open", () => this.events.onStatus("DataChannel open"));
    channel.addEventListener("close", () => this.events.onStatus("DataChannel closed"));
    channel.addEventListener("error", () => this.events.onError(new Error("DataChannel error")));
    this.secureChannel = new SecureChannel(channel, this.identity, this.role, {
      onReady: (peerFingerprint) => this.events.onSecureReady(peerFingerprint),
      onFrame: (frame) => this.events.onFrame(frame),
      onError: (error) => this.events.onError(error)
    });
  }

  private async waitForIceGathering(): Promise<void> {
    if (this.pc.iceGatheringState === "complete") {
      return;
    }

    this.iceGatheringComplete ??= new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.pc.removeEventListener("icegatheringstatechange", onStateChange);
        resolve();
      };
      const onStateChange = (): void => {
        if (this.pc.iceGatheringState === "complete") {
          finish();
        }
      };
      const timeout = setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
      this.resolveIceGathering = finish;
      this.pc.addEventListener("icegatheringstatechange", onStateChange);
    });

    await this.iceGatheringComplete;
  }
}
