// REST client + the types shared with the server.

import type { VoiceMember } from "./voice/types.ts";
import type { NotifyLevel, NotifySettings } from "./notifications.ts";

export interface User {
  id: string;
  username: string;
  displayName: string;
  /** URL of the profile picture, or null (initials are shown instead). */
  avatar: string | null;
  /** URL of the profile banner, or null. */
  banner: string | null;
}

export type ProfileImageKind = "avatar" | "banner";

export interface Server {
  id: string;
  name: string;
  ownerId: string;
  /** URL of the banner image, or null. */
  banner: string | null;
  /** URL of the icon image, or null (initials are shown instead). */
  icon: string | null;
}

export type ServerImageKind = "banner" | "icon";

export type ChannelType = "text" | "voice" | "dm";

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
}

export interface Category {
  id: string;
  serverId: string;
  name: string;
  position: number;
}

export interface Invite {
  code: string;
  serverId: string;
  creatorId: string | null;
  maxUses: number | null;
  uses: number;
  expiresAt: number | null;
  createdAt: number;
  creator?: User | null;
}

export interface Ban {
  user: User;
  reason: string | null;
  createdAt: number;
}

export interface Message {
  id: string;
  channelId: string;
  author: User;
  content: string;
  createdAt: number;
  attachment: ClipAttachment | null;
  files: FileAttachment[];
  /** The message this one answers; `author` is null when the original was deleted. */
  replyTo: { id: string; author: User | null; content: string; hasFiles: boolean } | null;
  editedAt: number | null;
  reactions: Reaction[];
  /** Ids of the people it pings (by @name or by replying), and whether it pings @everyone. */
  mentions: string[];
  mentionsEveryone: boolean;
  /** Only on live "message:new" events: the server of the channel (null in DMs). */
  serverId?: string | null;
}

export interface Reaction {
  emoji: string;
  userIds: string[];
}

/** A file sent in chat. `url` is null once the server deleted it to free space. */
export interface FileAttachment {
  id: string;
  name: string;
  kind: "image" | "video" | "file";
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  url: string | null;
}

/** A GIF result from the server's GIF search (GIPHY). */
export interface Gif {
  id: string;
  title: string;
  preview: string;
  url: string;
  width: number;
  height: number;
}

/** Limits the server enforces on chat files. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 10;

/** An instant replay posted in chat. `url` is null once the server deleted it to free space. */
export interface ClipAttachment {
  kind: "clip";
  url: string | null;
  mime: string;
  size: number;
  duration: number;
  width: number;
  height: number;
}

/** Largest clip the server accepts. */
export const MAX_CLIP_BYTES = 100 * 1024 * 1024;

export type UserStatus = "online" | "idle" | "dnd" | "invisible";
export type PresenceStatus = "online" | "idle" | "dnd" | "offline";

export interface Activity {
  name: string;
  startedAt: number;
}

export interface Presence {
  status: PresenceStatus;
  activity: Activity | null;
}

export type FriendState = "accepted" | "incoming" | "outgoing";

export interface Friend {
  user: User;
  state: FriendState;
}

export interface DmSummary {
  channel: Channel;
  /** The other participant of a 1:1 DM; null in a group. */
  user: User | null;
  /** Everyone else in the conversation. */
  members: User[];
  /** Set for a group DM. */
  group: { name: string | null; ownerId: string } | null;
  lastMessageAt: number | null;
}

/** People in a group DM, the owner included. */
export const MAX_GROUP_DM = 10;

/** A conversation's name: the person, or the group's name (or its people's). */
export function dmTitle(d: DmSummary): string {
  if (!d.group) return d.user?.displayName ?? "Conversa";
  return d.group.name || d.members.map((u) => u.displayName).join(", ") || "Grupo vazio";
}

export interface Role {
  id: string;
  serverId: string;
  name: string;
  color: string | null;
  permissions: number;
  position: number;
  hoist: boolean;
  isDefault: boolean;
}

export interface MemberData {
  nickname: string | null;
  roleIds: string[];
}

export interface ServerDetails {
  server: Server;
  /** The channels you see (private ones only if you have access). */
  channels: Channel[];
  categories: Category[];
  members: User[];
  /** Presence of members who are not offline. */
  presence: Record<string, Presence>;
  /** Voice channel id -> who is in it. */
  voice: Record<string, VoiceMember[]>;
  /** Highest position first; the last one is @everyone. */
  roles: Role[];
  /** user id -> nickname and roles in this server. */
  memberData: Record<string, MemberData>;
}

const TOKEN_KEY = "voxa.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable (private mode): the session just won't survive a reload.
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  // Blobs (images) are sent as-is; everything else as JSON.
  const isBlob = body instanceof Blob;
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": isBlob ? body.type : "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : isBlob ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "Algo deu errado.");
  return data as T;
}

type AuthResult = { token: string; user: User };

export const api = {
  register: (username: string, password: string, displayName?: string) =>
    request<AuthResult>("POST", "/api/auth/register", { username, password, displayName }),
  login: (username: string, password: string) => request<AuthResult>("POST", "/api/auth/login", { username, password }),
  logout: () => request<void>("POST", "/api/auth/logout"),
  me: () =>
    request<{
      user: User;
      /** Confirmed e-mail, for password recovery. */
      email: string | null;
      servers: Server[];
      status: UserStatus;
      activity: Activity | null;
      features?: { gifs: boolean; email: boolean; push: boolean };
      /** Channels with unseen messages (and how many mention you). */
      unread: Record<string, { mentions: number; serverId: string | null }>;
      notify: NotifySettings;
      /** People you blocked. */
      blocked: string[];
    }>("GET", "/api/me"),
  search: (scope: string, q: string, offset = 0) =>
    request<{ messages: Message[]; total: number }>("GET", `/api/search?${new URLSearchParams({ scope, q, offset: String(offset) })}`),
  messagesAround: (channelId: string, messageId: string) =>
    request<{ messages: Message[]; hasNewer: boolean }>("GET", `/api/channels/${channelId}/messages/around/${messageId}`),
  markRead: (channelId: string, at: number) => request<{ lastReadAt: number }>("POST", `/api/channels/${channelId}/read`, { at }),
  setNotify: (targetId: string, level: NotifyLevel | null, mutedUntil: number | null) =>
    request<{ notify: NotifySettings }>("PUT", `/api/notify/${targetId}`, { level, mutedUntil }),
  blocks: () => request<{ users: User[] }>("GET", "/api/blocks"),
  block: (userId: string) => request<void>("PUT", `/api/blocks/${userId}`),
  unblock: (userId: string) => request<void>("DELETE", `/api/blocks/${userId}`),
  pushKey: () => request<{ publicKey: string }>("GET", "/api/push/key"),
  pushSubscribe: (sub: PushSubscriptionJSON) => request<void>("POST", "/api/push/subscribe", sub),
  pushUnsubscribe: (endpoint: string) => request<void>("DELETE", "/api/push/subscribe", { endpoint }),
  authOptions: () => request<{ passwordReset: boolean }>("GET", "/api/auth/options"),
  forgotPassword: (login: string) => request<{ ok: true }>("POST", "/api/auth/forgot", { login }),
  resetPassword: (token: string, password: string) => request<AuthResult>("POST", "/api/auth/reset", { token, password }),
  verifyEmail: (token: string) => request<{ email: string }>("POST", "/api/auth/verify-email", { token }),
  setEmail: (email: string, password: string) => request<{ pending: string }>("PUT", "/api/me/email", { email, password }),
  removeEmail: () => request<void>("DELETE", "/api/me/email"),
  gifs: (query: string, offset = 0) =>
    request<{ gifs: Gif[] }>("GET", `/api/gifs?${new URLSearchParams({ q: query, offset: String(offset) })}`),
  setPresence: (patch: { status?: UserStatus; activity?: string | null }) =>
    request<{ status: UserStatus; presence: Presence }>("PATCH", "/api/me/presence", patch),

  friends: () => request<{ friends: Friend[]; presence: Record<string, Presence> }>("GET", "/api/friends"),
  addFriend: (username: string) => request<{ state: FriendState; user: User }>("POST", "/api/friends", { username }),
  acceptFriend: (userId: string) => request<{ state: FriendState }>("POST", `/api/friends/${userId}/accept`),
  removeFriend: (userId: string) => request<void>("DELETE", `/api/friends/${userId}`),

  dms: () => request<{ dms: DmSummary[]; presence: Record<string, Presence>; calls: Record<string, VoiceMember[]> }>("GET", "/api/dms"),
  openDm: (userId: string) => request<{ dm: DmSummary }>("POST", "/api/dms", { userId }),
  createGroupDm: (userIds: string[], name?: string) => request<{ dm: DmSummary }>("POST", "/api/dms/group", { userIds, name }),
  renameGroupDm: (channelId: string, name: string) => request<{ dm: DmSummary }>("PATCH", `/api/dms/${channelId}`, { name }),
  addToGroupDm: (channelId: string, userId: string) => request<{ dm: DmSummary }>("POST", `/api/dms/${channelId}/members`, { userId }),
  removeFromGroupDm: (channelId: string, userId: string) => request<void>("DELETE", `/api/dms/${channelId}/members/${userId}`),

  createServer: (name: string) => request<{ server: Server; channels: Channel[]; categories: Category[]; roles: Role[] }>("POST", "/api/servers", { name }),
  renameServer: (id: string, name: string) => request<{ server: Server }>("PATCH", `/api/servers/${id}`, { name }),
  deleteServer: (id: string) => request<void>("DELETE", `/api/servers/${id}`),
  uploadServerImage: (id: string, kind: ServerImageKind, image: Blob) => request<{ server: Server }>("PUT", `/api/servers/${id}/${kind}`, image),
  removeServerImage: (id: string, kind: ServerImageKind) => request<{ server: Server }>("DELETE", `/api/servers/${id}/${kind}`),
  leaveServer: (id: string) => request<void>("POST", `/api/servers/${id}/leave`),

  setNickname: (serverId: string, userId: string, nickname: string | null) =>
    request<MemberData>("PATCH", `/api/servers/${serverId}/members/${userId}`, { nickname }),
  addMemberRole: (serverId: string, userId: string, roleId: string) =>
    request<MemberData>("PUT", `/api/servers/${serverId}/members/${userId}/roles/${roleId}`),
  removeMemberRole: (serverId: string, userId: string, roleId: string) =>
    request<MemberData>("DELETE", `/api/servers/${serverId}/members/${userId}/roles/${roleId}`),
  kickMember: (serverId: string, userId: string) => request<void>("DELETE", `/api/servers/${serverId}/members/${userId}`),
  banMember: (serverId: string, userId: string, reason: string | null) => request<void>("PUT", `/api/servers/${serverId}/bans/${userId}`, { reason }),
  unban: (serverId: string, userId: string) => request<void>("DELETE", `/api/servers/${serverId}/bans/${userId}`),
  bans: (serverId: string) => request<{ bans: Ban[] }>("GET", `/api/servers/${serverId}/bans`),

  /** maxAge in seconds (0 = never expires), maxUses (0 = unlimited). */
  createInvite: (serverId: string, maxAge: number, maxUses: number) =>
    request<{ invite: Invite }>("POST", `/api/servers/${serverId}/invites`, { maxAge, maxUses }),
  invites: (serverId: string) => request<{ invites: Invite[] }>("GET", `/api/servers/${serverId}/invites`),
  deleteInvite: (code: string) => request<void>("DELETE", `/api/invites/${code}`),
  resetServerInvite: (serverId: string) => request<void>("POST", `/api/servers/${serverId}/invites/reset`),

  createRole: (serverId: string, fields: Partial<Pick<Role, "name" | "color" | "permissions" | "hoist">> = {}) =>
    request<{ role: Role }>("POST", `/api/servers/${serverId}/roles`, fields),
  updateRole: (serverId: string, roleId: string, fields: Partial<Pick<Role, "name" | "color" | "permissions" | "hoist">>) =>
    request<{ role: Role }>("PATCH", `/api/servers/${serverId}/roles/${roleId}`, fields),
  deleteRole: (serverId: string, roleId: string) => request<void>("DELETE", `/api/servers/${serverId}/roles/${roleId}`),
  moveRole: (serverId: string, roleId: string, direction: "up" | "down") =>
    request<{ roles: Role[] }>("POST", `/api/servers/${serverId}/roles/${roleId}/move`, { direction }),

  updateChannel: (id: string, patch: { name?: string; private?: boolean; roleIds?: string[] }) =>
    request<{ channel: Channel }>("PATCH", `/api/channels/${id}`, patch),
  moveChannel: (id: string, categoryId: string | null, beforeId: string | null) =>
    request<void>("POST", `/api/channels/${id}/move`, { categoryId, beforeId }),
  createCategory: (serverId: string, name: string) => request<{ category: Category }>("POST", `/api/servers/${serverId}/categories`, { name }),
  renameCategory: (id: string, name: string) => request<{ category: Category }>("PATCH", `/api/categories/${id}`, { name }),
  deleteCategory: (id: string) => request<void>("DELETE", `/api/categories/${id}`),
  moveCategory: (id: string, beforeId: string | null) => request<void>("POST", `/api/categories/${id}/move`, { beforeId }),
  deleteChannel: (id: string) => request<void>("DELETE", `/api/channels/${id}`),

  updateProfile: (displayName: string) => request<{ user: User }>("PATCH", "/api/me", { displayName }),
  uploadProfileImage: (kind: ProfileImageKind, image: Blob) => request<{ user: User }>("PUT", `/api/me/${kind}`, image),
  removeProfileImage: (kind: ProfileImageKind) => request<{ user: User }>("DELETE", `/api/me/${kind}`),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>("POST", "/api/me/password", { currentPassword, newPassword }),
  server: (id: string) => request<ServerDetails>("GET", `/api/servers/${id}`),
  createChannel: (serverId: string, fields: { name: string; type: ChannelType; categoryId: string | null; private: boolean; roleIds: string[] }) =>
    request<{ channel: Channel }>("POST", `/api/servers/${serverId}/channels`, fields),

  invite: (code: string) =>
    request<{ server: Pick<Server, "id" | "name" | "banner" | "icon">; memberCount: number; expiresAt: number | null }>("GET", `/api/invites/${code}`),
  joinInvite: (code: string) => request<{ server: Server }>("POST", `/api/invites/${code}`),

  rtcConfig: () => request<{ iceServers: RTCIceServer[] }>("GET", "/api/rtc-config"),

  messages: (channelId: string, before?: number) =>
    request<{ messages: Message[]; lastReadAt?: number }>("GET", `/api/channels/${channelId}/messages${before ? `?before=${before}` : ""}`),
  sendMessage: (channelId: string, content: string, uploads: string[] = [], replyTo: string | null = null) =>
    request<{ message: Message }>("POST", `/api/channels/${channelId}/messages`, { content, uploads, replyTo }),
  editMessage: (channelId: string, messageId: string, content: string) =>
    request<{ message: Message }>("PATCH", `/api/channels/${channelId}/messages/${messageId}`, { content }),
  react: (channelId: string, messageId: string, emoji: string, add: boolean) =>
    request<void>(add ? "PUT" : "DELETE", `/api/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`),
  uploadFile,
  deleteUpload: (id: string) => request<void>("DELETE", `/api/uploads/${id}`),
  deleteMessage: (channelId: string, messageId: string) => request<void>("DELETE", `/api/channels/${channelId}/messages/${messageId}`),
  uploadClip,
};

/** Sends a file for a message that will follow; reports progress (0..1). */
function uploadFile(file: File, size: { width?: number; height?: number }, onProgress: (fraction: number) => void): Promise<FileAttachment> {
  const q = new URLSearchParams({ name: file.name || "arquivo" });
  if (size.width && size.height) {
    q.set("width", String(Math.round(size.width)));
    q.set("height", String(Math.round(size.height)));
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/uploads?${q}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    const token = getToken();
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: { upload?: FileAttachment; error?: string } | null = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON (e.g. a proxy error page).
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.upload) resolve(data.upload);
      else reject(new ApiError(xhr.status, data?.error ?? "Não foi possível enviar o arquivo."));
    };
    xhr.onerror = () => reject(new ApiError(0, "Falha de conexão ao enviar o arquivo."));
    xhr.send(file);
  });
}

/** Posts a clip as a message, reporting upload progress (0..1). fetch() can't report upload progress, XHR can. */
function uploadClip(
  channelId: string,
  clip: { blob: Blob; duration: number; width: number; height: number; content: string },
  onProgress: (fraction: number) => void,
): Promise<Message> {
  const q = new URLSearchParams({ duration: clip.duration.toFixed(1), width: String(clip.width), height: String(clip.height), content: clip.content });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/channels/${channelId}/clips?${q}`);
    xhr.setRequestHeader("content-type", clip.blob.type || "application/octet-stream");
    const token = getToken();
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: { message?: Message; error?: string } | null = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON (e.g. a proxy error page).
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.message) resolve(data.message);
      else reject(new ApiError(xhr.status, data?.error ?? "Não foi possível enviar o clipe."));
    };
    xhr.onerror = () => reject(new ApiError(0, "Falha de conexão ao enviar o clipe."));
    xhr.send(clip.blob);
  });
}
