import {
  Clipboard,
  Copy,
  Download,
  FileUp,
  KeyRound,
  Link2,
  Lock,
  Mic,
  MicOff,
  Phone,
  PhoneCall,
  PhoneOff,
  Play,
  Send,
  ShieldCheck,
  Upload,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CALL_INVITE_TIMEOUT_MS,
  isCallFrameKind,
  validateCallControlFrame,
  type CallControlFrame,
  type CallEndReason,
  type CallRejectReason
} from "./callFrames";
import { formatFingerprint } from "./crypto/encoding";
import {
  DEFAULT_ENCRYPTION_PROFILE,
  ENCRYPTION_PROFILES,
  type EncryptionProfileId
} from "./crypto/session";
import {
  createIdentity,
  importIdentityFromBackup,
  parseBackup,
  serializeBackup,
  type Identity,
  type KeyBackupFile
} from "./crypto/identity";
import {
  appendIncomingChunk,
  completeIncomingFile,
  createFileOffer,
  MAX_FILE_SIZE_BYTES,
  sanitizeFileName,
  sendFileChunks,
  type FileChunkPayload,
  type FileOfferPayload,
  type IncomingFileState
} from "./fileTransfer";
import { SecurePeerConnection, type IceServerConfig, type ManualSessionPackage } from "./rtc/webrtc";
import { SignalingClient, type ServerSignal } from "./signaling/client";
import { clearIdentity, loadStoredIdentity, saveIdentity } from "./storage/identityStore";
import { isTrustedPeer, rememberTrustedPeer } from "./trustStore";

type AppPhase = "loading" | "identity" | "ready";
type PeerRole = "host" | "joiner";
type PairingMode = "server" | "manual";
type CallState = "idle" | "outgoing" | "incoming" | "connecting" | "active";

interface ChatMessage {
  id: string;
  direction: "sent" | "received" | "system";
  text: string;
  at: number;
}

interface IncomingOfferView {
  offer: FileOfferPayload;
  status: "pending" | "receiving" | "complete" | "rejected";
  receivedBytes: number;
  downloadUrl?: string;
}

interface OutgoingFileView {
  fileId: string;
  name: string;
  sentBytes: number;
  totalBytes: number;
  status: "offered" | "sending" | "complete" | "rejected" | "cancelled";
}

export default function App() {
  const webCryptoReady = Boolean(globalThis.isSecureContext && globalThis.crypto?.subtle);
  const [phase, setPhase] = useState<AppPhase>("loading");
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [backup, setBackup] = useState<KeyBackupFile | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [pairingMode, setPairingMode] = useState<PairingMode>("server");
  const [encryptionProfile, setEncryptionProfile] = useState<EncryptionProfileId>(DEFAULT_ENCRYPTION_PROFILE);
  const [manualOffer, setManualOffer] = useState("");
  const [manualAnswer, setManualAnswer] = useState("");
  const [manualInput, setManualInput] = useState("");
  const [status, setStatus] = useState("Not connected");
  const [role, setRole] = useState<PeerRole | null>(null);
  const [peerFingerprint, setPeerFingerprint] = useState("");
  const [verified, setVerified] = useState(false);
  const [turnUrl, setTurnUrl] = useState("");
  const [turnUsername, setTurnUsername] = useState("");
  const [turnCredential, setTurnCredential] = useState("");
  const [messageText, setMessageText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [incomingFiles, setIncomingFiles] = useState<IncomingOfferView[]>([]);
  const [outgoingFiles, setOutgoingFiles] = useState<OutgoingFileView[]>([]);
  const [callState, setCallState] = useState<CallState>("idle");
  const [callStatus, setCallStatus] = useState("Calls are available after peer verification.");
  const [localMuted, setLocalMuted] = useState(false);
  const [remoteMuted, setRemoteMuted] = useState(false);
  const [remoteAudioStream, setRemoteAudioStream] = useState<MediaStream | null>(null);
  const [remoteAudioBlocked, setRemoteAudioBlocked] = useState(false);

  const signalingRef = useRef<SignalingClient | null>(null);
  const peerRef = useRef<SecurePeerConnection | null>(null);
  const roleRef = useRef<PeerRole | null>(null);
  const identityRef = useRef<Identity | null>(null);
  const verifiedRef = useRef(false);
  const callStateRef = useRef<CallState>("idle");
  const localMutedRef = useRef(false);
  const callTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const pendingOpenActionRef = useRef<(() => void) | null>(null);
  const pendingOutgoingFilesRef = useRef(new Map<string, { offer: FileOfferPayload; bytes: Uint8Array }>());
  const incomingTransfersRef = useRef(new Map<string, IncomingFileState>());

  const canChat = Boolean(identity && peerFingerprint && verified && peerRef.current);
  const canStartCall = canChat && callState === "idle";
  const formattedOwnFingerprint = useMemo(
    () => (identity ? formatFingerprint(identity.fingerprint) : ""),
    [identity]
  );
  const formattedPeerFingerprint = useMemo(
    () => (peerFingerprint ? formatFingerprint(peerFingerprint) : ""),
    [peerFingerprint]
  );
  const trimmedManualInput = manualInput.trim();
  const expectsManualAnswer = role === "host" && Boolean(manualOffer);
  const canAcceptManualOffer = trimmedManualInput.length > 0 && role === null;
  const canAcceptManualAnswer = trimmedManualInput.length > 0 && expectsManualAnswer;
  const encryptionProfileLocked = role !== null || Boolean(roomCode || peerFingerprint || manualOffer || manualAnswer);
  const selectedEncryptionProfile = ENCRYPTION_PROFILES[encryptionProfile];

  useEffect(() => {
    void loadStoredIdentity()
      .then((stored) => {
        if (stored) {
          setIdentity(stored);
          identityRef.current = stored;
          setPhase("ready");
        } else {
          setPhase("identity");
        }
      })
      .catch((error) => {
        setStatus(toError(error).message);
        setPhase("identity");
      });
  }, []);

  useEffect(() => {
    verifiedRef.current = verified;
    if (!verified) {
      setCallStatus("Calls are available after peer verification.");
    }
  }, [verified]);

  useEffect(() => {
    const audio = remoteAudioRef.current;
    if (!audio) {
      return;
    }

    audio.srcObject = remoteAudioStream;
    setRemoteAudioBlocked(false);

    if (callState !== "active" || !remoteAudioStream) {
      audio.pause();
      return;
    }

    const playAttempt = audio.play();
    if (playAttempt) {
      void playAttempt.catch(() => {
        setRemoteAudioBlocked(true);
        setCallStatus("Browser blocked remote audio playback. Press play to hear the call.");
      });
    }
  }, [callState, remoteAudioStream]);

  useEffect(() => {
    return () => {
      clearCallTimeout();
      signalingRef.current?.close();
      peerRef.current?.close();
    };
  }, []);

  function setCallStateValue(nextState: CallState): void {
    callStateRef.current = nextState;
    setCallState(nextState);
  }

  function setLocalMutedValue(muted: boolean): void {
    localMutedRef.current = muted;
    peerRef.current?.setMicrophoneMuted(muted);
    setLocalMuted(muted);
  }

  function clearCallTimeout(): void {
    if (callTimeoutRef.current) {
      clearTimeout(callTimeoutRef.current);
      callTimeoutRef.current = null;
    }
  }

  function startCallTimeout(): void {
    clearCallTimeout();
    callTimeoutRef.current = setTimeout(() => {
      if (callStateRef.current === "outgoing") {
        void sendCallControl({ kind: "call_end", payload: { reason: "timeout" } }).catch(() => undefined);
        void cleanupCall("Call timed out.");
        return;
      }

      if (callStateRef.current === "incoming") {
        void sendCallControl({ kind: "call_reject", payload: { reason: "timeout" } }).catch(() => undefined);
        void cleanupCall("Incoming call timed out.");
      }
    }, CALL_INVITE_TIMEOUT_MS);
  }

  async function cleanupCall(nextStatus: string): Promise<void> {
    clearCallTimeout();
    await peerRef.current?.stopMicrophone();
    setLocalMutedValue(false);
    setRemoteMuted(false);
    setRemoteAudioBlocked(false);
    setCallStateValue("idle");
    setCallStatus(nextStatus);
  }

  async function sendCallControl(frame: CallControlFrame): Promise<void> {
    if (!peerRef.current || !verifiedRef.current) {
      return;
    }
    await peerRef.current.send(frame);
  }

  async function playRemoteAudio(): Promise<void> {
    try {
      await remoteAudioRef.current?.play();
      setRemoteAudioBlocked(false);
      setCallStatus("Call active.");
    } catch {
      setCallStatus("Browser blocked remote audio playback. Press play to hear the call.");
    }
  }

  async function handleCreateIdentity(): Promise<void> {
    try {
      if (!webCryptoReady) {
        throw new Error("Open this app over HTTPS or localhost so browser WebCrypto is available.");
      }
      setStatus("Creating identity");
      const created = await createIdentity(passphrase);
      await saveIdentity(created.identity);
      setIdentity(created.identity);
      identityRef.current = created.identity;
      setBackup(created.backup);
      setPhase("ready");
      setStatus("Identity created. Download the encrypted backup now.");
    } catch (error) {
      setStatus(toError(error).message);
    }
  }

  async function handleImportBackup(file: File | null): Promise<void> {
    if (!file) {
      return;
    }

    try {
      if (!webCryptoReady) {
        throw new Error("Open this app over HTTPS or localhost so browser WebCrypto is available.");
      }
      setStatus("Importing identity backup");
      const parsed = parseBackup(await file.text());
      const imported = await importIdentityFromBackup(parsed, passphrase);
      await saveIdentity(imported.identity);
      setIdentity(imported.identity);
      identityRef.current = imported.identity;
      setBackup(imported.backup);
      setPhase("ready");
      setStatus("Identity imported. Download a fresh encrypted backup now.");
    } catch (error) {
      setStatus(toError(error).message);
    }
  }

  function downloadBackup(): void {
    if (!backup) {
      return;
    }
    downloadBlob(new Blob([serializeBackup(backup)], { type: "application/json" }), "securechat-key.json");
  }

  async function resetIdentity(): Promise<void> {
    disconnect();
    await clearIdentity();
    setIdentity(null);
    identityRef.current = null;
    setBackup(null);
    setPeerFingerprint("");
    setVerified(false);
    setPhase("identity");
    setStatus("Local identity removed");
  }

  function createRoom(): void {
    if (!identityRef.current) {
      setStatus("Create or import an identity first");
      return;
    }
    const selectedProfile = encryptionProfile;
    setRole("host");
    roleRef.current = "host";
    connectSignaling("host", () =>
      signalingRef.current?.send({ type: "create_room", encryptionProfile: selectedProfile })
    );
  }

  function joinRoom(): void {
    if (!identityRef.current) {
      setStatus("Create or import an identity first");
      return;
    }

    const normalized = joinCode.replace(/\D/g, "");
    if (!/^\d{10}$/.test(normalized)) {
      setStatus("Enter the 10-digit pairing code");
      return;
    }

    setRole("joiner");
    roleRef.current = "joiner";
    const selectedProfile = encryptionProfile;
    connectSignaling("joiner", () =>
      signalingRef.current?.send({ type: "join_room", code: normalized, encryptionProfile: selectedProfile })
    );
  }

  function disconnect(): void {
    clearCallTimeout();
    setCallStateValue("idle");
    setLocalMutedValue(false);
    setRemoteMuted(false);
    setRemoteAudioBlocked(false);
    setCallStatus("Calls are available after peer verification.");
    peerRef.current?.close();
    peerRef.current = null;
    signalingRef.current?.close();
    signalingRef.current = null;
    roleRef.current = null;
    setRole(null);
    setRoomCode("");
    setManualOffer("");
    setManualAnswer("");
    setManualInput("");
    setPeerFingerprint("");
    verifiedRef.current = false;
    setVerified(false);
    setStatus("Disconnected");
  }

  async function createManualOffer(): Promise<void> {
    try {
      if (!identityRef.current) {
        setStatus("Create or import an identity first");
        return;
      }
      disconnect();
      setPairingMode("manual");
      setRole("host");
      roleRef.current = "host";
      await ensurePeer("host", "manual");
      setStatus("Creating manual offer. Gathering connection routes.");
      const offer = await peerRef.current?.createManualOffer();
      if (!offer) {
        throw new Error("Unable to create manual offer");
      }
      setManualOffer(encodeManualPackage(offer));
      setStatus("Manual offer ready. Share it with the peer.");
    } catch (error) {
      setStatus(toError(error).message);
    }
  }

  async function acceptManualOffer(): Promise<void> {
    try {
      if (!identityRef.current) {
        setStatus("Create or import an identity first");
        return;
      }
      const offer = decodeManualPackage(manualInput, "offer", encryptionProfile);
      disconnect();
      setPairingMode("manual");
      setRole("joiner");
      roleRef.current = "joiner";
      await ensurePeer("joiner", "manual");
      setStatus("Creating manual answer. Gathering connection routes.");
      const answer = await peerRef.current?.acceptManualOffer(offer);
      if (!answer) {
        throw new Error("Unable to create manual answer");
      }
      setManualAnswer(encodeManualPackage(answer));
      setStatus("Manual answer ready. Send it back to the host.");
    } catch (error) {
      setStatus(toError(error).message);
    }
  }

  async function acceptManualAnswer(): Promise<void> {
    try {
      if (!peerRef.current || roleRef.current !== "host") {
        throw new Error("Create a manual offer before accepting an answer");
      }
      const answer = decodeManualPackage(manualInput, "answer", encryptionProfile);
      await peerRef.current.acceptManualAnswer(answer);
      setStatus("Manual answer accepted. Waiting for secure channel.");
    } catch (error) {
      setStatus(toError(error).message);
    }
  }

  async function copyText(value: string): Promise<void> {
    await navigator.clipboard.writeText(value);
    setStatus("Copied to clipboard");
  }

  async function sendChatMessage(): Promise<void> {
    const text = messageText.trim();
    if (!text || !canChat || !peerRef.current) {
      return;
    }

    await peerRef.current.send({
      kind: "chat",
      payload: {
        text: text.slice(0, 4000),
        at: Date.now()
      }
    });
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        direction: "sent",
        text,
        at: Date.now()
      }
    ]);
    setMessageText("");
  }

  async function offerFile(file: File | null): Promise<void> {
    if (!file || !canChat || !peerRef.current) {
      return;
    }

    try {
      const outgoing = await createFileOffer(file);
      pendingOutgoingFilesRef.current.set(outgoing.offer.fileId, outgoing);
      setOutgoingFiles((current) => [
        ...current,
        {
          fileId: outgoing.offer.fileId,
          name: outgoing.offer.name,
          sentBytes: 0,
          totalBytes: outgoing.offer.size,
          status: "offered"
        }
      ]);
      await peerRef.current.send({
        kind: "file_offer",
        payload: outgoing.offer
      });
    } catch (error) {
      setStatus(toError(error).message);
    }
  }

  async function acceptFile(offer: FileOfferPayload): Promise<void> {
    if (!peerRef.current) {
      return;
    }
    incomingTransfersRef.current.set(offer.fileId, {
      offer,
      chunks: [],
      receivedBytes: 0
    });
    setIncomingFiles((current) =>
      current.map((file) =>
        file.offer.fileId === offer.fileId ? { ...file, status: "receiving", receivedBytes: 0 } : file
      )
    );
    await peerRef.current.send({
      kind: "file_accept",
      payload: {
        fileId: offer.fileId
      }
    });
  }

  async function rejectFile(offer: FileOfferPayload): Promise<void> {
    if (!peerRef.current) {
      return;
    }
    setIncomingFiles((current) =>
      current.map((file) => (file.offer.fileId === offer.fileId ? { ...file, status: "rejected" } : file))
    );
    await peerRef.current.send({
      kind: "file_reject",
      payload: {
        fileId: offer.fileId
      }
    });
  }

  async function cancelOfferedFile(fileId: string): Promise<void> {
    pendingOutgoingFilesRef.current.delete(fileId);
    setOutgoingFiles((current) =>
      current.map((file) => (file.fileId === fileId ? { ...file, status: "cancelled" } : file))
    );
    await peerRef.current?.send({
      kind: "file_cancel",
      payload: {
        fileId
      }
    });
  }

  function verifyPeer(): void {
    if (!peerFingerprint) {
      return;
    }
    rememberTrustedPeer(peerFingerprint);
    verifiedRef.current = true;
    setVerified(true);
    addSystemMessage("Peer fingerprint verified. Encrypted chat is enabled.");
  }

  function connectSignaling(nextRole: PeerRole, onOpen: () => void): void {
    disconnect();
    setRole(nextRole);
    roleRef.current = nextRole;
    pendingOpenActionRef.current = onOpen;
    const client = new SignalingClient({
      onOpen: () => {
        setStatus("Signaling connected");
        pendingOpenActionRef.current?.();
        pendingOpenActionRef.current = null;
      },
      onSignal: (signal) => {
        void handleSignal(signal);
      },
      onClose: () => setStatus("Signaling disconnected"),
      onError: (message) => setStatus(message)
    });
    signalingRef.current = client;
    client.connect();
    setStatus("Connecting to signaling server");
  }

  async function handleSignal(signal: ServerSignal): Promise<void> {
    try {
      switch (signal.type) {
        case "room_created":
          setRoomCode(signal.code);
          setStatus(`Pairing code expires at ${new Date(signal.expiresAt).toLocaleTimeString()}`);
          return;
        case "peer_joined":
          setStatus("Peer joined. Starting WebRTC handshake.");
          if (roleRef.current === "host") {
            await ensurePeer("host", "server");
            await peerRef.current?.createOffer();
          }
          return;
        case "offer":
          await ensurePeer("joiner", "server");
          await peerRef.current?.acceptOffer(signal.payload);
          return;
        case "answer":
          await peerRef.current?.acceptAnswer(signal.payload);
          return;
        case "ice_candidate":
          await peerRef.current?.addIceCandidate(signal.payload);
          return;
        case "error":
          setStatus(signal.message);
          return;
      }
    } catch (error) {
      setStatus(toError(error).message);
    }
  }

  async function ensurePeer(peerRole: PeerRole, transport: PairingMode): Promise<void> {
    const currentIdentity = identityRef.current;
    if (!currentIdentity) {
      throw new Error("Identity is required");
    }

    if (transport === "server" && !signalingRef.current) {
      throw new Error("Signaling connection is required");
    }

    if (peerRef.current) {
      return;
    }

    peerRef.current = new SecurePeerConnection(
      peerRole,
      currentIdentity,
      encryptionProfile,
      transport === "server" ? (signal) => signalingRef.current?.send(signal) : null,
      {
        onSecureReady: (fingerprint) => {
          setPeerFingerprint(fingerprint);
          const trusted = isTrustedPeer(fingerprint);
          verifiedRef.current = trusted;
          setVerified(trusted);
          setStatus(trusted ? "Trusted peer connected" : "Secure session ready. Verify peer fingerprint.");
          addSystemMessage(
            trusted
              ? "Known peer fingerprint matched. Encrypted chat is enabled."
              : "Compare the peer fingerprint out of band before sending messages."
          );
        },
        onFrame: (frame) => {
          void handleSecureFrame(frame).catch((error) => {
            setStatus(toError(error).message);
          });
        },
        onRemoteAudio: (stream) => {
          setRemoteAudioStream(stream);
        },
        onStatus: (nextStatus) => setStatus(nextStatus),
        onError: (error) => setStatus(error.message)
      },
      buildIceServers(transport)
    );
  }

  async function startCall(): Promise<void> {
    if (!canChat || callStateRef.current !== "idle") {
      return;
    }

    try {
      setRemoteMuted(false);
      setRemoteAudioBlocked(false);
      setCallStateValue("outgoing");
      setCallStatus("Calling peer...");
      await sendCallControl({ kind: "call_invite", payload: { media: "audio" } });
      startCallTimeout();
    } catch {
      await cleanupCall("Unable to start the call.");
    }
  }

  async function acceptCall(): Promise<void> {
    if (!canChat || callStateRef.current !== "incoming" || !peerRef.current) {
      return;
    }

    clearCallTimeout();
    setCallStateValue("connecting");
    setCallStatus("Starting microphone...");
    try {
      await peerRef.current.startMicrophone();
      setLocalMutedValue(false);
      await sendCallControl({ kind: "call_accept", payload: { media: "audio" } });
      setCallStateValue("active");
      setCallStatus("Call active.");
      addSystemMessage("Voice call active.");
    } catch {
      await sendCallControl({ kind: "call_reject", payload: { reason: "failed" } }).catch(() => undefined);
      await cleanupCall("Microphone permission is required to start the call.");
    }
  }

  async function rejectCall(reason: CallRejectReason = "declined"): Promise<void> {
    if (callStateRef.current !== "incoming") {
      return;
    }

    await sendCallControl({ kind: "call_reject", payload: { reason } }).catch(() => undefined);
    await cleanupCall(reason === "timeout" ? "Incoming call timed out." : "Call rejected.");
  }

  async function endCall(reason: CallEndReason = "ended"): Promise<void> {
    if (callStateRef.current === "idle") {
      return;
    }

    await sendCallControl({ kind: "call_end", payload: { reason } }).catch(() => undefined);
    await cleanupCall(reason === "timeout" ? "Call timed out." : "Call ended.");
    addSystemMessage("Voice call ended.");
  }

  async function toggleMute(): Promise<void> {
    if (callStateRef.current !== "active") {
      return;
    }

    const muted = !localMutedRef.current;
    setLocalMutedValue(muted);
    try {
      await sendCallControl({ kind: "call_mute", payload: { muted } });
      setCallStatus(muted ? "Microphone muted." : "Call active.");
    } catch {
      setCallStatus("Unable to update mute state.");
    }
  }

  async function handleCallControlFrame(frame: CallControlFrame): Promise<void> {
    switch (frame.kind) {
      case "call_invite":
        if (callStateRef.current !== "idle") {
          await sendCallControl({ kind: "call_reject", payload: { reason: "busy" } }).catch(() => undefined);
          return;
        }
        setRemoteMuted(false);
        setRemoteAudioBlocked(false);
        setCallStateValue("incoming");
        setCallStatus("Incoming audio call.");
        startCallTimeout();
        addSystemMessage("Incoming voice call.");
        return;
      case "call_accept":
        if (callStateRef.current !== "outgoing" || !peerRef.current) {
          await sendCallControl({ kind: "call_end", payload: { reason: "failed" } }).catch(() => undefined);
          return;
        }
        clearCallTimeout();
        setCallStateValue("connecting");
        setCallStatus("Starting microphone...");
        try {
          await peerRef.current.startMicrophone();
          setLocalMutedValue(false);
          setCallStateValue("active");
          setCallStatus("Call active.");
          addSystemMessage("Voice call active.");
        } catch {
          await sendCallControl({ kind: "call_end", payload: { reason: "failed" } }).catch(() => undefined);
          await cleanupCall("Microphone permission is required to start the call.");
        }
        return;
      case "call_reject":
        if (callStateRef.current === "outgoing" || callStateRef.current === "incoming" || callStateRef.current === "connecting") {
          await cleanupCall(frame.payload.reason === "busy" ? "Peer is busy." : "Call rejected.");
        }
        return;
      case "call_end":
        if (callStateRef.current !== "idle") {
          await cleanupCall(frame.payload.reason === "timeout" ? "Call timed out." : "Call ended by peer.");
          addSystemMessage("Voice call ended.");
        }
        return;
      case "call_mute":
        if (callStateRef.current === "active" || callStateRef.current === "connecting") {
          setRemoteMuted(frame.payload.muted);
          setCallStatus(frame.payload.muted ? "Peer muted microphone." : "Call active.");
        }
        return;
    }
  }

  async function handleSecureFrame(frame: { kind: string; payload: unknown }): Promise<void> {
    if (!verifiedRef.current) {
      setStatus("Received encrypted data before peer verification");
      return;
    }

    if (isCallFrameKind(frame.kind)) {
      let callFrame: CallControlFrame;
      try {
        callFrame = validateCallControlFrame(frame.kind, frame.payload);
      } catch (error) {
        if (frame.kind === "call_invite") {
          await sendCallControl({ kind: "call_reject", payload: { reason: "failed" } }).catch(() => undefined);
        }
        throw error;
      }
      await handleCallControlFrame(callFrame);
      return;
    }

    switch (frame.kind) {
      case "chat": {
        const payload = frame.payload as { text?: unknown; at?: unknown };
        const text = typeof payload.text === "string" ? payload.text.slice(0, 4000) : "";
        if (text) {
          setMessages((current) => [
            ...current,
            {
              id: crypto.randomUUID(),
              direction: "received",
              text,
              at: typeof payload.at === "number" ? payload.at : Date.now()
            }
          ]);
        }
        return;
      }
      case "file_offer": {
        const offer = validateFileOffer(frame.payload);
        setIncomingFiles((current) => [
          ...current,
          {
            offer,
            status: "pending",
            receivedBytes: 0
          }
        ]);
        addSystemMessage(`Incoming file offer: ${offer.name}`);
        return;
      }
      case "file_accept": {
        const fileId = readFileId(frame.payload);
        const outgoing = pendingOutgoingFilesRef.current.get(fileId);
        if (!outgoing || !peerRef.current) {
          return;
        }
        setOutgoingFiles((current) =>
          current.map((file) => (file.fileId === fileId ? { ...file, status: "sending" } : file))
        );
        await sendFileChunks(outgoing.offer, outgoing.bytes, (plain) => peerRef.current!.send(plain), (progress) => {
          setOutgoingFiles((current) =>
            current.map((file) =>
              file.fileId === progress.fileId
                ? { ...file, sentBytes: progress.sentBytes, totalBytes: progress.totalBytes }
                : file
            )
          );
        });
        setOutgoingFiles((current) =>
          current.map((file) => (file.fileId === fileId ? { ...file, status: "complete" } : file))
        );
        pendingOutgoingFilesRef.current.delete(fileId);
        return;
      }
      case "file_reject": {
        const fileId = readFileId(frame.payload);
        setOutgoingFiles((current) =>
          current.map((file) => (file.fileId === fileId ? { ...file, status: "rejected" } : file))
        );
        pendingOutgoingFilesRef.current.delete(fileId);
        return;
      }
      case "file_chunk": {
        const chunk = validateFileChunk(frame.payload);
        const current = incomingTransfersRef.current.get(chunk.fileId);
        if (!current) {
          return;
        }
        const next = appendIncomingChunk(current, chunk);
        incomingTransfersRef.current.set(chunk.fileId, next);
        setIncomingFiles((files) =>
          files.map((file) =>
            file.offer.fileId === chunk.fileId
              ? { ...file, status: "receiving", receivedBytes: next.receivedBytes }
              : file
          )
        );
        return;
      }
      case "file_complete": {
        const fileId = readFileId(frame.payload);
        const current = incomingTransfersRef.current.get(fileId);
        if (!current) {
          return;
        }
        const blob = await completeIncomingFile(current);
        const downloadUrl = URL.createObjectURL(blob);
        incomingTransfersRef.current.delete(fileId);
        setIncomingFiles((files) =>
          files.map((file) =>
            file.offer.fileId === fileId
              ? { ...file, status: "complete", receivedBytes: file.offer.size, downloadUrl }
              : file
          )
        );
        return;
      }
      case "file_cancel": {
        const fileId = readFileId(frame.payload);
        incomingTransfersRef.current.delete(fileId);
        setIncomingFiles((files) => files.filter((file) => file.offer.fileId !== fileId));
        return;
      }
      default:
        return;
    }
  }

  function buildIceServers(transport: PairingMode): IceServerConfig[] {
    if (turnUrl.trim()) {
      return [
        {
          urls: turnUrl.trim(),
          username: turnUsername.trim() || undefined,
          credential: turnCredential || undefined
        }
      ];
    }

    return transport === "manual" ? [{ urls: "stun:stun.l.google.com:19302" }] : [];
  }

  function addSystemMessage(text: string): void {
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        direction: "system",
        text,
        at: Date.now()
      }
    ]);
  }

  if (phase === "loading") {
    return (
      <main className="auth-shell">
        <section className="identity-pane">
          <p>Loading identity store...</p>
        </section>
      </main>
    );
  }

  if (phase === "identity") {
    return (
      <main className="auth-shell">
        <section className="identity-pane">
          <div className="brand-row">
            <Lock size={28} />
            <div>
              <h1>Secure Chat</h1>
              <p>Private peer-to-peer chat with encrypted key backup.</p>
            </div>
          </div>

          <label className="field">
            <span>Backup passphrase</span>
            <input
              data-testid="backup-passphrase"
              type="password"
              minLength={12}
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder="At least 12 characters"
            />
          </label>

          <div className="action-row">
            <button
              type="button"
              data-testid="create-identity"
              onClick={() => void handleCreateIdentity()}
              disabled={passphrase.length < 12 || !webCryptoReady}
            >
              <KeyRound size={18} />
              Create Identity
            </button>
            <label className="file-button">
              <Upload size={18} />
              Import Backup
              <input
                data-testid="import-backup-input"
                type="file"
                accept="application/json,.json"
                disabled={!webCryptoReady}
                onChange={(event) => void handleImportBackup(event.target.files?.item(0) ?? null)}
              />
            </label>
          </div>
          {!webCryptoReady ? (
            <p className="warning-line">
              Browser encryption is unavailable on this origin. Use HTTPS for LAN access, or use localhost on this
              machine.
            </p>
          ) : null}
          <p className="status-line" data-testid="status">
            {status}
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row compact">
          <Lock size={24} />
          <div>
            <h1>Secure Chat</h1>
            <p>Peer-to-peer encrypted session</p>
          </div>
        </div>

        <section className="panel">
          <h2>Identity</h2>
          <p className="fingerprint" data-testid="own-fingerprint">
            {formattedOwnFingerprint}
          </p>
          <div className="action-row vertical">
            <button type="button" data-testid="download-backup" onClick={downloadBackup} disabled={!backup}>
              <Download size={18} />
              Download Backup
            </button>
            <button type="button" className="secondary" onClick={() => void resetIdentity()}>
              <X size={18} />
              Reset Local Identity
            </button>
          </div>
        </section>

        <section className="panel">
          <h2>Pairing</h2>
          <div className="profile-control">
            <span>Encryption</span>
            <div className="segmented-control" aria-label="Encryption profile">
              <button
                type="button"
                data-testid="encryption-standard"
                className={encryptionProfile === "standard" ? "active" : "secondary"}
                onClick={() => setEncryptionProfile("standard")}
                disabled={encryptionProfileLocked}
              >
                Standard
              </button>
              <button
                type="button"
                data-testid="encryption-high-assurance"
                className={encryptionProfile === "high_assurance" ? "active" : "secondary"}
                onClick={() => setEncryptionProfile("high_assurance")}
                disabled={encryptionProfileLocked}
              >
                High Assurance
              </button>
            </div>
            <p className="profile-note">
              {selectedEncryptionProfile.layerCount === 7 ? "AES-GCM-256 x 7" : "AES-GCM-256"}
            </p>
          </div>
          <div className="segmented-control" aria-label="Pairing mode">
            <button
              type="button"
              className={pairingMode === "server" ? "active" : "secondary"}
              onClick={() => setPairingMode("server")}
            >
              Short code
            </button>
            <button
              type="button"
              className={pairingMode === "manual" ? "active" : "secondary"}
              onClick={() => setPairingMode("manual")}
            >
              Manual
            </button>
          </div>
          {pairingMode === "server" ? (
          <div className="action-row vertical">
            <button type="button" data-testid="create-room" onClick={createRoom}>
              <Link2 size={18} />
              Create Pairing Code
            </button>
            <label className="field">
              <span>Join code</span>
              <input
                data-testid="join-code-input"
                inputMode="numeric"
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value.replace(/\D/g, "").slice(0, 10))}
                placeholder="10 digits"
              />
            </label>
            <button type="button" data-testid="join-room" onClick={joinRoom} disabled={joinCode.length !== 10}>
              <Link2 size={18} />
              Join Peer
            </button>
          </div>
          ) : (
            <div className="manual-pairing">
              <button
                type="button"
                data-testid="create-manual-offer"
                onClick={() => void createManualOffer()}
                disabled={role === "host" && Boolean(manualOffer)}
              >
                <Clipboard size={18} />
                Create Offer
              </button>
              {manualOffer ? (
                <label className="field">
                  <span>Your offer</span>
                  <textarea data-testid="manual-offer-output" readOnly value={manualOffer} />
                </label>
              ) : null}
              {manualOffer ? (
                <button type="button" className="secondary" onClick={() => void copyText(manualOffer)}>
                  <Copy size={18} />
                  Copy Offer
                </button>
              ) : null}
              {manualAnswer ? (
                <label className="field">
                  <span>Your answer</span>
                  <textarea data-testid="manual-answer-output" readOnly value={manualAnswer} />
                </label>
              ) : null}
              {manualAnswer ? (
                <button type="button" className="secondary" onClick={() => void copyText(manualAnswer)}>
                  <Copy size={18} />
                  Copy Answer
                </button>
              ) : null}
              <label className="field">
                <span>{expectsManualAnswer ? "Paste peer answer" : "Paste peer offer"}</span>
                <textarea
                  data-testid="manual-input"
                  value={manualInput}
                  onChange={(event) => setManualInput(event.target.value)}
                  placeholder={
                    expectsManualAnswer
                      ? "Paste the answer JSON from the joiner"
                      : "Paste the offer JSON from the host"
                  }
                />
              </label>
              <div className="action-row">
                {role === null ? (
                  <button
                    type="button"
                    data-testid="accept-manual-offer"
                    onClick={() => void acceptManualOffer()}
                    disabled={!canAcceptManualOffer}
                  >
                    Accept Offer
                  </button>
                ) : null}
                {expectsManualAnswer ? (
                  <button
                    type="button"
                    data-testid="accept-manual-answer"
                    onClick={() => void acceptManualAnswer()}
                    disabled={!canAcceptManualAnswer}
                  >
                    Accept Answer
                  </button>
                ) : null}
              </div>
              <p className="manual-note">
                Manual mode does not contact the short-code signaling server. It uses Google STUN only to help the
                browsers find a direct route.
              </p>
            </div>
          )}
          {roomCode ? (
            <p className="pair-code" data-testid="room-code">
              {roomCode}
            </p>
          ) : null}
        </section>

        <section className="panel">
          <h2>TURN</h2>
          <label className="field">
            <span>Server URL</span>
            <input value={turnUrl} onChange={(event) => setTurnUrl(event.target.value)} placeholder="turns:turn.example.com:5349" />
          </label>
          <label className="field">
            <span>Username</span>
            <input value={turnUsername} onChange={(event) => setTurnUsername(event.target.value)} />
          </label>
          <label className="field">
            <span>Credential</span>
            <input type="password" value={turnCredential} onChange={(event) => setTurnCredential(event.target.value)} />
          </label>
        </section>
      </aside>

      <section className="chat-surface">
        <header className="chat-header">
          <div>
            <h2>{role ? `${role === "host" ? "Host" : "Joiner"} session` : "No active session"}</h2>
            <p data-testid="connection-status">{status}</p>
          </div>
          <button type="button" className="secondary" onClick={disconnect} disabled={!role}>
            <X size={18} />
            Disconnect
          </button>
        </header>

        {peerFingerprint ? (
          <section className="verify-band">
            <ShieldCheck size={22} />
            <div>
              <strong>{verified ? "Peer verified" : "Verify peer fingerprint"}</strong>
              <p data-testid="peer-fingerprint">{formattedPeerFingerprint}</p>
            </div>
            <button type="button" data-testid="verify-peer" onClick={verifyPeer} disabled={verified}>
              <ShieldCheck size={18} />
              Verified
            </button>
          </section>
        ) : null}

        <section className="call-band">
          <PhoneCall size={22} />
          <div className="call-meta">
            <strong>Voice call</strong>
            <p data-testid="call-status">{verified ? callStatus : "Verify peer fingerprint before starting a call."}</p>
            {remoteMuted ? <span data-testid="remote-muted">Peer muted</span> : null}
          </div>
          <div className="call-actions">
            {callState === "idle" ? (
              <button type="button" data-testid="start-call" onClick={() => void startCall()} disabled={!canStartCall}>
                <Phone size={18} />
                Start Call
              </button>
            ) : null}
            {callState === "incoming" ? (
              <>
                <button type="button" data-testid="accept-call" onClick={() => void acceptCall()} disabled={!canChat}>
                  <Phone size={18} />
                  Accept
                </button>
                <button
                  type="button"
                  data-testid="reject-call"
                  className="secondary"
                  onClick={() => void rejectCall()}
                  disabled={!canChat}
                >
                  <PhoneOff size={18} />
                  Reject
                </button>
              </>
            ) : null}
            {callState === "active" ? (
              <button type="button" data-testid="mute-call" className="secondary" onClick={() => void toggleMute()}>
                {localMuted ? <Mic size={18} /> : <MicOff size={18} />}
                {localMuted ? "Unmute" : "Mute"}
              </button>
            ) : null}
            {callState === "outgoing" || callState === "connecting" || callState === "active" ? (
              <button type="button" data-testid="end-call" className="secondary" onClick={() => void endCall()}>
                <PhoneOff size={18} />
                End
              </button>
            ) : null}
            {remoteAudioBlocked ? (
              <button
                type="button"
                data-testid="play-remote-audio"
                className="secondary"
                onClick={() => void playRemoteAudio()}
              >
                <Play size={18} />
                Play
              </button>
            ) : null}
          </div>
          <audio
            ref={remoteAudioRef}
            data-testid="remote-audio"
            className="remote-audio"
            autoPlay
            playsInline
            controls={remoteAudioBlocked}
          />
        </section>

        <section className="message-log" aria-live="polite">
          {messages.map((message) => (
            <div key={message.id} className={`message ${message.direction}`} data-testid={`message-${message.direction}`}>
              <span>{message.text}</span>
              <time>{new Date(message.at).toLocaleTimeString()}</time>
            </div>
          ))}
          {incomingFiles.map((file) => (
            <div key={file.offer.fileId} className="transfer-row incoming" data-testid="incoming-file">
              <div className="file-meta">
                <strong>{file.offer.name}</strong>
                <span>
                  {formatBytes(file.receivedBytes)} / {formatBytes(file.offer.size)} · {file.status}
                </span>
              </div>
              {file.status === "pending" ? (
                <div className="file-actions">
                  <button type="button" data-testid="accept-file" onClick={() => void acceptFile(file.offer)}>
                    Accept
                  </button>
                  <button
                    type="button"
                    data-testid="reject-file"
                    className="secondary"
                    onClick={() => void rejectFile(file.offer)}
                  >
                    Reject
                  </button>
                </div>
              ) : null}
              {file.status === "complete" && file.downloadUrl ? (
                <div className="file-actions">
                  <a className="download-link" data-testid="download-file" href={file.downloadUrl} download={file.offer.name}>
                    <Download size={16} />
                    Download
                  </a>
                </div>
              ) : null}
            </div>
          ))}
          {outgoingFiles.map((file) => (
            <div key={file.fileId} className="transfer-row outgoing" data-testid="outgoing-file">
              <div className="file-meta">
                <strong>{file.name}</strong>
                <span>
                  {formatBytes(file.sentBytes)} / {formatBytes(file.totalBytes)} · {file.status}
                </span>
              </div>
              {file.status === "offered" ? (
                <div className="file-actions">
                  <button
                    type="button"
                    data-testid="cancel-file"
                    className="secondary"
                    onClick={() => void cancelOfferedFile(file.fileId)}
                  >
                    Cancel
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </section>

        <footer className="composer">
          <label className="file-button icon-only" aria-label="Send file">
            <FileUp size={20} />
            <input
              data-testid="file-input"
              type="file"
              disabled={!canChat}
              onChange={(event) => void offerFile(event.target.files?.item(0) ?? null)}
            />
          </label>
          <input
            data-testid="message-input"
            value={messageText}
            onChange={(event) => setMessageText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void sendChatMessage();
              }
            }}
            placeholder={verified ? "Type an encrypted message" : "Verify peer fingerprint first"}
            disabled={!canChat}
          />
          <button
            type="button"
            data-testid="send-message"
            onClick={() => void sendChatMessage()}
            disabled={!canChat || !messageText.trim()}
          >
            <Send size={18} />
            Send
          </button>
        </footer>

        <p className="fine-print">File transfers are limited to {formatBytes(MAX_FILE_SIZE_BYTES)} and start only after the receiver accepts.</p>
      </section>
    </main>
  );
}

function validateFileOffer(value: unknown): FileOfferPayload {
  const offer = value as FileOfferPayload;
  if (
    typeof offer?.fileId !== "string" ||
    typeof offer.name !== "string" ||
    typeof offer.size !== "number" ||
    offer.size < 0 ||
    offer.size > MAX_FILE_SIZE_BYTES ||
    typeof offer.mimeType !== "string" ||
    typeof offer.chunkSize !== "number" ||
    typeof offer.sha256 !== "string"
  ) {
    throw new Error("Invalid file offer");
  }
  return {
    ...offer,
    name: sanitizeFileName(offer.name)
  };
}

function encodeManualPackage(value: ManualSessionPackage): string {
  return JSON.stringify(value);
}

function decodeManualPackage(
  value: string,
  expectedType: ManualSessionPackage["type"],
  expectedProfile: EncryptionProfileId
): ManualSessionPackage {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Paste a manual ${expectedType} package first`);
  }

  let parsed: Partial<ManualSessionPackage>;
  try {
    parsed = JSON.parse(trimmed) as Partial<ManualSessionPackage>;
  } catch {
    throw new Error("Paste a complete Secure Chat manual pairing package");
  }

  const description = parsed.description as RTCSessionDescriptionInit | undefined;
  if (
    parsed?.version !== 2 ||
    (parsed.type !== "offer" && parsed.type !== "answer") ||
    parsed.type !== expectedType ||
    parsed.encryptionProfile !== expectedProfile ||
    !description ||
    description.type !== expectedType ||
    typeof description.sdp !== "string" ||
    !Array.isArray(parsed.iceCandidates)
  ) {
    throw new Error(`Paste a valid Secure Chat ${expectedType} package`);
  }
  return parsed as ManualSessionPackage;
}

function validateFileChunk(value: unknown): FileChunkPayload {
  const chunk = value as FileChunkPayload;
  if (
    typeof chunk?.fileId !== "string" ||
    typeof chunk.index !== "number" ||
    typeof chunk.total !== "number" ||
    typeof chunk.data !== "string"
  ) {
    throw new Error("Invalid file chunk");
  }
  return chunk;
}

function readFileId(value: unknown): string {
  const payload = value as { fileId?: unknown };
  if (typeof payload?.fileId !== "string") {
    throw new Error("Invalid file control frame");
  }
  return payload.fileId;
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
