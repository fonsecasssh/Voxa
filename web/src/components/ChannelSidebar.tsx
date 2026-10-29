import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Channel, ServerDetails } from "../api.ts";
import { navigate } from "../router.ts";
import { Permission, can, canOpenSettings, memberColor, memberName, myPermissions } from "../members.ts";
import { useVoice } from "../voice/useVoice.ts";
import type { VoiceMember } from "../voice/types.ts";
import { Avatar } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";
import { useUserVolumeMenu, useUserVolumes } from "./UserVolumeMenu.tsx";

interface Props {
  details: ServerDetails;
  activeChannelId?: string;
  selfId: string;
  onCreateChannel: () => void;
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

export function ChannelSidebar(props: Props) {
  const { details, activeChannelId, selfId, onCreateChannel, onEditChannel, footer } = props;
  const [voice, vs] = useVoice();
  const perms = myPermissions(details, selfId);
  const manageChannels = can(perms, Permission.MANAGE_CHANNELS);
  const groups = [
    { label: "Canais de texto", type: "text" as const, icon: "#" },
    { label: "Canais de voz", type: "voice" as const, icon: "🔊" },
  ];

  const open = (c: Channel) => {
    if (c.type === "voice") voice?.join(c.id, details.server.id);
    navigate(`/channels/${details.server.id}/${c.id}`);
  };

  return (
    <aside className="sidebar">
      <ServerMenu {...props} perms={perms} />

      <div className="channel-list">
        {groups.map((g) => (
          <section key={g.type}>
            <div className="group-label">
              <span>{g.label}</span>
              {manageChannels && (
                <button className="icon-btn" title="Criar canal" onClick={onCreateChannel}>
                  +
                </button>
              )}
            </div>
            {details.channels
              .filter((c) => c.type === g.type)
              .map((c) => (
                <div key={c.id}>
                  <div className={`channel-row ${c.id === activeChannelId ? "active" : ""}`}>
                    <button
                      className={`channel ${c.id === activeChannelId ? "active" : ""} ${props.unread.has(c.id) && c.id !== activeChannelId ? "unread" : ""}`}
                      onClick={() => open(c)}
                    >
                      <span className="channel-icon">{g.icon}</span>
                      <span className="ellipsis">{c.name}</span>
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
                    <VoiceMembers
                      details={details}
                      members={details.voice[c.id] ?? []}
                      speaking={vs.speaking}
                      selfSocketId={vs.selfSocketId}
                      selfId={selfId}
                    />
                  )}
                </div>
              ))}
          </section>
        ))}
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
  onEditNickname,
  onLeave,
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
          {canOpenSettings(details, selfId) && item("Configurações do servidor", onOpenSettings)}
          {can(perms, Permission.MANAGE_CHANNELS) && item("Criar canal", onCreateChannel)}
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
