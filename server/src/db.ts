import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type DB = DatabaseSync;

// Each migration runs once, in order; PRAGMA user_version records how many have run.
// Never edit a migration that has shipped — append a new one instead.
const MIGRATIONS: string[] = [
  // 1: accounts, servers, channels, messages
  `
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS servers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    invite_code TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS members (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS channels (
    id         TEXT PRIMARY KEY,
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('text', 'voice')),
    position   INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id  TEXT NOT NULL REFERENCES users(id),
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS messages_by_channel ON messages(channel_id, created_at);
  `,

  // 2: friends, direct messages, user status.
  // Channels gain a 'dm' type with no server, which SQLite can only express by rebuilding the table.
  `
  CREATE TABLE channels_new (
    id         TEXT PRIMARY KEY,
    server_id  TEXT REFERENCES servers(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('text', 'voice', 'dm')),
    position   INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK ((type = 'dm') = (server_id IS NULL))
  );
  INSERT INTO channels_new SELECT id, server_id, name, type, position, created_at FROM channels;
  DROP TABLE channels;
  ALTER TABLE channels_new RENAME TO channels;
  CREATE INDEX channels_by_server ON channels(server_id, position);

  -- One row per DM conversation; user_low < user_high so a pair has exactly one row.
  CREATE TABLE dms (
    channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    user_low   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_high  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE (user_low, user_high)
  );
  CREATE INDEX dms_by_high ON dms(user_high);

  -- One row per pair, same ordering. requester_id tells who sent a pending request.
  CREATE TABLE friendships (
    user_low     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_high    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (user_low, user_high)
  );
  CREATE INDEX friendships_by_high ON friendships(user_high);

  ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'online'
    CHECK (status IN ('online', 'idle', 'dnd', 'invisible'));
  `,

  // 3: the activity ("Jogando X") survives reloads and reconnects, like the status.
  `
  ALTER TABLE users ADD COLUMN activity_name TEXT;
  ALTER TABLE users ADD COLUMN activity_started_at INTEGER;
  `,

  // 4: roles and per-server nicknames. Every existing server gets its @everyone role
  // (permission 64 = CHANGE_NICKNAME, see shared/permissions.ts).
  `
  ALTER TABLE members ADD COLUMN nickname TEXT;

  CREATE TABLE roles (
    id          TEXT PRIMARY KEY,
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    color       TEXT,
    permissions INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL,
    hoist       INTEGER NOT NULL DEFAULT 0,
    is_default  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX roles_by_server ON roles(server_id, position);
  CREATE UNIQUE INDEX one_default_role_per_server ON roles(server_id) WHERE is_default = 1;

  CREATE TABLE member_roles (
    server_id TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    role_id   TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (server_id, user_id, role_id),
    FOREIGN KEY (server_id, user_id) REFERENCES members(server_id, user_id) ON DELETE CASCADE
  );

  INSERT INTO roles (id, server_id, name, color, permissions, position, hoist, is_default, created_at)
    SELECT lower(hex(randomblob(16))), id, '@everyone', NULL, 64, 0, 0, 1, created_at FROM servers;
  `,

  // 5: server banner (a file name inside the media directory).
  `
  ALTER TABLE servers ADD COLUMN banner TEXT;
  `,
];

function migrate(db: DB) {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    // Foreign keys must be off while tables are rebuilt, or dropping one would cascade-delete
    // rows that point at it. The pragma is a no-op inside a transaction, so it's set outside.
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length) throw new Error(`migration ${v + 1} broke foreign keys: ${JSON.stringify(broken)}`);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

/** Opens (and migrates) the database. Pass ":memory:" for tests. */
export function openDb(file: string): DB {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}
