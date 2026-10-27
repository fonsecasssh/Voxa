import type { ServerDetails, User } from "../api.ts";
import { navigate } from "../router.ts";
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
  const groups = [
    { label: "Canais de texto", type: "text" as const, icon: "#" },
    { label: "Canais de voz", type: "voice" as const, icon: "🔊" },
  ];

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
                <button
                  key={c.id}
                  className={`channel ${c.id === activeChannelId ? "active" : ""}`}
                  onClick={() => navigate(`/channels/${c.serverId}/${c.id}`)}
                >
                  <span className="channel-icon">{g.icon}</span>
                  <span className="ellipsis">{c.name}</span>
                </button>
              ))}
          </section>
        ))}
      </div>

      <footer className="user-panel">
        <Avatar name={user.displayName} id={user.id} size={32} online />
        <div className="user-names">
          <strong className="ellipsis">{user.displayName}</strong>
          <span className="muted small ellipsis">@{user.username}</span>
        </div>
        <button className="icon-btn" title="Sair" onClick={onLogout}>
          ⏻
        </button>
      </footer>
    </aside>
  );
}
