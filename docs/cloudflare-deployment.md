# Cloudflare Wrangler Deployment

Secure Chat can run on Cloudflare as one Worker:

- Cloudflare Workers Static Assets serves the Vite `dist/` build.
- `/health` is handled by the Worker.
- `/signal` is handled by a Durable Object WebSocket signaling lobby.

Chat messages and files still use WebRTC DataChannels between browsers. Cloudflare only relays pairing metadata: room creation, join, SDP offer/answer, and ICE candidates.

## Files Added For Wrangler

- `wrangler.toml`: Cloudflare Worker, assets, and Durable Object configuration.
- `worker/index.ts`: Worker fetch handler plus `SignalingLobby` Durable Object.
- `worker/tsconfig.json`: TypeScript checking for Cloudflare Worker globals.
- `package.json`: Wrangler build, preview, and deploy scripts.

The existing Node `server/` remains useful for local Vite development and current Node-based tests.

## First-Time Setup

Install dependencies:

```bash
npm install
```

Log in to Cloudflare:

```bash
npx wrangler login
```

Optional: if your account has more than one Cloudflare account, either set `CLOUDFLARE_ACCOUNT_ID` or add `account_id = "..."` to `wrangler.toml`.

## Local Cloudflare Preview

Build the Vite app and run the Worker locally:

```bash
npm run preview:cloudflare
```

Open the local Wrangler URL. In this mode:

- Static app requests come from `dist/`.
- WebSocket signaling uses `ws://localhost:<port>/signal`.
- Health check is available at `/health`.

If `wrangler dev` fails with a `GLIBC_2.32`/`GLIBC_2.35` error, the local OS is too old for the `workerd` binary bundled with the installed Wrangler version. Use a newer Linux runtime, run Wrangler from a container with a newer glibc, or use Cloudflare remote development after login:

```bash
npx wrangler dev --remote
```

The deploy dry run does not require local `workerd`:

```bash
npx wrangler deploy --dry-run
```

## Deploy

Deploy to the configured Worker:

```bash
npm run deploy:cloudflare
```

This runs:

```bash
npm run build:client
npm run build:worker
wrangler deploy
```

The first deploy also applies the Durable Object migration declared in `wrangler.toml`:

```toml
[[migrations]]
tag = "v1"
new_sqlite_classes = ["SignalingLobby"]
```

By default, `wrangler.toml` has `workers_dev = true`, so Cloudflare will deploy to the Worker subdomain. For production, attach a custom domain in Cloudflare or add route configuration to `wrangler.toml`.

Example route configuration:

```toml
workers_dev = false

[route]
pattern = "chat.example.com/*"
zone_name = "example.com"
```

Use your real zone and hostname.

## Verify After Deploy

Check the app:

```bash
curl https://<your-worker-host>/health
```

Expected response:

```json
{"ok":true}
```

Then open two browser windows at the deployed URL and test:

1. Create a pairing code in the first browser.
2. Join that code in the second browser.
3. Verify fingerprints.
4. Send a short message.

## Operational Notes

- Do not deploy the old `server/index.ts` to Cloudflare Workers. It depends on Node `http`, Express, and `ws`.
- The Worker uses same-origin `/signal`, so the existing browser signaling client does not need a production URL setting.
- The Durable Object keeps room state in memory and uses normal WebSocket handling. Moving to Durable Object WebSocket hibernation can reduce idle cost later, but requires persisted socket attachments and state rebuild logic.
- Avoid logging SDP, ICE candidates, fingerprints, chat text, file names, or file metadata in Worker logs.
- If users require stronger IP privacy, configure and require trusted TURN relay-only WebRTC. Cloudflare signaling does not hide peer-to-peer WebRTC network metadata by itself.
