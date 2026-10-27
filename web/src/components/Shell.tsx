// The logged-in app: server rail, channel list, chat and member list.
// Owns the socket and the per-server / per-channel caches it keeps fresh.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, getToken, type Message, type Server, type ServerDetails, type User } from "../api.ts";
import { navigate } from "../router.ts";
import { connectSocket, type AppSocket } from "../socket.ts";
import { ServerRail } from "./ServerRail.tsx";
import { ChannelSidebar } from "./ChannelSidebar.tsx";
import { ChatView } from "./ChatView.tsx";
import { MemberList } from "./MemberList.tsx";
import { CreateChannelModal, CreateServerModal, InviteModal } from "./Modals.tsx";
import { VoiceView } from "./VoiceView.tsx";
import { VoiceClient } from "../voice/VoiceClient.ts";
import { VoiceContext } from "../voice/useVoice.ts";

const TYPING_MS = 4000;

interface ChannelMessages {
  items: Message[];
  hasMore: boolean;
}

type ModalKind = "createServer" | "createChannel" | "invite" | null;

interface Props {
  user: User;
  servers: Server[];
  setServers: (update: (s: Server[]) => Server[]) => void;
  serverId?: string;
  channelId?: string;
  onLogout: () => void;
}

export function Shell({ user, servers, setServers, serverId, channelId, onLogout }: Props) {
  const socketRef = useRef<AppSocket | null>(null);
  const [voice, setVoice] = useState<VoiceClient | null>(null);
  const [details, setDetails] = useState<Record<string, ServerDetails>>({});
  const [messages, setMessages] = useState<Record<string, ChannelMessages>>({});
  const [typing, setTyping] = useState<Record<string, Record<string, { user: User; until: number }>>>({});
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
        (d) => setDetails((all) => ({ ...all, [id]: d })),
        (err) => setLoadError((err as Error).message),
      )
      .finally(() => inFlight.current.delete(key));
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

    socket.on("connect", () => {
      // After a reconnect we may have missed events: refresh what's on screen.
      if (connectedBefore) {
        const { serverId: s, channelId: c } = activeRef.current;
        if (s) loadServer(s);
        if (c) loadMessages(c);
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
    });

    socket.on("channel:new", (c) => {
      setDetails((all) => {
        const d = all[c.serverId];
        if (!d || d.channels.some((x) => x.id === c.id)) return all;
        return { ...all, [c.serverId]: { ...d, channels: [...d.channels, c] } };
      });
    });

    socket.on("member:join", ({ serverId: sid, user: u }) => {
      setDetails((all) => {
        const d = all[sid];
        if (!d || d.members.some((x) => x.id === u.id)) return all;
        return { ...all, [sid]: { ...d, members: [...d.members, u], online: [...d.online, u.id] } };
      });
    });

    socket.on("presence", ({ userId, online }) => {
      setDetails((all) => {
        const next: typeof all = {};
        for (const [sid, d] of Object.entries(all)) {
          const has = d.online.includes(userId);
          next[sid] =
            online && !has && d.members.some((m) => m.id === userId)
              ? { ...d, online: [...d.online, userId] }
              : !online && has
                ? { ...d, online: d.online.filter((x) => x !== userId) }
                : d;
        }
        return next;
      });
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
  }, [loadServer, loadMessages]);

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
  const current = serverId ? details[serverId] : undefined;

  useEffect(() => setLoadError(null), [serverId]);

  useEffect(() => {
    if (!serverId) {
      if (servers.length) navigate(`/channels/${servers[0].id}`, true);
      return;
    }
    if (!details[serverId] && !loadError) loadServer(serverId);
  }, [serverId, servers, details, loadError, loadServer]);

  useEffect(() => {
    if (!current || channelId) return;
    const first = current.channels.find((c) => c.type === "text") ?? current.channels[0];
    if (first) navigate(`/channels/${current.server.id}/${first.id}`, true);
  }, [current, channelId]);

  const channel = current?.channels.find((c) => c.id === channelId);

  useEffect(() => {
    if (channel?.type === "text" && !messages[channel.id]) loadMessages(channel.id).catch(() => {});
  }, [channel, messages, loadMessages]);

  // --- render -----------------------------------------------------------------
  const typingUsers = channel ? Object.values(typing[channel.id] ?? {}).map((t) => t.user) : [];

  return (
    <VoiceContext.Provider value={voice}>
    <div className={`shell ${current ? "" : "no-members"}`}>
      <ServerRail servers={servers} activeId={serverId} onCreate={() => setModal("createServer")} />

      {current ? (
        <>
          <ChannelSidebar
            details={current}
            activeChannelId={channelId}
            user={user}
            isOwner={current.server.ownerId === user.id}
            onCreateChannel={() => setModal("createChannel")}
            onInvite={() => setModal("invite")}
            onLogout={onLogout}
          />
          {channel?.type === "text" ? (
            <ChatView
              channel={channel}
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
          ) : channel?.type === "voice" ? (
            <VoiceView channel={channel} members={current.voice[channel.id] ?? []} />
          ) : (
            <main className="main placeholder" />
          )}
          <MemberList members={current.members} online={current.online} ownerId={current.server.ownerId} />
        </>
      ) : (
        <>
          <aside className="sidebar">
            <div className="user-panel-spacer" />
          </aside>
          <main className="main placeholder">
            {loadError ? (
              <p className="muted">{loadError}</p>
            ) : serverId ? (
              <p className="muted">Carregando…</p>
            ) : (
              <>
                <h2>Olá, {user.displayName}!</h2>
                <p className="muted">Crie um servidor ou entre em um com um link de convite.</p>
                <button className="btn primary" onClick={() => setModal("createServer")}>
                  Criar servidor
                </button>
                <button className="link small" onClick={onLogout}>
                  Sair da conta
                </button>
              </>
            )}
          </main>
        </>
      )}

      {modal === "createServer" && (
        <CreateServerModal
          onClose={() => setModal(null)}
          onCreated={({ server, channels }) => {
            setServers((s) => [...s, server]);
            setDetails((all) => ({
              ...all,
              [server.id]: { server, channels, members: [user], online: [user.id], voice: {} },
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
            setDetails((all) => {
              const d = all[c.serverId];
              if (!d || d.channels.some((x) => x.id === c.id)) return all;
              return { ...all, [c.serverId]: { ...d, channels: [...d.channels, c] } };
            });
            setModal(null);
            navigate(`/channels/${c.serverId}/${c.id}`);
          }}
        />
      )}
      {modal === "invite" && current && <InviteModal server={current.server} onClose={() => setModal(null)} />}
    </div>
    </VoiceContext.Provider>
  );
}
