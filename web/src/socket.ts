import { io, type Socket } from "socket.io-client";
import type { Channel, DmSummary, FriendState, Message, Presence, User } from "./api.ts";
import type { VoiceMember } from "./voice/types.ts";

export interface ServerToClient {
  "message:new": (m: Message) => void;
  "channel:new": (c: Channel) => void;
  "member:join": (p: { serverId: string; user: User; presence: Presence }) => void;
  presence: (p: { userId: string; presence: Presence }) => void;
  "friend:update": (p: { user: User; state: FriendState | null; presence: Presence | null }) => void;
  "dm:new": (dm: DmSummary) => void;
  typing: (p: { channelId: string; user: User }) => void;
  "voice:update": (p: { serverId: string; channelId: string; members: VoiceMember[] }) => void;
  "voice:signal": (p: { from: string; data: unknown }) => void;
  "voice:replaced": () => void;
}

export type VoiceJoinResult = { error: string } | { channelId: string; self: VoiceMember; peers: VoiceMember[] };

export interface ClientToServer {
  typing: (p: { channelId: string }) => void;
  "voice:join": (p: { channelId: string }, ack: (r: VoiceJoinResult) => void) => void;
  "voice:leave": () => void;
  "voice:state": (p: { muted: boolean; deafened: boolean; screenStreamId: string | null }) => void;
  "voice:signal": (p: { to: string; data: unknown }) => void;
}

export type AppSocket = Socket<ServerToClient, ClientToServer>;

export function connectSocket(token: string): AppSocket {
  return io({ auth: { token } });
}
