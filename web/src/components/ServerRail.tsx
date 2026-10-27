import type { Server } from "../api.ts";
import { navigate } from "../router.ts";
import { Avatar } from "./Avatar.tsx";

export function ServerRail({ servers, activeId, onCreate }: { servers: Server[]; activeId?: string; onCreate: () => void }) {
  return (
    <nav className="rail" aria-label="Servidores">
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
