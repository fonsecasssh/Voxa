import { io, type Socket } from "socket.io-client";
import type { Category, Channel, DmSummary, FriendState, MemberData, Message, Presence, Role, Server, User, Reaction } from "./api.ts";
import type { VoiceMember } from "./voice/types.ts";

export interface ServerToClient {
  "message:new": (m: Message) => void;
  "message:update": (m: Message) => void;
  "message:delete": (e: { channelId: string; id: string }) => void;
  "message:reactions": (e: { channelId: string; messageId: string; reactions: Reaction[] }) => void;
  "channel:new": (c: Channel) => void;
  /** The channels (and categories) of a server that you see, after any change to them. */
  "channels:update": (p: { serverId: string; channels: Channel[]; categories: Category[] }) => void;
  "member:join": (p: { serverId: string; user: User; presence: Presence }) => void;
  presence: (p: { userId: string; presence: Presence }) => void;
  "friend:update": (p: { user: User; state: FriendState | null; presence: Presence | null }) => void;
  "dm:new": (dm: DmSummary) => void;
  "dm:update": (dm: DmSummary) => void;
  /** We left or were removed from a group DM (or it was deleted). */
  "dm:remove": (p: { channelId: string }) => void;
  /** Someone started a call in one of our DMs. */
  "call:ring": (p: { channelId: string; from: User }) => void;
  "user:update": (user: User) => void;
  "server:update": (server: Server) => void;
  /** We are no longer in this server (kicked, left elsewhere, or it was deleted). */
  "server:removed": (p: { serverId: string; reason: string | null }) => void;
  "member:update": (p: { serverId: string; userId: string } & MemberData) => void;
  "member:leave": (p: { serverId: string; userId: string }) => void;
  "roles:update": (p: { serverId: string; roles: Role[] }) => void;
  "channel:update": (c: Channel) => void;
  "channel:delete": (p: { serverId: string; channelId: string }) => void;
  "voice:kicked": (p: { reason: string }) => void;
  typing: (p: { channelId: string; user: User }) => void;
  /** serverId is null for a call in a DM. */
  "voice:update": (p: { serverId: string | null; channelId: string; members: VoiceMember[] }) => void;
  "voice:signal": (p: { from: string; data: unknown }) => void;
  "voice:replaced": () => void;
}

export type VoiceJoinResult =
  | { error: string }
  /** `sfu`: the call goes through this media server (LiveKit) instead of the mesh. */
  | { channelId: string; self: VoiceMember; peers: VoiceMember[]; sfu?: { url: string; token: string } };

export interface ClientToServer {
  typing: (p: { channelId: string }) => void;
  "voice:join": (p: { channelId: string }, ack: (r: VoiceJoinResult) => void) => void;
  "voice:leave": () => void;
  "voice:state": (p: { muted: boolean; deafened: boolean; screenStreamId: string | null; cameraStreamId: string | null }) => void;
  "voice:signal": (p: { to: string; data: unknown }) => void;
}

export type AppSocket = Socket<ServerToClient, ClientToServer>;

export function connectSocket(token: string): AppSocket {
  return io({ auth: { token } });
}
