import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3001;
const DB_FILE = process.env.DB_FILE || path.resolve(here, "../data/sintonia.db");

const { http } = createApp({
  db: openDb(DB_FILE),
  // Served when it has been built (`npm run build`); in development Vite serves the UI instead.
  webDist: path.resolve(here, "../../web/dist"),
});

http.listen(PORT, () => {
  console.log(`Sintonia server on http://localhost:${PORT}`);
});
