import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type Channel, type ChannelType, type Role, type Server, type ServerDetails, type User } from "../api.ts";
import { navigate } from "../router.ts";

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function useSubmit<T>(action: () => Promise<T>, onDone: (r: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await action());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

export function CreateServerModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (r: { server: Server; channels: Channel[]; roles: Role[] }) => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const create = useSubmit(() => api.createServer(name), onCreated);

  const join = (e: FormEvent) => {
    e.preventDefault();
    // Accept a bare code or a full invite link.
    const c = code.trim().split("/").filter(Boolean).at(-1);
    if (c) navigate(`/invite/${c}`);
  };

  return (
    <Modal title="Criar um servidor" onClose={onClose}>
      <form onSubmit={create.submit}>
        <label>
          Nome do servidor
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />
        </label>
        {create.error && <div className="form-error">{create.error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn subtle" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={create.busy}>
            Criar
          </button>
        </div>
      </form>

      <hr />
      <form onSubmit={join}>
        <label>
          Já tem um convite?
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Link ou código do convite" />
        </label>
        <div className="modal-actions">
          <button className="btn subtle" disabled={!code.trim()}>
            Entrar no servidor
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function CreateChannelModal({
  serverId,
  onClose,
  onCreated,
}: {
  serverId: string;
  onClose: () => void;
  onCreated: (c: Channel) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<ChannelType>("text");
  const { busy, error, submit } = useSubmit(
    () => api.createChannel(serverId, name, type).then((r) => r.channel),
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

export function InviteModal({ server, onClose }: { server: Server; onClose: () => void }) {
  const link = `${location.origin}/invite/${server.inviteCode}`;
  const [copied, setCopied] = useState(false);

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
    <Modal title={`Convidar para ${server.name}`} onClose={onClose}>
      <p className="muted">Envie este link para quem você quer chamar:</p>
      <div className="copy-row">
        <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
        <button className="btn primary" onClick={copy}>
          {copied ? "Copiado!" : "Copiar"}
        </button>
      </div>
    </Modal>
  );
}

export function EditChannelModal({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const [name, setName] = useState(channel.name);
  const save = useSubmit(() => api.renameChannel(channel.id, name), onClose);
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

/** Your own nickname in a server. */
export function NicknameModal({
  details,
  target,
  onClose,
}: {
  details: ServerDetails;
  target: User;
  selfId: string;
  onClose: () => void;
}) {
  const [nickname, setNickname] = useState(details.memberData[target.id]?.nickname ?? "");
  const { busy, error, submit } = useSubmit(
    () => api.setNickname(details.server.id, target.id, nickname.trim() || null),
    onClose,
  );
  return (
    <Modal title="Apelido no servidor" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted">
          É assim que você aparece em <strong>{details.server.name}</strong>. Nos outros servidores continua{" "}
          <strong>{target.displayName}</strong>.
        </p>
        <label>
          Apelido
          <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={32} placeholder={target.displayName} autoFocus />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions spread">
          <button type="button" className="btn subtle" onClick={() => setNickname("")} disabled={!nickname}>
            Remover apelido
          </button>
          <span>
            <button type="button" className="btn subtle" onClick={onClose}>
              Cancelar
            </button>
            <button className="btn primary" disabled={busy}>
              Salvar
            </button>
          </span>
        </div>
      </form>
    </Modal>
  );
}

/** Account settings: display name (shown everywhere) and password. */
export function ProfileModal({ user, onClose }: { user: User; onClose: () => void }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [saved, setSaved] = useState(false);
  const profile = useSubmit(
    () => api.updateProfile(displayName),
    () => setSaved(true),
  );

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [passwordDone, setPasswordDone] = useState(false);
  const password = useSubmit(
    () => api.changePassword(current, next),
    () => {
      setPasswordDone(true);
      setCurrent("");
      setNext("");
    },
  );

  return (
    <Modal title="Meu perfil" onClose={onClose}>
      <form onSubmit={profile.submit}>
        <label>
          Nome de exibição
          <input
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setSaved(false);
            }}
            maxLength={32}
            required
            autoFocus
          />
        </label>
        <p className="muted small">
          Seu usuário é <strong>@{user.username}</strong> (é por ele que as pessoas te adicionam).
        </p>
        {profile.error && <div className="form-error">{profile.error}</div>}
        {saved && <div className="form-ok">Nome atualizado.</div>}
        <div className="modal-actions">
          <button className="btn primary" disabled={profile.busy || !displayName.trim() || displayName.trim() === user.displayName}>
            Salvar nome
          </button>
        </div>
      </form>

      <hr />
      <form onSubmit={password.submit}>
        <label>
          Senha atual
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </label>
        <label>
          Nova senha
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} required />
        </label>
        {password.error && <div className="form-error">{password.error}</div>}
        {passwordDone && <div className="form-ok">Senha alterada. Outros dispositivos foram desconectados.</div>}
        <div className="modal-actions">
          <button type="button" className="btn subtle" onClick={onClose}>
            Fechar
          </button>
          <button className="btn primary" disabled={password.busy}>
            Trocar senha
          </button>
        </div>
      </form>
    </Modal>
  );
}
