// The logged-in app: server rail, sidebars, chat / voice / friends views and member list.
// Owns the socket and keeps the caches below fresh from its events.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  getToken,
  type Activity,
  type DmSummary,
  type Friend,
  type Message,
  type Presence,
  type Server,
  type ServerDetails,
  type User,
  type UserStatus,
} from "../api.ts";
import { navigate } from "../router.ts";
import { connectSocket, type AppSocket } from "../socket.ts";
import { VoiceClient } from "../voice/VoiceClient.ts";
import { VoiceContext, useVoiceSnapshot } from "../voice/useVoice.ts";
import { ServerRail } from "./ServerRail.tsx";
import { ChannelSidebar } from "./ChannelSidebar.tsx";
import { HomeSidebar } from "./HomeSidebar.tsx";
import { SidebarFooter, type SetPresence } from "./SidebarFooter.tsx";
import { ChatView } from "./ChatView.tsx";
import { FriendsView } from "./FriendsView.tsx";
import { MemberList } from "./MemberList.tsx";
import { VoiceView } from "./VoiceView.tsx";
import { CreateChannelModal, CreateServerModal, InviteModal } from "./Modals.tsx";

const TYPING_MS = 4000;
const HOME = "@me";

interface ChannelMessages {
  items: Message[];
  hasMore: boolean;
}

type ModalKind = "createServer" | "createChannel" | "invite" | null;

interface Props {
  user: User;
  initialStatus: UserStatus;
  servers: Server[];
  setServers: (update: (s: Server[]) => Server[]) => void;
  serverId?: string;
  channelId?: string;
  onLogout: () => void;
}

/** Applies a presence snapshot for `ids`: users missing from `known` are offline. */
function mergePresence(all: Record<string, Presence>, ids: string[], known: Record<string, Presence>) {
  const next = { ...all };
  for (const id of ids) {
    if (known[id]) next[id] = known[id];
    else delete next[id];
  }
  return next;
}

export function Shell({ user, initialStatus, servers, setServers, serverId, channelId, onLogout }: Props) {
  const socketRef = useRef<AppSocket | null>(null);
  const [voice, setVoice] = useState<VoiceClient | null>(null);
  const voiceState = useVoiceSnapshot(voice);

  const [details, setDetails] = useState<Record<string, ServerDetails>>({});
  const [messages, setMessages] = useState<Record<string, ChannelMessages>>({});
  const [typing, setTyping] = useState<Record<string, Record<string, { user: User; until: number }>>>({});
  const [presence, setPresenceMap] = useState<Record<string, Presence>>({});
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [dms, setDms] = useState<DmSummary[] | null>(null);
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [myStatus, setMyStatus] = useState<UserStatus>(initialStatus);
  const [myActivity, setMyActivity] = useState<Activity | null>(null);
  const [modal, setModal] = useState<ModalKind>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Requests in flight, so effects that re-run on unrelated state changes don't fire duplicates.
  const inFlight = useRef(new Set<string>());

  const loadServer = useCallback((id: string) => {
    const key = `server:${id}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    api
      .server(id)
      .then(
        (d) => {
          setDetails((all) => ({ ...all, [id]: d }));
          setPresenceMap((all) => mergePresence(all, d.members.map((m) => m.id), d.presence));
        },
        (err) => setLoadError((err as Error).message),
      )
      .finally(() => inFlight.current.delete(key));
  }, []);

  const loadSocial = useCallback(() => {
    api.friends().then(({ friends: list, presence: p }) => {
      setFriends(list);
      setPresenceMap((all) => mergePresence(all, list.filter((f) => f.state === "accepted").map((f) => f.user.id), p));
    });
    api.dms().then(({ dms: list, presence: p }) => {
      setDms(list);
      setPresenceMap((all) => mergePresence(all, list.map((d) => d.user.id), p));
    });
  }, []);

  const loadMessages = useCallback(async (id: string, before?: number) => {
    const key = `messages:${id}:${before ?? "latest"}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    const page = await api
      .messages(id, before)
      .then((r) => r.messages)
      .finally(() => inFlight.current.delete(key));
    setMessages((all) => {
      const prev = before ? (all[id]?.items ?? []) : [];
      const seen = new Set(prev.map((m) => m.id));
      return { ...all, [id]: { items: [...page.filter((m) => !seen.has(m.id)), ...prev], hasMore: page.length >= 50 } };
    });
  }, []);

  // --- socket -----------------------------------------------------------------
  const activeRef = useRef({ serverId, channelId });
  activeRef.current = { serverId, channelId };

  useEffect(() => {
    const socket = connectSocket(getToken()!);
    socketRef.current = socket;
    const voiceClient = new VoiceClient(socket);
    setVoice(voiceClient);
    let connectedBefore = false;
    loadSocial();

    socket.on("connect", () => {
      // After a reconnect we may have missed events: refresh what's on screen.
      if (connectedBefore) {
        const { serverId: s, channelId: c } = activeRef.current;
        if (s && s !== HOME) loadServer(s);
        if (c) loadMessages(c);
        loadSocial();
      }
      connectedBefore = true;
    });

    socket.on("message:new", (m) => {
      setMessages((all) => {
        const ch = all[m.channelId];
        if (!ch || ch.items.some((x) => x.id === m.id)) return all;
        return { ...all, [m.channelId]: { ...ch, items: [...ch.items, m] } };
      });
      setTyping((all) => {
        if (!all[m.channelId]?.[m.author.id]) return all;
        const { [m.author.id]: _, ...rest } = all[m.channelId];
        return { ...all, [m.channelId]: rest };
      });
      setDms((list) => {
        const dm = list?.find((d) => d.channel.id === m.channelId);
        if (!list || !dm) return list;
        // Most recent conversation first.
        return [{ ...dm, lastMessageAt: m.createdAt }, ...list.filter((d) => d !== dm)];
      });
      const viewing = activeRef.current.channelId === m.channelId && document.visibilityState === "visible";
      if (m.author.id !== user.id && !viewing) {
        setUnread((u) => (u.has(m.channelId) ? u : new Set(u).add(m.channelId)));
      }
    });

    socket.on("channel:new", (c) => {
      const sid = c.serverId;
      if (!sid) return;
      setDetails((all) => {
        const d = all[sid];
        if (!d || d.channels.some((x) => x.id === c.id)) return all;
        return { ...all, [sid]: { ...d, channels: [...d.channels, c] } };
      });
    });

    socket.on("member:join", ({ serverId: sid, user: u, presence: p }) => {
      setDetails((all) => {
        const d = all[sid];
        if (!d || d.members.some((x) => x.id === u.id)) return all;
        return { ...all, [sid]: { ...d, members: [...d.members, u] } };
      });
      setPresenceMap((all) => mergePresence(all, [u.id], p.status === "offline" ? {} : { [u.id]: p }));
    });

    socket.on("presence", ({ userId, presence: p }) => {
      setPresenceMap((all) => mergePresence(all, [userId], p.status === "offline" ? {} : { [userId]: p }));
      if (userId === user.id && p.status !== "offline") setMyActivity(p.activity);
    });

    socket.on("friend:update", ({ user: u, state, presence: p }) => {
      setFriends((list) => {
        const rest = (list ?? []).filter((f) => f.user.id !== u.id);
        return state ? [...rest, { user: u, state }].sort((a, b) => a.user.displayName.localeCompare(b.user.displayName)) : rest;
      });
      if (p && p.status !== "offline") setPresenceMap((all) => ({ ...all, [u.id]: p }));
    });

    socket.on("dm:new", (dm) => {
      setDms((list) => (list?.some((d) => d.channel.id === dm.channel.id) ? list : [dm, ...(list ?? [])]));
    });

    socket.on("voice:update", ({ serverId: sid, channelId: cid, members }) => {
      setDetails((all) => {
        const d = all[sid];
        if (!d) return all;
        return { ...all, [sid]: { ...d, voice: { ...d.voice, [cid]: members } } };
      });
    });

    socket.on("typing", ({ channelId: cid, user: u }) => {
      setTyping((all) => ({ ...all, [cid]: { ...all[cid], [u.id]: { user: u, until: Date.now() + TYPING_MS } } }));
    });

    return () => {
      voiceClient.leave();
      socket.close();
      socketRef.current = null;
      setVoice(null);
    };
  }, [loadServer, loadMessages, loadSocial, user.id]);

  // Expire typing indicators.
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setTyping((all) => {
        const expired = Object.values(all).some((users) => Object.values(users).some((v) => v.until <= now));
        if (!expired) return all;
        const next: typeof all = {};
        for (const [cid, users] of Object.entries(all)) {
          next[cid] = Object.fromEntries(Object.entries(users).filter(([, v]) => v.until > now));
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // --- routing ----------------------------------------------------------------
  const isHome = serverId === HOME;
  const current = serverId && !isHome ? details[serverId] : undefined;

  useEffect(() => setLoadError(null), [serverId]);

  useEffect(() => {
    if (!serverId) {
      navigate(`/channels/${HOME}`, true);
      return;
    }
    if (!isHome && !details[serverId] && !loadError) loadServer(serverId);
  }, [serverId, isHome, details, loadError, loadServer]);

  useEffect(() => {
    if (!current || channelId) return;
    const first = current.channels.find((c) => c.type === "text") ?? current.channels[0];
    if (first) navigate(`/channels/${current.server.id}/${first.id}`, true);
  }, [current, channelId]);

  const dm = isHome ? dms?.find((d) => d.channel.id === channelId) : undefined;
  const channel = dm?.channel ?? current?.channels.find((c) => c.id === channelId);

  useEffect(() => {
    if (channel && channel.type !== "voice" && !messages[channel.id]) loadMessages(channel.id).catch(() => {});
  }, [channel, messages, loadMessages]);

  // Reading a conversation clears its unread mark (also when coming back to the tab).
  useEffect(() => {
    if (!channelId) return;
    const clear = () => {
      if (document.visibilityState !== "visible") return;
      setUnread((u) => {
        if (!u.has(channelId)) return u;
        const next = new Set(u);
        next.delete(channelId);
        return next;
      });
    };
    clear();
    document.addEventListener("visibilitychange", clear);
    return () => document.removeEventListener("visibilitychange", clear);
  }, [channelId, unread]);

  // --- actions ------------------------------------------------------------------
  const openDm = async (other: User) => {
    try {
      const { dm: opened } = await api.openDm(other.id);
      setDms((list) => (list?.some((d) => d.channel.id === opened.channel.id) ? list : [opened, ...(list ?? [])]));
      navigate(`/channels/${HOME}/${opened.channel.id}`);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const setPresence: SetPresence = async (patch) => {
    const r = await api.setPresence(patch);
    setMyStatus(r.status);
    // While invisible the server reports us as offline with no activity, but the activity is kept.
    if (patch.activity !== undefined) {
      setMyActivity(patch.activity ? (r.presence.activity ?? { name: patch.activity, startedAt: Date.now() }) : null);
    } else if (r.status !== "invisible") {
      setMyActivity(r.presence.activity);
    }
  };

  // --- render -------------------------------------------------------------------
  const typingUsers = channel ? Object.values(typing[channel.id] ?? {}).map((t) => t.user) : [];
  const voiceServer = voiceState.serverId ? details[voiceState.serverId] : undefined;
  const voiceChannel = voiceServer?.channels.find((c) => c.id === voiceState.channelId);

  const footer = (
    <SidebarFooter
      user={user}
      status={myStatus}
      activity={myActivity}
      setPresence={setPresence}
      voiceLocation={
        voiceServer && voiceChannel
          ? { label: `${voiceChannel.name} / ${voiceServer.server.name}`, path: `/channels/${voiceServer.server.id}/${voiceChannel.id}` }
          : null
      }
      onLogout={onLogout}
    />
  );

  const chat = channel && channel.type !== "voice" && (
    <ChatView
      channel={channel}
      dmUser={dm?.user}
      messages={messages[channel.id]?.items}
      hasMore={messages[channel.id]?.hasMore ?? false}
      typingUsers={typingUsers}
      onLoadOlder={() => {
        const oldest = messages[channel.id]?.items[0];
        if (oldest) return loadMessages(channel.id, oldest.createdAt);
      }}
      onSend={(content) => api.sendMessage(channel.id, content).then(() => {})}
      onTyping={() => socketRef.current?.emit("typing", { channelId: channel.id })}
    />
  );

  let body;
  if (isHome) {
    body = (
      <>
        <HomeSidebar
          dms={dms}
          presence={presence}
          unread={unread}
          activeChannelId={channelId}
          pendingCount={friends?.filter((f) => f.state === "incoming").length ?? 0}
          footer={footer}
        />
        {channelId ? (
          (chat ?? (
            <main className="main placeholder">
              <p className="muted">{dms === null ? "Carregando…" : "Conversa não encontrada."}</p>
            </main>
          ))
        ) : (
          <FriendsView friends={friends} presence={presence} onOpenDm={openDm} />
        )}
      </>
    );
  } else if (current) {
    body = (
      <>
        <ChannelSidebar
          details={current}
          activeChannelId={channelId}
          isOwner={current.server.ownerId === user.id}
          onCreateChannel={() => setModal("createChannel")}
          onInvite={() => setModal("invite")}
          footer={footer}
        />
        {chat ||
          (channel?.type === "voice" ? (
            <VoiceView channel={channel} members={current.voice[channel.id] ?? []} />
          ) : (
            <main className="main placeholder" />
          ))}
        <MemberList
          members={current.members}
          presence={presence}
          ownerId={current.server.ownerId}
          selfId={user.id}
          onOpenDm={openDm}
        />
      </>
    );
  } else {
    body = (
      <>
        <aside className="sidebar">{footer}</aside>
        <main className="main placeholder">
          <p className="muted">{loadError ?? "Carregando…"}</p>
        </main>
      </>
    );
  }

  const unreadDms = [...unread].filter((id) => dms?.some((d) => d.channel.id === id)).length;

  return (
    <VoiceContext.Provider value={voice}>
      <div className={`shell ${current ? "" : "no-members"}`}>
        <ServerRail servers={servers} activeId={serverId} unreadDms={unreadDms} onCreate={() => setModal("createServer")} />
        {body}

        {modal === "createServer" && (
          <CreateServerModal
            onClose={() => setModal(null)}
            onCreated={({ server, channels }) => {
              setServers((s) => [...s, server]);
              setDetails((all) => ({
                ...all,
                [server.id]: { server, channels, members: [user], presence: {}, voice: {} },
              }));
              setModal(null);
              navigate(`/channels/${server.id}`);
            }}
          />
        )}
        {modal === "createChannel" && current && (
          <CreateChannelModal
            serverId={current.server.id}
            onClose={() => setModal(null)}
            onCreated={(c) => {
              const sid = current.server.id;
              setDetails((all) => {
                const d = all[sid];
                if (!d || d.channels.some((x) => x.id === c.id)) return all;
                return { ...all, [sid]: { ...d, channels: [...d.channels, c] } };
              });
              setModal(null);
              navigate(`/channels/${sid}/${c.id}`);
            }}
          />
        )}
        {modal === "invite" && current && <InviteModal server={current.server} onClose={() => setModal(null)} />}
      </div>
    </VoiceContext.Provider>
  );
}
