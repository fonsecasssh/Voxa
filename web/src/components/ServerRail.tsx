import type { Server } from "../api.ts";
import { navigate } from "../router.ts";
import { Avatar } from "./Avatar.tsx";

interface Props {
  servers: Server[];
  activeId?: string;
  unreadDms: number;
  onCreate: () => void;
}

export function ServerRail({ servers, activeId, unreadDms, onCreate }: Props) {
  return (
    <nav className="rail" aria-label="Servidores">
      <button
        className={`rail-item home ${activeId === "@me" ? "active" : ""}`}
        title="Mensagens diretas"
        onClick={() => navigate("/channels/@me")}
      >
        <span className="home-logo">V</span>
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
          <Avatar name={s.name} id={s.id} size={48} />
        </button>
      ))}
      <button className="rail-item add" title="Criar servidor" onClick={onCreate}>
        +
      </button>
    </nav>
  );
}
