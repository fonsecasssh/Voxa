import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupNow, listBackups } from "../src/backup.ts";
import { openDb } from "../src/db.ts";

describe("database backups", () => {
  it("copies the live database and keeps only the newest ones", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "voxa-backup-"));
    const db = openDb(path.join(dir, "voxa.db"));
    db.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES ('u1', 'ana', 'Ana', 'x', 0)").run();
    const backups = path.join(dir, "backups");
    // Something that isn't a backup is left alone.
    const day = 86_400_000;
    let t = Date.UTC(2026, 9, 1, 3, 0);
    for (let i = 0; i < 4; i++) {
      await backupNow(db, { dir: backups, keep: 3, now: () => t });
      t += day;
    }
    writeFileSync(path.join(backups, "notas.txt"), "oi");
    const kept = listBackups(backups).map((b) => path.basename(b.file));
    expect(kept).toEqual(["voxa-2026-10-02-0300.db", "voxa-2026-10-03-0300.db", "voxa-2026-10-04-0300.db"]);

    const copy = new DatabaseSync(listBackups(backups).at(-1)!.file, { readOnly: true });
    expect(copy.prepare("SELECT username FROM users").all()).toEqual([{ username: "ana" }]);
    copy.close();
    db.close();
  });
});
