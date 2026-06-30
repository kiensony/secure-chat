import type { ClientSignal } from "../signaling/client";
import { SecureChannel } from "./secureChannel";
import type { Identity } from "../crypto/identity";
import type { EncryptionProfileId, PeerRole, PlainFrame } from "../crypto/session";

const ICE_GATHERING_TIMEOUT_MS = 5000;

export interface PeerConnectionEvents {
  onSecureReady(peerFingerprint: string): void;
  onFrame(frame: PlainFrame): void;
  onRemoteAudio(stream: MediaStream): void;
  onStatus(status: string): void;
  onError(error: Error): void;
}

export interface IceServerConfig {
  urls: string;
  username?: string;
  credential?: string;
}

export interface ManualSessionPackage {
  version: 2;
  type: "offer" | "answer";
  encryptionProfile: EncryptionProfileId;
  description: RTCSessionDescriptionInit;
  iceCandidates: RTCIceCandidateInit[];
}

export class SecurePeerConnection {
  private readonly pc: RTCPeerConnection;
  private readonly audioTransceiver: RTCRtpTransceiver;
  private readonly remoteAudioStream = new MediaStream();
  private secureChannel?: SecureChannel;
  private dataChannel?: RTCDataChannel;
  private localAudioStream?: MediaStream;
  private readonly iceCandidates: RTCIceCandidateInit[] = [];
  private iceGatheringComplete?: Promise<void>;
  private resolveIceGathering?: () => void;

  constructor(
    private readonly role: PeerRole,
    private readonly identity: Identity,
    private readonly encryptionProfile: EncryptionProfileId,
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
    this.pc.addEventListener("track", (event) => {
      if (event.track.kind !== "audio") {
        return;
      }

      if (!this.remoteAudioStream.getTracks().includes(event.track)) {
        this.remoteAudioStream.addTrack(event.track);
      }
      this.events.onRemoteAudio(this.remoteAudioStream);
    });

    this.audioTransceiver = this.pc.addTransceiver("audio", { direction: "sendrecv" });

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
      version: 2,
      type: "offer",
      encryptionProfile: this.encryptionProfile,
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
    if (
      offerPackage.version !== 2 ||
      offerPackage.type !== "offer" ||
      offerPackage.encryptionProfile !== this.encryptionProfile
    ) {
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
      version: 2,
      type: "answer",
      encryptionProfile: this.encryptionProfile,
      description,
      iceCandidates: [...this.iceCandidates]
    };
  }

  async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(answer);
  }

  async acceptManualAnswer(answerPackage: ManualSessionPackage): Promise<void> {
    if (
      answerPackage.version !== 2 ||
      answerPackage.type !== "answer" ||
      answerPackage.encryptionProfile !== this.encryptionProfile
    ) {
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

  async startMicrophone(): Promise<void> {
    if (this.localAudioStream?.getAudioTracks().some((track) => track.readyState === "live")) {
      return;
    }

    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true
        },
        video: false
      });
      const [track] = stream.getAudioTracks();
      if (!track) {
        throw new Error("Microphone unavailable");
      }
      await this.audioTransceiver.sender.replaceTrack(track);
      this.localAudioStream = stream;
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      throw new Error("Microphone permission is required to start the call.");
    }
  }

  async stopMicrophone(): Promise<void> {
    const stream = this.localAudioStream;
    this.localAudioStream = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    try {
      await this.audioTransceiver.sender.replaceTrack(null);
    } catch {
      // The peer connection may already be closing.
    }
  }

  setMicrophoneMuted(muted: boolean): void {
    for (const track of this.localAudioStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
  }

  getRemoteAudioStream(): MediaStream {
    return this.remoteAudioStream;
  }

  close(): void {
    void this.secureChannel?.close();
    this.dataChannel?.close();
    void this.stopMicrophone();
    this.pc.close();
  }

  private attachDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;
    channel.addEventListener("open", () => this.events.onStatus("DataChannel open"));
    channel.addEventListener("close", () => this.events.onStatus("DataChannel closed"));
    channel.addEventListener("error", () => this.events.onError(new Error("DataChannel error")));
    this.secureChannel = new SecureChannel(channel, this.identity, this.role, this.encryptionProfile, {
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
