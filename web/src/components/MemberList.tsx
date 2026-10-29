import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { api, type Presence, type Role, type ServerDetails, type User } from "../api.ts";
import { Permission, can, memberColor, memberName, memberRoles, myPermissions, myTop, outranks } from "../members.ts";
import { Avatar, presenceText } from "./Avatar.tsx";
import { useBlocked } from "../blocking.ts";

interface Props {
  details: ServerDetails;
  presence: Record<string, Presence>;
  selfId: string;
  onOpenDm: (user: User) => void;
}

export function MemberList({ details, presence, selfId, onOpenDm }: Props) {
  const [card, setCard] = useState<{ user: User; top: number } | null>(null);
  const isOnline = (m: User) => (presence[m.id]?.status ?? "offline") !== "offline";
  const byName = (a: User, b: User) => memberName(details, a).localeCompare(memberName(details, b), "pt-BR");

  // Like Discord: online members are grouped under their highest "hoisted" role,
  // the rest under "Online"; everyone offline goes together at the end.
  const hoisted = details.roles.filter((r) => r.hoist && !r.isDefault);
  const sectionOf = (m: User) => memberRoles(details, m.id).find((r) => r.hoist)?.id ?? "online";
  const online = details.members.filter(isOnline);
  const sections = [
    ...hoisted.map((r) => ({ key: r.id, label: r.name, users: online.filter((m) => sectionOf(m) === r.id) })),
    { key: "online", label: "Online", users: online.filter((m) => sectionOf(m) === "online") },
    { key: "offline", label: "Offline", users: details.members.filter((m) => !isOnline(m)) },
  ].filter((s) => s.users.length > 0);

  // The member may have left while their card was open.
  const cardUser = card && details.members.find((m) => m.id === card.user.id);

  return (
    <aside className="members" aria-label="Membros">
      {sections.map((s) => (
        <section key={s.key}>
          <div className="group-label">
            {s.label} — {s.users.length}
          </div>
          {[...s.users].sort(byName).map((m) => {
            const p = presence[m.id];
            const name = memberName(details, m);
            return (
              <button
                key={m.id}
                className={`member ${isOnline(m) ? "" : "offline"} ${card?.user.id === m.id ? "selected" : ""}`}
                onClick={(e) => setCard(card?.user.id === m.id ? null : { user: m, top: e.currentTarget.getBoundingClientRect().top })}
              >
                <Avatar name={name} id={m.id} size={32} status={p?.status ?? "offline"} src={m.avatar} />
                <span className="member-names">
                  <span className="member-name">
                    <span className="ellipsis" style={{ color: memberColor(details, m.id) }}>
                      {name}
                    </span>
                    {m.id === details.server.ownerId && (
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
      ))}

      {card && cardUser && (
        <MemberCard
          details={details}
          user={cardUser}
          presence={presence[cardUser.id]}
          selfId={selfId}
          anchorTop={card.top}
          onOpenDm={(u) => {
            setCard(null);
            onOpenDm(u);
          }}
          onClose={() => setCard(null)}
        />
      )}
    </aside>
  );
}

/** Profile card shown next to the member list, with the actions the viewer is allowed to take. */
export function MemberCard({
  details,
  user,
  presence,
  selfId,
  anchorTop,
  onOpenDm,
  onClose,
}: {
  details: ServerDetails;
  user: User;
  presence: Presence | undefined;
  selfId: string;
  anchorTop: number;
  onOpenDm: (u: User) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(anchorTop);
  const [picking, setPicking] = useState(false);
  const [editingNick, setEditingNick] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSelf = user.id === selfId;
  const perms = myPermissions(details, selfId);
  const mine = myTop(details, selfId);
  const roles = memberRoles(details, user.id);
  const canManageRole = (r: Role) => can(perms, Permission.MANAGE_ROLES) && r.position < mine;
  const assignable = details.roles.filter((r) => !r.isDefault && canManageRole(r) && !roles.includes(r));
  const canNick = isSelf
    ? can(perms, Permission.CHANGE_NICKNAME) || can(perms, Permission.MANAGE_NICKNAMES)
    : can(perms, Permission.MANAGE_NICKNAMES) && outranks(details, selfId, user.id);
  const canKick = !isSelf && can(perms, Permission.KICK_MEMBERS) && outranks(details, selfId, user.id);
  const canBan = !isSelf && can(perms, Permission.BAN_MEMBERS) && outranks(details, selfId, user.id);
  const isBlocked = useBlocked().has(user.id);

  // Keep the card inside the window.
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    setTop(Math.max(8, Math.min(anchorTop, window.innerHeight - h - 8)));
  }, [anchorTop, roles.length, picking, editingNick]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!ref.current?.contains(t) && !t.closest(".member")) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  const name = memberName(details, user);
  const sid = details.server.id;

  return (
    <div className="member-card" ref={ref} style={{ top }} role="dialog" aria-label={`Perfil de ${name}`}>
      <div
        className={`member-card-banner ${user.banner ? "has-image" : ""}`}
        style={user.banner ? { backgroundImage: `url(${user.banner})` } : { background: memberColor(details, user.id) ?? "var(--accent)" }}
      />
      <div className="member-card-body">
        <div className="member-card-avatar">
          <Avatar name={name} id={user.id} size={72} status={presence?.status ?? "offline"} src={user.avatar} />
        </div>
        <h3 style={{ color: memberColor(details, user.id) }}>{name}</h3>
        <p className="muted small">
          {name !== user.displayName && <>{user.displayName} · </>}@{user.username}
        </p>
        {presence?.activity && <p className="small activity-line">{presenceText(presence)}</p>}

        {editingNick && (
          <NicknameForm
            initial={details.memberData[user.id]?.nickname ?? ""}
            onSave={async (nick) => {
              if (await act(() => api.setNickname(sid, user.id, nick || null))) setEditingNick(false);
            }}
            onCancel={() => setEditingNick(false)}
          />
        )}

        <div className="card-section-label">Cargos</div>
        <div className="role-chips">
          {roles.length === 0 && <span className="muted small">Nenhum cargo</span>}
          {roles.map((r) => (
            <span key={r.id} className="role-chip">
              <span className="role-dot" style={{ background: r.color ?? "var(--offline)" }} />
              {r.name}
              {canManageRole(r) && (
                <button className="role-chip-x" title={`Remover ${r.name}`} onClick={() => act(() => api.removeMemberRole(sid, user.id, r.id))}>
                  ✕
                </button>
              )}
            </span>
          ))}
          {assignable.length > 0 && (
            <button className="role-chip add" title="Adicionar cargo" onClick={() => setPicking((p) => !p)}>
              +
            </button>
          )}
        </div>
        {picking && (
          <div className="role-picker">
            {assignable.map((r) => (
              <button
                key={r.id}
                className="menu-item"
                onClick={async () => {
                  if (await act(() => api.addMemberRole(sid, user.id, r.id))) setPicking(false);
                }}
              >
                <span className="role-dot" style={{ background: r.color ?? "var(--offline)" }} />
                {r.name}
              </button>
            ))}
          </div>
        )}

        {error && <div className="form-error">{error}</div>}

        <div className="member-card-actions">
          {!isSelf && (
            <button className="btn primary" onClick={() => onOpenDm(user)}>
              Enviar mensagem
            </button>
          )}
          {canNick && !editingNick && (
            <button className="btn subtle" onClick={() => setEditingNick(true)}>
              {isSelf ? "Mudar meu apelido" : "Mudar apelido"}
            </button>
          )}
          {canKick && (
            <button
              className="btn subtle danger"
              onClick={async () => {
                if (!confirm(`Expulsar ${name} do servidor?`)) return;
                if (await act(() => api.kickMember(sid, user.id))) onClose();
              }}
            >
              Expulsar
            </button>
          )}
          {canBan && (
            <button
              className="btn subtle danger"
              onClick={async () => {
                const reason = prompt(`Banir ${name}? Ele sai do servidor e não consegue voltar com convites.\n\nMotivo (opcional):`);
                if (reason === null) return;
                if (await act(() => api.banMember(sid, user.id, reason.trim() || null))) onClose();
              }}
            >
              Banir
            </button>
          )}
          {!isSelf && (
            <button
              className="btn subtle"
              onClick={async () => {
                if (isBlocked) await act(() => api.unblock(user.id));
                else if (confirm(`Bloquear ${name}? Vocês deixam de ser amigos, não podem trocar DMs e as mensagens dele ficam escondidas.`)) {
                  await act(() => api.block(user.id));
                }
              }}
            >
              {isBlocked ? "Desbloquear" : "Bloquear"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function NicknameForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (nickname: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave(value.trim());
  };
  return (
    <form className="nick-form" onSubmit={submit}>
      <input value={value} onChange={(e) => setValue(e.target.value)} maxLength={32} placeholder="Apelido (vazio = sem apelido)" autoFocus aria-label="Apelido" />
      <div className="modal-actions">
        <button type="button" className="btn subtle" onClick={onCancel}>
          Cancelar
        </button>
        <button className="btn primary">Salvar</button>
      </div>
    </form>
  );
}
