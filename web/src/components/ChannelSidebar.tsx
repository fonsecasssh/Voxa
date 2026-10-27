import type { ReactNode } from "react";
import type { Channel, ServerDetails } from "../api.ts";
import { navigate } from "../router.ts";
import { useVoice } from "../voice/useVoice.ts";
import type { VoiceMember } from "../voice/types.ts";
import { Avatar } from "./Avatar.tsx";

interface Props {
  details: ServerDetails;
  activeChannelId?: string;
  isOwner: boolean;
  onCreateChannel: () => void;
  onInvite: () => void;
  footer: ReactNode;
}

export function ChannelSidebar({ details, activeChannelId, isOwner, onCreateChannel, onInvite, footer }: Props) {
  const [voice, vs] = useVoice();
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
      <header className="sidebar-header">
        <span className="ellipsis">{details.server.name}</span>
        <button className="icon-btn" title="Convidar pessoas" onClick={onInvite}>
          👤+
        </button>
      </header>

      <div className="channel-list">
        {groups.map((g) => (
          <section key={g.type}>
            <div className="group-label">
              <span>{g.label}</span>
              {isOwner && (
                <button className="icon-btn" title="Criar canal" onClick={onCreateChannel}>
                  +
                </button>
              )}
            </div>
            {details.channels
              .filter((c) => c.type === g.type)
              .map((c) => (
                <div key={c.id}>
                  <button className={`channel ${c.id === activeChannelId ? "active" : ""}`} onClick={() => open(c)}>
                    <span className="channel-icon">{g.icon}</span>
                    <span className="ellipsis">{c.name}</span>
                  </button>
                  {c.type === "voice" && (
                    <VoiceMembers members={details.voice[c.id] ?? []} speaking={vs.speaking} selfSocketId={vs.selfSocketId} />
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

function VoiceMembers({
  members,
  speaking,
  selfSocketId,
}: {
  members: VoiceMember[];
  speaking: string[];
  selfSocketId: string | null;
}) {
  if (members.length === 0) return null;
  return (
    <ul className="voice-members">
      {members.map((m) => {
        const isSpeaking = speaking.includes(m.socketId === selfSocketId ? "self" : m.socketId);
        return (
          <li key={m.socketId}>
            <span className={`speak-ring ${isSpeaking ? "speaking" : ""}`}>
              <Avatar name={m.user.displayName} id={m.user.id} size={22} />
            </span>
            <span className="ellipsis">{m.user.displayName}</span>
            {m.screenStreamId && <span className="live-badge">AO VIVO</span>}
            {m.deafened ? <span title="Áudio desativado">🔕</span> : m.muted ? <span title="Microfone desativado">🔇</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
