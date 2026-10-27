import type { Channel, ServerDetails, User } from "../api.ts";
import { navigate } from "../router.ts";
import { useVoice } from "../voice/useVoice.ts";
import type { VoiceMember } from "../voice/types.ts";
import { Avatar } from "./Avatar.tsx";

interface Props {
  details: ServerDetails;
  activeChannelId?: string;
  user: User;
  isOwner: boolean;
  onCreateChannel: () => void;
  onInvite: () => void;
  onLogout: () => void;
}

export function ChannelSidebar({ details, activeChannelId, user, isOwner, onCreateChannel, onInvite, onLogout }: Props) {
  const [voice, vs] = useVoice();
  const groups = [
    { label: "Canais de texto", type: "text" as const, icon: "#" },
    { label: "Canais de voz", type: "voice" as const, icon: "🔊" },
  ];

  const open = (c: Channel) => {
    if (c.type === "voice") voice?.join(c.id, c.serverId);
    navigate(`/channels/${c.serverId}/${c.id}`);
  };

  const connectedChannel = vs.status !== "idle" ? details.channels.find((c) => c.id === vs.channelId) : undefined;

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

      {vs.error && <div className="voice-error">{vs.error}</div>}

      {vs.status !== "idle" && (
        <div className="voice-panel">
          <div className="voice-panel-info">
            <strong className={vs.status === "connected" ? "ok" : "pending"}>
              {vs.status === "connected" ? "Voz conectada" : "Conectando…"}
            </strong>
            <button
              className="link small ellipsis"
              onClick={() => connectedChannel && navigate(`/channels/${connectedChannel.serverId}/${connectedChannel.id}`)}
            >
              {connectedChannel ? `${connectedChannel.name} / ${details.server.name}` : "Outro servidor"}
            </button>
          </div>
          <button
            className={`icon-btn ${vs.localScreen ? "on" : ""}`}
            title={vs.localScreen ? "Parar de transmitir" : "Compartilhar tela"}
            disabled={vs.status !== "connected"}
            onClick={() => (vs.localScreen ? voice?.stopScreenShare() : voice?.startScreenShare())}
          >
            🖥
          </button>
          <button className="icon-btn danger" title="Desconectar" onClick={() => voice?.leave()}>
            ✆
          </button>
        </div>
      )}

      <footer className="user-panel">
        <Avatar name={user.displayName} id={user.id} size={32} online />
        <div className="user-names">
          <strong className="ellipsis">{user.displayName}</strong>
          <span className="muted small ellipsis">@{user.username}</span>
        </div>
        <button
          className={`icon-btn ${vs.muted || vs.deafened ? "off" : ""}`}
          title={vs.muted ? "Ativar microfone" : "Desativar microfone"}
          aria-pressed={vs.muted}
          onClick={() => voice?.setMuted(!vs.muted)}
        >
          {vs.muted || vs.deafened ? "🔇" : "🎙"}
        </button>
        <button
          className={`icon-btn ${vs.deafened ? "off" : ""}`}
          title={vs.deafened ? "Ativar áudio" : "Desativar áudio"}
          aria-pressed={vs.deafened}
          onClick={() => voice?.setDeafened(!vs.deafened)}
        >
          {vs.deafened ? "🔕" : "🎧"}
        </button>
        <button className="icon-btn" title="Sair da conta" onClick={onLogout}>
          ⏻
        </button>
      </footer>
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
