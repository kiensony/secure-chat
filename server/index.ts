import { createSignalingServer } from "./signalingServer.js";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const host = process.env.HOST ?? "127.0.0.1";
const signalingServer = createSignalingServer();

signalingServer
  .start(port, host)
  .then((actualPort) => {
    console.log(`Signaling server listening on http://${host}:${actualPort}`);
  })
  .catch((error: unknown) => {
    console.error("Failed to start signaling server", error);
    process.exitCode = 1;
  });
