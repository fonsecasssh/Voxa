// Socket.IO: authentication, room membership, presence and typing indicators.
//
// Rooms:
//   user:<id>    every socket of one user (so REST handlers can reach them)
//   server:<id>  everyone who is a member of that server

import type { Server as IOServer, Socket } from "socket.io";
import type { PublicUser, Store } from "./store.ts";

interface SocketData {
  user: PublicUser;
}

export function registerRealtime(io: IOServer, store: Store) {
  // Number of open sockets per user; a user is online while this is > 0.
  const connections = new Map<string, number>();

  const broadcastPresence = (userId: string, online: boolean) => {
    for (const server of store.serversForUser(userId)) {
      io.to(`server:${server.id}`).emit("presence", { userId, online });
    }
  };

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const user = typeof token === "string" ? store.userForToken(token) : null;
    if (!user) return next(new Error("unauthorized"));
    (socket.data as SocketData).user = user;
    next();
  });

  io.on("connection", (socket: Socket) => {
    const { user } = socket.data as SocketData;
    socket.join(`user:${user.id}`);
    for (const server of store.serversForUser(user.id)) socket.join(`server:${server.id}`);

    const count = (connections.get(user.id) ?? 0) + 1;
    connections.set(user.id, count);
    if (count === 1) broadcastPresence(user.id, true);

    socket.on("typing", (payload: unknown) => {
      const channelId = (payload as { channelId?: unknown })?.channelId;
      if (typeof channelId !== "string") return;
      const channel = store.channelById(channelId);
      if (!channel || !socket.rooms.has(`server:${channel.serverId}`)) return;
      socket.to(`server:${channel.serverId}`).emit("typing", { channelId, user });
    });

    socket.on("disconnect", () => {
      const left = (connections.get(user.id) ?? 1) - 1;
      if (left > 0) {
        connections.set(user.id, left);
        return;
      }
      connections.delete(user.id);
      broadcastPresence(user.id, false);
    });
  });

  return {
    onlineUserIds(userIds: string[]): string[] {
      return userIds.filter((id) => connections.has(id));
    },
  };
}
