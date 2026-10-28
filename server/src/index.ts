import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { createIceProvider } from "./ice.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3001;
const DB_FILE = process.env.DB_FILE || path.resolve(here, "../data/voxa.db");

const db = openDb(DB_FILE);
const ice = createIceProvider();
const { http, io } = createApp({
  db,
  ice,
  // Served when it has been built (`npm run build`); in development Vite serves the UI instead.
  webDist: path.resolve(here, "../../web/dist"),
  trustProxy: Number(process.env.TRUST_PROXY) || 0,
});

http.listen(PORT, () => {
  console.log(`Voxa server on http://localhost:${PORT} (banco: ${DB_FILE}; voz: ${ice.describe()})`);
});

// Hosts stop the old instance with SIGTERM on every deploy: close connections and the
// database cleanly so no write is cut in half.
let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} recebido, encerrando…`);
  io.close();
  http.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
