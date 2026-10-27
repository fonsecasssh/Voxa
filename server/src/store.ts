// All SQL lives here, so routes and socket handlers deal in plain objects.

import { randomUUID } from "node:crypto";
import type { DB } from "./db.ts";
import { newInviteCode, newToken } from "./auth.ts";

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
}

export interface Server {
  id: string;
  name: string;
  ownerId: string;
  inviteCode: string;
}

export type ChannelType = "text" | "voice";

export interface Channel {
  id: string;
  serverId: string;
  name: string;
  type: ChannelType;
  position: number;
}

export interface Message {
  id: string;
  channelId: string;
  author: PublicUser;
  content: string;
  createdAt: number;
}

type Row = Record<string, unknown>;

const toUser = (r: Row): PublicUser => ({
  id: r.id as string,
  username: r.username as string,
  displayName: r.display_name as string,
});

const toServer = (r: Row): Server => ({
  id: r.id as string,
  name: r.name as string,
  ownerId: r.owner_id as string,
  inviteCode: r.invite_code as string,
});

const toChannel = (r: Row): Channel => ({
  id: r.id as string,
  serverId: r.server_id as string,
  name: r.name as string,
  type: r.type as ChannelType,
  position: r.position as number,
});

const toMessage = (r: Row): Message => ({
  id: r.id as string,
  channelId: r.channel_id as string,
  author: { id: r.author_id as string, username: r.username as string, displayName: r.display_name as string },
  content: r.content as string,
  createdAt: r.created_at as number,
});

export function createStore(db: DB) {
  return {
    // --- users & sessions -------------------------------------------------
    createUser(username: string, displayName: string, passwordHash: string): PublicUser {
      const id = randomUUID();
      db.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, username, displayName, passwordHash, Date.now());
      return { id, username, displayName };
    },

    findUserForLogin(username: string): (PublicUser & { passwordHash: string }) | null {
      const r = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as Row | undefined;
      return r ? { ...toUser(r), passwordHash: r.password_hash as string } : null;
    },

    usernameTaken(username: string): boolean {
      return db.prepare("SELECT 1 FROM users WHERE username = ?").get(username) !== undefined;
    },

    createSession(userId: string): string {
      const token = newToken();
      db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(token, userId, Date.now());
      return token;
    },

    userForToken(token: string): PublicUser | null {
      const r = db
        .prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?")
        .get(token) as Row | undefined;
      return r ? toUser(r) : null;
    },

    deleteSession(token: string): void {
      db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    },

    // --- servers & membership ---------------------------------------------
    createServer(ownerId: string, name: string): { server: Server; channels: Channel[] } {
      const now = Date.now();
      const server: Server = { id: randomUUID(), name, ownerId, inviteCode: newInviteCode() };
      db.exec("BEGIN");
      try {
        db.prepare("INSERT INTO servers (id, name, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(server.id, name, ownerId, server.inviteCode, now);
        db.prepare("INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)").run(server.id, ownerId, now);
        const channels = [
          this.insertChannel(server.id, "geral", "text", 0),
          this.insertChannel(server.id, "Geral", "voice", 1),
        ];
        db.exec("COMMIT");
        return { server, channels };
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    serversForUser(userId: string): Server[] {
      return (
        db
          .prepare("SELECT s.* FROM servers s JOIN members m ON m.server_id = s.id WHERE m.user_id = ? ORDER BY m.joined_at")
          .all(userId) as Row[]
      ).map(toServer);
    },

    serverById(id: string): Server | null {
      const r = db.prepare("SELECT * FROM servers WHERE id = ?").get(id) as Row | undefined;
      return r ? toServer(r) : null;
    },

    serverByInvite(code: string): Server | null {
      const r = db.prepare("SELECT * FROM servers WHERE invite_code = ?").get(code) as Row | undefined;
      return r ? toServer(r) : null;
    },

    isMember(serverId: string, userId: string): boolean {
      return db.prepare("SELECT 1 FROM members WHERE server_id = ? AND user_id = ?").get(serverId, userId) !== undefined;
    },

    /** Returns false when the user was already a member. */
    addMember(serverId: string, userId: string): boolean {
      const res = db
        .prepare("INSERT OR IGNORE INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)")
        .run(serverId, userId, Date.now());
      return res.changes > 0;
    },

    members(serverId: string): PublicUser[] {
      return (
        db
          .prepare("SELECT u.* FROM members m JOIN users u ON u.id = m.user_id WHERE m.server_id = ? ORDER BY u.display_name COLLATE NOCASE")
          .all(serverId) as Row[]
      ).map(toUser);
    },

    // --- channels ---------------------------------------------------------
    insertChannel(serverId: string, name: string, type: ChannelType, position?: number): Channel {
      const pos =
        position ??
        ((db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE server_id = ?").get(serverId) as Row)
          .p as number);
      const channel: Channel = { id: randomUUID(), serverId, name, type, position: pos };
      db.prepare("INSERT INTO channels (id, server_id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(channel.id, serverId, name, type, pos, Date.now());
      return channel;
    },

    channels(serverId: string): Channel[] {
      return (db.prepare("SELECT * FROM channels WHERE server_id = ? ORDER BY position").all(serverId) as Row[]).map(toChannel);
    },

    channelById(id: string): Channel | null {
      const r = db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as Row | undefined;
      return r ? toChannel(r) : null;
    },

    // --- messages ---------------------------------------------------------
    insertMessage(channelId: string, author: PublicUser, content: string): Message {
      const msg: Message = { id: randomUUID(), channelId, author, content, createdAt: Date.now() };
      db.prepare("INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(msg.id, channelId, author.id, content, msg.createdAt);
      return msg;
    },

    /** Newest `limit` messages older than `before`, returned oldest first. */
    messages(channelId: string, before: number, limit: number): Message[] {
      const rows = db
        .prepare(
          `SELECT m.*, u.username, u.display_name FROM messages m JOIN users u ON u.id = m.author_id
           WHERE m.channel_id = ? AND m.created_at < ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
        )
        .all(channelId, before, limit) as Row[];
      return rows.map(toMessage).reverse();
    },
  };
}

export type Store = ReturnType<typeof createStore>;
