// Socket.IO: authentication, room membership, presence and typing indicators.
//
// Rooms:
//   user:<id>    every socket of one user (so REST handlers can reach them)
//   server:<id>  everyone who is a member of that server
//
// Presence is what others see: the status the user picked (online / idle / do
// not disturb), "offline" while they have no open connection or chose to
// appear invisible, and an optional activity ("Jogando Valorant"). It goes to
// everyone who shares a server with the user, and to their friends.

import type { Server as IOServer, Socket } from "socket.io";
import type { Channel, PublicUser, Store } from "./store.ts";
import { createVoice } from "./voice.ts";
import type { Sfu } from "./livekit.ts";

interface SocketData {
  user: PublicUser;
}

export interface Activity {
  name: string;
  startedAt: number;
}

export interface Presence {
  status: "online" | "idle" | "dnd" | "offline";
  activity: Activity | null;
}

const OFFLINE: Presence = { status: "offline", activity: null };

export function registerRealtime(io: IOServer, store: Store, sfu: Sfu | null = null) {
  const voice = createVoice(io, store, sfu);
  // Number of open sockets per user; a user is connected while this is > 0.
  const connections = new Map<string, number>();

  const presenceOf = (userId: string): Presence => {
    if (!connections.has(userId)) return OFFLINE;
    const status = store.getStatus(userId);
    if (status === "invisible") return OFFLINE;
    return { status, activity: store.getActivity(userId) };
  };

  /** Rooms that should hear about this user's presence. */
  const audience = (userId: string) => [
    `user:${userId}`,
    ...store.serversForUser(userId).map((s) => `server:${s.id}`),
    ...store.friendIds(userId).map((id) => `user:${id}`),
    ...store.groupDmPeers(userId).map((id) => `user:${id}`),
  ];

  const broadcastPresence = (userId: string) => {
    io.to(audience(userId)).emit("presence", { userId, presence: presenceOf(userId) });
  };

  /** Rooms that receive a channel's messages and typing indicators (a private channel: only who sees it). */
  const channelRooms = (channel: Channel): string[] => {
    if (channel.serverId && !channel.private) return [`server:${channel.serverId}`];
    return store.channelViewers(channel).map((id) => `user:${id}`);
  };

  const canAccess = (channel: Channel, userId: string): boolean => store.canViewChannel(channel, userId);

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const user = typeof token === "string" ? store.userForToken(token) : null;
    if (!user) return next(new Error("unauthorized"));
    (socket.data as SocketData).user = user;
    next();
  });

  io.on("connection", (socket: Socket) => {
    const data = socket.data as SocketData;
    const { user } = data;
    socket.join(`user:${user.id}`);
    for (const server of store.serversForUser(user.id)) socket.join(`server:${server.id}`);

    const count = (connections.get(user.id) ?? 0) + 1;
    connections.set(user.id, count);
    if (count === 1) broadcastPresence(user.id);

    socket.on("typing", (payload: unknown) => {
      const channelId = (payload as { channelId?: unknown })?.channelId;
      if (typeof channelId !== "string") return;
      const channel = store.channelById(channelId);
      if (!channel || channel.type === "voice" || !canAccess(channel, user.id)) return;
      socket.to(channelRooms(channel)).except(`user:${user.id}`).emit("typing", { channelId, user: data.user });
    });

    voice.register(socket, () => data.user);

    socket.on("disconnect", () => {
      const left = (connections.get(user.id) ?? 1) - 1;
      if (left > 0) {
        connections.set(user.id, left);
        return;
      }
      connections.delete(user.id);
      broadcastPresence(user.id);
    });
  });

  return {
    /** Presence of the given users, leaving out those who are offline. */
    presenceMap(userIds: string[]): Record<string, Presence> {
      const out: Record<string, Presence> = {};
      for (const id of userIds) {
        const p = presenceOf(id);
        if (p.status !== "offline") out[id] = p;
      }
      return out;
    },
    presenceOf,
    broadcastPresence,
    setActivity(userId: string, name: string | null) {
      const current = store.getActivity(userId);
      if (name === null) store.setActivity(userId, null);
      // Keep the start time when the same activity is reported again (the desktop app re-sends it).
      else if (current?.name !== name) store.setActivity(userId, { name, startedAt: Date.now() });
      broadcastPresence(userId);
    },
    channelRooms,
    canAccess,
    voiceState: voice.stateForServer,
    /**
     * Sends every member the channels and categories they see (after any change that can
     * show or hide a channel), and drops people from voice channels they can't see anymore.
     */
    emitChannels(serverId: string) {
      const categories = store.categories(serverId);
      for (const m of store.members(serverId)) {
        io.to(`user:${m.id}`).emit("channels:update", { serverId, channels: store.visibleChannels(serverId, m.id), categories });
      }
      voice.recheckServer(serverId);
    },
    dmCalls: voice.stateForChannels,
    evictVoiceChannel: voice.evictChannel,
    evictFromCall: voice.evictFromChannel,
    refreshCall: voice.refreshChannel,

    /** A profile change: refresh the user on their sockets and in voice, and tell everyone who can see them. */
    updateUser(user: PublicUser) {
      for (const s of io.sockets.sockets.values()) {
        const d = s.data as SocketData;
        if (d.user?.id === user.id) d.user = user;
      }
      voice.updateUser(user);
      io.to(audience(user.id)).emit("user:update", user);
    },

    /** After a kick or leave: the user's sockets stop receiving the server's events, and leave its voice. */
    removeFromServer(serverId: string, userId: string, reason: string) {
      voice.evictUser(userId, serverId, reason);
      io.in(`user:${userId}`).socketsLeave(`server:${serverId}`);
    },
  };
}
