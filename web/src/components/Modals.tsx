import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type Channel, type ChannelType, type Server } from "../api.ts";
import { navigate } from "../router.ts";

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
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
  onCreated: (r: { server: Server; channels: Channel[] }) => void;
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
