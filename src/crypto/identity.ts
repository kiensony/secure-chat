import {
  arrayBufferToBytes,
  base64ToBytes,
  bytesToArrayBuffer,
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  randomBytes,
  utf8ToBytes
} from "./encoding";

const RSA_ALGORITHM: RsaHashedKeyGenParams = {
  name: "RSA-PSS",
  modulusLength: 4096,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-384"
};

const SIGNING_ALGORITHM: RsaPssParams = {
  name: "RSA-PSS",
  saltLength: 48
};

const BACKUP_VERSION = 1;
const BACKUP_ITERATIONS = 600_000;

export interface Identity {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JsonWebKey;
  fingerprint: string;
  createdAt: number;
}

export interface KeyBackupFile {
  version: 1;
  createdAt: number;
  publicJwk: JsonWebKey;
  fingerprint: string;
  kdf: {
    name: "PBKDF2";
    hash: "SHA-256";
    iterations: number;
    salt: string;
  };
  cipher: {
    name: "AES-GCM";
    iv: string;
    ciphertext: string;
  };
}

export async function createIdentity(passphrase: string): Promise<{ identity: Identity; backup: KeyBackupFile }> {
  const generated = await crypto.subtle.generateKey(RSA_ALGORITHM, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", generated.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", generated.privateKey);
  const privateKey = await importPrivateSigningKey(privateJwk);
  const publicKey = await importPublicSigningKey(publicJwk);
  const fingerprint = await fingerprintPublicKey(publicKey);
  const createdAt = Date.now();
  const backup = await encryptPrivateKeyBackup(privateJwk, publicJwk, fingerprint, passphrase, createdAt);

  return {
    identity: {
      privateKey,
      publicKey,
      publicJwk,
      fingerprint,
      createdAt
    },
    backup
  };
}

export async function importIdentityFromBackup(
  backup: KeyBackupFile,
  passphrase: string
): Promise<{ identity: Identity; backup: KeyBackupFile }> {
  validateBackupFile(backup);
  const privateJwk = await decryptPrivateKeyBackup(backup, passphrase);
  const privateKey = await importPrivateSigningKey(privateJwk);
  const publicKey = await importPublicSigningKey(backup.publicJwk);
  const fingerprint = await fingerprintPublicKey(publicKey);

  if (fingerprint !== backup.fingerprint) {
    throw new Error("Backup fingerprint does not match the public key");
  }

  return {
    identity: {
      privateKey,
      publicKey,
      publicJwk: backup.publicJwk,
      fingerprint,
      createdAt: backup.createdAt
    },
    backup
  };
}

export async function importPublicSigningKey(publicJwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    publicJwk,
    {
      name: "RSA-PSS",
      hash: "SHA-384"
    },
    true,
    ["verify"]
  );
}

export async function importPrivateSigningKey(privateJwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    privateJwk,
    {
      name: "RSA-PSS",
      hash: "SHA-384"
    },
    false,
    ["sign"]
  );
}

export async function fingerprintPublicKey(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const digest = await crypto.subtle.digest("SHA-256", spki);
  return bytesToHex(arrayBufferToBytes(digest));
}

export async function signBytes(privateKey: CryptoKey, payload: Uint8Array): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign(SIGNING_ALGORITHM, privateKey, bytesToArrayBuffer(payload));
  return arrayBufferToBytes(signature);
}

export async function verifyBytes(publicKey: CryptoKey, payload: Uint8Array, signature: Uint8Array): Promise<boolean> {
  return crypto.subtle.verify(
    SIGNING_ALGORITHM,
    publicKey,
    bytesToArrayBuffer(signature),
    bytesToArrayBuffer(payload)
  );
}

export function serializeBackup(backup: KeyBackupFile): string {
  return JSON.stringify(backup, null, 2);
}

export function parseBackup(value: string): KeyBackupFile {
  const parsed = JSON.parse(value) as unknown;
  validateBackupFile(parsed);
  return parsed;
}

async function encryptPrivateKeyBackup(
  privateJwk: JsonWebKey,
  publicJwk: JsonWebKey,
  fingerprint: string,
  passphrase: string,
  createdAt: number
): Promise<KeyBackupFile> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveBackupKey(passphrase, salt, BACKUP_ITERATIONS);
  const plaintext = utf8ToBytes(JSON.stringify(privateJwk));
  const aad = utf8ToBytes(`${BACKUP_VERSION}:${fingerprint}`);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: bytesToArrayBuffer(iv),
      additionalData: bytesToArrayBuffer(aad)
    },
    key,
    bytesToArrayBuffer(plaintext)
  );

  return {
    version: BACKUP_VERSION,
    createdAt,
    publicJwk,
    fingerprint,
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: BACKUP_ITERATIONS,
      salt: bytesToBase64(salt)
    },
    cipher: {
      name: "AES-GCM",
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(arrayBufferToBytes(ciphertext))
    }
  };
}

async function decryptPrivateKeyBackup(backup: KeyBackupFile, passphrase: string): Promise<JsonWebKey> {
  const salt = base64ToBytes(backup.kdf.salt);
  const iv = base64ToBytes(backup.cipher.iv);
  const ciphertext = base64ToBytes(backup.cipher.ciphertext);
  const key = await deriveBackupKey(passphrase, salt, backup.kdf.iterations);
  const aad = utf8ToBytes(`${backup.version}:${backup.fingerprint}`);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytesToArrayBuffer(iv),
      additionalData: bytesToArrayBuffer(aad)
    },
    key,
    bytesToArrayBuffer(ciphertext)
  );
  return JSON.parse(bytesToUtf8(arrayBufferToBytes(plaintext))) as JsonWebKey;
}

async function deriveBackupKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  if (passphrase.length < 12) {
    throw new Error("Use a backup passphrase with at least 12 characters");
  }

  const keyMaterial = await crypto.subtle.importKey("raw", bytesToArrayBuffer(utf8ToBytes(passphrase)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: bytesToArrayBuffer(salt),
      iterations,
      hash: "SHA-256"
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

function validateBackupFile(value: unknown): asserts value is KeyBackupFile {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid backup file");
  }

  const backup = value as KeyBackupFile;
  if (
    backup.version !== BACKUP_VERSION ||
    typeof backup.createdAt !== "number" ||
    typeof backup.fingerprint !== "string" ||
    !backup.publicJwk ||
    backup.kdf?.name !== "PBKDF2" ||
    backup.kdf.hash !== "SHA-256" ||
    typeof backup.kdf.iterations !== "number" ||
    typeof backup.kdf.salt !== "string" ||
    backup.cipher?.name !== "AES-GCM" ||
    typeof backup.cipher.iv !== "string" ||
    typeof backup.cipher.ciphertext !== "string"
  ) {
    throw new Error("Invalid backup file");
  }
}
