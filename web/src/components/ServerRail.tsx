import type { Server } from "../api.ts";
import { navigate } from "../router.ts";
import { ServerIcon } from "./Avatar.tsx";
import { Logo } from "./Logo.tsx";

interface Props {
  servers: Server[];
  activeId?: string;
  unreadDms: number;
  /** Mentions of you not seen yet, per server. */
  mentionsByServer: Record<string, number>;
  onCreate: () => void;
}

export function ServerRail({ servers, activeId, unreadDms, mentionsByServer, onCreate }: Props) {
  return (
    <nav className="rail" aria-label="Servidores">
      <button
        className={`rail-item home ${activeId === "@me" ? "active" : ""}`}
        title="Mensagens diretas"
        onClick={() => navigate("/channels/@me")}
      >
        <Logo size={30} />
        {unreadDms > 0 && <span className="rail-badge">{unreadDms}</span>}
      </button>
      <div className="rail-divider" />
      {servers.map((s) => (
        <button
          key={s.id}
          className={`rail-item ${s.id === activeId ? "active" : ""}`}
          title={s.name}
          onClick={() => navigate(`/channels/${s.id}`)}
        >
          <ServerIcon server={s} size={48} />
          {!!mentionsByServer[s.id] && <span className="rail-badge">{mentionsByServer[s.id]}</span>}
        </button>
      ))}
      <button className="rail-item add" title="Criar servidor" onClick={onCreate}>
        +
      </button>
    </nav>
  );
}
