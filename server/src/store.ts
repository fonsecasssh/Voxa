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

export type ChannelType = "text" | "voice" | "dm";

export interface Channel {
  id: string;
  /** null for direct-message channels. */
  serverId: string | null;
  name: string;
  type: ChannelType;
  position: number;
}

export type UserStatus = "online" | "idle" | "dnd" | "invisible";

export type FriendState = "accepted" | "incoming" | "outgoing";

export interface Friend {
  user: PublicUser;
  state: FriendState;
}

export interface DmSummary {
  channel: Channel;
  /** The other participant. */
  user: PublicUser;
  lastMessageAt: number | null;
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
  serverId: (r.server_id as string | null) ?? null,
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

/** Two user ids in canonical order, matching the (user_low, user_high) columns. */
const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

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

    userById(id: string): PublicUser | null {
      const r = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
      return r ? toUser(r) : null;
    },

    userByUsername(username: string): PublicUser | null {
      const r = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as Row | undefined;
      return r ? toUser(r) : null;
    },

    getStatus(userId: string): UserStatus {
      const r = db.prepare("SELECT status FROM users WHERE id = ?").get(userId) as Row | undefined;
      return (r?.status as UserStatus) ?? "online";
    },

    setStatus(userId: string, status: UserStatus): void {
      db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, userId);
    },

    getActivity(userId: string): { name: string; startedAt: number } | null {
      const r = db.prepare("SELECT activity_name, activity_started_at FROM users WHERE id = ?").get(userId) as Row | undefined;
      return r?.activity_name ? { name: r.activity_name as string, startedAt: r.activity_started_at as number } : null;
    },

    setActivity(userId: string, activity: { name: string; startedAt: number } | null): void {
      db.prepare("UPDATE users SET activity_name = ?, activity_started_at = ? WHERE id = ?")
        .run(activity?.name ?? null, activity?.startedAt ?? null, userId);
    },

    // --- friends ----------------------------------------------------------
    friendship(a: string, b: string): { status: "pending" | "accepted"; requesterId: string } | null {
      const [low, high] = pair(a, b);
      const r = db.prepare("SELECT * FROM friendships WHERE user_low = ? AND user_high = ?").get(low, high) as Row | undefined;
      return r ? { status: r.status as "pending" | "accepted", requesterId: r.requester_id as string } : null;
    },

    requestFriend(from: string, to: string): void {
      const [low, high] = pair(from, to);
      db.prepare(
        "INSERT INTO friendships (user_low, user_high, requester_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
      ).run(low, high, from, Date.now());
    },

    acceptFriend(a: string, b: string): void {
      const [low, high] = pair(a, b);
      db.prepare("UPDATE friendships SET status = 'accepted' WHERE user_low = ? AND user_high = ?").run(low, high);
    },

    /** Removes a friendship or a pending request in either direction. Returns whether one existed. */
    removeFriendship(a: string, b: string): boolean {
      const [low, high] = pair(a, b);
      return db.prepare("DELETE FROM friendships WHERE user_low = ? AND user_high = ?").run(low, high).changes > 0;
    },

    friendsOf(userId: string): Friend[] {
      const rows = db
        .prepare(
          `SELECT u.*, f.status AS f_status, f.requester_id FROM friendships f
           JOIN users u ON u.id = CASE WHEN f.user_low = ? THEN f.user_high ELSE f.user_low END
           WHERE f.user_low = ? OR f.user_high = ?
           ORDER BY u.display_name COLLATE NOCASE`,
        )
        .all(userId, userId, userId) as Row[];
      return rows.map((r) => ({
        user: toUser(r),
        state: r.f_status === "accepted" ? "accepted" : r.requester_id === userId ? "outgoing" : "incoming",
      }));
    },

    friendIds(userId: string): string[] {
      return (
        db
          .prepare(
            `SELECT CASE WHEN user_low = ? THEN user_high ELSE user_low END AS id FROM friendships
             WHERE (user_low = ? OR user_high = ?) AND status = 'accepted'`,
          )
          .all(userId, userId, userId) as Row[]
      ).map((r) => r.id as string);
    },

    sharesServer(a: string, b: string): boolean {
      return (
        db
          .prepare("SELECT 1 FROM members m1 JOIN members m2 ON m1.server_id = m2.server_id WHERE m1.user_id = ? AND m2.user_id = ?")
          .get(a, b) !== undefined
      );
    },

    // --- direct messages ----------------------------------------------------
    /** The DM channel between two users, created on first use. */
    openDm(a: string, b: string): { channel: Channel; created: boolean } {
      const [low, high] = pair(a, b);
      const existing = db
        .prepare("SELECT c.* FROM dms d JOIN channels c ON c.id = d.channel_id WHERE d.user_low = ? AND d.user_high = ?")
        .get(low, high) as Row | undefined;
      if (existing) return { channel: toChannel(existing), created: false };

      const channel: Channel = { id: randomUUID(), serverId: null, name: "", type: "dm", position: 0 };
      db.exec("BEGIN");
      try {
        db.prepare("INSERT INTO channels (id, server_id, name, type, position, created_at) VALUES (?, NULL, '', 'dm', 0, ?)")
          .run(channel.id, Date.now());
        db.prepare("INSERT INTO dms (channel_id, user_low, user_high) VALUES (?, ?, ?)").run(channel.id, low, high);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return { channel, created: true };
    },

    dmParticipants(channelId: string): [string, string] | null {
      const r = db.prepare("SELECT user_low, user_high FROM dms WHERE channel_id = ?").get(channelId) as Row | undefined;
      return r ? [r.user_low as string, r.user_high as string] : null;
    },

    dmsForUser(userId: string): DmSummary[] {
      const rows = db
        .prepare(
          `SELECT c.*, u.id AS u_id, u.username, u.display_name,
                  (SELECT MAX(created_at) FROM messages m WHERE m.channel_id = c.id) AS last_at
           FROM dms d
           JOIN channels c ON c.id = d.channel_id
           JOIN users u ON u.id = CASE WHEN d.user_low = ? THEN d.user_high ELSE d.user_low END
           WHERE d.user_low = ? OR d.user_high = ?
           ORDER BY COALESCE(last_at, c.created_at) DESC`,
        )
        .all(userId, userId, userId) as Row[];
      return rows.map((r) => ({
        channel: toChannel(r),
        user: { id: r.u_id as string, username: r.username as string, displayName: r.display_name as string },
        lastMessageAt: (r.last_at as number | null) ?? null,
      }));
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
