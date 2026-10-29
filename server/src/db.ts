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

  // 6: server icon (same idea as the banner).
  `
  ALTER TABLE servers ADD COLUMN icon TEXT;
  `,

  // 7: user profile picture and profile banner.
  `
  ALTER TABLE users ADD COLUMN avatar TEXT;
  ALTER TABLE users ADD COLUMN profile_banner TEXT;
  `,

  // 8: a clip (instant replay video) attached to a message, as JSON (see store.ts).
  `
  ALTER TABLE messages ADD COLUMN attachment TEXT;
  `,

  // 9: files attached to messages. Uploaded first (message_id NULL), then attached when the
  // message is sent. The file on disk is named after the id.
  `
  CREATE TABLE attachments (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    width      INTEGER,
    height     INTEGER,
    position   INTEGER NOT NULL DEFAULT 0,
    expired    INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX attachments_by_message ON attachments(message_id);
  `,

  // 10: replies, edits and reactions.
  `
  ALTER TABLE messages ADD COLUMN reply_to TEXT;
  ALTER TABLE messages ADD COLUMN edited_at INTEGER;
  CREATE TABLE reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );
  CREATE INDEX reactions_by_message ON reactions(message_id, created_at);
  `,

  // 11: who a message mentions (user ids, as JSON) and whether it pings @everyone.
  `
  ALTER TABLE messages ADD COLUMN mentions TEXT;
  ALTER TABLE messages ADD COLUMN mention_everyone INTEGER NOT NULL DEFAULT 0;
  `,

  // 12: group DMs. Every DM conversation lists its people in dm_members (a 1:1 DM keeps
  // its row in dms, which makes the pair unique); a group also has a row in group_dms.
  `
  CREATE TABLE dm_members (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at  INTEGER NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  );
  CREATE INDEX dm_members_by_user ON dm_members(user_id);
  INSERT INTO dm_members (channel_id, user_id, joined_at) SELECT channel_id, user_low, 0 FROM dms;
  INSERT INTO dm_members (channel_id, user_id, joined_at) SELECT channel_id, user_high, 0 FROM dms;

  CREATE TABLE group_dms (
    channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    owner_id   TEXT NOT NULL,
    name       TEXT
  );
  `,

  // 13: channel categories, private channels (open to some roles), bans, and invites
  // that expire or run out of uses (the server's original invite code keeps working).
  `
  CREATE TABLE categories (
    id         TEXT PRIMARY KEY,
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX categories_by_server ON categories(server_id, position);
  ALTER TABLE channels ADD COLUMN category_id TEXT REFERENCES categories(id) ON DELETE SET NULL;
  ALTER TABLE channels ADD COLUMN private INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE channel_roles (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, role_id)
  );

  CREATE TABLE bans (
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by  TEXT,
    reason     TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
  );

  CREATE TABLE invites (
    code       TEXT PRIMARY KEY,
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    creator_id TEXT,
    max_uses   INTEGER,
    uses       INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX invites_by_server ON invites(server_id);
  -- Everyone could share the server's link so far: keep that (1024 = CREATE_INVITE).
  UPDATE roles SET permissions = permissions | 1024 WHERE is_default = 1;
  `,

  // 14: a confirmed e-mail address (to reset a forgotten password), and the one-time
  // tokens sent by e-mail (only their SHA-256 is stored).
  `
  ALTER TABLE users ADD COLUMN email TEXT;
  CREATE UNIQUE INDEX users_by_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;
  CREATE TABLE email_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('verify', 'reset')),
    email      TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX email_tokens_by_user ON email_tokens(user_id);
  `,
];

/** The schema version a fully migrated database has. */
export const SCHEMA_VERSION = MIGRATIONS.length;

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
