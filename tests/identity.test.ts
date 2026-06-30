import { describe, expect, it } from "vitest";
import {
  createIdentity,
  importIdentityFromBackup,
  parseBackup,
  serializeBackup,
  signBytes,
  verifyBytes
} from "../src/crypto/identity";
import { utf8ToBytes } from "../src/crypto/encoding";

describe("identity backup", () => {
  it("imports an encrypted backup and preserves the fingerprint", async () => {
    const created = await createIdentity("correct horse battery staple");
    const imported = await importIdentityFromBackup(created.backup, "correct horse battery staple");

    expect(imported.identity.fingerprint).toBe(created.identity.fingerprint);
    await expect(
      verifyBytes(
        imported.identity.publicKey,
        utf8ToBytes("message"),
        await signBytes(imported.identity.privateKey, utf8ToBytes("message"))
      )
    ).resolves.toBe(true);
  }, 30_000);

  it("rejects wrong passphrases and tampered backup metadata", async () => {
    const created = await createIdentity("correct horse battery staple");
    await expect(importIdentityFromBackup(created.backup, "wrong horse battery staple")).rejects.toThrow();

    const tampered = parseBackup(serializeBackup(created.backup));
    tampered.fingerprint = "0".repeat(64);
    await expect(importIdentityFromBackup(tampered, "correct horse battery staple")).rejects.toThrow();
  }, 30_000);

  it("requires a minimum backup passphrase length", async () => {
    await expect(createIdentity("too-short")).rejects.toThrow(/at least 12/);
  });
});
