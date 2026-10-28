// Consistent copy of the live database (safe while the server is running).
// Usage: npm run backup -w server [-- destino.db]

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const source = process.env.DB_FILE || path.resolve(import.meta.dirname, "../data/voxa.db");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = process.argv[2] || path.join(path.dirname(source), `backup-${stamp}.db`);

const db = new DatabaseSync(source, { readOnly: true });
// VACUUM INTO writes a compact, transactionally consistent snapshot to a new file.
db.prepare("VACUUM INTO ?").run(target);
db.close();
console.log(`Backup salvo em ${target}`);
