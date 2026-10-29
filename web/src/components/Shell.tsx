// The logged-in app: server rail, sidebars, chat / voice / friends views and member list.
// Owns the socket and keeps the caches below fresh from its events.

import { MessageSkeleton, ServerSkeleton } from "./Skeleton.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  dmTitle,
  getToken,
  type Activity,
  type CustomStatus,
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
import { Permission, can, memberName, myPermissions } from "../members.ts";
import { connectSocket, type AppSocket } from "../socket.ts";
import { VoiceClient } from "../voice/VoiceClient.ts";
import { VoiceContext, useVoiceSnapshot } from "../voice/useVoice.ts";
import { useVoiceSounds } from "../voice/useVoiceSounds.ts";
import { usePushToTalk } from "../voice/usePushToTalk.ts";
import { useUserVolumes } from "./UserVolumeMenu.tsx";
import { playSound } from "../sounds.ts";
import { ServerRail } from "./ServerRail.tsx";
import { ChannelSidebar } from "./ChannelSidebar.tsx";
import { HomeSidebar } from "./HomeSidebar.tsx";
import { SidebarFooter, type SetPresence } from "./SidebarFooter.tsx";
import { ChatView } from "./ChatView.tsx";
import { ReplayModal } from "./ReplayModal.tsx";
import { AppSettingsModal } from "./AppSettingsModal.tsx";
import { FriendsView } from "./FriendsView.tsx";
import { MemberList } from "./MemberList.tsx";
import { VoiceView } from "./VoiceView.tsx";
import { DmCallBar, GroupDmModal, GroupMembers, IncomingCall, RING_FOR_MS } from "./DmParts.tsx";
import { Icon } from "./Icon.tsx";
import { MobileNavContext } from "./MobileNav.tsx";
import type { VoiceMember } from "../voice/types.ts";
import { CreateServerModal, NicknameModal, ProfileModal } from "./Modals.tsx";
import { CategoryModal, CreateChannelModal, EditChannelModal, InviteModal, ThreadModal } from "./ChannelModals.tsx";
import { ServerSettings } from "./ServerSettings.tsx";
import { VoiceSettingsModal } from "./VoiceSettingsModal.tsx";
import type { Category, Channel } from "../api.ts";
import { notifyFor, type NotifySettings } from "../notifications.ts";
import { NotifyModal, type NotifyTarget } from "./NotifyModal.tsx";
import { BlockedContext } from "../blocking.ts";
import { SearchBox, SearchPanel, type SearchScope } from "./Search.tsx";
import { PinsButton } from "./Pins.tsx";
import { CustomEmojiContext } from "../customEmojis.ts";
import type { CustomEmoji } from "../api.ts";

const TYPING_MS = 4000;
const HOME = "@me";

interface ChannelMessages {
  items: Message[];
  hasMore: boolean;
  /** Where you had stopped reading (for the "Novas mensagens" line). */
  lastReadAt?: number;
  /** An older stretch is shown (after jumping to a message); live messages wait. */
  hasNewer?: boolean;
}

type ModalKind =
  | { kind: "createServer" | "invite" | "nickname" | "profile" | "settings" | "voiceSettings" | "replay" | "appSettings" }
  | { kind: "createChannel"; categoryId: string | null }
  | { kind: "editChannel"; channel: Channel }
  | { kind: "notify"; target: NotifyTarget }
  | { kind: "thread"; channel: Channel; message: Message }
  /** Create a category, or edit `category`. */
  | { kind: "category"; category?: Category }
  /** Start a group DM, or add people to one (`dm` is where the button was). */
  | { kind: "groupDm"; dm?: DmSummary }
  | null;

interface Props {
  user: User;
  setUser: (user: User) => void;
  initialStatus: UserStatus;
  initialActivity: Activity | null;
  initialCustomStatus: CustomStatus | null;
  initialUnread: Record<string, { mentions: number; serverId: string | null }>;
  initialNotify: NotifySettings;
  initialBlocked: string[];
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

export function Shell({
  user,
  setUser,
  initialStatus,
  initialActivity,
  initialCustomStatus,
  initialUnread,
  initialNotify,
  initialBlocked,
  servers,
  setServers,
  serverId,
  channelId,
  onLogout,
}: Props) {
  const socketRef = useRef<AppSocket | null>(null);
  const [voice, setVoice] = useState<VoiceClient | null>(null);
  const voiceState = useVoiceSnapshot(voice);

  const [details, setDetails] = useState<Record<string, ServerDetails>>({});
  /** Calls going on in our DMs, by channel. */
  const [dmCalls, setDmCalls] = useState<Record<string, VoiceMember[]>>({});
  /** An incoming DM call we haven't answered or declined. */
  const [ringing, setRinging] = useState<{ channelId: string; from: User } | null>(null);
  const [showGroupMembers, setShowGroupMembers] = useState(true);
  const [customEmojis, setCustomEmojis] = useState<CustomEmoji[]>([]);
  useEffect(() => {
    api.myEmojis().then((r) => setCustomEmojis(r.emojis), () => {});
  }, [servers.length]);
  const [search, setSearch] = useState<{ scope: SearchScope; q: string } | null>(null);
  const [focus, setFocus] = useState<{ channelId: string; id: string; n: number } | null>(null);
  /** Phones: the server and channel lists are showing (instead of the conversation). */
  const [navOpen, setNavOpen] = useState(true);
  const openNav = useCallback(() => setNavOpen(true), []);
  const myVoiceMembers = !voiceState.channelId
    ? undefined
    : voiceState.serverId
      ? details[voiceState.serverId]?.voice[voiceState.channelId]
      : dmCalls[voiceState.channelId];
  useVoiceSounds(voiceState, myVoiceMembers);
  usePushToTalk(voice);
  // Each person's volume for us follows them across reconnects (stored by user, applied by socket).
  const volumes = useUserVolumes();
  useEffect(() => {
    if (!voice || !myVoiceMembers) return;
    for (const m of myVoiceMembers) {
      if (m.socketId !== voiceState.selfSocketId) voice.setPeerVolume(m.socketId, volumes[m.user.id] ?? { volume: 1, muted: false });
    }
  }, [voice, myVoiceMembers, volumes, voiceState.selfSocketId]);
  const [messages, setMessages] = useState<Record<string, ChannelMessages>>({});
  const [typing, setTyping] = useState<Record<string, Record<string, { user: User; until: number }>>>({});
  const [presence, setPresenceMap] = useState<Record<string, Presence>>({});
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [dms, setDms] = useState<DmSummary[] | null>(null);
  const [notifySettings, setNotifySettings] = useState<NotifySettings>(initialNotify);
  const [blocked, setBlocked] = useState<Set<string>>(() => new Set(initialBlocked));
  // Unread from the server (it remembers where you stopped reading), minus muted conversations.
  const [unread, setUnread] = useState<Set<string>>(
    () => new Set(Object.entries(initialUnread).filter(([id, u]) => !notifyFor(initialNotify, id, u.serverId).muted).map(([id]) => id)),
  );
  /** Unseen mentions of you, per channel (with its server, for the badge on the server icon). */
  const [mentionCounts, setMentionCounts] = useState<Record<string, { n: number; serverId: string | null }>>(() =>
    Object.fromEntries(
      Object.entries(initialUnread)
        .filter(([id, u]) => u.mentions > 0 && u.serverId && !notifyFor(initialNotify, id, u.serverId).muted)
        .map(([id, u]) => [id, { n: u.mentions, serverId: u.serverId }]),
    ),
  );
  const [myStatus, setMyStatus] = useState<UserStatus>(initialStatus);
  const [myActivity, setMyActivity] = useState<Activity | null>(initialActivity);
  const [myCustomStatus, setMyCustomStatus] = useState<CustomStatus | null>(initialCustomStatus);
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
    api.dms().then(({ dms: list, presence: p, calls }) => {
      setDms(list);
      setDmCalls(calls);
      applyPresenceSnapshot([...new Set(list.flatMap((d) => d.members.map((u) => u.id)))], p, requestedAt);
    });
  }, [applyPresenceSnapshot]);

  // Messages that arrive while a channel's latest page is loading: the page may have been read
  // before they were sent, so they're added to it when it comes.
  const arrivedWhileLoading = useRef(new Map<string, Message[]>());
  const loadMessages = useCallback(async (id: string, before?: number) => {
    const key = `messages:${id}:${before ?? "latest"}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    if (!before) arrivedWhileLoading.current.set(id, []);
    const { messages: page, lastReadAt } = await api.messages(id, before).finally(() => inFlight.current.delete(key));
    const arrived = before ? [] : (arrivedWhileLoading.current.get(id) ?? []);
    if (!before) arrivedWhileLoading.current.delete(id);
    setMessages((all) => {
      if (before) {
        const prev = all[id]?.items ?? [];
        const seen = new Set(prev.map((m) => m.id));
        return { ...all, [id]: { items: [...page.filter((m) => !seen.has(m.id)), ...prev], hasMore: page.length >= 50, lastReadAt: lastReadAt ?? all[id]?.lastReadAt } };
      }
      const newest = page.at(-1)?.createdAt ?? -Infinity;
      const seen = new Set(page.map((m) => m.id));
      const live = [...arrived, ...(all[id]?.items ?? [])].filter((m) => m.createdAt >= newest && !seen.has(m.id) && (seen.add(m.id), true));
      live.sort((a, b) => a.createdAt - b.createdAt);
      return { ...all, [id]: { items: [...page, ...live], hasMore: page.length >= 50, lastReadAt: lastReadAt ?? all[id]?.lastReadAt } };
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
  const notifyRef = useRef(notifySettings);
  notifyRef.current = notifySettings;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;

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
      arrivedWhileLoading.current.get(m.channelId)?.push(m);
      setMessages((all) => {
        const ch = all[m.channelId];
        // Looking at older messages: the new one shows when going back to the present.
        if (!ch || ch.hasNewer || ch.items.some((x) => x.id === m.id)) return all;
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
      // Someone you blocked, or a muted conversation: no unread mark, no sound.
      const { muted, level } = notifyFor(notifyRef.current, m.channelId, m.serverId ?? null);
      if (m.author.id !== user.id && !viewing && !muted && !blockedRef.current.has(m.author.id)) {
        setUnread((u) => (u.has(m.channelId) ? u : new Set(u).add(m.channelId)));
        const isDm = !m.serverId;
        const mentioned = m.mentions.includes(user.id) || m.mentionsEveryone;
        if (mentioned && !isDm) {
          setMentionCounts((c) => ({ ...c, [m.channelId]: { n: (c[m.channelId]?.n ?? 0) + 1, serverId: m.serverId ?? null } }));
        }
        // DMs notify every message by default, servers only mentions (each can be changed), unless in "do not disturb".
        if ((level === "all" || mentioned) && myStatusRef.current !== "dnd") {
          playSound("message");
          if (document.visibilityState !== "visible" || !document.hasFocus()) {
            const body =
              m.content.slice(0, 200) ||
              (m.poll ? `📊 ${m.poll.question}` : m.attachment ? "Enviou um replay 🎬" : m.files.length ? `Enviou ${m.files.length === 1 ? "um arquivo" : `${m.files.length} arquivos`} 📎` : "");
            const title = mentioned && !isDm ? `${m.author.displayName} mencionou você` : m.author.displayName;
            notify(title, body, m.channelId, () => navigate(`/channels/${m.serverId ?? HOME}/${m.channelId}`));
            desktop?.flash();
          }
        }
      }
    });

    // Read on another device: clear it here too.
    socket.on("channel:read", ({ channelId: cid, at }) => {
      setUnread((u) => {
        if (!u.has(cid)) return u;
        const next = new Set(u);
        next.delete(cid);
        return next;
      });
      setMentionCounts(({ [cid]: _, ...rest }) => rest);
      setMessages((all) => (all[cid] && (all[cid].lastReadAt ?? 0) < at ? { ...all, [cid]: { ...all[cid], lastReadAt: at } } : all));
    });
    socket.on("emojis:update", ({ serverId: sid, emojis }) =>
      setCustomEmojis((all) => [...all.filter((e) => e.serverId !== sid), ...emojis]),
    );
    socket.on("notify:update", (settings) => {
      setNotifySettings(settings);
      // Muting something hides its unread marks right away.
      const quiet = (cid: string, sid: string | null) => notifyFor(settings, cid, sid).muted;
      setMentionCounts((c) => Object.fromEntries(Object.entries(c).filter(([cid, v]) => !quiet(cid, v.serverId))));
    });
    socket.on("blocks:update", ({ blocked: ids }) => setBlocked(new Set(ids)));

    socket.on("message:reactions", ({ channelId: cid, messageId, reactions }) => {
      setMessages((all) => {
        const ch = all[cid];
        if (!ch) return all;
        return { ...all, [cid]: { ...ch, items: ch.items.map((x) => (x.id === messageId ? { ...x, reactions } : x)) } };
      });
    });

    socket.on("message:poll", ({ channelId: cid, messageId, poll }) => {
      setMessages((all) => {
        const ch = all[cid];
        if (!ch) return all;
        return { ...all, [cid]: { ...ch, items: ch.items.map((x) => (x.id === messageId ? { ...x, poll } : x)) } };
      });
    });

    socket.on("message:delete", ({ channelId: cid, id }) => {
      setMessages((all) => {
        const ch = all[cid];
        if (!ch) return all;
        // Replies quoting it now say the original was deleted.
        const items = ch.items
          .filter((x) => x.id !== id)
          .map((x) => (x.replyTo?.id === id ? { ...x, replyTo: { id, author: null, content: "", hasFiles: false } } : x));
        return { ...all, [cid]: { ...ch, items } };
      });
    });

    // A message changed, e.g. its clip was deleted to free space on the server.
    socket.on("message:update", (m) => {
      setMessages((all) => {
        const ch = all[m.channelId];
        if (!ch) return all;
        // Replies quoting an edited message show its new text.
        const items = ch.items.map((x) =>
          x.id === m.id ? m : x.replyTo?.id === m.id && x.replyTo.author ? { ...x, replyTo: { ...x.replyTo, content: m.content.slice(0, 200) } } : x,
        );
        return { ...all, [m.channelId]: { ...ch, items } };
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
      if (userId === user.id && p.status !== "offline") {
        setMyActivity(p.activity);
        setMyCustomStatus(p.custom ?? null);
      }
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
    socket.on("dm:update", (dm) => {
      setDms((list) => list?.map((d) => (d.channel.id === dm.channel.id ? dm : d)) ?? list);
    });
    socket.on("dm:remove", ({ channelId: cid }) => {
      setDms((list) => list?.filter((d) => d.channel.id !== cid) ?? list);
      setDmCalls(({ [cid]: _, ...rest }) => rest);
      setRinging((r) => (r?.channelId === cid ? null : r));
      if (activeRef.current.channelId === cid) navigate(`/channels/${HOME}`, true);
    });
    socket.on("call:ring", (r) => {
      if (myStatusRef.current === "dnd") return;
      setRinging(r);
    });

    socket.on("voice:update", ({ serverId: sid, channelId: cid, members }) => {
      if (sid === null) {
        setDmCalls(({ [cid]: _, ...rest }) => (members.length ? { ...rest, [cid]: members } : rest));
        return;
      }
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
      setDms((list) => list?.map((d) => ({ ...d, user: d.user && swap(d.user), members: d.members.map(swap) })) ?? list);
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

    socket.on("channels:update", ({ serverId: sid, channels, categories }) => {
      updateServer(sid, (d) => ({ ...d, channels, categories }));
      // A channel we were looking at was deleted or hidden from us.
      const { serverId: here, channelId: open } = activeRef.current;
      if (here === sid && open && !channels.some((c) => c.id === open)) navigate(`/channels/${sid}`, true);
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
      setMentionCounts((c) => {
        if (!c[channelId]) return c;
        const { [channelId]: _, ...rest } = c;
        return rest;
      });
    };
    clear();
    document.addEventListener("visibilitychange", clear);
    return () => document.removeEventListener("visibilitychange", clear);
  }, [channelId, unread]);

  // Tell the server how far you've read (it remembers across devices and reloads).
  const latestAt = channelId ? messages[channelId]?.items.at(-1)?.createdAt : undefined;
  const markedRef = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!channelId || !latestAt) return;
    const mark = () => {
      if (document.visibilityState !== "visible" || (markedRef.current[channelId] ?? 0) >= latestAt) return;
      markedRef.current[channelId] = latestAt;
      api
        .markRead(channelId, latestAt)
        .then(({ lastReadAt }) =>
          setMessages((all) => (all[channelId] ? { ...all, [channelId]: { ...all[channelId], lastReadAt } } : all)),
        )
        .catch(() => delete markedRef.current[channelId]);
    };
    // A moment later, so the "Novas mensagens" line is drawn from where you were.
    const t = setTimeout(mark, 300);
    document.addEventListener("visibilitychange", mark);
    return () => {
      clearTimeout(t);
      document.removeEventListener("visibilitychange", mark);
    };
  }, [channelId, latestAt]);

  // --- desktop app integration ---------------------------------------------------

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

  /** Opens a channel at one message (loading the messages around it when needed). */
  const jumpToMessage = async (channelId: string, messageId: string) => {
    const owner = Object.values(details).find((d) => d.channels.some((c) => c.id === channelId));
    navigate(`/channels/${owner?.server.id ?? HOME}/${channelId}`);
    if (!messages[channelId]?.items.some((m) => m.id === messageId)) {
      try {
        const r = await api.messagesAround(channelId, messageId);
        setMessages((all) => ({ ...all, [channelId]: { items: r.messages, hasMore: true, hasNewer: r.hasNewer, lastReadAt: all[channelId]?.lastReadAt } }));
      } catch (err) {
        return alert((err as Error).message);
      }
    }
    setFocus({ channelId, id: messageId, n: Date.now() });
  };

  // Searching another server or conversation closes the results.
  useEffect(() => {
    if (!search) return;
    const here = isHome ? channelId : serverId;
    if (here !== search.scope.id) setSearch(null);
  }, [serverId, channelId, isHome, search]);

  /** Answers (or starts) a call in a DM, optionally with the camera on. */
  const joinDmCall = async (channelId: string, video: boolean) => {
    setRinging(null);
    if (!voice) return;
    navigate(`/channels/${HOME}/${channelId}`);
    await voice.join(channelId, null);
    if (video) await voice.startCamera();
  };

  // An unanswered ring stops when the call ends, when we pick up, or after a while.
  useEffect(() => {
    if (!ringing) return;
    if (!dmCalls[ringing.channelId]?.length || (voiceState.channelId === ringing.channelId && voiceState.status !== "idle")) {
      setRinging(null);
      return;
    }
    const t = setTimeout(() => setRinging(null), RING_FOR_MS);
    return () => clearTimeout(t);
  }, [ringing, dmCalls, voiceState.channelId, voiceState.status]);

  const leaveGroup = async (d: DmSummary) => {
    if (!confirm(`Sair de ${dmTitle(d)}? Você só volta se alguém te adicionar de novo.`)) return;
    try {
      await api.removeFromGroupDm(d.channel.id, user.id);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const setPresence: SetPresence = async (patch) => {
    const r = await api.setPresence(patch);
    setMyStatus(r.status);
    setMyCustomStatus(r.customStatus);
    // While invisible the server reports us as offline with no activity, but the activity is kept.
    if (patch.activity !== undefined) {
      setMyActivity(patch.activity ? (r.presence.activity ?? { name: patch.activity, startedAt: Date.now() }) : null);
    } else if (r.status !== "invisible") {
      setMyActivity(r.presence.activity);
    }
  };
  setPresenceRef.current = setPresence;

  // Unread marks, minus conversations muted since (muting doesn't forget them, it hides them).
  const shownUnread = useMemo(() => {
    const serverOf = new Map<string, string>();
    for (const d of Object.values(details)) for (const c of d.channels) serverOf.set(c.id, d.server.id);
    return new Set([...unread].filter((id) => !notifyFor(notifySettings, id, serverOf.get(id) ?? null).muted));
  }, [unread, notifySettings, details]);
  const unreadDms = [...shownUnread].filter((id) => dms?.some((d) => d.channel.id === id)).length;
  useEffect(() => desktop?.setBadge(unreadDms), [unreadDms]);

  // --- render -------------------------------------------------------------------
  const typingUsers = channel ? Object.values(typing[channel.id] ?? {}).map((t) => t.user) : [];
  const voiceServer = voiceState.serverId ? details[voiceState.serverId] : undefined;
  const voiceChannel = voiceServer?.channels.find((c) => c.id === voiceState.channelId);
  const voiceDm = !voiceState.serverId && voiceState.channelId ? dms?.find((d) => d.channel.id === voiceState.channelId) : undefined;

  const footer = (
    <SidebarFooter
      user={user}
      status={myStatus}
      activity={myActivity}
      customStatus={myCustomStatus}
      setPresence={setPresence}
      onEditProfile={() => setModal({ kind: "profile" })}
      onVoiceSettings={() => setModal({ kind: "voiceSettings" })}
      onReplay={() => setModal({ kind: "replay" })}
      onAppSettings={() => setModal({ kind: "appSettings" })}
      voiceLocation={
        voiceServer && voiceChannel
          ? {
              label: `${voiceChannel.name} / ${voiceServer.server.name}`,
              path: `/channels/${voiceServer.server.id}/${voiceChannel.id}`,
              serverId: voiceServer.server.id,
              serverName: voiceServer.server.name,
            }
          : voiceDm
            ? { label: `Chamada / ${dmTitle(voiceDm)}`, path: `/channels/${HOME}/${voiceDm.channel.id}`, serverId: null }
            : null
      }
      onLogout={onLogout}
    />
  );

  const chat = channel && channel.type !== "voice" && (
    <ChatView
      channel={channel}
      dm={dm}
      server={current}
      lastReadAt={messages[channel.id]?.lastReadAt}
      blocked={blocked}
      onUnblock={(id) => api.unblock(id).catch((e) => alert((e as Error).message))}
      onRename={
        dm?.group
          ? (name) => api.renameGroupDm(dm.channel.id, name).then(() => {})
          : channel.type === "thread" && current && (channel.creatorId === user.id || can(myPermissions(current, user.id), Permission.MANAGE_MESSAGES))
            ? (name) => api.updateChannel(channel.id, { name: name || channel.name }).then(() => {})
            : undefined
      }
      parentName={channel.type === "thread" ? current?.channels.find((c) => c.id === channel.parentId)?.name : undefined}
      onOpenParent={() => current && channel.parentId && navigate(`/channels/${current.server.id}/${channel.parentId}`)}
      onStartThread={current && channel.type === "text" ? (m) => setModal({ kind: "thread", channel, message: m }) : undefined}
      onOpenThread={(id) => current && navigate(`/channels/${current.server.id}/${id}`)}
      focus={focus && focus.channelId === channel.id ? focus : undefined}
      hasNewer={messages[channel.id]?.hasNewer}
      onJumpToPresent={() => loadMessages(channel.id).catch(() => {})}
      onJumpToMessage={(id) => jumpToMessage(channel.id, id)}
      canPin={!current || dm !== undefined || can(myPermissions(current, user.id), Permission.MANAGE_MESSAGES)}
      onPin={(m, pinned) => api.pin(channel.id, m.id, pinned).then(() => {})}
      onInvite={current ? () => setModal({ kind: "invite" }) : undefined}
      headerActions={
        <>
          <PinsButton
            channelId={channel.id}
            server={current}
            canPin={!current || dm !== undefined || can(myPermissions(current, user.id), Permission.MANAGE_MESSAGES)}
            version={(messages[channel.id]?.items ?? [])
              .filter((m) => m.pinnedAt)
              .map((m) => m.id)
              .join()}
            onJump={(m) => jumpToMessage(channel.id, m.id)}
          />
          <SearchBox
            key={dm ? channel.id : current?.server.id}
            scope={dm ? { id: channel.id, label: dmTitle(dm) } : { id: current!.server.id, label: current!.server.name }}
            onSearch={(q) => setSearch({ scope: dm ? { id: channel.id, label: dmTitle(dm) } : { id: current!.server.id, label: current!.server.name }, q })}
          />
          {dm && (
          <>
            <button className="icon-btn" title="Iniciar chamada de voz" aria-label="Iniciar chamada de voz" onClick={() => joinDmCall(dm.channel.id, false)}>
              <Icon name="phone" size={20} />
            </button>
            <button className="icon-btn" title="Iniciar chamada de vídeo" aria-label="Iniciar chamada de vídeo" onClick={() => joinDmCall(dm.channel.id, true)}>
              <Icon name="video" size={20} />
            </button>
            <button
              className="icon-btn"
              title={dm.group ? "Adicionar amigos ao grupo" : "Criar grupo com esta pessoa"}
              aria-label={dm.group ? "Adicionar amigos ao grupo" : "Criar grupo com esta pessoa"}
              onClick={() => setModal({ kind: "groupDm", dm })}
            >
              <Icon name="userPlus" size={20} />
            </button>
            {dm.group && (
              <button
                className={`icon-btn ${showGroupMembers ? "active" : ""}`}
                title="Mostrar membros"
                aria-label="Mostrar membros"
                aria-pressed={showGroupMembers}
                onClick={() => setShowGroupMembers((v) => !v)}
              >
                <Icon name="users" size={20} />
              </button>
            )}
          </>
          )}
        </>
      }
      top={
        dm && (
          <DmCallBar
            members={dmCalls[dm.channel.id] ?? []}
            inCall={voiceState.status !== "idle" && voiceState.channelId === dm.channel.id}
            onJoin={(video) => joinDmCall(dm.channel.id, video)}
          />
        )
      }
      messages={messages[channel.id]?.items}
      hasMore={messages[channel.id]?.hasMore ?? false}
      typingUsers={typingUsers}
      onLoadOlder={() => {
        const oldest = messages[channel.id]?.items[0];
        if (oldest) return loadMessages(channel.id, oldest.createdAt);
      }}
      onSend={(content, uploads, replyTo) => {
        requestNotificationPermission();
        return api.sendMessage(channel.id, content, uploads, replyTo).then(() => {});
      }}
      selfId={user.id}
      resolveName={(id) => {
        const member = current?.members.find((u) => u.id === id);
        if (member) return memberName(current, member);
        const inDm = dm?.members.find((u) => u.id === id);
        if (inDm) return inDm.displayName;
        return id === user.id ? user.displayName : "Alguém";
      }}
      onEdit={(m, content) => api.editMessage(channel.id, m.id, content).then(() => {})}
      mentionables={
        current && !dm
          ? current.members.map((u) => ({ id: u.id, username: u.username, label: memberName(current, u), avatar: u.avatar }))
          : dm
            ? [...dm.members, user].map((u) => ({ id: u.id, username: u.username, label: u.displayName, avatar: u.avatar }))
            : []
      }
      canMentionEveryone={!!current && !dm && can(myPermissions(current, user.id), Permission.MENTION_EVERYONE)}
      onReact={(m, emoji, add) => api.react(channel.id, m.id, emoji, add)}
      onTyping={() => socketRef.current?.emit("typing", { channelId: channel.id })}
      canDelete={(m) => m.author.id === user.id || (!!current && !dm && can(myPermissions(current, user.id), Permission.MANAGE_MESSAGES))}
      onDelete={(m) => api.deleteMessage(channel.id, m.id)}
    />
  );

  const emojiSet = useMemo(
    () => ({ emojis: customEmojis, serverNames: Object.fromEntries(servers.map((x) => [x.id, x.name])), currentServerId: current?.server.id ?? null }),
    [customEmojis, servers, current?.server.id],
  );

  const searchPanel = search && (
    <SearchPanel
      scope={search.scope}
      query={search.q}
      server={current}
      channelName={(id) => current?.channels.find((c) => c.id === id)?.name ?? null}
      onOpen={(m) => jumpToMessage(m.channelId, m.id)}
      onClose={() => setSearch(null)}
    />
  );

  let body;
  if (isHome) {
    body = (
      <>
        <HomeSidebar
          dms={dms}
          presence={presence}
          unread={shownUnread}
          activeChannelId={channelId}
          pendingCount={friends?.filter((f) => f.state === "incoming").length ?? 0}
          calls={dmCalls}
          onCreateGroup={() => setModal({ kind: "groupDm" })}
          notify={notifySettings}
          onNotify={(target) => setModal({ kind: "notify", target })}
          footer={footer}
        />
        {channelId ? (
          (chat ?? (
            dms === null ? (
              <main className="main">
                <div className="chat-header" />
                <div className="skeleton-main">
                  <MessageSkeleton />
                </div>
              </main>
            ) : (
              <main className="main placeholder">
                <p className="muted">Conversa não encontrada.</p>
              </main>
            )
          ))
        ) : (
          <FriendsView friends={friends} presence={presence} onOpenDm={openDm} />
        )}
        {search ? searchPanel : dm?.group && showGroupMembers && <GroupMembers dm={dm} self={user} presence={presence} onLeave={() => leaveGroup(dm)} />}
      </>
    );
  } else if (current) {
    body = (
      <>
        <ChannelSidebar
          details={current}
          activeChannelId={channelId}
          selfId={user.id}
          onCreateChannel={(categoryId) => setModal({ kind: "createChannel", categoryId })}
          onCreateCategory={() => setModal({ kind: "category" })}
          notify={notifySettings}
          onNotify={(target) => setModal({ kind: "notify", target })}
          onEditCategory={(category) => setModal({ kind: "category", category })}
          onInvite={() => setModal({ kind: "invite" })}
          onOpenSettings={() => setModal({ kind: "settings" })}
          onEditNickname={() => setModal({ kind: "nickname" })}
          onEditChannel={(c) => setModal({ kind: "editChannel", channel: c })}
          unread={shownUnread}
          mentionCounts={Object.fromEntries(Object.entries(mentionCounts).map(([id, x]) => [id, x.n]))}
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
        {search ? searchPanel : <MemberList details={current} presence={presence} selfId={user.id} onOpenDm={openDm} />}
      </>
    );
  } else {
    body = (
      <>
        {loadError ? (
          <>
            <aside className="sidebar">{footer}</aside>
            <main className="main placeholder">
              <p className="muted">{loadError}</p>
            </main>
          </>
        ) : (
          <ServerSkeleton footer={footer} />
        )}
      </>
    );
  }

  return (
    <VoiceContext.Provider value={voice}>
      <MobileNavContext.Provider value={openNav}>
      <BlockedContext.Provider value={blocked}>
      <CustomEmojiContext.Provider value={emojiSet}>
      {ringing &&
        (() => {
          const d = dms?.find((x) => x.channel.id === ringing.channelId);
          return (
            <IncomingCall
              from={ringing.from}
              title={d ? dmTitle(d) : ringing.from.displayName}
              onAccept={(video) => joinDmCall(ringing.channelId, video)}
              onDecline={() => {
                setRinging(null);
                playSound("callEnd");
              }}
            />
          );
        })()}
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
      <div
        className={`shell ${current || search || (dm?.group && showGroupMembers) || (!isHome && !loadError) ? "" : "no-members"} ${navOpen ? "nav-open" : ""} ${search ? "searching" : ""}`}
        // Phones: picking a channel or conversation shows it.
        onClick={(e) => (e.target as Element).closest?.(".sidebar .channel, .sidebar .channel.dm") && setNavOpen(false)}
      >
        <ServerRail
          servers={servers}
          activeId={serverId}
          unreadDms={unreadDms}
          mentionsByServer={Object.values(mentionCounts).reduce<Record<string, number>>((acc, x) => {
            if (x.serverId) acc[x.serverId] = (acc[x.serverId] ?? 0) + x.n;
            return acc;
          }, {})}
          onCreate={() => setModal({ kind: "createServer" })}
        />
        {body}

        {modal?.kind === "createServer" && (
          <CreateServerModal
            onClose={() => setModal(null)}
            onCreated={({ server, channels, categories, roles }) => {
              setServers((s) => [...s, server]);
              setDetails((all) => ({
                ...all,
                [server.id]: {
                  server,
                  channels,
                  categories,
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
            details={current}
            categoryId={modal.categoryId}
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
        {modal?.kind === "invite" && current && <InviteModal details={current} onClose={() => setModal(null)} />}
        {modal?.kind === "editChannel" && current && <EditChannelModal details={current} channel={modal.channel} onClose={() => setModal(null)} />}
        {modal?.kind === "category" && current && <CategoryModal serverId={current.server.id} category={modal.category} onClose={() => setModal(null)} />}
        {modal?.kind === "nickname" && current && (
          <NicknameModal details={current} target={user} selfId={user.id} onClose={() => setModal(null)} />
        )}
        {modal?.kind === "profile" && <ProfileModal user={user} onClose={() => setModal(null)} />}
        {modal?.kind === "voiceSettings" && <VoiceSettingsModal onClose={() => setModal(null)} />}
        {modal?.kind === "thread" && current && (
          <ThreadModal
            channel={modal.channel}
            message={modal.message}
            onClose={() => setModal(null)}
            onCreated={(c) => {
              setModal(null);
              const sid = current.server.id;
              setDetails((all) => (all[sid] && !all[sid].channels.some((x) => x.id === c.id) ? { ...all, [sid]: { ...all[sid], channels: [...all[sid].channels, c] } } : all));
              navigate(`/channels/${sid}/${c.id}`);
            }}
          />
        )}
        {modal?.kind === "notify" && <NotifyModal target={modal.target} settings={notifySettings} onClose={() => setModal(null)} />}
        {modal?.kind === "groupDm" && (
          <GroupDmModal
            friends={friends}
            dm={modal.dm}
            onClose={() => setModal(null)}
            onDone={(d) => {
              setModal(null);
              setDms((list) => (list?.some((x) => x.channel.id === d.channel.id) ? list : [d, ...(list ?? [])]));
              navigate(`/channels/${HOME}/${d.channel.id}`);
            }}
          />
        )}
        {modal?.kind === "appSettings" && <AppSettingsModal onClose={() => setModal(null)} />}
        {modal?.kind === "replay" && (
          <ReplayModal
            onClose={() => setModal(null)}
            shareTarget={channel && channel.type !== "voice" ? { channelId: channel.id, label: dm ? (dm.group ? dmTitle(dm) : `@${dmTitle(dm)}`) : `#${channel.name}` } : null}
          />
        )}
        {modal?.kind === "settings" && current && (
          <ServerSettings details={current} selfId={user.id} presence={presence} onClose={() => setModal(null)} />
        )}
      </div>
      </CustomEmojiContext.Provider>
      </BlockedContext.Provider>
      </MobileNavContext.Provider>
    </VoiceContext.Provider>
  );
}
