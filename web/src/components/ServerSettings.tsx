// Full-screen server settings, like Discord's: overview (name), roles and members.

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { PERMISSION_INFO, Permission as P } from "../../../shared/permissions.ts";
import { api, type Presence, type Role, type ServerDetails, type ServerImageKind, type User } from "../api.ts";
import { Permission, can, memberColor, memberName, memberRoles, myPermissions, myTop, outranks } from "../members.ts";
import { navigate } from "../router.ts";
import { Avatar, ServerIcon } from "./Avatar.tsx";
import { NicknameForm } from "./MemberList.tsx";
import { ImageCropper } from "./ImageCropper.tsx";

type Tab = "overview" | "roles" | "members";

const SWATCHES = ["#1abc9c", "#2ecc71", "#3498db", "#9b59b6", "#e91e63", "#f1c40f", "#e67e22", "#e74c3c", "#95a5a6", "#607d8b"];

interface Props {
  details: ServerDetails;
  selfId: string;
  presence: Record<string, Presence>;
  onClose: () => void;
}

export function ServerSettings({ details, selfId, presence, onClose }: Props) {
  const perms = myPermissions(details, selfId);
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "overview", label: "Visão geral", show: can(perms, Permission.MANAGE_SERVER) || details.server.ownerId === selfId },
    { id: "roles", label: "Cargos", show: can(perms, Permission.MANAGE_ROLES) },
    { id: "members", label: "Membros", show: true },
  ];
  const visible = tabs.filter((t) => t.show);
  const [tab, setTab] = useState<Tab>(visible[0].id);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !(e.target as Element).closest?.("input, textarea") && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  return (
    <div className="settings-overlay" role="dialog" aria-label="Configurações do servidor">
      <nav className="settings-nav">
        <div className="settings-nav-inner">
          <div className="group-label">{details.server.name}</div>
          {visible.map((t) => (
            <button key={t.id} className={`settings-tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </nav>
      <div className="settings-content">
        <div className="settings-content-inner">
          {tab === "overview" && <Overview details={details} selfId={selfId} perms={perms} onClose={onClose} />}
          {tab === "roles" && <Roles details={details} selfId={selfId} perms={perms} />}
          {tab === "members" && <Members details={details} selfId={selfId} perms={perms} presence={presence} />}
        </div>
        <button className="settings-close" title="Fechar (Esc)" onClick={onClose}>
          ✕<span>ESC</span>
        </button>
      </div>
    </div>
  );
}

function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

// --- overview ------------------------------------------------------------------

function Overview({ details, selfId, perms, onClose }: { details: ServerDetails; selfId: string; perms: number; onClose: () => void }) {
  const [name, setName] = useState(details.server.name);
  const [saved, setSaved] = useState(false);
  const { error, busy, run } = useAction();
  const isOwner = details.server.ownerId === selfId;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.renameServer(details.server.id, name))) setSaved(true);
  };

  return (
    <>
      <h2>Visão geral do servidor</h2>
      {can(perms, Permission.MANAGE_SERVER) && (
        <form className="settings-form" onSubmit={save}>
          <label>
            Nome do servidor
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
              }}
              maxLength={100}
              required
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          {saved && <div className="form-ok">Nome salvo.</div>}
          <div className="modal-actions">
            <button className="btn primary" disabled={busy || !name.trim() || name.trim() === details.server.name}>
              Salvar alterações
            </button>
          </div>
        </form>
      )}

      {can(perms, Permission.MANAGE_SERVER) && (
        <>
          <ServerImageSection details={details} kind="icon" />
          <ServerImageSection details={details} kind="banner" />
        </>
      )}

      {isOwner && (
        <section className="danger-zone">
          <h3>Excluir servidor</h3>
          <p className="muted">Apaga o servidor, todos os canais e mensagens. Não dá para desfazer.</p>
          <button
            className="btn danger-solid"
            onClick={async () => {
              const typed = prompt(`Para confirmar, digite o nome do servidor: ${details.server.name}`);
              if (typed?.trim() !== details.server.name) return;
              if (await run(() => api.deleteServer(details.server.id))) {
                onClose();
                navigate("/channels/@me", true);
              }
            }}
          >
            Excluir servidor
          </button>
        </section>
      )}
    </>
  );
}

const IMAGE_TEXT = {
  banner: {
    title: "Banner do servidor",
    hint: "Aparece no topo da lista de canais e no convite. Tamanho ideal: 960×540 (16:9).",
    empty: "Sem banner",
    remove: "Remover banner",
    pick: "Escolher imagem do banner",
  },
  icon: {
    title: "Ícone do servidor",
    hint: "Aparece na barra de servidores e no convite. Tamanho ideal: 256×256 (quadrado).",
    empty: "",
    remove: "Remover ícone",
    pick: "Escolher imagem do ícone",
  },
} as const;

function ServerImageSection({ details, kind }: { details: ServerDetails; kind: ServerImageKind }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const { error, busy, run } = useAction();
  const current = details.server[kind];
  const text = IMAGE_TEXT[kind];

  return (
    <section className={`image-section ${kind}`}>
      <h3>{text.title}</h3>
      <p className="muted small">{text.hint}</p>
      {kind === "banner" ? (
        <div className="banner-preview" style={current ? { backgroundImage: `url(${current})` } : undefined}>
          {!current && <span className="muted">{text.empty}</span>}
        </div>
      ) : (
        <div className="icon-preview">
          <ServerIcon server={details.server} size={96} />
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        aria-label={text.pick}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ""; // allow picking the same file again
          if (f) setFile(f);
        }}
      />
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions start">
        <button className="btn primary" onClick={() => input.current?.click()} disabled={busy}>
          {current ? "Trocar imagem" : "Enviar imagem"}
        </button>
        {current && (
          <button className="btn subtle danger" onClick={() => run(() => api.removeServerImage(details.server.id, kind))} disabled={busy}>
            {text.remove}
          </button>
        )}
      </div>
      {file && (
        <ImageCropper
          file={file}
          kind={kind}
          onCancel={() => setFile(null)}
          onCropped={async (image) => {
            await api.uploadServerImage(details.server.id, kind, image);
            setFile(null);
          }}
        />
      )}
    </section>
  );
}

// --- roles ------------------------------------------------------------------------

function Roles({ details, selfId, perms }: { details: ServerDetails; selfId: string; perms: number }) {
  const [selectedId, setSelectedId] = useState<string | null>(details.roles[0]?.id ?? null);
  const { error, run } = useAction();
  const top = myTop(details, selfId);
  const selected = details.roles.find((r) => r.id === selectedId) ?? details.roles[0];
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of Object.values(details.memberData)) for (const id of m.roleIds) c[id] = (c[id] ?? 0) + 1;
    return c;
  }, [details.memberData]);

  const create = () =>
    run(async () => {
      const { role } = await api.createRole(details.server.id, { name: "novo cargo" });
      setSelectedId(role.id);
    });

  return (
    <>
      <h2>Cargos</h2>
      <p className="muted">
        Cargos organizam os membros e definem o que cada um pode fazer. Quem tem um cargo só gerencia os cargos <strong>abaixo</strong> do
        seu cargo mais alto.
      </p>
      {error && <div className="form-error">{error}</div>}
      <div className="roles-layout">
        <div className="roles-list">
          <button className="btn primary small-btn" onClick={create}>
            Criar cargo
          </button>
          {details.roles.map((r) => (
            <button key={r.id} className={`role-row ${r.id === selected?.id ? "active" : ""}`} onClick={() => setSelectedId(r.id)}>
              <span className="role-dot" style={{ background: r.color ?? "var(--offline)" }} />
              <span className="ellipsis">{r.name}</span>
              {!r.isDefault && <span className="muted small">{counts[r.id] ?? 0}</span>}
              {r.position >= top && <span title="Acima do seu cargo: você não pode editar">🔒</span>}
            </button>
          ))}
        </div>
        {selected && (
          <RoleEditor
            key={selected.id + JSON.stringify(selected)}
            details={details}
            role={selected}
            perms={perms}
            editable={selected.position < top}
            onDeleted={() => setSelectedId(null)}
          />
        )}
      </div>
    </>
  );
}

function RoleEditor({
  details,
  role,
  perms,
  editable,
  onDeleted,
}: {
  details: ServerDetails;
  role: Role;
  perms: number;
  editable: boolean;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color);
  const [hoist, setHoist] = useState(role.hoist);
  const [bits, setBits] = useState(role.permissions);
  const { error, busy, run } = useAction();
  const sid = details.server.id;
  const dirty = name !== role.name || color !== role.color || hoist !== role.hoist || bits !== role.permissions;
  const others = details.roles.filter((r) => !r.isDefault);
  const index = others.findIndex((r) => r.id === role.id);

  const save = () =>
    run(() =>
      api.updateRole(
        sid,
        role.id,
        role.isDefault ? { permissions: bits } : { name: name.trim(), color, hoist, permissions: bits },
      ),
    );

  return (
    <div className="role-editor">
      <div className="role-editor-head">
        <h3>
          Editar cargo — <span style={{ color: color ?? undefined }}>{role.name}</span>
        </h3>
        {!role.isDefault && editable && (
          <span className="role-move">
            <button className="icon-btn" title="Subir" disabled={index <= 0} onClick={() => run(() => api.moveRole(sid, role.id, "up"))}>
              ▲
            </button>
            <button
              className="icon-btn"
              title="Descer"
              disabled={index === others.length - 1}
              onClick={() => run(() => api.moveRole(sid, role.id, "down"))}
            >
              ▼
            </button>
          </span>
        )}
      </div>
      {!editable && <p className="muted small">Este cargo está acima (ou no nível) do seu cargo mais alto, então você não pode editá-lo.</p>}

      <fieldset disabled={!editable} className="role-fields">
        {!role.isDefault && (
          <>
            <label>
              Nome do cargo
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
            </label>
            <div className="field-label">Cor</div>
            <div className="swatches">
              <button className={`swatch none ${color === null ? "selected" : ""}`} title="Sem cor" onClick={() => setColor(null)} />
              {SWATCHES.map((c) => (
                <button key={c} className={`swatch ${color === c ? "selected" : ""}`} style={{ background: c }} title={c} onClick={() => setColor(c)} />
              ))}
              <input
                type="color"
                className="swatch custom"
                value={color ?? "#99aab5"}
                onChange={(e) => setColor(e.target.value)}
                title="Outra cor"
                aria-label="Outra cor"
              />
            </div>
            <label className="toggle-row">
              <span>
                Mostrar separado na lista de membros
                <span className="muted small block">Membros online com este cargo aparecem numa seção própria.</span>
              </span>
              <input type="checkbox" checked={hoist} onChange={(e) => setHoist(e.target.checked)} />
            </label>
          </>
        )}

        <div className="field-label">Permissões{role.isDefault && " (valem para todos os membros)"}</div>
        {PERMISSION_INFO.map((p) => {
          const flag = P[p.key];
          const has = (bits & flag) !== 0;
          // You can't grant a permission you don't have (you can always remove one).
          const locked = !has && !can(perms, flag);
          return (
            <label key={p.key} className={`toggle-row ${locked ? "locked" : ""}`}>
              <span>
                {p.label}
                <span className="muted small block">{locked ? "Você não tem essa permissão, então não pode concedê-la." : p.description}</span>
              </span>
              <input type="checkbox" checked={has} disabled={locked} onChange={(e) => setBits(e.target.checked ? bits | flag : bits & ~flag)} />
            </label>
          );
        })}
      </fieldset>

      {error && <div className="form-error">{error}</div>}
      {editable && (
        <div className="modal-actions spread sticky-actions">
          {!role.isDefault ? (
            <button
              className="btn subtle danger"
              onClick={async () => {
                if (!confirm(`Excluir o cargo "${role.name}"? Ele será removido de todos os membros.`)) return;
                if (await run(() => api.deleteRole(sid, role.id))) onDeleted();
              }}
            >
              Excluir cargo
            </button>
          ) : (
            <span />
          )}
          <span>
            {dirty && (
              <button
                className="btn subtle"
                onClick={() => {
                  setName(role.name);
                  setColor(role.color);
                  setHoist(role.hoist);
                  setBits(role.permissions);
                }}
              >
                Desfazer
              </button>
            )}
            <button className="btn primary" disabled={!dirty || busy || !name.trim()} onClick={save}>
              Salvar alterações
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

// --- members ------------------------------------------------------------------------

function Members({
  details,
  selfId,
  perms,
  presence,
}: {
  details: ServerDetails;
  selfId: string;
  perms: number;
  presence: Record<string, Presence>;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const list = details.members
    .filter((m) => !q || [memberName(details, m), m.displayName, m.username].some((s) => s.toLowerCase().includes(q)))
    .sort((a, b) => memberName(details, a).localeCompare(memberName(details, b), "pt-BR"));

  return (
    <>
      <h2>Membros — {details.members.length}</h2>
      <input className="search" placeholder="Buscar membros" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Buscar membros" />
      <div className="members-table">
        {list.map((m) => (
          <MemberRow key={m.id} details={details} user={m} selfId={selfId} perms={perms} presence={presence[m.id]} />
        ))}
      </div>
    </>
  );
}

function MemberRow({
  details,
  user,
  selfId,
  perms,
  presence,
}: {
  details: ServerDetails;
  user: User;
  selfId: string;
  perms: number;
  presence: Presence | undefined;
}) {
  const [picking, setPicking] = useState(false);
  const [editingNick, setEditingNick] = useState(false);
  const { error, run } = useAction();
  const sid = details.server.id;
  const top = myTop(details, selfId);
  const roles = memberRoles(details, user.id);
  const canManageRole = (r: Role) => can(perms, Permission.MANAGE_ROLES) && r.position < top;
  const assignable = details.roles.filter((r) => !r.isDefault && canManageRole(r) && !roles.includes(r));
  const isSelf = user.id === selfId;
  const canNick = isSelf
    ? can(perms, Permission.CHANGE_NICKNAME) || can(perms, Permission.MANAGE_NICKNAMES)
    : can(perms, Permission.MANAGE_NICKNAMES) && outranks(details, selfId, user.id);
  const canKick = !isSelf && can(perms, Permission.KICK_MEMBERS) && outranks(details, selfId, user.id);
  const name = memberName(details, user);

  return (
    <div className="member-row">
      <Avatar name={name} id={user.id} size={36} status={presence?.status ?? "offline"} src={user.avatar} />
      <div className="member-row-main">
        <div>
          <strong style={{ color: memberColor(details, user.id) }}>{name}</strong>
          {user.id === details.server.ownerId && <span title="Dono do servidor"> 👑</span>}
          <span className="muted small"> @{user.username}</span>
        </div>
        <div className="role-chips">
          {roles.map((r) => (
            <span key={r.id} className="role-chip">
              <span className="role-dot" style={{ background: r.color ?? "var(--offline)" }} />
              {r.name}
              {canManageRole(r) && (
                <button className="role-chip-x" title={`Remover ${r.name}`} onClick={() => run(() => api.removeMemberRole(sid, user.id, r.id))}>
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
          <div className="role-picker inline">
            {assignable.map((r) => (
              <button
                key={r.id}
                className="menu-item"
                onClick={async () => {
                  if (await run(() => api.addMemberRole(sid, user.id, r.id))) setPicking(false);
                }}
              >
                <span className="role-dot" style={{ background: r.color ?? "var(--offline)" }} />
                {r.name}
              </button>
            ))}
          </div>
        )}
        {editingNick && (
          <NicknameForm
            initial={details.memberData[user.id]?.nickname ?? ""}
            onSave={async (nick) => {
              if (await run(() => api.setNickname(sid, user.id, nick || null))) setEditingNick(false);
            }}
            onCancel={() => setEditingNick(false)}
          />
        )}
        {error && <div className="form-error">{error}</div>}
      </div>
      <div className="member-row-actions">
        {canNick && !editingNick && (
          <button className="icon-btn" title="Mudar apelido" onClick={() => setEditingNick(true)}>
            ✎
          </button>
        )}
        {canKick && (
          <button
            className="icon-btn danger"
            title="Expulsar"
            onClick={() => confirm(`Expulsar ${name} do servidor?`) && run(() => api.kickMember(sid, user.id))}
          >
            ⨯
          </button>
        )}
      </div>
    </div>
  );
}
