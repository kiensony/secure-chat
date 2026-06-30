const TRUST_STORE_KEY = "secure-chat.trusted-peers.v1";

export interface TrustedPeer {
  fingerprint: string;
  firstVerifiedAt: number;
  lastSeenAt: number;
}

export function loadTrustedPeers(): TrustedPeer[] {
  try {
    const raw = localStorage.getItem(TRUST_STORE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isTrustedPeerRecord);
  } catch {
    return [];
  }
}

export function isTrustedPeer(fingerprint: string): boolean {
  return loadTrustedPeers().some((peer) => peer.fingerprint === fingerprint);
}

export function rememberTrustedPeer(fingerprint: string): TrustedPeer {
  const peers = loadTrustedPeers();
  const existing = peers.find((peer) => peer.fingerprint === fingerprint);
  const now = Date.now();
  const trusted = existing
    ? {
        ...existing,
        lastSeenAt: now
      }
    : {
        fingerprint,
        firstVerifiedAt: now,
        lastSeenAt: now
      };
  const next = [trusted, ...peers.filter((peer) => peer.fingerprint !== fingerprint)].slice(0, 50);
  localStorage.setItem(TRUST_STORE_KEY, JSON.stringify(next));
  return trusted;
}

function isTrustedPeerRecord(value: unknown): value is TrustedPeer {
  const peer = value as TrustedPeer;
  return (
    typeof peer?.fingerprint === "string" &&
    /^[0-9a-f]{64}$/i.test(peer.fingerprint) &&
    typeof peer.firstVerifiedAt === "number" &&
    typeof peer.lastSeenAt === "number"
  );
}
