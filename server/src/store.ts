// All SQL lives here, so routes and socket handlers deal in plain objects.

import { createHash, randomUUID } from "node:crypto";
import type { DB } from "./db.ts";
import { newInviteCode, newToken } from "./auth.ts";
import { DEFAULT_PERMISSIONS, Permission, can, permissionsOf } from "../../shared/permissions.ts";
import { previewLinks } from "../../shared/markdown.ts";
import type { LinkEmbed } from "./unfurl.ts";
import { CLIP_MIME, CLIP_URL_PREFIX, imageUrlPrefix, type ClipType, type ServerImageKind, type UserImageKind } from "./media.ts";

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  /** URL of the profile picture, or null (initials are shown instead). */
  avatar: string | null;
  /** URL of the profile banner, or null. */
  banner: string | null;
}

export interface Server {
  id: string;
  name: string;
  ownerId: string;
  /** URL of the banner image, or null. */
  banner: string | null;
  /** URL of the icon image, or null (the initials are shown instead). */
  icon: string | null;
}

export type ChannelType = "text" | "voice" | "dm" | "thread";

export interface Channel {
  id: string;
  /** null for direct-message channels. */
  serverId: string | null;
  name: string;
  type: ChannelType;
  position: number;
  categoryId: string | null;
  /** Only the owner, administrators and the roles in roleIds see a private channel. */
  private: boolean;
  roleIds: string[];
  /** Threads: the channel they belong to, the message they started from, who started them. */
  parentId: string | null;
  starterMessageId: string | null;
  creatorId: string | null;
}

export type NotifyLevel = "all" | "mentions" | "none";

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface CustomEmoji {
  id: string;
  serverId: string;
  name: string;
  animated: boolean;
  /** The picture (by id, so it works wherever the emoji is used). */
  url: string;
}

export interface Category {
  id: string;
  serverId: string;
  name: string;
  position: number;
}

export interface Ban {
  user: PublicUser;
  reason: string | null;
  createdAt: number;
}

export interface Invite {
  code: string;
  serverId: string;
  creatorId: string | null;
  /** null = unlimited. */
  maxUses: number | null;
  uses: number;
  /** null = never expires. */
  expiresAt: number | null;
  createdAt: number;
}

/** Text and/or emoji (a unicode emoji or a custom emoji token) the user shows, until expiresAt. */
export interface CustomStatus {
  text: string | null;
  emoji: string | null;
  expiresAt: number | null;
}

export type UserStatus = "online" | "idle" | "dnd" | "invisible";

export type FriendState = "accepted" | "incoming" | "outgoing";

export interface Friend {
  user: PublicUser;
  state: FriendState;
}

export interface DmSummary {
  channel: Channel;
  /** The other participant of a 1:1 DM; null in a group. */
  user: PublicUser | null;
  /** Everyone else in the conversation. */
  members: PublicUser[];
  /** Set for a group DM. */
  group: { name: string | null; ownerId: string } | null;
  lastMessageAt: number | null;
}

/** People in a group DM, the owner included (like Discord). */
export const MAX_GROUP_DM = 10;

export interface Role {
  id: string;
  serverId: string;
  name: string;
  /** Hex color like "#e91e63", or null for the default text color. */
  color: string | null;
  permissions: number;
  /** Higher is more important; @everyone is always 0. */
  position: number;
  /** Shown as its own section in the member list. */
  hoist: boolean;
  isDefault: boolean;
}

export interface MemberData {
  nickname: string | null;
  roleIds: string[];
}

export interface Message {
  id: string;
  channelId: string;
  author: PublicUser;
  content: string;
  createdAt: number;
  attachment: ClipAttachment | null;
  /** Files sent with the message (images, videos, anything else). */
  files: FileAttachment[];
  /** The message this one answers, or null. `author` is null if it was deleted. */
  replyTo: ReplyPreview | null;
  editedAt: number | null;
  reactions: Reaction[];
  /** Ids of the people this message pings (by @name, or by replying to them). */
  mentions: string[];
  mentionsEveryone: boolean;
  /** When it was pinned to the channel, or null. */
  pinnedAt: number | null;
  /** Previews of the links in it (filled in a moment after it's sent). */
  embeds: LinkEmbed[];
  /** The thread started from this message, if any. */
  thread: { id: string; name: string; count: number; lastAt: number | null } | null;
}

export interface ReplyPreview {
  id: string;
  author: PublicUser | null;
  /** The start of its text. */
  content: string;
  hasFiles: boolean;
}

export interface Reaction {
  emoji: string;
  userIds: string[];
}

export type FileKind = "image" | "video" | "file";

/** A file sent in chat. `url` is null once it was deleted to free space. */
export interface FileAttachment {
  id: string;
  name: string;
  kind: FileKind;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  url: string | null;
}

/** An uploaded file before (and after) it is attached to a message. */
export interface UploadRow {
  id: string;
  ownerId: string;
  messageId: string | null;
  name: string;
  kind: FileKind;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  expired: boolean;
  createdAt: number;
}

export const FILE_URL_PREFIX = "/media/files/";
const fileUrl = (id: string, name: string) => `${FILE_URL_PREFIX}${id}/${encodeURIComponent(name)}`;

const toUpload = (r: Row): UploadRow => ({
  id: r.id as string,
  ownerId: r.owner_id as string,
  messageId: (r.message_id as string | null) ?? null,
  name: r.name as string,
  kind: r.kind as FileKind,
  mime: r.mime as string,
  size: r.size as number,
  width: (r.width as number | null) ?? null,
  height: (r.height as number | null) ?? null,
  expired: !!r.expired,
  createdAt: r.created_at as number,
});

export const toFileAttachment = (u: UploadRow): FileAttachment => ({
  id: u.id,
  name: u.name,
  kind: u.kind,
  mime: u.mime,
  size: u.size,
  width: u.width,
  height: u.height,
  url: u.expired ? null : fileUrl(u.id, u.name),
});

/** An instant-replay video. `url` is null once the clip was deleted to free space. */
export interface ClipAttachment {
  kind: "clip";
  url: string | null;
  mime: string;
  size: number;
  /** Seconds. */
  duration: number;
  width: number;
  height: number;
}

/** How a clip is kept in messages.attachment (JSON). */
export interface StoredClip {
  kind: "clip";
  file: string;
  type: ClipType;
  size: number;
  duration: number;
  width: number;
  height: number;
  expired?: boolean;
}

function toAttachment(json: unknown): ClipAttachment | null {
  if (typeof json !== "string") return null;
  const a = JSON.parse(json) as StoredClip;
  return {
    kind: "clip",
    url: a.expired ? null : CLIP_URL_PREFIX + a.file,
    mime: CLIP_MIME[a.type],
    size: a.size,
    duration: a.duration,
    width: a.width,
    height: a.height,
  };
}

type Row = Record<string, unknown>;

/** A user from a row with the users columns; `id` overrides the id when the row's own id is something else (a joined query). */
const toUser = (r: Row, id = r.id as string): PublicUser => ({
  id,
  username: r.username as string,
  displayName: r.display_name as string,
  avatar: r.avatar ? imageUrlPrefix("avatar") + (r.avatar as string) : null,
  banner: r.profile_banner ? imageUrlPrefix("profile-banner") + (r.profile_banner as string) : null,
});

const toServer = (r: Row): Server => ({
  id: r.id as string,
  name: r.name as string,
  ownerId: r.owner_id as string,
  banner: r.banner ? imageUrlPrefix("banner") + (r.banner as string) : null,
  icon: r.icon ? imageUrlPrefix("icon") + (r.icon as string) : null,
});

const toChannel = (r: Row): Channel => ({
  id: r.id as string,
  serverId: (r.server_id as string | null) ?? null,
  name: r.name as string,
  type: r.type as ChannelType,
  position: r.position as number,
  categoryId: (r.category_id as string | null) ?? null,
  private: r.private === 1,
  roleIds: r.role_ids ? (r.role_ids as string).split(",") : [],
  parentId: (r.parent_id as string | null) ?? null,
  starterMessageId: (r.starter_message_id as string | null) ?? null,
  creatorId: (r.creator_id as string | null) ?? null,
});

/** Channels with the roles a private one is open to (comma-separated). */
const CHANNEL_SELECT = `SELECT c.*, (SELECT group_concat(role_id) FROM channel_roles cr WHERE cr.channel_id = c.id) AS role_ids FROM channels c`;

const toEmoji = (r: Row): CustomEmoji => ({
  id: r.id as string,
  serverId: r.server_id as string,
  name: r.name as string,
  animated: r.animated === 1,
  url: `/api/emojis/${r.id as string}/image`,
});

const toInvite = (r: Row): Invite => ({
  code: r.code as string,
  serverId: r.server_id as string,
  creatorId: (r.creator_id as string | null) ?? null,
  maxUses: (r.max_uses as number | null) ?? null,
  uses: r.uses as number,
  expiresAt: (r.expires_at as number | null) ?? null,
  createdAt: r.created_at as number,
});

const toRole = (r: Row): Role => ({
  id: r.id as string,
  serverId: r.server_id as string,
  name: r.name as string,
  color: (r.color as string | null) ?? null,
  permissions: r.permissions as number,
  position: r.position as number,
  hoist: r.hoist === 1,
  isDefault: r.is_default === 1,
});

const toMessage = (r: Row): Message => ({
  id: r.id as string,
  channelId: r.channel_id as string,
  author: toUser(r, r.author_id as string),
  content: r.content as string,
  createdAt: r.created_at as number,
  attachment: toAttachment(r.attachment),
  files: [],
  replyTo: r.reply_to ? { id: r.reply_to as string, author: null, content: "", hasFiles: false } : null,
  editedAt: (r.edited_at as number | null) ?? null,
  reactions: [],
  mentions: typeof r.mentions === "string" ? (JSON.parse(r.mentions) as string[]) : [],
  mentionsEveryone: !!r.mention_everyone,
  pinnedAt: (r.pinned_at as number | null) ?? null,
  embeds: [],
  thread: null,
});

const MESSAGE_SELECT = `SELECT m.*, u.username, u.display_name, u.avatar, u.profile_banner FROM messages m JOIN users u ON u.id = m.author_id`;

/** Rows of the reactions table -> per message, one entry per emoji (in the order first used). */
function groupReactions(rows: Row[]): Map<string, Reaction[]> {
  const out = new Map<string, Reaction[]>();
  for (const r of rows) {
    const list = out.get(r.message_id as string) ?? [];
    let entry = list.find((x) => x.emoji === r.emoji);
    if (!entry) {
      entry = { emoji: r.emoji as string, userIds: [] };
      list.push(entry);
    }
    entry.userIds.push(r.user_id as string);
    out.set(r.message_id as string, list);
  }
  return out;
}

/** Two user ids in canonical order, matching the (user_low, user_high) columns. */
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

export function createStore(db: DB) {
  return {
    // --- users & sessions -------------------------------------------------
    createUser(username: string, displayName: string, passwordHash: string): PublicUser {
      const id = randomUUID();
      db.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, username, displayName, passwordHash, Date.now());
      return { id, username, displayName, avatar: null, banner: null };
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

    /** Sets a profile image's file name (or null) and returns the previous one, so its file can be removed. */
    setUserImage(kind: UserImageKind, userId: string, file: string | null): string | null {
      // The column name comes from a fixed list, never from user input.
      const column = ({ avatar: "avatar", "profile-banner": "profile_banner" } as const)[kind];
      const prev = db.prepare(`SELECT ${column} AS f FROM users WHERE id = ?`).get(userId) as Row | undefined;
      db.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(file, userId);
      return (prev?.f as string | null) ?? null;
    },

    setDisplayName(userId: string, displayName: string): void {
      db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(displayName, userId);
    },

    passwordHash(userId: string): string | null {
      const r = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as Row | undefined;
      return (r?.password_hash as string | undefined) ?? null;
    },

    // --- reading, notifications, blocks, push --------------------------------
    /** Marks a channel read up to `at` (never moves backwards). */
    markRead(userId: string, channelId: string, at: number): number {
      db.prepare(
        `INSERT INTO read_states (user_id, channel_id, last_read_at) VALUES (?, ?, ?)
         ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)`,
      ).run(userId, channelId, at);
      return this.lastReadAt(userId, channelId);
    },

    /** When this person last read the channel (0 if never). */
    lastReadAt(userId: string, channelId: string): number {
      const r = db.prepare("SELECT last_read_at FROM read_states WHERE user_id = ? AND channel_id = ?").get(userId, channelId) as Row | undefined;
      return (r?.last_read_at as number | undefined) ?? 0;
    },

    /**
     * Channels with messages from others newer than where this person stopped reading,
     * with how many of those mention them. A channel never opened counts from when they joined.
     */
    unreadFor(userId: string, channels: Channel[]): Record<string, { mentions: number; serverId: string | null }> {
      const out: Record<string, { mentions: number; serverId: string | null }> = {};
      const since = db.prepare(
        `SELECT COALESCE(
           (SELECT last_read_at FROM read_states WHERE user_id = ? AND channel_id = ?),
           (SELECT joined_at FROM members WHERE user_id = ? AND server_id = ?),
           (SELECT joined_at FROM dm_members WHERE user_id = ? AND channel_id = ?),
           0) AS t`,
      );
      const newer = db.prepare(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN mention_everyone = 1 OR instr(COALESCE(mentions, ''), ?) > 0 THEN 1 ELSE 0 END) AS m
         FROM messages WHERE channel_id = ? AND created_at > ? AND author_id != ?
           AND author_id NOT IN (SELECT blocked_id FROM blocks WHERE user_id = ?)`,
      );
      for (const c of channels) {
        if (c.type === "voice") continue;
        const t = (since.get(userId, c.id, userId, c.serverId, userId, c.id) as Row).t as number;
        const r = newer.get(`"${userId}"`, c.id, t, userId, userId) as Row;
        if ((r.n as number) > 0) out[c.id] = { mentions: (r.m as number | null) ?? 0, serverId: c.serverId };
      }
      return out;
    },

    /** Notification settings by target (server, channel or DM). */
    notifySettings(userId: string): Record<string, { level: NotifyLevel | null; mutedUntil: number | null }> {
      const out: Record<string, { level: NotifyLevel | null; mutedUntil: number | null }> = {};
      for (const r of db.prepare("SELECT target_id, level, muted_until FROM notify_settings WHERE user_id = ?").all(userId) as Row[]) {
        out[r.target_id as string] = { level: (r.level as NotifyLevel | null) ?? null, mutedUntil: (r.muted_until as number | null) ?? null };
      }
      return out;
    },

    setNotify(userId: string, targetId: string, level: NotifyLevel | null, mutedUntil: number | null): void {
      if (level === null && mutedUntil === null) {
        db.prepare("DELETE FROM notify_settings WHERE user_id = ? AND target_id = ?").run(userId, targetId);
        return;
      }
      db.prepare(
        `INSERT INTO notify_settings (user_id, target_id, level, muted_until) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, target_id) DO UPDATE SET level = excluded.level, muted_until = excluded.muted_until`,
      ).run(userId, targetId, level, mutedUntil);
    },

    /**
     * What a new message in this channel means for this person: muted (nothing), or
     * notify for every message or only for mentions. The channel's setting wins over the
     * server's; DMs notify every message by default, servers only mentions.
     */
    notifyFor(userId: string, channel: Channel, now = Date.now()): { muted: boolean; level: NotifyLevel } {
      const settings = this.notifySettings(userId);
      const ch = settings[channel.id];
      const sv = channel.serverId ? settings[channel.serverId] : undefined;
      const active = (s?: { mutedUntil: number | null }) => !!s?.mutedUntil && s.mutedUntil > now;
      const level = ch?.level ?? sv?.level ?? (channel.serverId ? "mentions" : "all");
      return { muted: active(ch) || active(sv) || level === "none", level };
    },

    block(userId: string, blockedId: string): void {
      db.prepare("INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)").run(userId, blockedId, Date.now());
    },

    unblock(userId: string, blockedId: string): boolean {
      return db.prepare("DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?").run(userId, blockedId).changes > 0;
    },

    blockedIds(userId: string): string[] {
      return (db.prepare("SELECT blocked_id FROM blocks WHERE user_id = ? ORDER BY created_at").all(userId) as Row[]).map((r) => r.blocked_id as string);
    },

    blockedUsers(userId: string): PublicUser[] {
      return (db.prepare("SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ? ORDER BY b.created_at").all(userId) as Row[]).map((r) => toUser(r));
    },

    /** Whether either of the two blocked the other. */
    blockedBetween(a: string, b: string): boolean {
      return db.prepare("SELECT 1 FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)").get(a, b, b, a) !== undefined;
    },

    hasBlocked(userId: string, otherId: string): boolean {
      return db.prepare("SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?").get(userId, otherId) !== undefined;
    },

    addPushSubscription(userId: string, sub: PushSubscriptionRow): void {
      db.prepare(
        `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      ).run(sub.endpoint, userId, sub.p256dh, sub.auth, Date.now());
    },

    removePushSubscription(endpoint: string, userId?: string): void {
      if (userId) db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").run(endpoint, userId);
      else db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
    },

    pushSubscriptions(userId: string): PushSubscriptionRow[] {
      return (db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?").all(userId) as Row[]).map((r) => ({
        endpoint: r.endpoint as string,
        p256dh: r.p256dh as string,
        auth: r.auth as string,
      }));
    },

    getSetting(key: string): string | null {
      const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
      return (r?.value as string | undefined) ?? null;
    },

    setSetting(key: string, value: string): void {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
    },

    // --- e-mail -------------------------------------------------------------
    emailOf(userId: string): string | null {
      const r = db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as Row | undefined;
      return (r?.email as string | null) ?? null;
    },

    /** Sets (or clears) the confirmed address; false if another account already has it. */
    setEmail(userId: string, email: string | null): boolean {
      if (email && db.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id != ?").get(email, userId)) return false;
      db.prepare("UPDATE users SET email = ? WHERE id = ?").run(email, userId);
      return true;
    },

    /** An account by its username or its confirmed e-mail. */
    userByLogin(login: string): (PublicUser & { email: string | null }) | null {
      const r = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE OR (email IS NOT NULL AND email = ? COLLATE NOCASE)").get(login, login) as
        | Row
        | undefined;
      return r ? { ...toUser(r), email: (r.email as string | null) ?? null } : null;
    },

    /** Stores a one-time token (by its hash); a new one of the same kind replaces the old. */
    createEmailToken(userId: string, kind: "verify" | "reset", email: string, ttlMs: number): string {
      const token = newToken();
      db.prepare("DELETE FROM email_tokens WHERE user_id = ? AND kind = ?").run(userId, kind);
      db.prepare("INSERT INTO email_tokens (token_hash, user_id, kind, email, expires_at) VALUES (?, ?, ?, ?, ?)").run(
        sha256(token),
        userId,
        kind,
        email,
        Date.now() + ttlMs,
      );
      return token;
    },

    /** Uses up a token: its user and e-mail if it was valid and not expired. */
    consumeEmailToken(token: string, kind: "verify" | "reset"): { userId: string; email: string } | null {
      const hash = sha256(token);
      const r = db.prepare("SELECT * FROM email_tokens WHERE token_hash = ? AND kind = ?").get(hash, kind) as Row | undefined;
      if (!r) return null;
      db.prepare("DELETE FROM email_tokens WHERE token_hash = ?").run(hash);
      return (r.expires_at as number) > Date.now() ? { userId: r.user_id as string, email: r.email as string } : null;
    },

    /** After a password reset: every session ends, and the new one starts. */
    resetPassword(userId: string, passwordHash: string): string {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM email_tokens WHERE user_id = ? AND kind = 'reset'").run(userId);
      return this.createSession(userId);
    },

    /** Sets a new password and signs out every other session. */
    setPassword(userId: string, passwordHash: string, keepToken: string): void {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(userId, keepToken);
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

    /** The custom status, unless it has expired. */
    getCustomStatus(userId: string): CustomStatus | null {
      const r = db.prepare("SELECT custom_status FROM users WHERE id = ?").get(userId) as Row | undefined;
      if (!r?.custom_status) return null;
      const c = JSON.parse(r.custom_status as string) as CustomStatus;
      return c.expiresAt !== null && c.expiresAt <= Date.now() ? null : c;
    },

    setCustomStatus(userId: string, custom: CustomStatus | null): void {
      db.prepare("UPDATE users SET custom_status = ? WHERE id = ?").run(custom ? JSON.stringify(custom) : null, userId);
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

      const channel: Channel = { id: randomUUID(), serverId: null, name: "", type: "dm", position: 0, categoryId: null, private: false, roleIds: [], parentId: null, starterMessageId: null, creatorId: null };
      db.exec("BEGIN");
      try {
        db.prepare("INSERT INTO channels (id, server_id, name, type, position, created_at) VALUES (?, NULL, '', 'dm', 0, ?)")
          .run(channel.id, Date.now());
        db.prepare("INSERT INTO dms (channel_id, user_low, user_high) VALUES (?, ?, ?)").run(channel.id, low, high);
        const now = Date.now();
        for (const id of [low, high]) {
          db.prepare("INSERT INTO dm_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)").run(channel.id, id, now);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return { channel, created: true };
    },

    /** Everyone in a DM conversation (1:1 or group), or null if the channel isn't one. */
    dmParticipants(channelId: string): string[] | null {
      const rows = db.prepare("SELECT user_id FROM dm_members WHERE channel_id = ? ORDER BY joined_at, user_id").all(channelId) as Row[];
      return rows.length ? rows.map((r) => r.user_id as string) : null;
    },

    /** People who share a group DM with this user (they see each other's presence). */
    groupDmPeers(userId: string): string[] {
      return (
        db
          .prepare(
            `SELECT DISTINCT o.user_id AS id FROM dm_members me
             JOIN group_dms g ON g.channel_id = me.channel_id
             JOIN dm_members o ON o.channel_id = me.channel_id
             WHERE me.user_id = ? AND o.user_id != ?`,
          )
          .all(userId, userId) as Row[]
      ).map((r) => r.id as string);
    },

    groupDm(channelId: string): { name: string | null; ownerId: string } | null {
      const r = db.prepare("SELECT name, owner_id FROM group_dms WHERE channel_id = ?").get(channelId) as Row | undefined;
      return r ? { name: (r.name as string | null) ?? null, ownerId: r.owner_id as string } : null;
    },

    /** A new group DM with its owner and these people. */
    createGroupDm(ownerId: string, userIds: string[], name: string | null): Channel {
      const channel: Channel = { id: randomUUID(), serverId: null, name: "", type: "dm", position: 0, categoryId: null, private: false, roleIds: [], parentId: null, starterMessageId: null, creatorId: null };
      const now = Date.now();
      db.exec("BEGIN");
      try {
        db.prepare("INSERT INTO channels (id, server_id, name, type, position, created_at) VALUES (?, NULL, '', 'dm', 0, ?)").run(channel.id, now);
        db.prepare("INSERT INTO group_dms (channel_id, owner_id, name) VALUES (?, ?, ?)").run(channel.id, ownerId, name);
        [ownerId, ...userIds].forEach((id, i) => {
          db.prepare("INSERT INTO dm_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)").run(channel.id, id, now + i);
        });
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return channel;
    },

    addDmMember(channelId: string, userId: string) {
      db.prepare("INSERT OR IGNORE INTO dm_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)").run(channelId, userId, Date.now());
    },

    /**
     * Takes someone out of a group DM. The owner leaving hands the group to whoever joined
     * first; the last person leaving deletes it. Returns what happened to the group.
     */
    removeDmMember(channelId: string, userId: string): "removed" | "deleted" {
      db.prepare("DELETE FROM dm_members WHERE channel_id = ? AND user_id = ?").run(channelId, userId);
      const left = this.dmParticipants(channelId);
      if (!left) {
        db.prepare("DELETE FROM channels WHERE id = ? AND type = 'dm'").run(channelId);
        return "deleted";
      }
      if (this.groupDm(channelId)?.ownerId === userId) {
        db.prepare("UPDATE group_dms SET owner_id = ? WHERE channel_id = ?").run(left[0], channelId);
      }
      return "removed";
    },

    renameGroupDm(channelId: string, name: string | null) {
      db.prepare("UPDATE group_dms SET name = ? WHERE channel_id = ?").run(name, channelId);
    },

    /** One conversation as `userId` sees it. */
    dmFor(channelId: string, userId: string): DmSummary | null {
      return this.dmsForUser(userId, channelId)[0] ?? null;
    },

    dmsForUser(userId: string, onlyChannel?: string): DmSummary[] {
      const rows = db
        .prepare(
          `SELECT c.*, g.name AS g_name, g.owner_id AS g_owner,
                  (SELECT MAX(created_at) FROM messages m WHERE m.channel_id = c.id) AS last_at
           FROM dm_members dm
           JOIN channels c ON c.id = dm.channel_id
           LEFT JOIN group_dms g ON g.channel_id = c.id
           WHERE dm.user_id = ? AND (? IS NULL OR c.id = ?)
           ORDER BY COALESCE(last_at, c.created_at) DESC`,
        )
        .all(userId, onlyChannel ?? null, onlyChannel ?? null) as Row[];
      const others = db.prepare(
        `SELECT u.* FROM dm_members dm JOIN users u ON u.id = dm.user_id
         WHERE dm.channel_id = ? AND dm.user_id != ? ORDER BY dm.joined_at, u.id`,
      );
      return rows.map((r) => {
        const members = (others.all(r.id as string, userId) as Row[]).map((u) => toUser(u));
        const group = r.g_owner ? { name: (r.g_name as string | null) ?? null, ownerId: r.g_owner as string } : null;
        return {
          channel: toChannel(r),
          user: group ? null : (members[0] ?? null),
          members,
          group,
          lastMessageAt: (r.last_at as number | null) ?? null,
        };
      });
    },

    // --- servers & membership ---------------------------------------------
    createServer(ownerId: string, name: string): { server: Server; channels: Channel[]; categories: Category[]; roles: Role[]; inviteCode: string } {
      const now = Date.now();
      const server: Server = { id: randomUUID(), name, ownerId, banner: null, icon: null };
      const inviteCode = newInviteCode();
      db.exec("BEGIN");
      try {
        db.prepare("INSERT INTO servers (id, name, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(server.id, name, ownerId, inviteCode, now);
        db.prepare("INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)").run(server.id, ownerId, now);
        // Like Discord's default server: a text and a voice category, one channel in each.
        const categories = [this.createCategory(server.id, "Canais de texto"), this.createCategory(server.id, "Canais de voz")];
        const channels = [
          this.insertChannel(server.id, "geral", "text", { categoryId: categories[0].id }),
          this.insertChannel(server.id, "Geral", "voice", { categoryId: categories[1].id }),
        ];
        const everyone: Role = {
          id: randomUUID(),
          serverId: server.id,
          name: "@everyone",
          color: null,
          permissions: DEFAULT_PERMISSIONS,
          position: 0,
          hoist: false,
          isDefault: true,
        };
        db.prepare(
          `INSERT INTO roles (id, server_id, name, color, permissions, position, hoist, is_default, created_at)
           VALUES (?, ?, '@everyone', NULL, ?, 0, 0, 1, ?)`,
        ).run(everyone.id, server.id, everyone.permissions, now);
        db.exec("COMMIT");
        return { server, channels, categories, roles: [everyone], inviteCode };
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
      ).map((r) => toUser(r));
    },

    /** Removes a member (kick or leave); their roles and nickname go with the membership row. */
    removeMember(serverId: string, userId: string): boolean {
      return db.prepare("DELETE FROM members WHERE server_id = ? AND user_id = ?").run(serverId, userId).changes > 0;
    },

    /** Sets a server image's file name (or null) and returns the previous one, so its file can be removed. */
    setServerImage(kind: ServerImageKind, serverId: string, file: string | null): string | null {
      // The column name comes from a fixed list, never from user input.
      const column = ({ banner: "banner", icon: "icon" } as const)[kind];
      const prev = db.prepare(`SELECT ${column} AS f FROM servers WHERE id = ?`).get(serverId) as Row | undefined;
      db.prepare(`UPDATE servers SET ${column} = ? WHERE id = ?`).run(file, serverId);
      return (prev?.f as string | null) ?? null;
    },

    renameServer(serverId: string, name: string): void {
      db.prepare("UPDATE servers SET name = ? WHERE id = ?").run(name, serverId);
    },

    deleteServer(serverId: string): void {
      db.prepare("DELETE FROM servers WHERE id = ?").run(serverId);
    },

    /** Nickname and role ids of every member, keyed by user id. */
    memberData(serverId: string): Record<string, MemberData> {
      const out: Record<string, MemberData> = {};
      for (const r of db.prepare("SELECT user_id, nickname FROM members WHERE server_id = ?").all(serverId) as Row[]) {
        out[r.user_id as string] = { nickname: (r.nickname as string | null) ?? null, roleIds: [] };
      }
      for (const r of db.prepare("SELECT user_id, role_id FROM member_roles WHERE server_id = ?").all(serverId) as Row[]) {
        out[r.user_id as string]?.roleIds.push(r.role_id as string);
      }
      return out;
    },

    memberInfo(serverId: string, userId: string): MemberData | null {
      const r = db.prepare("SELECT nickname FROM members WHERE server_id = ? AND user_id = ?").get(serverId, userId) as Row | undefined;
      if (!r) return null;
      const roleIds = (
        db.prepare("SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?").all(serverId, userId) as Row[]
      ).map((x) => x.role_id as string);
      return { nickname: (r.nickname as string | null) ?? null, roleIds };
    },

    setNickname(serverId: string, userId: string, nickname: string | null): void {
      db.prepare("UPDATE members SET nickname = ? WHERE server_id = ? AND user_id = ?").run(nickname, serverId, userId);
    },

    addMemberRole(serverId: string, userId: string, roleId: string): void {
      db.prepare("INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)").run(serverId, userId, roleId);
    },

    removeMemberRole(serverId: string, userId: string, roleId: string): void {
      db.prepare("DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?").run(serverId, userId, roleId);
    },

    // --- roles ------------------------------------------------------------
    roles(serverId: string): Role[] {
      return (db.prepare("SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC").all(serverId) as Row[]).map(toRole);
    },

    roleById(id: string): Role | null {
      const r = db.prepare("SELECT * FROM roles WHERE id = ?").get(id) as Row | undefined;
      return r ? toRole(r) : null;
    },

    /** New roles go to the bottom of the list, just above @everyone, like on Discord. */
    createRole(serverId: string, fields: { name: string; color: string | null; permissions: number; hoist: boolean }): Role {
      const role: Role = { id: randomUUID(), serverId, ...fields, position: 1, isDefault: false };
      db.exec("BEGIN");
      try {
        db.prepare("UPDATE roles SET position = position + 1 WHERE server_id = ? AND is_default = 0").run(serverId);
        db.prepare(
          `INSERT INTO roles (id, server_id, name, color, permissions, position, hoist, is_default, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?)`,
        ).run(role.id, serverId, role.name, role.color, role.permissions, role.hoist ? 1 : 0, Date.now());
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return role;
    },

    updateRole(id: string, fields: Partial<Pick<Role, "name" | "color" | "permissions" | "hoist">>): void {
      const r = this.roleById(id);
      if (!r) return;
      const next = { ...r, ...fields };
      db.prepare("UPDATE roles SET name = ?, color = ?, permissions = ?, hoist = ? WHERE id = ?").run(
        next.name,
        next.color,
        next.permissions,
        next.hoist ? 1 : 0,
        id,
      );
    },

    deleteRole(id: string): void {
      db.prepare("DELETE FROM roles WHERE id = ? AND is_default = 0").run(id);
    },

    swapRolePositions(a: Role, b: Role): void {
      db.exec("BEGIN");
      try {
        db.prepare("UPDATE roles SET position = ? WHERE id = ?").run(b.position, a.id);
        db.prepare("UPDATE roles SET position = ? WHERE id = ?").run(a.position, b.id);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    // --- channels ---------------------------------------------------------
    insertChannel(
      serverId: string,
      name: string,
      type: ChannelType,
      opts: { categoryId?: string | null; private?: boolean; roleIds?: string[] } = {},
    ): Channel {
      const pos = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE server_id = ?").get(serverId) as Row).p as number;
      const id = randomUUID();
      db.prepare("INSERT INTO channels (id, server_id, name, type, position, created_at, category_id, private) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        id,
        serverId,
        name,
        type,
        pos,
        Date.now(),
        opts.categoryId ?? null,
        opts.private ? 1 : 0,
      );
      if (opts.private) this.setChannelRoles(id, opts.roleIds ?? []);
      return this.channelById(id)!;
    },

    /** Every channel of a server, in display order within each category. */
    channels(serverId: string): Channel[] {
      return (db.prepare(`${CHANNEL_SELECT} WHERE c.server_id = ? ORDER BY c.position`).all(serverId) as Row[]).map(toChannel);
    },

    channelById(id: string): Channel | null {
      const r = db.prepare(`${CHANNEL_SELECT} WHERE c.id = ?`).get(id) as Row | undefined;
      return r ? toChannel(r) : null;
    },

    renameChannel(id: string, name: string): void {
      db.prepare("UPDATE channels SET name = ? WHERE id = ?").run(name, id);
    },

    /** Makes a channel private to these roles, or public again. */
    setChannelPrivacy(id: string, isPrivate: boolean, roleIds: string[]): void {
      db.prepare("UPDATE channels SET private = ? WHERE id = ?").run(isPrivate ? 1 : 0, id);
      this.setChannelRoles(id, isPrivate ? roleIds : []);
    },

    setChannelRoles(id: string, roleIds: string[]): void {
      db.prepare("DELETE FROM channel_roles WHERE channel_id = ?").run(id);
      for (const roleId of new Set(roleIds)) db.prepare("INSERT INTO channel_roles (channel_id, role_id) VALUES (?, ?)").run(id, roleId);
    },

    /**
     * Whether someone sees a channel: a DM's people; a server's members, except for a
     * private channel, which only the owner, administrators and its roles see.
     */
    canViewChannel(channel: Channel, userId: string): boolean {
      // A thread is seen by whoever sees its channel.
      if (channel.type === "thread") {
        const parent = channel.parentId ? this.channelById(channel.parentId) : null;
        return !!parent && this.canViewChannel(parent, userId);
      }
      if (!channel.serverId) return !!this.dmParticipants(channel.id)?.includes(userId);
      const info = this.memberInfo(channel.serverId, userId);
      if (!info) return false;
      if (!channel.private) return true;
      const server = this.serverById(channel.serverId)!;
      if (can(permissionsOf(server, this.roles(server.id), userId, info.roleIds), Permission.ADMINISTRATOR)) return true;
      return info.roleIds.some((id) => channel.roleIds.includes(id));
    },

    /** Server members who see this channel (all of them unless it's private). */
    channelViewers(channel: Channel): string[] {
      if (channel.type === "thread") {
        const parent = channel.parentId ? this.channelById(channel.parentId) : null;
        return parent ? this.channelViewers(parent) : [];
      }
      if (!channel.serverId) return this.dmParticipants(channel.id) ?? [];
      const ids = (db.prepare("SELECT user_id FROM members WHERE server_id = ?").all(channel.serverId) as Row[]).map((r) => r.user_id as string);
      return channel.private ? ids.filter((id) => this.canViewChannel(channel, id)) : ids;
    },

    /** The channels a member sees. */
    visibleChannels(serverId: string, userId: string): Channel[] {
      return this.channels(serverId).filter((c) => this.canViewChannel(c, userId));
    },

    /**
     * Moves a channel into a category (null = above all categories), before another
     * channel or at the end, and renumbers positions so the order is stable.
     */
    moveChannel(serverId: string, channelId: string, categoryId: string | null, beforeId: string | null): void {
      const order = this.channels(serverId).filter((c) => c.id !== channelId && c.type !== "thread");
      const at = beforeId ? order.findIndex((c) => c.id === beforeId) : -1;
      const ids = order.map((c) => c.id);
      if (at >= 0) ids.splice(at, 0, channelId);
      else ids.push(channelId);
      db.exec("BEGIN");
      try {
        db.prepare("UPDATE channels SET category_id = ? WHERE id = ?").run(categoryId, channelId);
        ids.forEach((id, i) => db.prepare("UPDATE channels SET position = ? WHERE id = ?").run(i, id));
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    /** A thread under a text channel, from one of its messages (or none). */
    createThread(parent: Channel, name: string, starterMessageId: string | null, creatorId: string): Channel {
      const id = randomUUID();
      db.prepare(
        "INSERT INTO channels (id, server_id, name, type, position, created_at, parent_id, starter_message_id, creator_id) VALUES (?, ?, ?, 'thread', 0, ?, ?, ?, ?)",
      ).run(id, parent.serverId, name, Date.now(), parent.id, starterMessageId, creatorId);
      return this.channelById(id)!;
    },

    threadOf(messageId: string): Channel | null {
      const r = db.prepare(`${CHANNEL_SELECT} WHERE c.starter_message_id = ?`).get(messageId) as Row | undefined;
      return r ? toChannel(r) : null;
    },

    // --- categories -------------------------------------------------------
    categories(serverId: string): Category[] {
      return (db.prepare("SELECT * FROM categories WHERE server_id = ? ORDER BY position").all(serverId) as Row[]).map((r) => ({
        id: r.id as string,
        serverId: r.server_id as string,
        name: r.name as string,
        position: r.position as number,
      }));
    },

    categoryById(id: string): Category | null {
      const r = db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as Row | undefined;
      return r ? { id: r.id as string, serverId: r.server_id as string, name: r.name as string, position: r.position as number } : null;
    },

    createCategory(serverId: string, name: string): Category {
      const position = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM categories WHERE server_id = ?").get(serverId) as Row).p as number;
      const category: Category = { id: randomUUID(), serverId, name, position };
      db.prepare("INSERT INTO categories (id, server_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)").run(category.id, serverId, name, position, Date.now());
      return category;
    },

    renameCategory(id: string, name: string): void {
      db.prepare("UPDATE categories SET name = ? WHERE id = ?").run(name, id);
    },

    /** Deletes a category; its channels stay, without a category. */
    deleteCategory(id: string): void {
      db.prepare("UPDATE channels SET category_id = NULL WHERE category_id = ?").run(id);
      db.prepare("DELETE FROM categories WHERE id = ?").run(id);
    },

    moveCategory(serverId: string, categoryId: string, beforeId: string | null): void {
      const ids = this.categories(serverId).map((c) => c.id).filter((id) => id !== categoryId);
      const at = beforeId ? ids.indexOf(beforeId) : -1;
      if (at >= 0) ids.splice(at, 0, categoryId);
      else ids.push(categoryId);
      ids.forEach((id, i) => db.prepare("UPDATE categories SET position = ? WHERE id = ?").run(i, id));
    },

    // --- bans ---------------------------------------------------------------
    isBanned(serverId: string, userId: string): boolean {
      return db.prepare("SELECT 1 FROM bans WHERE server_id = ? AND user_id = ?").get(serverId, userId) !== undefined;
    },

    ban(serverId: string, userId: string, bannedBy: string, reason: string | null): void {
      db.prepare("INSERT OR REPLACE INTO bans (server_id, user_id, banned_by, reason, created_at) VALUES (?, ?, ?, ?, ?)").run(
        serverId,
        userId,
        bannedBy,
        reason,
        Date.now(),
      );
    },

    unban(serverId: string, userId: string): boolean {
      return db.prepare("DELETE FROM bans WHERE server_id = ? AND user_id = ?").run(serverId, userId).changes > 0;
    },

    bans(serverId: string): Ban[] {
      return (
        db.prepare("SELECT b.reason, b.created_at, u.* FROM bans b JOIN users u ON u.id = b.user_id WHERE b.server_id = ? ORDER BY b.created_at DESC").all(serverId) as Row[]
      ).map((r) => ({ user: toUser(r), reason: (r.reason as string | null) ?? null, createdAt: r.created_at as number }));
    },

    // --- invites ------------------------------------------------------------
    /** maxAgeMs null = never expires. */
    createInvite(serverId: string, creatorId: string, maxUses: number | null, maxAgeMs: number | null): Invite {
      const now = Date.now();
      const invite: Invite = { code: newInviteCode(), serverId, creatorId, maxUses, uses: 0, expiresAt: maxAgeMs ? now + maxAgeMs : null, createdAt: now };
      db.prepare("INSERT INTO invites (code, server_id, creator_id, max_uses, uses, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)").run(
        invite.code,
        serverId,
        creatorId,
        maxUses,
        invite.expiresAt,
        invite.createdAt,
      );
      return invite;
    },

    /** Invites that still work. */
    invites(serverId: string): Invite[] {
      return (
        db
          .prepare("SELECT * FROM invites WHERE server_id = ? AND (expires_at IS NULL OR expires_at > ?) AND (max_uses IS NULL OR uses < max_uses) ORDER BY created_at DESC")
          .all(serverId, Date.now()) as Row[]
      ).map(toInvite);
    },

    inviteByCode(code: string): Invite | null {
      const r = db.prepare("SELECT * FROM invites WHERE code = ?").get(code) as Row | undefined;
      return r ? toInvite(r) : null;
    },

    /** Counts a use; false when the invite expired or ran out meanwhile. */
    useInvite(code: string): boolean {
      return (
        db
          .prepare("UPDATE invites SET uses = uses + 1 WHERE code = ? AND (expires_at IS NULL OR expires_at > ?) AND (max_uses IS NULL OR uses < max_uses)")
          .run(code, Date.now()).changes > 0
      );
    },

    deleteInvite(code: string): void {
      db.prepare("DELETE FROM invites WHERE code = ?").run(code);
    },

    /** Gives the server a new original invite code, so links with the old one stop working. */
    resetServerInvite(serverId: string): void {
      db.prepare("UPDATE servers SET invite_code = ? WHERE id = ?").run(newInviteCode(), serverId);
    },

    /** The server an invite code leads to: a working invite, or the server's original code. */
    serverForInvite(code: string): { server: Server; invite: Invite | null } | null {
      const invite = this.inviteByCode(code);
      if (invite) {
        const valid = (invite.expiresAt === null || invite.expiresAt > Date.now()) && (invite.maxUses === null || invite.uses < invite.maxUses);
        const server = valid ? this.serverById(invite.serverId) : null;
        return server ? { server, invite } : null;
      }
      const server = this.serverByInvite(code);
      return server ? { server, invite: null } : null;
    },

    deleteChannel(id: string): void {
      db.prepare("DELETE FROM channels WHERE id = ? AND type != 'dm'").run(id);
    },

    // --- messages ---------------------------------------------------------
    insertMessage(
      channelId: string,
      author: PublicUser,
      content: string,
      clip?: StoredClip,
      id: string = randomUUID(),
      replyTo: string | null = null,
    ): Message {
      const json = clip ? JSON.stringify(clip) : null;
      const createdAt = Date.now();
      db.prepare("INSERT INTO messages (id, channel_id, author_id, content, created_at, attachment, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, channelId, author.id, content, createdAt, json, replyTo);
      return this.messageById(id)!;
    },

    setMentions(id: string, userIds: string[], everyone: boolean) {
      db.prepare("UPDATE messages SET mentions = ?, mention_everyone = ? WHERE id = ?").run(userIds.length ? JSON.stringify(userIds) : null, everyone ? 1 : 0, id);
    },

    /** Ids of the people who can read a channel among these usernames (server members, or the DM's two). */
    audienceByUsernames(channel: Channel, usernames: string[]): string[] {
      if (usernames.length === 0) return [];
      const marks = usernames.map(() => "?").join(",");
      if (channel.serverId) {
        return (
          db
            .prepare(`SELECT u.id FROM users u JOIN members m ON m.user_id = u.id WHERE m.server_id = ? AND lower(u.username) IN (${marks})`)
            .all(channel.serverId, ...usernames) as Row[]
        )
          .map((r) => r.id as string)
          .filter((id) => !channel.private || this.canViewChannel(channel, id));
      }
      const people: string[] = this.dmParticipants(channel.id) ?? [];
      return (db.prepare(`SELECT id FROM users WHERE lower(username) IN (${marks})`).all(...usernames) as Row[])
        .map((r) => r.id as string)
        .filter((id) => people.includes(id));
    },

    /** Changes a message's text and marks it edited. */
    editMessage(id: string, content: string) {
      db.prepare("UPDATE messages SET content = ?, edited_at = ? WHERE id = ?").run(content, Date.now(), id);
    },

    /** Whether a message has something besides text (files or a clip), so its text may be emptied. */
    hasMedia(id: string): boolean {
      const r = db.prepare("SELECT attachment, (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS n FROM messages m WHERE id = ?").get(id) as Row | undefined;
      return !!r && (r.attachment !== null || (r.n as number) > 0);
    },

    // --- reactions ------------------------------------------------------------
    /** Adds a reaction; false when the message already has the maximum number of different emojis. */
    addReaction(messageId: string, userId: string, emoji: string, maxKinds: number): boolean {
      const kinds = db.prepare("SELECT COUNT(DISTINCT emoji) AS n, SUM(emoji = ?) AS has FROM reactions WHERE message_id = ?").get(emoji, messageId) as Row;
      if (!(kinds.has as number) && (kinds.n as number) >= maxKinds) return false;
      db.prepare("INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)").run(messageId, userId, emoji, Date.now());
      return true;
    },

    removeReaction(messageId: string, userId: string, emoji: string) {
      db.prepare("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?").run(messageId, userId, emoji);
    },

    reactionsOf(messageId: string): Reaction[] {
      return groupReactions(db.prepare("SELECT * FROM reactions WHERE message_id = ? ORDER BY created_at").all(messageId) as Row[]).get(messageId) ?? [];
    },

    /** Who wrote a message, where, and its clip file (for deleting it). */
    messageInfo(id: string): { channelId: string; authorId: string; clipFile: string | null } | null {
      const r = db.prepare("SELECT channel_id, author_id, attachment FROM messages WHERE id = ?").get(id) as Row | undefined;
      if (!r) return null;
      const clip = typeof r.attachment === "string" ? (JSON.parse(r.attachment) as StoredClip) : null;
      return { channelId: r.channel_id as string, authorId: r.author_id as string, clipFile: clip && !clip.expired ? clip.file : null };
    },

    deleteMessage(id: string) {
      db.prepare("DELETE FROM messages WHERE id = ?").run(id);
    },

    /** Marks the clips of these messages as deleted; returns the messages that changed. */
    expireClips(messageIds: string[]): Message[] {
      const changed: Message[] = [];
      for (const id of messageIds) {
        const r = db
          .prepare(
            `UPDATE messages SET attachment = json_set(attachment, '$.expired', json('true'))
             WHERE id = ? AND attachment IS NOT NULL RETURNING id`,
          )
          .get(id);
        if (!r) continue;
        changed.push(this.messageById(id)!);
      }
      return changed;
    },

    messageById(id: string): Message | null {
      const r = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id) as Row | undefined;
      return r ? hydrate([toMessage(r)])[0] : null;
    },

    // --- attachments --------------------------------------------------------
    insertUpload(u: Omit<UploadRow, "messageId" | "expired" | "createdAt">): UploadRow {
      const createdAt = Date.now();
      db.prepare(
        "INSERT INTO attachments (id, owner_id, name, kind, mime, size, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(u.id, u.ownerId, u.name, u.kind, u.mime, u.size, u.width, u.height, createdAt);
      return { ...u, messageId: null, expired: false, createdAt };
    },

    uploadById(id: string): UploadRow | null {
      const r = db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as Row | undefined;
      return r ? toUpload(r) : null;
    },

    deleteUpload(id: string) {
      db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
    },

    /** Attaches the owner's pending uploads to a message, in the given order; false if any isn't theirs or is taken. */
    attachUploads(messageId: string, ownerId: string, ids: string[]): boolean {
      const stmt = db.prepare("UPDATE attachments SET message_id = ?, position = ? WHERE id = ? AND owner_id = ? AND message_id IS NULL");
      return ids.every((id, i) => Number(stmt.run(messageId, i, id, ownerId).changes) === 1);
    },

    /** Ids of the files of a message (to delete them with it). */
    fileIdsOf(messageId: string): string[] {
      return (db.prepare("SELECT id FROM attachments WHERE message_id = ?").all(messageId) as Row[]).map((r) => r.id as string);
    },

    /** Uploads never attached to a message, older than `before`. */
    staleUploads(before: number): string[] {
      return (db.prepare("SELECT id FROM attachments WHERE message_id IS NULL AND created_at < ?").all(before) as Row[]).map((r) => r.id as string);
    },

    /** Marks files as deleted (to free space); returns the messages that changed. */
    expireFiles(ids: string[]): Message[] {
      const messageIds = new Set<string>();
      for (const id of ids) {
        const r = db.prepare("UPDATE attachments SET expired = 1 WHERE id = ? RETURNING message_id").get(id) as Row | undefined;
        if (r?.message_id) messageIds.add(r.message_id as string);
      }
      return [...messageIds].map((id) => this.messageById(id)).filter((m): m is Message => !!m);
    },

    /** Newest `limit` messages older than `before`, returned oldest first. */
    // --- custom emojis -----------------------------------------------------
    emojis(serverId: string): CustomEmoji[] {
      return (db.prepare("SELECT * FROM emojis WHERE server_id = ? ORDER BY created_at").all(serverId) as Row[]).map(toEmoji);
    },

    /** Every emoji of the servers this person is in (they can use them anywhere). */
    emojisForUser(userId: string): CustomEmoji[] {
      return (
        db.prepare("SELECT e.* FROM emojis e JOIN members m ON m.server_id = e.server_id WHERE m.user_id = ? ORDER BY m.joined_at, e.created_at").all(userId) as Row[]
      ).map(toEmoji);
    },

    emojiById(id: string): (CustomEmoji & { file: string }) | null {
      const r = db.prepare("SELECT * FROM emojis WHERE id = ?").get(id) as Row | undefined;
      return r ? { ...toEmoji(r), file: r.file as string } : null;
    },

    emojiNameTaken(serverId: string, name: string, exceptId = ""): boolean {
      return db.prepare("SELECT 1 FROM emojis WHERE server_id = ? AND name = ? COLLATE NOCASE AND id != ?").get(serverId, name, exceptId) !== undefined;
    },

    addEmoji(serverId: string, name: string, file: string, animated: boolean, creatorId: string): CustomEmoji {
      const id = randomUUID();
      db.prepare("INSERT INTO emojis (id, server_id, name, file, animated, creator_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        id,
        serverId,
        name,
        file,
        animated ? 1 : 0,
        creatorId,
        Date.now(),
      );
      return this.emojiById(id)!;
    },

    renameEmoji(id: string, name: string): void {
      db.prepare("UPDATE emojis SET name = ? WHERE id = ?").run(name, id);
    },

    deleteEmoji(id: string): void {
      db.prepare("DELETE FROM emojis WHERE id = ?").run(id);
    },

    /** Pins or unpins a message; false when the channel already has the maximum. */
    setPinned(messageId: string, pinned: boolean, max: number): boolean {
      if (pinned) {
        const info = db.prepare("SELECT channel_id, pinned_at FROM messages WHERE id = ?").get(messageId) as { channel_id: string; pinned_at: number | null } | undefined;
        if (!info || info.pinned_at) return true;
        const n = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL").get(info.channel_id) as Row).n as number;
        if (n >= max) return false;
      }
      db.prepare("UPDATE messages SET pinned_at = ? WHERE id = ?").run(pinned ? Date.now() : null, messageId);
      return true;
    },

    /** Links of this message whose preview is missing or older than `maxAge`. */
    stalePreviews(content: string, maxAge: number): string[] {
      const links = previewLinks(content);
      if (!links.length) return [];
      const fresh = new Set(
        (db.prepare(`SELECT url FROM link_previews WHERE url IN (${links.map(() => "?").join(",")}) AND fetched_at > ?`).all(...links, Date.now() - maxAge) as Row[]).map(
          (r) => r.url as string,
        ),
      );
      return links.filter((u) => !fresh.has(u));
    },

    savePreview(url: string, embed: LinkEmbed | null): void {
      db.prepare(
        "INSERT INTO link_previews (url, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT (url) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at",
      ).run(url, embed ? JSON.stringify(embed) : null, Date.now());
    },

    pinnedMessages(channelId: string): Message[] {
      const rows = db.prepare(`${MESSAGE_SELECT} WHERE m.channel_id = ? AND m.pinned_at IS NOT NULL ORDER BY m.pinned_at DESC`).all(channelId) as Row[];
      return hydrate(rows.map(toMessage));
    },

    /** Messages around one (for jumping to it): `half` before and after, and whether there are newer ones. */
    messagesAround(channelId: string, messageId: string, half: number): { messages: Message[]; hasNewer: boolean } | null {
      const at = db.prepare("SELECT created_at, rowid AS r FROM messages WHERE id = ? AND channel_id = ?").get(messageId, channelId) as { created_at: number; r: number } | undefined;
      if (!at) return null;
      const older = db
        .prepare(`${MESSAGE_SELECT} WHERE m.channel_id = ? AND (m.created_at < ? OR (m.created_at = ? AND m.rowid <= ?)) ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`)
        .all(channelId, at.created_at, at.created_at, at.r, half + 1) as Row[];
      const newer = db
        .prepare(`${MESSAGE_SELECT} WHERE m.channel_id = ? AND (m.created_at > ? OR (m.created_at = ? AND m.rowid > ?)) ORDER BY m.created_at, m.rowid LIMIT ?`)
        .all(channelId, at.created_at, at.created_at, at.r, half + 1) as Row[];
      const hasNewer = newer.length > half;
      return { messages: hydrate([...older.reverse(), ...newer.slice(0, half)].map(toMessage)), hasNewer };
    },

    /**
     * Search: words (all of them, the last one as a prefix) in these channels, newest first,
     * optionally by author and with files, images, videos, links or clips. Skips people the
     * searcher blocked.
     */
    searchMessages(
      viewerId: string,
      channelIds: string[],
      opts: { words: string[]; authorId?: string; has?: "file" | "image" | "video" | "link" | "clip"; offset: number; limit: number },
    ): { messages: Message[]; total: number } {
      if (channelIds.length === 0) return { messages: [], total: 0 };
      const where: string[] = [`m.channel_id IN (${channelIds.map(() => "?").join(",")})`, "m.author_id NOT IN (SELECT blocked_id FROM blocks WHERE user_id = ?)"];
      const params: (string | number)[] = [...channelIds, viewerId];
      let from = "messages m";
      if (opts.words.length) {
        from = "messages_fts f JOIN messages m ON m.rowid = f.rowid";
        where.push("messages_fts MATCH ?");
        params.push(opts.words.map((w, i) => `"${w.replace(/"/g, "")}"${i === opts.words.length - 1 ? "*" : ""}`).join(" "));
      }
      if (opts.authorId) {
        where.push("m.author_id = ?");
        params.push(opts.authorId);
      }
      if (opts.has === "link") where.push("(m.content LIKE '%http://%' OR m.content LIKE '%https://%')");
      else if (opts.has === "clip") where.push("m.attachment IS NOT NULL");
      else if (opts.has) {
        where.push(`EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id${opts.has === "file" ? "" : " AND a.kind = ?"})`);
        if (opts.has !== "file") params.push(opts.has);
      }
      const clause = where.join(" AND ");
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${clause}`).get(...params) as Row).n as number;
      const ids = (
        db.prepare(`SELECT m.id FROM ${from} WHERE ${clause} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`).all(...params, opts.limit, opts.offset) as Row[]
      ).map((r) => r.id as string);
      return { messages: ids.map((id) => this.messageById(id)!).filter(Boolean), total };
    },

    messages(channelId: string, before: number, limit: number): Message[] {
      const rows = db
        .prepare(`${MESSAGE_SELECT} WHERE m.channel_id = ? AND m.created_at < ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`)
        .all(channelId, before, limit) as Row[];
      return hydrate(rows.map(toMessage).reverse());
    },
  };

  /** Fills in what lives in other tables (files), for a page of messages at once. */
  function hydrate(msgs: Message[]): Message[] {
    if (msgs.length === 0) return msgs;
    const marks = msgs.map(() => "?").join(",");
    const files = db
      .prepare(`SELECT * FROM attachments WHERE message_id IN (${marks}) ORDER BY position`)
      .all(...msgs.map((m) => m.id)) as Row[];
    const byMessage = new Map<string, FileAttachment[]>();
    for (const r of files) {
      const u = toUpload(r);
      const list = byMessage.get(u.messageId!) ?? [];
      list.push(toFileAttachment(u));
      byMessage.set(u.messageId!, list);
    }
    for (const m of msgs) m.files = byMessage.get(m.id) ?? [];

    const reactions = groupReactions(
      db.prepare(`SELECT * FROM reactions WHERE message_id IN (${marks}) ORDER BY created_at`).all(...msgs.map((m) => m.id)) as Row[],
    );
    for (const m of msgs) m.reactions = reactions.get(m.id) ?? [];
    // Threads started from these messages, with how many messages they have.
    for (const r of db
      .prepare(
        `SELECT c.id, c.name, c.starter_message_id, (SELECT COUNT(*) FROM messages x WHERE x.channel_id = c.id) AS n,
                (SELECT MAX(created_at) FROM messages x WHERE x.channel_id = c.id) AS last_at
         FROM channels c WHERE c.starter_message_id IN (${marks})`,
      )
      .all(...msgs.map((m) => m.id)) as Row[]) {
      const m = msgs.find((x) => x.id === r.starter_message_id);
      if (m) m.thread = { id: r.id as string, name: r.name as string, count: r.n as number, lastAt: (r.last_at as number | null) ?? null };
    }
    // Link previews, from the cache by URL.
    const links = new Map(msgs.map((m) => [m.id, previewLinks(m.content)]));
    const urls = [...new Set([...links.values()].flat())];
    if (urls.length) {
      const cached = new Map(
        (db.prepare(`SELECT url, data FROM link_previews WHERE data IS NOT NULL AND url IN (${urls.map(() => "?").join(",")})`).all(...urls) as Row[]).map(
          (r) => [r.url as string, JSON.parse(r.data as string) as LinkEmbed],
        ),
      );
      for (const m of msgs) m.embeds = (links.get(m.id) ?? []).flatMap((u) => cached.get(u) ?? []);
    }

    // Replies: a short preview of each original (it may live on an older page, or be gone).
    const replyIds = [...new Set(msgs.flatMap((m) => (m.replyTo ? [m.replyTo.id] : [])))];
    if (replyIds.length) {
      const rows = db
        .prepare(
          `SELECT m.*, u.username, u.display_name, u.avatar, u.profile_banner,
                  (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS nfiles
           FROM messages m JOIN users u ON u.id = m.author_id WHERE m.id IN (${replyIds.map(() => "?").join(",")})`,
        )
        .all(...replyIds) as Row[];
      const originals = new Map(rows.map((r) => [r.id as string, r]));
      for (const m of msgs) {
        if (!m.replyTo) continue;
        const o = originals.get(m.replyTo.id);
        if (!o) continue;
        m.replyTo = {
          id: o.id as string,
          author: toUser(o, o.author_id as string),
          content: (o.content as string).slice(0, 200),
          hasFiles: (o.nfiles as number) > 0 || o.attachment !== null,
        };
      }
    }
    return msgs;
  }
}

export type Store = ReturnType<typeof createStore>;
