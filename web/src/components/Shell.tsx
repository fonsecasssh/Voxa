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
import { desktop, notify, requestNotificationPermission } from "../desktop.ts";
import { connectSocket, type AppSocket } from "../socket.ts";
import { VoiceClient } from "../voice/VoiceClient.ts";
import { VoiceContext, useVoiceSnapshot } from "../voice/useVoice.ts";
import { ServerRail } from "./ServerRail.tsx";
import { ChannelSidebar } from "./ChannelSidebar.tsx";
import { HomeSidebar } from "./HomeSidebar.tsx";
import { SidebarFooter, type SetPresence } from "./SidebarFooter.tsx";
import { ChatView } from "./ChatView.tsx";
import { ReplayModal } from "./ReplayModal.tsx";
import { FriendsView } from "./FriendsView.tsx";
import { MemberList } from "./MemberList.tsx";
import { VoiceView } from "./VoiceView.tsx";
import { CreateChannelModal, CreateServerModal, EditChannelModal, InviteModal, NicknameModal, ProfileModal } from "./Modals.tsx";
import { ServerSettings } from "./ServerSettings.tsx";
import { VoiceSettingsModal } from "./VoiceSettingsModal.tsx";
import type { Channel } from "../api.ts";

const TYPING_MS = 4000;
const HOME = "@me";

interface ChannelMessages {
  items: Message[];
  hasMore: boolean;
}

type ModalKind =
  | { kind: "createServer" | "createChannel" | "invite" | "nickname" | "profile" | "settings" | "voiceSettings" | "replay" }
  | { kind: "editChannel"; channel: Channel }
  | null;

interface Props {
  user: User;
  setUser: (user: User) => void;
  initialStatus: UserStatus;
  initialActivity: Activity | null;
  servers: Server[];
  setServers: (update: (s: Server[]) => Server[]) => void;
  serverId?: string;
  channelId?: string;
  onLogout: () => void;
}

const AUTO_ACTIVITY_KEY = "voxa.autoActivity";

function readAutoActivity(): string | null {
  try {
    return localStorage.getItem(AUTO_ACTIVITY_KEY);
  } catch {
    return null;
  }
}

function writeAutoActivity(name: string | null) {
  try {
    if (name) localStorage.setItem(AUTO_ACTIVITY_KEY, name);
    else localStorage.removeItem(AUTO_ACTIVITY_KEY);
  } catch {
    // Storage unavailable: detection then only manages activities set during this session.
  }
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

export function Shell({ user, setUser, initialStatus, initialActivity, servers, setServers, serverId, channelId, onLogout }: Props) {
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
  const [myActivity, setMyActivity] = useState<Activity | null>(initialActivity);
  const [modal, setModal] = useState<ModalKind>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** A short message at the top of the window (e.g. "you were removed from the server"). */
  const [notice, setNotice] = useState<string | null>(null);

  // Requests in flight, so effects that re-run on unrelated state changes don't fire duplicates.
  const inFlight = useRef(new Set<string>());

  // Presence comes from two places: snapshots in REST responses and live socket events.
  // A snapshot may be computed before an event that arrives first (e.g. our own socket
  // connecting right after the page asked for the member list), so a snapshot never
  // overwrites a user whose event is newer than the request.
  const presenceEventAt = useRef(new Map<string, number>());
  const applyPresenceSnapshot = useCallback((ids: string[], known: Record<string, Presence>, requestedAt: number) => {
    const fresh = ids.filter((id) => (presenceEventAt.current.get(id) ?? 0) < requestedAt);
    setPresenceMap((all) => mergePresence(all, fresh, known));
  }, []);
  const applyPresenceEvent = useCallback((userId: string, p: Presence) => {
    presenceEventAt.current.set(userId, Date.now());
    setPresenceMap((all) => mergePresence(all, [userId], p.status === "offline" ? {} : { [userId]: p }));
  }, []);

  const loadServer = useCallback((id: string) => {
    const key = `server:${id}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    const requestedAt = Date.now();
    api
      .server(id)
      .then(
        (d) => {
          setDetails((all) => ({ ...all, [id]: d }));
          applyPresenceSnapshot(d.members.map((m) => m.id), d.presence, requestedAt);
        },
        (err) => setLoadError((err as Error).message),
      )
      .finally(() => inFlight.current.delete(key));
  }, [applyPresenceSnapshot]);

  const loadSocial = useCallback(() => {
    const requestedAt = Date.now();
    api.friends().then(({ friends: list, presence: p }) => {
      setFriends(list);
      applyPresenceSnapshot(list.filter((f) => f.state === "accepted").map((f) => f.user.id), p, requestedAt);
    });
    api.dms().then(({ dms: list, presence: p }) => {
      setDms(list);
      applyPresenceSnapshot(list.map((d) => d.user.id), p, requestedAt);
    });
  }, [applyPresenceSnapshot]);

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
  // Latest values for socket handlers, which are registered once.
  const dmsRef = useRef(dms);
  dmsRef.current = dms;
  const myStatusRef = useRef(myStatus);
  myStatusRef.current = myStatus;

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
        // Direct messages notify (servers would be too noisy without mentions), unless in "do not disturb".
        const isDm = dmsRef.current?.some((d) => d.channel.id === m.channelId);
        if (isDm && myStatusRef.current !== "dnd" && (document.visibilityState !== "visible" || !document.hasFocus())) {
          notify(m.author.displayName, m.content.slice(0, 200) || (m.attachment ? "Enviou um replay 🎬" : ""), m.channelId, () => navigate(`/channels/${HOME}/${m.channelId}`));
          desktop?.flash();
        }
      }
    });

    // A message changed, e.g. its clip was deleted to free space on the server.
    socket.on("message:update", (m) => {
      setMessages((all) => {
        const ch = all[m.channelId];
        if (!ch) return all;
        return { ...all, [m.channelId]: { ...ch, items: ch.items.map((x) => (x.id === m.id ? m : x)) } };
      });
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
        return {
          ...all,
          [sid]: { ...d, members: [...d.members, u], memberData: { ...d.memberData, [u.id]: { nickname: null, roleIds: [] } } },
        };
      });
      applyPresenceEvent(u.id, p);
    });

    socket.on("presence", ({ userId, presence: p }) => {
      applyPresenceEvent(userId, p);
      if (userId === user.id && p.status !== "offline") setMyActivity(p.activity);
    });

    socket.on("friend:update", ({ user: u, state, presence: p }) => {
      setFriends((list) => {
        const rest = (list ?? []).filter((f) => f.user.id !== u.id);
        return state ? [...rest, { user: u, state }].sort((a, b) => a.user.displayName.localeCompare(b.user.displayName)) : rest;
      });
      if (p) applyPresenceEvent(u.id, p);
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

    // --- names and roles ---
    const updateServer = (sid: string, fn: (d: ServerDetails) => ServerDetails) =>
      setDetails((all) => (all[sid] ? { ...all, [sid]: fn(all[sid]) } : all));

    socket.on("user:update", (u) => {
      const swap = (x: User) => (x.id === u.id ? u : x);
      setDetails((all) => Object.fromEntries(Object.entries(all).map(([sid, d]) => [sid, { ...d, members: d.members.map(swap) }])));
      setFriends((list) => list?.map((f) => ({ ...f, user: swap(f.user) })) ?? list);
      setDms((list) => list?.map((d) => ({ ...d, user: swap(d.user) })) ?? list);
      setMessages((all) =>
        Object.fromEntries(
          Object.entries(all).map(([cid, ch]) => [
            cid,
            ch.items.some((m) => m.author.id === u.id) ? { ...ch, items: ch.items.map((m) => ({ ...m, author: swap(m.author) })) } : ch,
          ]),
        ),
      );
      if (u.id === user.id) setUser(u);
    });

    socket.on("server:update", (srv) => {
      setServers((list) => list.map((x) => (x.id === srv.id ? srv : x)));
      updateServer(srv.id, (d) => ({ ...d, server: srv }));
    });

    socket.on("server:removed", ({ serverId: sid, reason }) => {
      setServers((list) => list.filter((x) => x.id !== sid));
      setDetails((all) => {
        const { [sid]: _, ...rest } = all;
        return rest;
      });
      if (activeRef.current.serverId === sid) navigate(`/channels/${HOME}`, true);
      if (reason) setNotice(reason);
    });

    socket.on("member:update", ({ serverId: sid, userId, nickname, roleIds }) => {
      updateServer(sid, (d) => ({ ...d, memberData: { ...d.memberData, [userId]: { nickname, roleIds } } }));
    });

    socket.on("member:leave", ({ serverId: sid, userId }) => {
      updateServer(sid, (d) => {
        const { [userId]: _, ...memberData } = d.memberData;
        return { ...d, members: d.members.filter((m) => m.id !== userId), memberData };
      });
    });

    socket.on("roles:update", ({ serverId: sid, roles }) => {
      updateServer(sid, (d) => {
        // Deleted roles disappear from members too.
        const ids = new Set(roles.map((r) => r.id));
        const memberData = Object.fromEntries(
          Object.entries(d.memberData).map(([uid, m]) => [uid, { ...m, roleIds: m.roleIds.filter((r) => ids.has(r)) }]),
        );
        return { ...d, roles, memberData };
      });
    });

    socket.on("channel:update", (c) => {
      if (c.serverId) updateServer(c.serverId, (d) => ({ ...d, channels: d.channels.map((x) => (x.id === c.id ? c : x)) }));
    });

    socket.on("channel:delete", ({ serverId: sid, channelId: cid }) => {
      updateServer(sid, (d) => ({ ...d, channels: d.channels.filter((x) => x.id !== cid) }));
      if (activeRef.current.channelId === cid) navigate(`/channels/${sid}`, true);
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
  }, [loadServer, loadMessages, loadSocial, applyPresenceEvent, user.id, setUser, setServers]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

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

  // --- desktop app integration ---------------------------------------------------
  const unreadDms = [...unread].filter((id) => dms?.some((d) => d.channel.id === id)).length;
  useEffect(() => desktop?.setBadge(unreadDms), [unreadDms]);

  // The desktop app detects running games. It only manages the activity it set itself,
  // so an activity the user typed by hand is never overwritten or cleared by detection.
  // Which one it set is remembered across restarts, so a game that closed while the app
  // was not running still gets cleared on the next launch.
  const myActivityRef = useRef(myActivity);
  myActivityRef.current = myActivity;
  const setPresenceRef = useRef<SetPresence | null>(null);

  useEffect(() => {
    if (!desktop) return;
    const apply = (game: string | null) => {
      const current = myActivityRef.current?.name ?? null;
      const auto = readAutoActivity();
      if (current === game) {
        writeAutoActivity(game);
        return;
      }
      if (current !== null && current !== auto) return; // Typed by hand: leave it alone.
      writeAutoActivity(game);
      setPresenceRef.current?.({ activity: game }).catch(() => {});
    };
    desktop.getActivity().then(apply);
    return desktop.onActivity(apply);
  }, []);

  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  useEffect(() => desktop?.onUpdateReady(setUpdateVersion), []);

  // --- actions ------------------------------------------------------------------
  const openDm = async (other: User) => {
    requestNotificationPermission();
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
  setPresenceRef.current = setPresence;

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
      onEditProfile={() => setModal({ kind: "profile" })}
      onVoiceSettings={() => setModal({ kind: "voiceSettings" })}
      onReplay={() => setModal({ kind: "replay" })}
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
      server={current}
      messages={messages[channel.id]?.items}
      hasMore={messages[channel.id]?.hasMore ?? false}
      typingUsers={typingUsers}
      onLoadOlder={() => {
        const oldest = messages[channel.id]?.items[0];
        if (oldest) return loadMessages(channel.id, oldest.createdAt);
      }}
      onSend={(content) => {
        requestNotificationPermission();
        return api.sendMessage(channel.id, content).then(() => {});
      }}
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
          selfId={user.id}
          onCreateChannel={() => setModal({ kind: "createChannel" })}
          onInvite={() => setModal({ kind: "invite" })}
          onOpenSettings={() => setModal({ kind: "settings" })}
          onEditNickname={() => setModal({ kind: "nickname" })}
          onEditChannel={(c) => setModal({ kind: "editChannel", channel: c })}
          onLeave={async () => {
            if (!confirm(`Sair de "${current.server.name}"? Você só volta com um novo convite.`)) return;
            try {
              await api.leaveServer(current.server.id);
            } catch (err) {
              alert((err as Error).message);
            }
          }}
          footer={footer}
        />
        {chat ||
          (channel?.type === "voice" ? (
            <VoiceView channel={channel} members={current.voice[channel.id] ?? []} server={current} />
          ) : (
            <main className="main placeholder" />
          ))}
        <MemberList details={current} presence={presence} selfId={user.id} onOpenDm={openDm} />
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

  return (
    <VoiceContext.Provider value={voice}>
      {notice && (
        <div className="update-banner notice" role="status">
          {notice}
          <button className="icon-btn" title="Fechar" onClick={() => setNotice(null)}>
            ✕
          </button>
        </div>
      )}
      {updateVersion && (
        <div className="update-banner" role="status">
          Uma nova versão do Voxa ({updateVersion}) está pronta.
          <button className="btn primary" onClick={() => desktop?.installUpdate()}>
            Reiniciar e atualizar
          </button>
          <button className="icon-btn" title="Depois" onClick={() => setUpdateVersion(null)}>
            ✕
          </button>
        </div>
      )}
      <div className={`shell ${current ? "" : "no-members"}`}>
        <ServerRail servers={servers} activeId={serverId} unreadDms={unreadDms} onCreate={() => setModal({ kind: "createServer" })} />
        {body}

        {modal?.kind === "createServer" && (
          <CreateServerModal
            onClose={() => setModal(null)}
            onCreated={({ server, channels, roles }) => {
              setServers((s) => [...s, server]);
              setDetails((all) => ({
                ...all,
                [server.id]: {
                  server,
                  channels,
                  members: [user],
                  presence: {},
                  voice: {},
                  roles,
                  memberData: { [user.id]: { nickname: null, roleIds: [] } },
                },
              }));
              setModal(null);
              navigate(`/channels/${server.id}`);
            }}
          />
        )}
        {modal?.kind === "createChannel" && current && (
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
        {modal?.kind === "invite" && current && <InviteModal server={current.server} onClose={() => setModal(null)} />}
        {modal?.kind === "editChannel" && current && <EditChannelModal channel={modal.channel} onClose={() => setModal(null)} />}
        {modal?.kind === "nickname" && current && (
          <NicknameModal details={current} target={user} selfId={user.id} onClose={() => setModal(null)} />
        )}
        {modal?.kind === "profile" && <ProfileModal user={user} onClose={() => setModal(null)} />}
        {modal?.kind === "voiceSettings" && <VoiceSettingsModal onClose={() => setModal(null)} />}
        {modal?.kind === "replay" && (
          <ReplayModal
            onClose={() => setModal(null)}
            shareTarget={channel && channel.type !== "voice" ? { channelId: channel.id, label: dm ? `@${dm.user.displayName}` : `#${channel.name}` } : null}
          />
        )}
        {modal?.kind === "settings" && current && (
          <ServerSettings details={current} selfId={user.id} presence={presence} onClose={() => setModal(null)} />
        )}
      </div>
    </VoiceContext.Provider>
  );
}
