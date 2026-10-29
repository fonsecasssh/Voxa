// Dialogs for organizing a server: creating and editing channels (including who sees a
// private one), categories, and invite links that expire or run out of uses.

import { useEffect, useState } from "react";
import { api, type Category, type Channel, type ChannelType, type Invite, type ServerDetails } from "../api.ts";
import { Icon } from "./Icon.tsx";
import { Modal, useSubmit } from "./Modals.tsx";

/** "Canal privado" and the roles it's open to (the owner and administrators always see it). */
function PrivacyFields({
  details,
  isPrivate,
  roleIds,
  onChange,
}: {
  details: ServerDetails;
  isPrivate: boolean;
  roleIds: string[];
  onChange: (isPrivate: boolean, roleIds: string[]) => void;
}) {
  const roles = details.roles.filter((r) => !r.isDefault);
  return (
    <div className="privacy-fields">
      <label className="toggle-row compact">
        <span>
          <span className="inline-icon">
            <Icon name="lock" size={14} /> Canal privado
          </span>
          <span className="muted small block">Só os cargos escolhidos (e administradores) veem e entram neste canal.</span>
        </span>
        <input type="checkbox" checked={isPrivate} onChange={(e) => onChange(e.target.checked, roleIds)} />
      </label>
      {isPrivate && (
        <div className="role-pick" role="group" aria-label="Cargos com acesso">
          {roles.length === 0 ? (
            <p className="muted small">Crie um cargo em Configurações do servidor › Cargos para dar acesso a mais pessoas.</p>
          ) : (
            roles.map((r) => (
              <label key={r.id} className={`role-chip ${roleIds.includes(r.id) ? "picked" : ""}`}>
                <input
                  type="checkbox"
                  checked={roleIds.includes(r.id)}
                  onChange={(e) => onChange(true, e.target.checked ? [...roleIds, r.id] : roleIds.filter((id) => id !== r.id))}
                />
                <span className="role-dot" style={{ background: r.color ?? "var(--text-muted)" }} />
                {r.name}
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function CreateChannelModal({
  details,
  categoryId: initialCategory,
  onClose,
  onCreated,
}: {
  details: ServerDetails;
  categoryId: string | null;
  onClose: () => void;
  onCreated: (c: Channel) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<ChannelType>("text");
  const [categoryId, setCategoryId] = useState<string | null>(initialCategory);
  const [privacy, setPrivacy] = useState({ isPrivate: false, roleIds: [] as string[] });
  const { busy, error, submit } = useSubmit(
    () =>
      api
        .createChannel(details.server.id, { name, type, categoryId, private: privacy.isPrivate, roleIds: privacy.roleIds })
        .then((r) => r.channel),
    onCreated,
  );

  return (
    <Modal title="Criar canal" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="radio-group">
          {(["text", "voice"] as const).map((t) => (
            <label key={t} className={`radio ${type === t ? "checked" : ""}`}>
              <input type="radio" name="type" checked={type === t} onChange={() => setType(t)} />
              <span>{t === "text" ? "# Texto" : "🔊 Voz"}</span>
            </label>
          ))}
        </div>
        <label>
          Nome do canal
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />
        </label>
        {details.categories.length > 0 && (
          <label>
            Categoria
            <select value={categoryId ?? ""} onChange={(e) => setCategoryId(e.target.value || null)}>
              <option value="">Sem categoria</option>
              {details.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <PrivacyFields details={details} isPrivate={privacy.isPrivate} roleIds={privacy.roleIds} onChange={(isPrivate, roleIds) => setPrivacy({ isPrivate, roleIds })} />
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn subtle" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy}>
            Criar canal
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function EditChannelModal({ details, channel, onClose }: { details: ServerDetails; channel: Channel; onClose: () => void }) {
  const [name, setName] = useState(channel.name);
  const [privacy, setPrivacy] = useState({ isPrivate: channel.private, roleIds: channel.roleIds });
  const save = useSubmit(() => api.updateChannel(channel.id, { name, private: privacy.isPrivate, roleIds: privacy.roleIds }), onClose);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (!confirm(`Excluir o canal "${channel.name}"? As mensagens dele serão apagadas.`)) return;
    setDeleting(true);
    try {
      await api.deleteChannel(channel.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setDeleting(false);
    }
  };

  return (
    <Modal title={`Editar ${channel.type === "voice" ? "canal de voz" : "canal"}`} onClose={onClose}>
      <form onSubmit={save.submit}>
        <label>
          Nome do canal
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />
        </label>
        <PrivacyFields details={details} isPrivate={privacy.isPrivate} roleIds={privacy.roleIds} onChange={(isPrivate, roleIds) => setPrivacy({ isPrivate, roleIds })} />
        {(save.error || error) && <div className="form-error">{save.error || error}</div>}
        <div className="modal-actions spread">
          <button type="button" className="btn subtle danger" onClick={remove} disabled={deleting}>
            Excluir canal
          </button>
          <span>
            <button type="button" className="btn subtle" onClick={onClose}>
              Cancelar
            </button>
            <button className="btn primary" disabled={save.busy || !name.trim()}>
              Salvar
            </button>
          </span>
        </div>
      </form>
    </Modal>
  );
}

/** Create a category (no `category`), or rename / delete one. */
export function CategoryModal({ serverId, category, onClose }: { serverId: string; category?: Category; onClose: () => void }) {
  const [name, setName] = useState(category?.name ?? "");
  const save = useSubmit(() => (category ? api.renameCategory(category.id, name) : api.createCategory(serverId, name)), onClose);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (!category || !confirm(`Excluir a categoria "${category.name}"? Os canais dela continuam, sem categoria.`)) return;
    try {
      await api.deleteCategory(category.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title={category ? "Editar categoria" : "Criar categoria"} onClose={onClose}>
      <form onSubmit={save.submit}>
        <label>
          Nome da categoria
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus placeholder="Novos canais" />
        </label>
        {(save.error || error) && <div className="form-error">{save.error || error}</div>}
        <div className={`modal-actions ${category ? "spread" : ""}`}>
          {category && (
            <button type="button" className="btn subtle danger" onClick={remove}>
              Excluir categoria
            </button>
          )}
          <span>
            <button type="button" className="btn subtle" onClick={onClose}>
              Cancelar
            </button>
            <button className="btn primary" disabled={save.busy || !name.trim()}>
              {category ? "Salvar" : "Criar categoria"}
            </button>
          </span>
        </div>
      </form>
    </Modal>
  );
}

export const INVITE_AGES: { value: number; label: string }[] = [
  { value: 1800, label: "30 minutos" },
  { value: 3600, label: "1 hora" },
  { value: 21600, label: "6 horas" },
  { value: 43200, label: "12 horas" },
  { value: 86400, label: "1 dia" },
  { value: 604800, label: "7 dias" },
  { value: 0, label: "Nunca" },
];
export const INVITE_USES: { value: number; label: string }[] = [
  { value: 0, label: "Sem limite" },
  { value: 1, label: "1 uso" },
  { value: 5, label: "5 usos" },
  { value: 10, label: "10 usos" },
  { value: 25, label: "25 usos" },
  { value: 50, label: "50 usos" },
  { value: 100, label: "100 usos" },
];

/** "Expira em 7 dias", "nunca expira"… */
export function inviteSummary(invite: Pick<Invite, "expiresAt" | "maxUses" | "uses">): string {
  const parts: string[] = [];
  if (invite.expiresAt === null) parts.push("nunca expira");
  else {
    const left = invite.expiresAt - Date.now();
    const h = left / 3_600_000;
    parts.push(h >= 24 ? `expira em ${Math.round(h / 24)} ${Math.round(h / 24) === 1 ? "dia" : "dias"}` : h >= 1 ? `expira em ${Math.round(h)} h` : `expira em ${Math.max(1, Math.round(left / 60_000))} min`);
  }
  if (invite.maxUses !== null) parts.push(`${invite.maxUses - invite.uses} de ${invite.maxUses} ${invite.maxUses === 1 ? "uso restante" : "usos restantes"}`);
  return parts.join(" · ");
}

/** A link to share; by default it lasts 7 days, like Discord's. "Editar link" changes that. */
export function InviteModal({ details, onClose }: { details: ServerDetails; onClose: () => void }) {
  const [maxAge, setMaxAge] = useState(604800);
  const [maxUses, setMaxUses] = useState(0);
  const [editing, setEditing] = useState(false);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    api
      .createInvite(details.server.id, maxAge, maxUses)
      .then((r) => live && setInvite(r.invite))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
    // `version` asks for a fresh link with the chosen settings.
  }, [details.server.id, version]);

  const link = invite ? `${location.origin}/invite/${invite.code}` : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the link is still selectable in the input.
    }
  };

  return (
    <Modal title={`Convidar para ${details.server.name}`} onClose={onClose}>
      <p className="muted">Envie este link para quem você quer chamar:</p>
      <div className="copy-row">
        <input readOnly value={link} placeholder="Gerando link…" onFocus={(e) => e.currentTarget.select()} aria-label="Link de convite" />
        <button className="btn primary" onClick={copy} disabled={!invite}>
          {copied ? "Copiado!" : "Copiar"}
        </button>
      </div>
      {error && <div className="form-error">{error}</div>}
      {invite && !editing && (
        <p className="muted small invite-summary">
          Este link {inviteSummary(invite)}.{" "}
          <button className="link" onClick={() => setEditing(true)}>
            Editar link de convite
          </button>
        </p>
      )}
      {editing && (
        <div className="invite-settings">
          <label>
            Expirar após
            <select value={maxAge} onChange={(e) => setMaxAge(Number(e.target.value))}>
              {INVITE_AGES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Número máximo de usos
            <select value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
              {INVITE_USES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div className="modal-actions">
            <button className="btn subtle" onClick={() => setEditing(false)}>
              Cancelar
            </button>
            <button
              className="btn primary"
              onClick={() => {
                setEditing(false);
                setInvite(null);
                setVersion((v) => v + 1);
              }}
            >
              Gerar novo link
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
