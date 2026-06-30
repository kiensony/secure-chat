# Secure Chat

Secure Chat is a browser-based peer-to-peer chat application with local identity keys, explicit fingerprint verification, encrypted messaging, and encrypted direct file transfer over WebRTC DataChannels.

The app supports two pairing modes:

- Short-code pairing through a small signaling server.
- Manual offer/answer pairing that avoids the app signaling server and uses copy/paste exchange.

## Current Status

This is a development-stage secure chat prototype. It uses strong browser cryptography and avoids sending chat messages or file bytes through the signaling server, but it has not had an external security audit.

Use it for testing and controlled environments first. Before production use, review the deployment, TLS, STUN/TURN, logging, browser support, and operational security assumptions.

## Features

- Browser-generated RSA-PSS identity keypair.
- Encrypted identity backup and import.
- Peer fingerprint verification before chat is enabled.
- WebRTC peer-to-peer connection.
- End-to-end encrypted DataChannel payloads.
- Short-lived 10-digit room codes for normal pairing.
- Manual offer/answer exchange for users who do not want app-server signaling.
- Encrypted file offer, accept, reject, cancel, transfer, and download flow.
- File integrity verification with SHA-256.
- Local trusted-peer memory after a fingerprint is verified.
- Optional TURN server configuration from the UI.
- HTTPS development mode for LAN testing.

## User Workflow

### 1. Create Or Import Identity

On first load, the browser asks for a backup passphrase.

Choose a passphrase with at least 12 characters, then create an identity. Download the encrypted backup when prompted.

The backup is for your own recovery or for moving your identity to your own device. Do not send it to your chat partner.

### 2. Pair With A Peer

Short-code mode:

1. One browser clicks `Create Pairing Code`.
2. The other browser enters the 10-digit code and clicks `Join Peer`.
3. The app performs WebRTC setup through the signaling server.

Manual mode:

1. Host selects `Manual` and clicks `Create Offer`.
2. Host sends the offer JSON to the joiner through any out-of-band channel.
3. Joiner pastes the offer and clicks `Accept Offer`.
4. Joiner sends the answer JSON back to the host.
5. Host pastes the answer and clicks `Accept Answer`.

Manual mode does not contact the short-code signaling server. It can still use STUN to help browsers discover a route. ICE candidates may reveal network address information to the peer and to the configured STUN service.

### 3. Verify Fingerprints

Do not compare the two `Peer verified` values to each other. Each browser shows the other browser's identity fingerprint.

Correct verification:

- Browser A `Peer fingerprint` must match Browser B `Identity` fingerprint.
- Browser B `Peer fingerprint` must match Browser A `Identity` fingerprint.

Share only the identity fingerprint with your partner. Do not share:

- Private key material.
- Encrypted key backup file.
- Backup passphrase.
- Browser profile or storage.

If the fingerprints do not cross-match, do not click `Verified`. Disconnect and start pairing again.

### 4. Chat And Send Files

After both users verify the peer fingerprint, the message box is enabled.

File transfer flow:

1. Sender selects a file.
2. Receiver sees an incoming file card in the chat flow.
3. Receiver accepts or rejects the file.
4. If accepted, file chunks are sent over the encrypted DataChannel.
5. Receiver downloads the completed file after hash verification passes.

The current file size limit is 100 MB.

## Security Model

### Identity

Each browser identity is an RSA-PSS 4096-bit signing key using SHA-384.

The identity fingerprint is the SHA-256 digest of the exported public key. This fingerprint is what users compare out of band.

The live private key is imported as non-extractable for normal use. During initial identity creation or backup import, the app creates an encrypted backup file for recovery.

### Backup Encryption

Identity backups contain the private key encrypted with:

- PBKDF2-SHA-256.
- 600,000 iterations.
- AES-GCM-256.
- Random salt and IV.
- Additional authenticated data bound to backup version and fingerprint.

The backup passphrase is not stored by the app.

### Session Encryption

For each chat session:

1. Each side creates a fresh ECDH P-384 keypair.
2. Each side signs its session hello with its long-term RSA-PSS identity.
3. The peer validates the signature and verifies the public key fingerprint.
4. The session derives directional AES-GCM-256 keys with HKDF-SHA-384.
5. Encrypted frames include sequence numbers and authenticated metadata.

Replay or out-of-order encrypted frames are rejected.

### Signaling Server Scope

The signaling server is only responsible for:

- Creating short-lived 10-digit room codes.
- Matching one host and one joiner.
- Relaying WebRTC offer, answer, and ICE candidate messages.

The signaling server should not receive:

- Private keys.
- Backup passphrases.
- Chat plaintext.
- File bytes.
- Encrypted chat/file DataChannel payloads.

### Manual Pairing Scope

Manual pairing avoids the app signaling server by having users exchange WebRTC offer and answer packages themselves.

Manual mode is useful when users do not want their pairing setup routed through the app's short-code server. It does not make WebRTC invisible. Depending on network conditions and ICE configuration, local, public, or relay candidate information can still be exposed to the peer and the STUN/TURN infrastructure used.

### File Transfer

Files are sent as encrypted DataChannel frames after peer verification.

The file offer includes:

- Random file ID.
- Sanitized file name.
- File size.
- MIME type.
- Chunk size.
- SHA-256 hash.

The receiver reconstructs the file and verifies the SHA-256 hash before exposing a download link. Potentially active MIME types such as HTML, SVG, JavaScript, and XML are downloaded as `application/octet-stream`.

## Architecture

```text
Browser A                         Signaling Server                  Browser B
---------                         ----------------                  ---------
Identity key                                                        Identity key
Create room  ------------------->  10-digit room
                                  relay offer/answer/ICE  <------  Join room

WebRTC DataChannel established directly or through configured ICE/TURN path

Browser A  <================ encrypted session frames ================> Browser B
```

Main client modules:

- `src/App.tsx`: UI, identity flow, pairing flow, chat, file transfer state.
- `src/crypto/identity.ts`: identity key creation, backup encryption, backup import, signatures, fingerprints.
- `src/crypto/session.ts`: session hello, ECDH, HKDF, AES-GCM envelopes, replay checks.
- `src/rtc/webrtc.ts`: WebRTC peer connection, server/manual offer-answer flow, ICE handling.
- `src/rtc/secureChannel.ts`: secure DataChannel handshake and encrypted frame transport.
- `src/fileTransfer.ts`: file offers, chunking, hash verification, safe downloads.
- `src/signaling/client.ts`: browser WebSocket signaling client.
- `server/signalingServer.ts`: Express and WebSocket signaling server.

## Development

Install dependencies:

```bash
npm install
```

Run local development:

```bash
npm run dev
```

By default:

- Client: `http://localhost:5173` or the next available Vite port.
- Signaling server: `http://localhost:8787`.

The Vite client proxies:

- `/signal` to the signaling server WebSocket endpoint.
- `/health` to the signaling server health endpoint.

## Cloudflare Wrangler Deployment

This repo includes a Cloudflare Worker deployment path that serves the Vite build as Worker static assets and handles `/signal` with a Durable Object WebSocket lobby.

Preview locally with Wrangler:

```bash
npm run preview:cloudflare
```

Deploy:

```bash
npm run deploy:cloudflare
```

Automatic deployment is configured with GitHub Actions on pushes to `main`. Add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as GitHub Actions repository secrets before relying on CI/CD.

See [`docs/cloudflare-deployment.md`](docs/cloudflare-deployment.md) for first-time login, custom domain, and verification steps.

## HTTPS And LAN Testing

Browser WebCrypto and WebRTC features require a secure context for LAN use. `localhost` is treated as secure by browsers, but another device on the network should use HTTPS.

Generate a local development certificate:

```bash
mkdir -p /tmp/secure-chat-cert
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout /tmp/secure-chat-cert/key.pem \
  -out /tmp/secure-chat-cert/cert.pem \
  -days 7 \
  -subj "/CN=secure-chat.local"
```

Run on all interfaces with HTTPS:

```bash
HOST=0.0.0.0 \
DEV_HTTPS_KEY=/tmp/secure-chat-cert/key.pem \
DEV_HTTPS_CERT=/tmp/secure-chat-cert/cert.pem \
npm run dev
```

Open the network URL printed by Vite, for example:

```text
https://192.168.0.102:5174/
```

With a self-signed certificate, each browser will show a certificate warning. Accept it only for trusted development machines.

## TURN And NAT Traversal

The UI has optional TURN fields:

- Server URL, such as `turns:turn.example.com:5349`.
- Username.
- Credential.

If configured, the app passes this TURN server to WebRTC.

Without TURN:

- Short-code mode does not configure a public STUN server unless a TURN server is supplied. It is best suited to same-LAN testing or networks where host candidates are enough.
- Manual mode uses Google's public STUN server by default when no TURN server is supplied.

For production, use an owned STUN/TURN service with TLS where possible. TURN can relay traffic when direct peer-to-peer connectivity fails, but the relay operator can observe metadata such as connection timing and volume.

## Testing

Run individual checks:

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:server
npm run test:e2e
npm run test:security
```

Run the full local gate:

```bash
npm run test:all
```

Current coverage strategy:

- Unit tests cover identity backup/import, session encryption, replay rejection, and file chunk/hash validation.
- Server tests cover room codes, one-time joins, signaling relay behavior, invalid messages, expiry, disconnects, and rate limits.
- Playwright tests run two isolated browser contexts through identity creation, short-code pairing, fingerprint verification, encrypted chat, file accept/reject/cancel/download, and manual offer/answer pairing.
- Security checks look for unsafe HTML/code execution sinks, missing CSP/Helmet basics, sensitive server logging patterns, and chat/file payloads sent over signaling.

The E2E suite starts its own client and signaling server:

- Client: `http://127.0.0.1:5180`.
- Signaling server: `http://127.0.0.1:8788`.

## Production Notes

Before production deployment:

- Serve the client and signaling endpoint over trusted TLS.
- Bind the signaling server intentionally for the deployment environment.
- Configure an owned STUN/TURN service.
- Use secure operational logging that never records private keys, passphrases, SDP payloads, ICE candidates, chat content, or file metadata unless explicitly required and protected.
- Review CSP, reverse proxy headers, WebSocket timeouts, rate limits, and abuse controls.
- Add monitoring for server health and abnormal connection rates.
- Run a security review focused on cryptographic protocol behavior, browser storage, deployment, and network metadata exposure.

For a Cloudflare-specific deployment plan, see [Cloudflare Deployment Strategy](docs/cloudflare-deployment.md).

## Limitations

- No external security audit has been completed.
- No multi-device account sync exists; importing a backup is the way to reuse an identity.
- If a user loses both browser storage and backup, the identity cannot be recovered.
- Manual mode requires users to safely exchange large JSON offer/answer packages.
- WebRTC may expose network metadata to peers and ICE infrastructure.
- File transfer is limited to 100 MB in v1.
- There is no group chat support.

## Glossary

- Identity fingerprint: Public-key fingerprint users compare out of band.
- Peer fingerprint: The remote browser identity shown after secure session setup.
- Signaling: Temporary WebRTC setup messages used to establish a peer connection.
- STUN: Helps discover network addresses for direct WebRTC connectivity.
- TURN: Relays WebRTC traffic when direct connectivity fails.
- DataChannel: WebRTC transport used by this app for encrypted chat and file frames.
