// Full-screen server settings, like Discord's: overview (name), roles and members.

import { EmptyState } from "./EmptyState.tsx";
import { ListSkeleton } from "./Skeleton.tsx";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { PERMISSION_INFO, Permission as P } from "../../../shared/permissions.ts";
import { api, type Ban, type Invite, type Presence, type Role, type ServerDetails, type ServerImageKind, type Sound, type User } from "../api.ts";
import { checkSoundFile, playBoardSound } from "../soundboard.ts";
import { Permission, can, memberColor, memberName, memberRoles, myPermissions, myTop, outranks } from "../members.ts";
import { navigate } from "../router.ts";
import { Avatar, ServerIcon } from "./Avatar.tsx";
import { NicknameForm } from "./MemberList.tsx";
import { ImageCropper } from "./ImageCropper.tsx";
import { inviteSummary } from "./ChannelModals.tsx";
import { useCustomEmojis } from "../customEmojis.ts";

type Tab = "overview" | "roles" | "members" | "emojis" | "sounds" | "invites" | "bans";

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
    { id: "emojis", label: "Emojis", show: can(perms, Permission.MANAGE_EMOJIS) },
    { id: "sounds", label: "Sons", show: can(perms, Permission.MANAGE_EMOJIS) },
    { id: "invites", label: "Convites", show: can(perms, Permission.MANAGE_SERVER) },
    { id: "bans", label: "Banimentos", show: can(perms, Permission.BAN_MEMBERS) },
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
          {tab === "emojis" && <Emojis details={details} />}
          {tab === "sounds" && <Sounds details={details} />}
          {tab === "invites" && <Invites details={details} />}
          {tab === "bans" && <Bans details={details} />}
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
  const canBan = !isSelf && can(perms, Permission.BAN_MEMBERS) && outranks(details, selfId, user.id);
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
        {canBan && (
          <button
            className="icon-btn danger"
            title="Banir"
            aria-label={`Banir ${name}`}
            onClick={() => {
              const reason = prompt(`Banir ${name}? Motivo (opcional):`);
              if (reason !== null) run(() => api.banMember(sid, user.id, reason.trim() || null));
            }}
          >
            ⛔
          </button>
        )}
      </div>
    </div>
  );
}

// --- invites ---------------------------------------------------------------------

function Invites({ details }: { details: ServerDetails }) {
  const sid = details.server.id;
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { error, run } = useAction();
  const load = () => api.invites(sid).then((r) => setInvites(r.invites), () => setInvites([]));
  useEffect(() => {
    load();
  }, [sid]);

  return (
    <>
      <h2>Convites</h2>
      <p className="muted">Links que ainda funcionam. Revogue um link para ele parar de funcionar na hora.</p>
      {error && <div className="form-error">{error}</div>}
      {invites === null ? (
        <ListSkeleton count={4} twoLines />
      ) : invites.length === 0 ? (
        <EmptyState icon="userPlus" title="Nenhum convite ativo" compact>
          Crie um em "Convidar pessoas", no menu do servidor.
        </EmptyState>
      ) : (
        <div className="settings-list">
          {invites.map((i) => (
            <div key={i.code} className="settings-list-row">
              <code className="invite-code">{i.code}</code>
              <span className="ellipsis">
                {i.creator ? (
                  <>
                    <Avatar name={i.creator.displayName} id={i.creator.id} size={20} src={i.creator.avatar} /> {i.creator.displayName}
                  </>
                ) : (
                  "—"
                )}
              </span>
              <span className="muted small">
                {i.uses} {i.uses === 1 ? "uso" : "usos"} · {inviteSummary(i)}
              </span>
              <button className="btn subtle danger small" onClick={async () => (await run(() => api.deleteInvite(i.code))) && load()}>
                Revogar
              </button>
            </div>
          ))}
        </div>
      )}
      <h3>Link original do servidor</h3>
      <p className="muted small">
        Servidores criados antes dos convites com validade têm um link permanente. Se ele foi compartilhado demais, desative-o: quem já está no servidor
        continua.
      </p>
      {notice && <div className="form-ok">{notice}</div>}
      <button
        className="btn subtle danger"
        onClick={async () => {
          if (!confirm("Desativar o link original deste servidor? Quem tiver esse link não vai mais conseguir entrar.")) return;
          if (await run(() => api.resetServerInvite(sid))) setNotice("Link original desativado.");
        }}
      >
        Desativar link original
      </button>
    </>
  );
}

// --- bans -------------------------------------------------------------------------

function Bans({ details }: { details: ServerDetails }) {
  const sid = details.server.id;
  const [bans, setBans] = useState<Ban[] | null>(null);
  const { error, run } = useAction();
  const load = () => api.bans(sid).then((r) => setBans(r.bans), () => setBans([]));
  useEffect(() => {
    load();
  }, [sid]);

  return (
    <>
      <h2>Banimentos</h2>
      <p className="muted">Pessoas banidas não conseguem voltar ao servidor com nenhum convite até o banimento ser revogado.</p>
      {error && <div className="form-error">{error}</div>}
      {bans === null ? (
        <ListSkeleton count={4} twoLines />
      ) : bans.length === 0 ? (
        <p className="muted">Ninguém banido.</p>
      ) : (
        <div className="settings-list">
          {bans.map((b) => (
            <div key={b.user.id} className="settings-list-row">
              <Avatar name={b.user.displayName} id={b.user.id} size={32} src={b.user.avatar} />
              <span className="ellipsis">
                <strong>{b.user.displayName}</strong> <span className="muted small">@{b.user.username}</span>
              </span>
              <span className="muted small ellipsis">{b.reason ? `Motivo: ${b.reason}` : "Sem motivo"}</span>
              <button className="btn subtle small" onClick={async () => (await run(() => api.unban(sid, b.user.id))) && load()}>
                Revogar banimento
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// --- emojis ----------------------------------------------------------------------

/** Still images are shrunk to 128 px squares (kept whole, centered); GIFs go as they are. */
async function prepareEmoji(file: File): Promise<Blob> {
  if (file.type === "image/gif") return file;
  const img = await createImageBitmap(file);
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const scale = Math.min(size / img.width, size / img.height, 1);
  const w = img.width * scale;
  const h = img.height * scale;
  canvas.getContext("2d")!.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Imagem inválida."))), "image/png"));
}

function Emojis({ details }: { details: ServerDetails }) {
  const sid = details.server.id;
  const all = useCustomEmojis().emojis.filter((e) => e.serverId === sid);
  const input = useRef<HTMLInputElement>(null);
  const { error, busy, run } = useAction();
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const upload = async (file: File) => {
    const name = file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 32).padEnd(2, "_");
    await run(async () => api.addEmoji(sid, name, await prepareEmoji(file)));
  };

  return (
    <>
      <h2>Emojis</h2>
      <p className="muted">
        Até 50 por servidor. Todos aqui podem usar com <code>:nome:</code> nas mensagens, no seletor de emojis e nas reações (PNG, JPEG, WebP ou GIF animado, até 512 KB).
      </p>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) upload(f);
        }}
      />
      <button className="btn primary" disabled={busy || all.length >= 50} onClick={() => input.current?.click()}>
        Enviar emoji
      </button>
      {error && <div className="form-error">{error}</div>}
      <div className="settings-list">
        {all.length === 0 && (
          <EmptyState icon="smile" title="Nenhum emoji ainda" compact>
            Envie uma imagem para criar o primeiro emoji do servidor.
          </EmptyState>
        )}
        {all.map((e) => (
          <div key={e.id} className="settings-list-row emoji-row">
            <img src={e.url} alt="" className="custom-emoji big" />
            {editing?.id === e.id ? (
              <form
                className="emoji-rename"
                onSubmit={async (ev) => {
                  ev.preventDefault();
                  if (await run(() => api.renameEmoji(e.id, editing.name))) setEditing(null);
                }}
              >
                <input value={editing.name} onChange={(ev) => setEditing({ id: e.id, name: ev.target.value })} maxLength={32} autoFocus aria-label="Nome do emoji" />
                <button className="btn primary small">Salvar</button>
              </form>
            ) : (
              <button className="link ellipsis" title="Renomear" onClick={() => setEditing({ id: e.id, name: e.name })}>
                :{e.name}:
              </button>
            )}
            <span className="muted small">{e.animated ? "Animado" : ""}</span>
            <button
              className="btn subtle danger small"
              onClick={() => confirm(`Apagar :${e.name}:? Onde ele foi usado aparece só o nome.`) && run(() => api.deleteEmoji(e.id))}
            >
              Apagar
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

// --- soundboard sounds ------------------------------------------------------------

const MAX_SOUNDS = 30;

function Sounds({ details }: { details: ServerDetails }) {
  const sid = details.server.id;
  const [sounds, setSounds] = useState<Sound[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const { error, busy, run } = useAction();
  const [draft, setDraft] = useState<{ file: File; url: string; name: string; emoji: string; volume: number } | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string; emoji: string; volume: number } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const reload = () => api.sounds(sid).then((r) => setSounds(r.sounds), () => setSounds([]));
  useEffect(() => {
    reload();
  }, [sid]);
  useEffect(
    () => () => {
      if (draft) URL.revokeObjectURL(draft.url);
    },
    [draft?.url],
  );

  const pick = async (file: File) => {
    setFileError(null);
    try {
      await checkSoundFile(file);
    } catch (err) {
      return setFileError((err as Error).message);
    }
    setDraft({ file, url: URL.createObjectURL(file), name: file.name.replace(/\.[^.]+$/, "").slice(0, 32), emoji: "", volume: 1 });
  };

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const ok = await run(() => api.addSound(sid, { name: draft.name.trim(), emoji: draft.emoji.trim() || null, volume: draft.volume }, draft.file));
    if (ok) {
      setDraft(null);
      reload();
    }
  };

  return (
    <>
      <h2>Sons</h2>
      <p className="muted">
        Até {MAX_SOUNDS} sons para o soundboard: quem estiver num canal de voz do servidor toca para todos ali. MP3, OGG, WAV, WebM ou M4A, até 5 segundos e
        512 KB.
      </p>
      <input
        ref={input}
        type="file"
        accept="audio/*"
        hidden
        aria-label="Escolher áudio"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) pick(f);
        }}
      />
      {!draft && (
        <button className="btn primary" disabled={busy || (sounds?.length ?? 0) >= MAX_SOUNDS} onClick={() => input.current?.click()}>
          Enviar som
        </button>
      )}
      {fileError && <div className="form-error">{fileError}</div>}
      {draft && (
        <form className="sound-form" onSubmit={upload}>
          <div className="sound-form-row">
            <label className="sound-emoji-field">
              Emoji
              <input value={draft.emoji} onChange={(e) => setDraft({ ...draft, emoji: e.target.value })} placeholder="🔊" maxLength={16} />
            </label>
            <label>
              Nome
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={32} required autoFocus aria-label="Nome do som" />
            </label>
          </div>
          <label className="volume-row">
            Volume
            <input type="range" min={0.05} max={1} step={0.05} value={draft.volume} onChange={(e) => setDraft({ ...draft, volume: Number(e.target.value) })} aria-label="Volume do som" />
            <span className="muted small">{Math.round(draft.volume * 100)}%</span>
          </label>
          <div className="modal-actions">
            <button type="button" className="btn subtle" onClick={() => playBoardSound({ id: "draft", name: draft.name, emoji: null, volume: draft.volume, url: draft.url }, 1)}>
              ▶ Ouvir
            </button>
            <button type="button" className="btn subtle" onClick={() => setDraft(null)}>
              Cancelar
            </button>
            <button className="btn primary" disabled={busy || !draft.name.trim()}>
              Adicionar
            </button>
          </div>
        </form>
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="settings-list">
        {sounds?.length === 0 && (
          <EmptyState icon="soundboard" title="Nenhum som ainda" compact>
            Os sons padrão do Voxa estão sempre disponíveis; os do servidor aparecem aqui.
          </EmptyState>
        )}
        {sounds?.map((s) =>
          editing?.id === s.id ? (
            <form
              key={s.id}
              className="settings-list-row sound-row editing"
              onSubmit={async (ev) => {
                ev.preventDefault();
                if (await run(() => api.updateSound(s.id, { name: editing.name.trim(), emoji: editing.emoji.trim() || null, volume: editing.volume }))) {
                  setEditing(null);
                  reload();
                }
              }}
            >
              <input className="sound-emoji-input" value={editing.emoji} onChange={(e) => setEditing({ ...editing, emoji: e.target.value })} placeholder="🔊" maxLength={16} aria-label="Emoji do som" />
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={32} autoFocus aria-label="Nome do som" />
              <input type="range" min={0.05} max={1} step={0.05} value={editing.volume} onChange={(e) => setEditing({ ...editing, volume: Number(e.target.value) })} aria-label="Volume do som" />
              <button className="btn primary small">Salvar</button>
              <button type="button" className="btn subtle small" onClick={() => setEditing(null)}>
                Cancelar
              </button>
            </form>
          ) : (
            <div key={s.id} className="settings-list-row sound-row">
              <span className="sound-emoji">{s.emoji ?? "🔊"}</span>
              <strong className="ellipsis">{s.name}</strong>
              <span className="muted small">{Math.round(s.volume * 100)}%</span>
              <button className="btn subtle small" title="Ouvir" aria-label={`Ouvir ${s.name}`} onClick={() => playBoardSound(s, 1)}>
                ▶
              </button>
              <button className="btn subtle small" onClick={() => setEditing({ id: s.id, name: s.name, emoji: s.emoji ?? "", volume: s.volume })}>
                Editar
              </button>
              <button
                className="btn subtle danger small"
                onClick={async () => {
                  if (confirm(`Apagar o som "${s.name}"?`) && (await run(() => api.deleteSound(s.id)))) reload();
                }}
              >
                Apagar
              </button>
            </div>
          ),
        )}
      </div>
    </>
  );
}
