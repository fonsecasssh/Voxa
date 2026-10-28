import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const server = process.env.VOXA_SERVER || "http://localhost:3001";

export default defineConfig({
  plugins: [react()],
  build: {
    // Audio worklets and their WASM models must be real files: AudioWorklet can't be relied on to load inlined data: URLs.
    assetsInlineLimit: (file) => (file.includes("web-noise-suppressor") ? false : undefined),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": server,
      "/socket.io": { target: server, ws: true },
      "/media": server,
      "/download": server,
    },
  },
});
