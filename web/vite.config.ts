import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const server = process.env.VOXA_SERVER || "http://localhost:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": server,
      "/socket.io": { target: server, ws: true },
    },
  },
});
