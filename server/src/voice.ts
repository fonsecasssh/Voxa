// Voice channel state and WebRTC signaling relay.
//
// Media never touches this server: peers connect to each other directly (a full
// mesh), and the server only tracks who is in which voice channel and forwards
// the SDP offers/answers and ICE candidates between their sockets.
//
// A user can be in one voice channel at a time. Joining from a second tab or
// device moves the session there and tells the old socket it was replaced.
//
// Calls in DMs (1:1 and group) are the same thing on the DM's channel: its people
// hear about them on their user rooms, and starting one rings the others.

import type { Server as IOServer, Socket } from "socket.io";
import type { PublicUser, Store } from "./store.ts";
import type { Sfu } from "./livekit.ts";

export interface VoiceMember {
  socketId: string;
  user: PublicUser;
  muted: boolean;
  deafened: boolean;
  /** MediaStream id of the screen share being sent, so peers can tell it from the mic. */
  screenStreamId: string | null;
  /** MediaStream id of the camera, while it's on. */
  cameraStreamId: string | null;
}

interface Session {
  channelId: string;
  /** null for a call in a DM. */
  serverId: string | null;
  member: VoiceMember;
}

const isStreamId = (v: unknown) => v === null || (typeof v === "string" && v.length <= 100);

export function createVoice(io: IOServer, store: Store, sfu: Sfu | null = null, onRing?: (channelId: string, from: PublicUser, userIds: string[]) => void) {
  const bySocket = new Map<string, Session>();
  const byUser = new Map<string, string>(); // userId -> socketId
  const channels = new Map<string, Map<string, VoiceMember>>(); // channelId -> socketId -> member

  const membersOf = (channelId: string) => [...(channels.get(channelId)?.values() ?? [])];

  /** Who hears about a channel's voice state: the server, or the DM's people. */
  const roomsFor = (serverId: string | null, channelId: string) => {
    const channel = store.channelById(channelId);
    if (serverId && !channel?.private) return [`server:${serverId}`];
    return channel ? store.channelViewers(channel).map((id) => `user:${id}`) : [];
  };

  const broadcast = (serverId: string | null, channelId: string) => {
    const rooms = roomsFor(serverId, channelId);
    if (rooms.length) io.to(rooms).emit("voice:update", { serverId, channelId, members: membersOf(channelId) });
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

  /** Ends a voice session from the server side and tells that socket why. */
  const evict = (socketId: string, reason: string) => {
    leave(socketId);
    io.to(socketId).emit("voice:kicked", { reason });
  };

  /** `currentUser` returns the socket's user at call time (the display name can change). */
  function register(socket: Socket, currentUser: () => PublicUser) {
    socket.on("voice:join", (payload: unknown, ack?: (r: unknown) => void) => {
      const user = currentUser();
      const reply = typeof ack === "function" ? ack : () => {};
      const channelId = (payload as { channelId?: unknown })?.channelId;
      const channel = typeof channelId === "string" ? store.channelById(channelId) : null;
      const serverId = channel?.type === "voice" ? channel.serverId : null;
      const dmPeople = channel?.type === "dm" ? store.dmParticipants(channel.id) : null;
      const allowed = serverId ? socket.rooms.has(`server:${serverId}`) && store.canViewChannel(channel!, user.id) : !!dmPeople?.includes(user.id);
      if (!channel || !allowed) {
        return reply({ error: "Canal de voz não encontrado." });
      }

      leave(socket.id);
      const previous = byUser.get(user.id);
      if (previous) {
        leave(previous);
        io.to(previous).emit("voice:replaced");
      }

      const member: VoiceMember = { socketId: socket.id, user, muted: false, deafened: false, screenStreamId: null, cameraStreamId: null };
      const peers = membersOf(channel.id);
      if (!channels.has(channel.id)) channels.set(channel.id, new Map());
      channels.get(channel.id)!.set(socket.id, member);
      bySocket.set(socket.id, { channelId: channel.id, serverId, member });
      byUser.set(user.id, socket.id);
      socket.join(`voice:${channel.id}`);

      // With a media server, media goes through it (signaling below is then unused).
      const media = sfu ? { url: sfu.url, token: sfu.token(channel.id, socket.id, user.displayName) } : undefined;
      reply({ channelId: channel.id, self: member, peers, sfu: media });
      broadcast(serverId, channel.id);
      // Starting a call in a DM rings everyone else there (not the caller's other devices).
      if (dmPeople && peers.length === 0) {
        // Not those who blocked the caller.
        const others = dmPeople.filter((id) => id !== user.id && !store.hasBlocked(id, user.id));
        if (others.length) io.to(others.map((id) => `user:${id}`)).emit("call:ring", { channelId: channel.id, from: user });
        if (others.length) onRing?.(channel.id, user, others);
      }
    });

    socket.on("voice:leave", () => leave(socket.id));

    socket.on("voice:state", (payload: unknown) => {
      const session = bySocket.get(socket.id);
      if (!session || typeof payload !== "object" || payload === null) return;
      const p = payload as Partial<VoiceMember>;
      const m = session.member;
      if (typeof p.muted === "boolean") m.muted = p.muted;
      if (typeof p.deafened === "boolean") m.deafened = p.deafened;
      if (isStreamId(p.screenStreamId)) m.screenStreamId = p.screenStreamId!;
      if (isStreamId(p.cameraStreamId)) m.cameraStreamId = p.cameraStreamId!;
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
    /** Disconnects everyone from a voice channel that is being deleted. */
    evictChannel(channelId: string) {
      for (const [socketId, s] of [...bySocket]) if (s.channelId === channelId) evict(socketId, "O canal de voz foi excluído.");
    },
    /** Disconnects a user from a call in one channel (e.g. removed from a group DM). */
    evictFromChannel(userId: string, channelId: string, reason: string) {
      const socketId = byUser.get(userId);
      if (socketId && bySocket.get(socketId)?.channelId === channelId) evict(socketId, reason);
    },
    /** Re-sends a DM call's state to its (changed) people. */
    refreshChannel(channelId: string) {
      if (channels.has(channelId)) broadcast(null, channelId);
    },
    /** Calls going on in these DM channels, for the initial page load. */
    stateForChannels(channelIds: string[]): Record<string, VoiceMember[]> {
      const out: Record<string, VoiceMember[]> = {};
      for (const id of channelIds) if (channels.has(id)) out[id] = membersOf(id);
      return out;
    },
    /** Disconnects a user from voice in a server they no longer belong to. */
    evictUser(userId: string, serverId: string, reason: string) {
      const socketId = byUser.get(userId);
      if (socketId && bySocket.get(socketId)?.serverId === serverId) evict(socketId, reason);
    },
    /** Refreshes the user shown in voice lists after a profile change. */
    updateUser(user: PublicUser) {
      const socketId = byUser.get(user.id);
      const session = socketId && bySocket.get(socketId);
      if (!session) return;
      session.member.user = user;
      broadcast(session.serverId, session.channelId);
    },
    /** Voice channel occupancy for one server (the channels this user sees), for the initial page load. */
    stateForServer(serverId: string, userId: string): Record<string, VoiceMember[]> {
      const out: Record<string, VoiceMember[]> = {};
      for (const c of store.visibleChannels(serverId, userId)) {
        if (c.type === "voice" && channels.has(c.id)) out[c.id] = membersOf(c.id);
      }
      return out;
    },
    /** Drops people from voice channels of this server that they can't see anymore. */
    recheckServer(serverId: string) {
      for (const [socketId, s] of [...bySocket]) {
        if (s.serverId !== serverId) continue;
        const channel = store.channelById(s.channelId);
        if (!channel || !store.canViewChannel(channel, s.member.user.id)) evict(socketId, "Você não tem mais acesso a este canal de voz.");
      }
    },
  };
}
