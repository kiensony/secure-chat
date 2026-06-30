import { describe, expect, it } from "vitest";
import { createIdentity } from "../src/crypto/identity";
import {
  ENCRYPTION_PROFILES,
  createLocalHello,
  establishSecureSession,
  type EncryptionProfileId
} from "../src/crypto/session";

describe("secure session", () => {
  it("derives compatible directional keys for each profile and rejects replay", async () => {
    for (const profileId of ["standard", "high_assurance"] as const) {
      const { aliceSession, bobSession } = await createPairedSessions(profileId);

      const envelope = await aliceSession.encrypt({
        kind: "chat",
        payload: {
          text: `hello ${profileId}`
        }
      });

      expect(envelope).toMatchObject({
        version: 2,
        encryptionProfile: profileId,
        layerCount: ENCRYPTION_PROFILES[profileId].layerCount
      });
      expect(envelope.nonces).toHaveLength(ENCRYPTION_PROFILES[profileId].layerCount);

      await expect(bobSession.decrypt(envelope)).resolves.toEqual({
        kind: "chat",
        payload: {
          text: `hello ${profileId}`
        }
      });
      await expect(bobSession.decrypt(envelope)).rejects.toThrow(/Replay/);
    }
  }, 60_000);

  it("rejects tampered handshake signatures and encrypted frames", async () => {
    const alice = await createIdentity("correct horse battery staple");
    const bob = await createIdentity("another correct horse battery staple");
    const aliceLocal = await createLocalHello(alice.identity, "host");
    const bobLocal = await createLocalHello(bob.identity, "joiner");
    const tamperedProfileHello = {
      ...bobLocal.hello,
      encryptionProfile: "high_assurance" as const,
      layerCount: 7
    };
    const tamperedNonceHello = {
      ...bobLocal.hello,
      nonce: "tampered"
    };

    await expect(
      establishSecureSession({
        identity: alice.identity,
        role: "host",
        localEcdh: aliceLocal.ecdh,
        localHello: aliceLocal.hello,
        remoteHello: tamperedNonceHello
      })
    ).rejects.toThrow(/signature/);
    await expect(
      establishSecureSession({
        identity: alice.identity,
        role: "host",
        localEcdh: aliceLocal.ecdh,
        localHello: aliceLocal.hello,
        remoteHello: tamperedProfileHello
      })
    ).rejects.toThrow(/signature/);

    const { aliceSession, bobSession } = await createPairedSessions("high_assurance");
    const envelope = await aliceSession.encrypt({ kind: "chat", payload: { text: "hello" } });

    await expect(bobSession.decrypt({ ...envelope, aad: "{}" })).rejects.toThrow(/AAD/);
    await expect(
      bobSession.decrypt({ ...envelope, nonces: [tamperBase64(envelope.nonces[0]), ...envelope.nonces.slice(1)] })
    ).rejects.toThrow();
    await expect(bobSession.decrypt({ ...envelope, ciphertext: envelope.ciphertext.slice(0, -4) + "AAAA" })).rejects.toThrow();
  }, 60_000);

  it("rejects peers that choose a different encryption profile", async () => {
    const alice = await createIdentity("correct horse battery staple");
    const bob = await createIdentity("another correct horse battery staple");
    const aliceLocal = await createLocalHello(alice.identity, "host", "standard");
    const bobLocal = await createLocalHello(bob.identity, "joiner", "high_assurance");

    await expect(
      establishSecureSession({
        identity: alice.identity,
        role: "host",
        localEcdh: aliceLocal.ecdh,
        localHello: aliceLocal.hello,
        remoteHello: bobLocal.hello
      })
    ).rejects.toThrow(/profile/);
  }, 60_000);
});

async function createPairedSessions(profileId: EncryptionProfileId) {
  const alice = await createIdentity("correct horse battery staple");
  const bob = await createIdentity("another correct horse battery staple");
  const aliceLocal = await createLocalHello(alice.identity, "host", profileId);
  const bobLocal = await createLocalHello(bob.identity, "joiner", profileId);

  const aliceSession = await establishSecureSession({
    identity: alice.identity,
    role: "host",
    localEcdh: aliceLocal.ecdh,
    localHello: aliceLocal.hello,
    remoteHello: bobLocal.hello
  });
  const bobSession = await establishSecureSession({
    identity: bob.identity,
    role: "joiner",
    localEcdh: bobLocal.ecdh,
    localHello: bobLocal.hello,
    remoteHello: aliceLocal.hello
  });

  return { aliceSession, bobSession };
}

function tamperBase64(value: string): string {
  return value.slice(0, -1) + (value.endsWith("A") ? "B" : "A");
}
