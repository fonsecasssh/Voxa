// Voice channel state and WebRTC signaling relay.
//
// Media never touches this server: peers connect to each other directly (a full
// mesh), and the server only tracks who is in which voice channel and forwards
// the SDP offers/answers and ICE candidates between their sockets.
//
// A user can be in one voice channel at a time. Joining from a second tab or
// device moves the session there and tells the old socket it was replaced.

import type { Server as IOServer, Socket } from "socket.io";
import type { PublicUser, Store } from "./store.ts";

export interface VoiceMember {
  socketId: string;
  user: PublicUser;
  muted: boolean;
  deafened: boolean;
  /** MediaStream id of the screen share being sent, so peers can tell it from the mic. */
  screenStreamId: string | null;
}

interface Session {
  channelId: string;
  serverId: string;
  member: VoiceMember;
}

export function createVoice(io: IOServer, store: Store) {
  const bySocket = new Map<string, Session>();
  const byUser = new Map<string, string>(); // userId -> socketId
  const channels = new Map<string, Map<string, VoiceMember>>(); // channelId -> socketId -> member

  const membersOf = (channelId: string) => [...(channels.get(channelId)?.values() ?? [])];

  const broadcast = (serverId: string, channelId: string) => {
    io.to(`server:${serverId}`).emit("voice:update", { serverId, channelId, members: membersOf(channelId) });
  };

  const leave = (socketId: string) => {
    const session = bySocket.get(socketId);
    if (!session) return;
    bySocket.delete(socketId);
    if (byUser.get(session.member.user.id) === socketId) byUser.delete(session.member.user.id);
    const room = channels.get(session.channelId);
    room?.delete(socketId);
    if (room?.size === 0) channels.delete(session.channelId);
    io.sockets.sockets.get(socketId)?.leave(`voice:${session.channelId}`);
    broadcast(session.serverId, session.channelId);
  };

  function register(socket: Socket, user: PublicUser) {
    socket.on("voice:join", (payload: unknown, ack?: (r: unknown) => void) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const channelId = (payload as { channelId?: unknown })?.channelId;
      const channel = typeof channelId === "string" ? store.channelById(channelId) : null;
      const serverId = channel?.type === "voice" ? channel.serverId : null;
      if (!channel || !serverId || !socket.rooms.has(`server:${serverId}`)) {
        return reply({ error: "Canal de voz não encontrado." });
      }

      leave(socket.id);
      const previous = byUser.get(user.id);
      if (previous) {
        leave(previous);
        io.to(previous).emit("voice:replaced");
      }

      const member: VoiceMember = { socketId: socket.id, user, muted: false, deafened: false, screenStreamId: null };
      const peers = membersOf(channel.id);
      if (!channels.has(channel.id)) channels.set(channel.id, new Map());
      channels.get(channel.id)!.set(socket.id, member);
      bySocket.set(socket.id, { channelId: channel.id, serverId, member });
      byUser.set(user.id, socket.id);
      socket.join(`voice:${channel.id}`);

      reply({ channelId: channel.id, self: member, peers });
      broadcast(serverId, channel.id);
    });

    socket.on("voice:leave", () => leave(socket.id));

    socket.on("voice:state", (payload: unknown) => {
      const session = bySocket.get(socket.id);
      if (!session || typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<VoiceMember>;
      const m = session.member;
      if (typeof p.muted === "boolean") m.muted = p.muted;
      if (typeof p.deafened === "boolean") m.deafened = p.deafened;
      if (p.screenStreamId === null || typeof p.screenStreamId === "string") m.screenStreamId = p.screenStreamId;
      broadcast(session.serverId, session.channelId);
    });

    // Relay SDP / ICE to another socket in the same voice channel.
    socket.on("voice:signal", (payload: unknown) => {
      const session = bySocket.get(socket.id);
      const { to, data } = (payload ?? {}) as { to?: unknown; data?: unknown };
      if (!session || typeof to !== "string" || bySocket.get(to)?.channelId !== session.channelId) return;
      io.to(to).emit("voice:signal", { from: socket.id, data });
    });

    socket.on("disconnect", () => leave(socket.id));
  }

  return {
    register,
    /** Voice channel occupancy for one server, for the initial page load. */
    stateForServer(serverId: string): Record<string, VoiceMember[]> {
      const out: Record<string, VoiceMember[]> = {};
      for (const c of store.channels(serverId)) {
        if (c.type === "voice" && channels.has(c.id)) out[c.id] = membersOf(c.id);
      }
      return out;
    },
  };
}
