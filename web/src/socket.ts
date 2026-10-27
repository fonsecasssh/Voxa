import { io, type Socket } from "socket.io-client";
import type { Channel, Message, User } from "./api.ts";

export interface ServerToClient {
  "message:new": (m: Message) => void;
  "channel:new": (c: Channel) => void;
  "member:join": (p: { serverId: string; user: User }) => void;
  presence: (p: { userId: string; online: boolean }) => void;
  typing: (p: { channelId: string; user: User }) => void;
}

export interface ClientToServer {
  typing: (p: { channelId: string }) => void;
}

export type AppSocket = Socket<ServerToClient, ClientToServer>;

export function connectSocket(token: string): AppSocket {
  return io({ auth: { token } });
}
