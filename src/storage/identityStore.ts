import type { Identity } from "../crypto/identity";

const DB_NAME = "secure-chat";
const DB_VERSION = 1;
const STORE_NAME = "identity";
const IDENTITY_KEY = "current";

interface StoredIdentity {
  id: "current";
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  fingerprint: string;
  createdAt: number;
}

export async function loadStoredIdentity(): Promise<Identity | null> {
  const db = await openDb();
  const stored = await requestToPromise<StoredIdentity | undefined>(
    db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(IDENTITY_KEY)
  );
  db.close();

  if (!stored) {
    return null;
  }

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    stored.publicJwk,
    {
      name: "RSA-PSS",
      hash: "SHA-384"
    },
    true,
    ["verify"]
  );

  return {
    privateKey: stored.privateKey,
    publicKey,
    publicJwk: stored.publicJwk,
    fingerprint: stored.fingerprint,
    createdAt: stored.createdAt
  };
}

export async function saveIdentity(identity: Identity): Promise<void> {
  const db = await openDb();
  await requestToPromise(
    db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put({
      id: IDENTITY_KEY,
      privateKey: identity.privateKey,
      publicJwk: identity.publicJwk,
      fingerprint: identity.fingerprint,
      createdAt: identity.createdAt
    } satisfies StoredIdentity)
  );
  db.close();
}

export async function clearIdentity(): Promise<void> {
  const db = await openDb();
  await requestToPromise(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(IDENTITY_KEY));
  db.close();
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to open identity store"));
    request.onsuccess = () => resolve(request.result);
  });
}

function requestToPromise<T = unknown>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    request.onsuccess = () => resolve(request.result);
  });
}
