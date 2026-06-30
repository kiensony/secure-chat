import { describe, expect, it } from "vitest";
import { createIdentity } from "../src/crypto/identity";
import { createLocalHello, establishSecureSession } from "../src/crypto/session";

describe("secure session", () => {
  it("derives compatible directional keys and rejects replay", async () => {
    const alice = await createIdentity("correct horse battery staple");
    const bob = await createIdentity("another correct horse battery staple");
    const aliceLocal = await createLocalHello(alice.identity, "host");
    const bobLocal = await createLocalHello(bob.identity, "joiner");

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

    const envelope = await aliceSession.encrypt({
      kind: "chat",
      payload: {
        text: "hello"
      }
    });

    await expect(bobSession.decrypt(envelope)).resolves.toEqual({
      kind: "chat",
      payload: {
        text: "hello"
      }
    });
    await expect(bobSession.decrypt(envelope)).rejects.toThrow(/Replay/);
  }, 30_000);

  it("rejects tampered handshake signatures and encrypted frames", async () => {
    const alice = await createIdentity("correct horse battery staple");
    const bob = await createIdentity("another correct horse battery staple");
    const aliceLocal = await createLocalHello(alice.identity, "host");
    const bobLocal = await createLocalHello(bob.identity, "joiner");
    const tamperedHello = {
      ...bobLocal.hello,
      nonce: "tampered"
    };

    await expect(
      establishSecureSession({
        identity: alice.identity,
        role: "host",
        localEcdh: aliceLocal.ecdh,
        localHello: aliceLocal.hello,
        remoteHello: tamperedHello
      })
    ).rejects.toThrow(/signature/);

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
    const envelope = await aliceSession.encrypt({ kind: "chat", payload: { text: "hello" } });

    await expect(bobSession.decrypt({ ...envelope, aad: "{}" })).rejects.toThrow(/AAD/);
    await expect(bobSession.decrypt({ ...envelope, ciphertext: envelope.ciphertext.slice(0, -4) + "AAAA" })).rejects.toThrow();
  }, 30_000);
});
