import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { api, type Category, type Channel, type ServerDetails } from "../api.ts";
import { navigate } from "../router.ts";
import { Permission, can, canOpenSettings, memberColor, memberName, myPermissions } from "../members.ts";
import { useVoice } from "../voice/useVoice.ts";
import type { VoiceMember } from "../voice/types.ts";
import { Avatar } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";
import { useUserVolumeMenu, useUserVolumes } from "./UserVolumeMenu.tsx";
import { isMuted, notifyFor, type NotifySettings } from "../notifications.ts";
import type { NotifyTarget } from "./NotifyModal.tsx";

interface Props {
  details: ServerDetails;
  activeChannelId?: string;
  selfId: string;
  /** In a category, or above all of them (null). */
  onCreateChannel: (categoryId: string | null) => void;
  onCreateCategory: () => void;
  /** Notification settings: for the server (menu) or a channel (right-click). */
  notify: NotifySettings;
  onNotify: (target: NotifyTarget) => void;
  onEditCategory: (category: Category) => void;
  onInvite: () => void;
  onOpenSettings: () => void;
  onEditNickname: () => void;
  onEditChannel: (channel: Channel) => void;
  onLeave: () => void;
  footer: ReactNode;
  /** Text channels with messages not seen yet, and how many of them mention you. */
  unread: Set<string>;
  mentionCounts: Record<string, number>;
}

const COLLAPSED_KEY = "voxa.collapsedCategories";

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

/** What is being dragged (only for people who can manage channels). */
type Drag = { kind: "channel"; id: string } | { kind: "category"; id: string };
/** Where it would land: before a channel, at the end of a category (or of the top group), or before a category. */
type Drop = { kind: "channel"; id: string } | { kind: "end"; categoryId: string | null } | { kind: "category"; id: string | null };

export function ChannelSidebar(props: Props) {
  const { details, activeChannelId, selfId, onCreateChannel, onEditChannel, onEditCategory, footer } = props;
  const [voice, vs] = useVoice();
  const perms = myPermissions(details, selfId);
  const manageChannels = can(perms, Permission.MANAGE_CHANNELS);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Storage unavailable: remembered for this session only.
      }
      return next;
    });

  const open = (c: Channel) => {
    if (c.type === "voice") voice?.join(c.id, details.server.id);
    navigate(`/channels/${details.server.id}/${c.id}`);
  };

  const known = new Set(details.categories.map((c) => c.id));
  const inCategory = (id: string | null) => details.channels.filter((c) => (c.categoryId && known.has(c.categoryId) ? c.categoryId : null) === id);

  const finishDrop = (target: Drop) => {
    const d = drag;
    setDrag(null);
    setDrop(null);
    if (!d) return;
    const fail = (e: unknown) => alert((e as Error).message);
    if (d.kind === "channel") {
      if (target.kind === "channel") {
        if (target.id === d.id) return;
        const before = details.channels.find((c) => c.id === target.id);
        api.moveChannel(d.id, before?.categoryId && known.has(before.categoryId) ? before.categoryId : null, target.id).catch(fail);
      } else if (target.kind === "end") {
        api.moveChannel(d.id, target.categoryId, null).catch(fail);
      }
    } else if (target.kind === "category" && target.id !== d.id) {
      api.moveCategory(d.id, target.id).catch(fail);
    }
  };

  /** Drag-and-drop handlers for an element that accepts `target` while `accepts` is being dragged. */
  const dropZone = (target: Drop, accepts: Drag["kind"]) =>
    manageChannels
      ? {
          onDragOver: (e: DragEvent) => {
            if (drag?.kind !== accepts) return;
            e.preventDefault();
            e.stopPropagation();
            if (JSON.stringify(drop) !== JSON.stringify(target)) setDrop(target);
          },
          onDrop: (e: DragEvent) => {
            if (drag?.kind !== accepts) return;
            e.preventDefault();
            e.stopPropagation();
            finishDrop(target);
          },
        }
      : {};
  const isDrop = (target: Drop) => !!drop && JSON.stringify(drop) === JSON.stringify(target);
  const draggable = (d: Drag) =>
    manageChannels
      ? {
          draggable: true,
          onDragStart: (e: DragEvent) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", d.id);
            // Changing the page during dragstart makes Chrome cancel the drag at once.
            setTimeout(() => setDrag(d));
          },
          onDragEnd: () => {
            setDrag(null);
            setDrop(null);
          },
        }
      : {};

  const channelRow = (c: Channel, hidden: boolean) => {
    if (hidden && c.id !== activeChannelId && !(c.type === "voice" && details.voice[c.id]?.length)) return null;
    return (
      <div key={c.id} className={`channel-item ${drag?.id === c.id ? "dragging" : ""}`} {...dropZone({ kind: "channel", id: c.id }, "channel")}>
        {isDrop({ kind: "channel", id: c.id }) && <div className="drop-line" />}
        <div
          className={`channel-row ${c.id === activeChannelId ? "active" : ""} ${notifyFor(props.notify, c.id, details.server.id).muted ? "muted-channel" : ""}`}
          {...draggable({ kind: "channel", id: c.id })}
          onContextMenu={
            c.type === "text"
              ? (e) => {
                  e.preventDefault();
                  props.onNotify({ id: c.id, kind: "channel", label: `#${c.name}` });
                }
              : undefined
          }
        >
          <button
            className={`channel ${c.id === activeChannelId ? "active" : ""} ${props.unread.has(c.id) && c.id !== activeChannelId ? "unread" : ""}`}
            onClick={() => open(c)}
          >
            <span className="channel-icon">{c.type === "voice" ? "🔊" : "#"}</span>
            <span className="ellipsis">{c.name}</span>
            {c.private && (
              <span className="channel-lock" title="Canal privado">
                <Icon name="lock" size={12} />
              </span>
            )}
            {isMuted(props.notify, c.id) && (
              <span className="channel-lock" title="Silenciado">
                <Icon name="bellOff" size={12} />
              </span>
            )}
            {!!props.mentionCounts[c.id] && c.id !== activeChannelId && (
              <span className="badge" aria-label={`${props.mentionCounts[c.id]} menções`}>
                {props.mentionCounts[c.id]}
              </span>
            )}
          </button>
          {manageChannels && (
            <button className="icon-btn channel-edit" title="Editar canal" onClick={() => onEditChannel(c)}>
              ⚙
            </button>
          )}
        </div>
        {c.type === "voice" && (
          <VoiceMembers details={details} members={details.voice[c.id] ?? []} speaking={vs.speaking} selfSocketId={vs.selfSocketId} selfId={selfId} />
        )}
      </div>
    );
  };

  const top = inCategory(null);

  return (
    <aside className="sidebar">
      <ServerMenu {...props} perms={perms} />

      <div className="channel-list" onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDrop(null)}>
        <section className="category-section uncategorized" {...dropZone({ kind: "end", categoryId: null }, "channel")}>
          {top.map((c) => channelRow(c, false))}
          {isDrop({ kind: "end", categoryId: null }) && <div className="drop-line" />}
        </section>
        {details.categories.map((cat) => {
          const isCollapsed = collapsed.has(cat.id);
          const channels = inCategory(cat.id);
          return (
            <section
              key={cat.id}
              className={`category-section ${drag?.id === cat.id ? "dragging" : ""}`}
              {...dropZone({ kind: "end", categoryId: cat.id }, "channel")}
            >
              {isDrop({ kind: "category", id: cat.id }) && <div className="drop-line" />}
              <div className="group-label category-label" {...dropZone({ kind: "category", id: cat.id }, "category")} {...draggable({ kind: "category", id: cat.id })}>
                <button className="category-toggle" aria-expanded={!isCollapsed} onClick={() => toggle(cat.id)} onContextMenu={manageChannels ? (e) => (e.preventDefault(), onEditCategory(cat)) : undefined}>
                  <span className={`category-chevron ${isCollapsed ? "collapsed" : ""}`} aria-hidden="true">
                    ▾
                  </span>
                  <span className="ellipsis">{cat.name}</span>
                </button>
                {manageChannels && (
                  <>
                    <button className="icon-btn category-edit" title="Editar categoria" onClick={() => onEditCategory(cat)}>
                      ⚙
                    </button>
                    <button className="icon-btn" title="Criar canal" aria-label={`Criar canal em ${cat.name}`} onClick={() => onCreateChannel(cat.id)}>
                      +
                    </button>
                  </>
                )}
              </div>
              {channels.map((c) => channelRow(c, isCollapsed))}
              {isDrop({ kind: "end", categoryId: cat.id }) && <div className="drop-line" />}
            </section>
          );
        })}
        {drag?.kind === "category" && (
          <div className="category-end" {...dropZone({ kind: "category", id: null }, "category")}>
            {isDrop({ kind: "category", id: null }) && <div className="drop-line" />}
          </div>
        )}
        {details.channels.length === 0 && details.categories.length === 0 && <p className="muted small pad-x">Nenhum canal que você possa ver.</p>}
      </div>

      {footer}
    </aside>
  );
}

/** The server name at the top, which opens a menu of server actions (like Discord's). */
function ServerMenu({
  details,
  selfId,
  perms,
  onInvite,
  onOpenSettings,
  onCreateChannel,
  onCreateCategory,
  onEditNickname,
  onLeave,
  ...props
}: Props & { perms: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isOwner = details.server.ownerId === selfId;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const item = (label: string, onClick: () => void, className = "") => (
    <button
      role="menuitem"
      className={`menu-item ${className}`}
      onClick={() => {
        setOpen(false);
        onClick();
      }}
    >
      {label}
    </button>
  );

  return (
    <div className={`server-menu ${details.server.banner ? "with-banner" : ""}`} ref={ref}>
      {details.server.banner && (
        <div className="server-banner" style={{ backgroundImage: `url(${details.server.banner})` }} aria-hidden="true" />
      )}
      <button className="sidebar-header server-menu-button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="ellipsis">{details.server.name}</span>
        <span className="chevron">{open ? "✕" : "▾"}</span>
      </button>
      {open && (
        <div className="dropdown" role="menu">
          {item("Convidar pessoas", onInvite, "accent")}
          {item(isMuted(props.notify, details.server.id) ? "Notificações (silenciado)" : "Notificações", () =>
            props.onNotify({ id: details.server.id, kind: "server", label: details.server.name }),
          )}
          {canOpenSettings(details, selfId) && item("Configurações do servidor", onOpenSettings)}
          {can(perms, Permission.MANAGE_CHANNELS) && item("Criar canal", () => onCreateChannel(null))}
          {can(perms, Permission.MANAGE_CHANNELS) && item("Criar categoria", onCreateCategory)}
          {(can(perms, Permission.CHANGE_NICKNAME) || can(perms, Permission.MANAGE_NICKNAMES)) && item("Editar apelido no servidor", onEditNickname)}
          {!isOwner && item("Sair do servidor", onLeave, "danger")}
        </div>
      )}
    </div>
  );
}

function VoiceMembers({
  details,
  members,
  speaking,
  selfSocketId,
  selfId,
}: {
  details: ServerDetails;
  members: VoiceMember[];
  speaking: string[];
  selfSocketId: string | null;
  selfId: string;
}) {
  const volumes = useUserVolumes();
  const menu = useUserVolumeMenu();
  if (members.length === 0) return null;
  return (
    <ul className="voice-members">
      {menu.menu}
      {members.map((m) => {
        const isSpeaking = speaking.includes(m.socketId === selfSocketId ? "self" : m.socketId);
        const name = memberName(details, m.user);
        const mutedForMe = volumes[m.user.id]?.muted;
        return (
          <li key={m.socketId} onContextMenu={m.user.id === selfId ? undefined : (e) => menu.open(e, m.user.id, name)}>
            <span className={`speak-ring ${isSpeaking ? "speaking" : ""}`}>
              <Avatar name={name} id={m.user.id} size={22} src={m.user.avatar} />
            </span>
            <span className="ellipsis" style={{ color: memberColor(details, m.user.id) }}>
              {name}
            </span>
            {m.screenStreamId && <span className="live-badge">AO VIVO</span>}
            {m.cameraStreamId && (
              <span className="state-icon" title="Câmera ligada">
                <Icon name="video" size={15} />
              </span>
            )}
            {mutedForMe && (
              <span className="state-icon" title="Silenciado para você">
                <Icon name="speakerOff" size={15} />
              </span>
            )}
            {m.deafened ? (
              <span className="state-icon" title="Áudio desativado">
                <Icon name="headphonesOff" size={15} />
              </span>
            ) : m.muted ? (
              <span className="state-icon" title="Microfone desativado">
                <Icon name="micOff" size={15} />
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
