import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const signalingTarget = process.env.SIGNALING_TARGET ?? "http://localhost:8787";
const httpsKey = process.env.DEV_HTTPS_KEY;
const httpsCert = process.env.DEV_HTTPS_CERT;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    https:
      httpsKey && httpsCert
        ? {
            key: readFileSync(httpsKey),
            cert: readFileSync(httpsCert)
          }
        : undefined,
    proxy: {
      "/signal": {
        target: signalingTarget,
        ws: true
      },
      "/health": signalingTarget
    }
  }
});
