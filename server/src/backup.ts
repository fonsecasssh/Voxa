// Automatic database backups: a consistent copy of the SQLite database (taken while the
// server keeps running) once a day, keeping the last few. They sit on the same disk as
// the database, which guards against mistakes and corruption, not against losing the
// disk itself: copy them elsewhere from time to time (see DEPLOY.md).

import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { backup } from "node:sqlite";
import type { DB } from "./db.ts";

const NAME_RE = /^voxa-\d{4}-\d{2}-\d{2}-\d{4}\.db$/;
const HOUR = 3_600_000;

export interface BackupOptions {
  dir: string;
  /** How many backups to keep (the oldest go first). */
  keep: number;
  /** Minimum time between two backups. */
  everyMs: number;
  now?: () => number;
}

/** Existing backups, oldest first. */
export function listBackups(dir: string): { file: string; time: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => NAME_RE.test(n))
    .map((n) => ({ file: path.join(dir, n), time: statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

const stamp = (t: number) => new Date(t).toISOString().replace(/T(\d{2}):(\d{2}).*/, "-$1$2");

/** Takes a backup now and removes the ones beyond `keep`. Returns the new file. */
export async function backupNow(db: DB, { dir, keep, now = Date.now }: Pick<BackupOptions, "dir" | "keep" | "now">): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `voxa-${stamp(now())}.db`);
  const partial = `${file}.partial`;
  rmSync(partial, { force: true });
  await backup(db, partial);
  // Only complete copies get a backup name.
  renameSync(partial, file);
  const all = listBackups(dir);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(old.file, { force: true });
  return file;
}

/** Backs up when the newest backup is older than `everyMs` (checked now and every hour). */
export function scheduleBackups(db: DB, opts: BackupOptions): () => void {
  const now = opts.now ?? Date.now;
  let running = false;
  const check = async () => {
    if (running) return;
    const newest = listBackups(opts.dir).at(-1);
    if (newest && now() - newest.time < opts.everyMs) return;
    running = true;
    try {
      const file = await backupNow(db, opts);
      console.log(`backup do banco salvo em ${file}`);
    } catch (err) {
      console.error("falha no backup do banco:", err);
    } finally {
      running = false;
    }
  };
  // A little after startup, so it doesn't compete with the first requests.
  const first = setTimeout(check, 60_000);
  const timer = setInterval(check, HOUR);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
