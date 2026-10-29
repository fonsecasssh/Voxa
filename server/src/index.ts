import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { createIceProvider } from "./ice.ts";
import { createGiphyProvider } from "./gifs.ts";
import { scheduleBackups } from "./backup.ts";
import { createSmtpMailer } from "./mail.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3001;
const DB_FILE = process.env.DB_FILE || path.resolve(here, "../data/voxa.db");
// Uploaded images live next to the database, so they're on the same persistent disk.
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(path.dirname(DB_FILE), "media");

const db = openDb(DB_FILE);
const ice = createIceProvider();
const { http, io } = createApp({
  db,
  ice,
  // Served when it has been built (`npm run build`); in development Vite serves the UI instead.
  webDist: path.resolve(here, "../../web/dist"),
  trustProxy: Number(process.env.TRUST_PROXY) || 0,
  mediaDir: MEDIA_DIR,
  // Clips shared in chat may take this much disk in total (the oldest are deleted beyond it).
  clipsMaxBytes: (Number(process.env.CLIPS_MAX_MB) || 400) * 1024 * 1024,
  // Same for files sent in chat (images, videos, documents).
  filesMaxBytes: (Number(process.env.FILES_MAX_MB) || 300) * 1024 * 1024,
  // GIF search in chat: a free key from developers.giphy.com.
  gifs: process.env.GIPHY_API_KEY ? createGiphyProvider(process.env.GIPHY_API_KEY) : null,
  // Password recovery by e-mail: SMTP_* (see mail.ts), and the site's address for the links
  // (Render sets RENDER_EXTERNAL_URL by itself).
  mailer: createSmtpMailer(process.env),
  appUrl: process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || null,
});

// A daily copy of the database, keeping the last BACKUP_KEEP (7) of them; BACKUP_DISABLED=1 turns it off.
if (process.env.BACKUP_DISABLED !== "1" && DB_FILE !== ":memory:") {
  scheduleBackups(db, {
    dir: process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), "backups"),
    keep: Math.max(1, Number(process.env.BACKUP_KEEP) || 7),
    everyMs: 24 * 3_600_000,
  });
}

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
