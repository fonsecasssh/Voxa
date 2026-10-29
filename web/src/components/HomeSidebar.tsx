import type { ReactNode } from "react";
import { dmTitle, type DmSummary, type Presence } from "../api.ts";
import { navigate } from "../router.ts";
import type { VoiceMember } from "../voice/types.ts";
import { PresenceLine } from "./CustomStatus.tsx";
import { DmAvatar } from "./DmParts.tsx";
import { Icon } from "./Icon.tsx";
import { isMuted, type NotifySettings } from "../notifications.ts";
import type { NotifyTarget } from "./NotifyModal.tsx";

interface Props {
  dms: DmSummary[] | null;
  presence: Record<string, Presence>;
  unread: Set<string>;
  activeChannelId?: string;
  pendingCount: number;
  /** Calls going on in DMs, to mark those conversations. */
  calls: Record<string, VoiceMember[]>;
  onCreateGroup: () => void;
  notify: NotifySettings;
  onNotify: (target: NotifyTarget) => void;
  footer: ReactNode;
}

export function HomeSidebar({ dms, presence, unread, activeChannelId, pendingCount, calls, onCreateGroup, notify, onNotify, footer }: Props) {
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
          <button className="icon-btn subtle" title="Criar DM em grupo" aria-label="Criar DM em grupo" onClick={onCreateGroup}>
            <Icon name="plus" size={16} />
          </button>
        </div>
        {dms === null ? (
          <p className="muted small pad-x">Carregando…</p>
        ) : dms.length === 0 ? (
          <p className="muted small pad-x">Nenhuma conversa ainda. Abra uma pela lista de amigos ou de membros.</p>
        ) : (
          dms.map((d) => {
            const p = d.user ? presence[d.user.id] : undefined;
            const inCall = (calls[d.channel.id]?.length ?? 0) > 0;
            const isUnread = unread.has(d.channel.id);
            return (
              <button
                key={d.channel.id}
                className={`channel dm ${d.channel.id === activeChannelId ? "active" : ""} ${isUnread ? "unread" : ""} ${isMuted(notify, d.channel.id) ? "muted-channel" : ""}`}
                onClick={() => navigate(`/channels/@me/${d.channel.id}`)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onNotify({ id: d.channel.id, kind: "dm", label: d.group ? dmTitle(d) : `@${dmTitle(d)}` });
                }}
              >
                <DmAvatar dm={d} size={32} presence={presence} />
                <span className="dm-names">
                  <span className="ellipsis">{dmTitle(d)}</span>
                  {d.group ? (
                    <span className="muted small ellipsis">{d.members.length + 1} membros</span>
                  ) : (
                    <PresenceLine presence={p} />
                  )}
                </span>
                {inCall && (
                  <span className="dm-in-call" title="Chamada em andamento">
                    <Icon name="phone" size={14} />
                  </span>
                )}
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
