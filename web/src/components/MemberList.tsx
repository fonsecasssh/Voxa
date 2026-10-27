import type { Presence, User } from "../api.ts";
import { Avatar } from "./Avatar.tsx";

interface Props {
  members: User[];
  presence: Record<string, Presence>;
  ownerId: string;
  selfId: string;
  onOpenDm: (user: User) => void;
}

export function MemberList({ members, presence, ownerId, selfId, onOpenDm }: Props) {
  const isOnline = (m: User) => (presence[m.id]?.status ?? "offline") !== "offline";
  const sections = [
    { label: "Online", users: members.filter(isOnline) },
    { label: "Offline", users: members.filter((m) => !isOnline(m)) },
  ];

  return (
    <aside className="members" aria-label="Membros">
      {sections.map(
        (s) =>
          s.users.length > 0 && (
            <section key={s.label}>
              <div className="group-label">
                {s.label} — {s.users.length}
              </div>
              {s.users.map((m) => {
                const p = presence[m.id];
                return (
                  <button
                    key={m.id}
                    className={`member ${isOnline(m) ? "" : "offline"}`}
                    title={m.id === selfId ? undefined : `Enviar mensagem para ${m.displayName}`}
                    onClick={() => m.id !== selfId && onOpenDm(m)}
                  >
                    <Avatar name={m.displayName} id={m.id} size={32} status={p?.status ?? "offline"} />
                    <span className="member-names">
                      <span className="member-name">
                        <span className="ellipsis">{m.displayName}</span>
                        {m.id === ownerId && (
                          <span className="crown" title="Dono do servidor">
                            👑
                          </span>
                        )}
                      </span>
                      {p?.activity && <span className="muted small ellipsis">Jogando {p.activity.name}</span>}
                    </span>
                  </button>
                );
              })}
            </section>
          ),
      )}
    </aside>
  );
}
