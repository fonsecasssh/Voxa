import type { ReactNode } from "react";
import type { DmSummary, Presence } from "../api.ts";
import { navigate } from "../router.ts";
import { Avatar, presenceText } from "./Avatar.tsx";

interface Props {
  dms: DmSummary[] | null;
  presence: Record<string, Presence>;
  unread: Set<string>;
  activeChannelId?: string;
  pendingCount: number;
  footer: ReactNode;
}

export function HomeSidebar({ dms, presence, unread, activeChannelId, pendingCount, footer }: Props) {
  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <span className="ellipsis">Mensagens diretas</span>
      </header>

      <div className="channel-list">
        <button className={`channel friends-link ${activeChannelId ? "" : "active"}`} onClick={() => navigate("/channels/@me")}>
          <span className="channel-icon">👥</span>
          <span className="ellipsis">Amigos</span>
          {pendingCount > 0 && <span className="badge">{pendingCount}</span>}
        </button>

        <div className="group-label">
          <span>Conversas</span>
        </div>
        {dms === null ? (
          <p className="muted small pad-x">Carregando…</p>
        ) : dms.length === 0 ? (
          <p className="muted small pad-x">Nenhuma conversa ainda. Abra uma pela lista de amigos ou de membros.</p>
        ) : (
          dms.map((d) => {
            const p = presence[d.user.id];
            const isUnread = unread.has(d.channel.id);
            return (
              <button
                key={d.channel.id}
                className={`channel dm ${d.channel.id === activeChannelId ? "active" : ""} ${isUnread ? "unread" : ""}`}
                onClick={() => navigate(`/channels/@me/${d.channel.id}`)}
              >
                <Avatar name={d.user.displayName} id={d.user.id} size={32} status={p?.status ?? "offline"} src={d.user.avatar} />
                <span className="dm-names">
                  <span className="ellipsis">{d.user.displayName}</span>
                  {p?.activity && <span className="muted small ellipsis">{presenceText(p)}</span>}
                </span>
                {isUnread && <span className="unread-dot" aria-label="Mensagens não lidas" />}
              </button>
            );
          })
        )}
      </div>

      {footer}
    </aside>
  );
}
