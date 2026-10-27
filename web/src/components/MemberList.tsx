import type { User } from "../api.ts";
import { Avatar } from "./Avatar.tsx";

export function MemberList({ members, online, ownerId }: { members: User[]; online: string[]; ownerId: string }) {
  const onlineSet = new Set(online);
  const sections = [
    { label: "Online", users: members.filter((m) => onlineSet.has(m.id)) },
    { label: "Offline", users: members.filter((m) => !onlineSet.has(m.id)) },
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
              {s.users.map((m) => (
                <div key={m.id} className={`member ${onlineSet.has(m.id) ? "" : "offline"}`}>
                  <Avatar name={m.displayName} id={m.id} size={32} online={onlineSet.has(m.id)} />
                  <span className="ellipsis">{m.displayName}</span>
                  {m.id === ownerId && (
                    <span className="crown" title="Dono do servidor">
                      👑
                    </span>
                  )}
                </div>
              ))}
            </section>
          ),
      )}
    </aside>
  );
}
