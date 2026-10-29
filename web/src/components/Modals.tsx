import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { api, type Category, type Channel, type ProfileImageKind, type Role, type Server, type ServerDetails, type User } from "../api.ts";
import { Avatar } from "./Avatar.tsx";
import { ImageCropper } from "./ImageCropper.tsx";
import { navigate } from "../router.ts";
import { getFeatures } from "../features.ts";

export function Modal({ title, onClose, children, className }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className ?? ""}`} role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function useSubmit<T>(action: () => Promise<T>, onDone: (r: T) => void) {
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
  onCreated: (r: { server: Server; channels: Channel[]; categories: Category[]; roles: Role[] }) => void;
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

type ProfileCrop = { kind: ProfileImageKind; file: File };

/** Profile picture and banner, with a preview of the profile card. */
function ProfileImages({ user }: { user: User }) {
  const avatarInput = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);
  const [crop, setCrop] = useState<ProfileCrop | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = async (kind: ProfileImageKind) => {
    setError(null);
    try {
      await api.removeProfileImage(kind);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const picker = (kind: ProfileImageKind, ref: typeof avatarInput, label: string) => (
    <input
      ref={ref}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      hidden
      aria-label={label}
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) setCrop({ kind, file });
      }}
    />
  );

  return (
    <div className="profile-images">
      <div className="profile-preview">
        <div className="profile-preview-banner" style={user.banner ? { backgroundImage: `url(${user.banner})` } : undefined} />
        <div className="profile-preview-body">
          <Avatar name={user.displayName} id={user.id} size={72} src={user.avatar} />
          <div>
            <strong>{user.displayName}</strong>
            <div className="muted small">@{user.username}</div>
          </div>
        </div>
      </div>
      {picker("avatar", avatarInput, "Escolher foto de perfil")}
      {picker("banner", bannerInput, "Escolher banner do perfil")}
      <div className="profile-image-actions">
        <button type="button" className="btn primary" onClick={() => avatarInput.current?.click()}>
          {user.avatar ? "Trocar foto" : "Enviar foto"}
        </button>
        {user.avatar && (
          <button type="button" className="btn subtle danger" onClick={() => remove("avatar")}>
            Remover foto
          </button>
        )}
        <button type="button" className="btn subtle" onClick={() => bannerInput.current?.click()}>
          {user.banner ? "Trocar banner" : "Enviar banner"}
        </button>
        {user.banner && (
          <button type="button" className="btn subtle danger" onClick={() => remove("banner")}>
            Remover banner
          </button>
        )}
      </div>
      {error && <div className="form-error">{error}</div>}
      {crop && (
        <ImageCropper
          file={crop.file}
          kind={crop.kind === "avatar" ? "avatar" : "profileBanner"}
          onCancel={() => setCrop(null)}
          onCropped={async (image) => {
            await api.uploadProfileImage(crop.kind, image);
            setCrop(null);
          }}
        />
      )}
    </div>
  );
}

/** The confirmed e-mail used to recover a forgotten password (when the server can send e-mail). */
function EmailSection() {
  const [email, setEmail] = useState<string | null | undefined>(undefined);
  const [value, setValue] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    api.me().then((me) => setEmail(me.email), () => setEmail(null));
  }, []);
  const save = useSubmit(
    () => api.setEmail(value.trim(), password),
    (r) => {
      setPending(r.pending);
      setPassword("");
    },
  );
  if (!getFeatures().email) return null;
  return (
    <>
      <hr />
      <form onSubmit={save.submit}>
        <div className="field-label">E-mail para recuperar a senha</div>
        {email ? (
          <p className="muted small">
            Confirmado: <strong>{email}</strong>.{" "}
            <button type="button" className="link" onClick={() => confirm("Remover o e-mail? Você não poderá recuperar a senha se esquecê-la.") && api.removeEmail().then(() => setEmail(null))}>
              Remover
            </button>
          </p>
        ) : (
          <p className="muted small">Sem e-mail, não dá para recuperar a conta se você esquecer a senha.</p>
        )}
        <label>
          {email ? "Trocar e-mail" : "E-mail"}
          <input type="email" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="email" required />
        </label>
        <label>
          Sua senha atual
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {save.error && <div className="form-error">{save.error}</div>}
        {pending && (
          <div className="form-ok" role="status">
            Enviamos um link para <strong>{pending}</strong>. Abra-o para confirmar o e-mail.
          </div>
        )}
        <div className="modal-actions">
          <button className="btn primary" disabled={save.busy}>
            Enviar confirmação
          </button>
        </div>
      </form>
    </>
  );
}

/** How your card will look to others. */
function ProfilePreview({ user, bio }: { user: User; bio: string }) {
  return (
    <div className="pcard-preview" style={user.color ? ({ "--profile": user.color } as CSSProperties) : undefined}>
      <span className="field-label">Prévia</span>
      <div className={`pcard-card ${user.color ? "has-color" : ""}`}>
        <div className="pcard-banner" style={user.banner ? { backgroundImage: `url(${user.banner})` } : undefined} />
        <div className="pcard-body">
          <span className="pcard-avatar">
            <Avatar name={user.displayName} id={user.id} size={56} src={user.avatar} />
          </span>
          <strong>{user.displayName}</strong>
          <span className="muted small">@{user.username}</span>
          {bio.trim() && <p className="small profile-bio">{bio.trim()}</p>}
        </div>
      </div>
    </div>
  );
}

/** Account settings: picture, banner, display name (shown everywhere) and password. */
/** Profile colors to pick from (any other one through the color picker). */
export const PROFILE_COLORS = ["#7c4dff", "#3a7bff", "#16a3b8", "#2ea86b", "#e0b020", "#ff6a3d", "#e0457b", "#9b59b6", "#5d6d7e"];

export function ProfileModal({ user, onClose }: { user: User; onClose: () => void }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [bio, setBio] = useState<string | null>(null);
  const [color, setColor] = useState<string | null>(user.color ?? null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api.profile(user.id).then((r) => setBio((b) => b ?? r.bio ?? ""), () => setBio((b) => b ?? ""));
  }, [user.id]);
  const profile = useSubmit(
    () => api.updateProfile({ displayName, bio: bio ?? undefined, color }),
    () => setSaved(true),
  );
  const changed = () => setSaved(false);

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
      <ProfileImages user={user} />
      <hr />
      <form onSubmit={profile.submit} className="profile-form">
        <label>
          Nome de exibição
          <input
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              changed();
            }}
            maxLength={32}
            required
            autoFocus
          />
        </label>
        <p className="muted small">
          Seu usuário é <strong>@{user.username}</strong> (é por ele que as pessoas te adicionam).
        </p>
        <label>
          Sobre mim
          <textarea
            value={bio ?? ""}
            onChange={(e) => {
              setBio(e.target.value);
              changed();
            }}
            maxLength={190}
            rows={3}
            placeholder="Conte um pouco sobre você: jogos, horários, o que curte…"
            disabled={bio === null}
          />
          <span className="muted small field-count">{(bio ?? "").length}/190</span>
        </label>
        <div>
          <span className="field-label">Cor do perfil</span>
          <div className="profile-colors" role="radiogroup" aria-label="Cor do perfil">
            <button
              type="button"
              role="radio"
              aria-checked={color === null}
              className={`profile-color none ${color === null ? "picked" : ""}`}
              title="Sem cor (usa a do tema)"
              onClick={() => {
                setColor(null);
                changed();
              }}
            />
            {PROFILE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={`Cor ${c}`}
                className={`profile-color ${color === c ? "picked" : ""}`}
                style={{ background: c }}
                onClick={() => {
                  setColor(c);
                  changed();
                }}
              />
            ))}
            <label className={`profile-color custom ${color && !PROFILE_COLORS.includes(color) ? "picked" : ""}`} title="Outra cor">
              <input
                type="color"
                value={color ?? "#7c4dff"}
                onChange={(e) => {
                  setColor(e.target.value);
                  changed();
                }}
                aria-label="Escolher outra cor"
              />
            </label>
          </div>
          <p className="muted small">Aparece no seu cartão de perfil (no lugar do banner, se você não tiver um).</p>
        </div>
        <ProfilePreview user={{ ...user, displayName: displayName.trim() || user.displayName, color }} bio={bio ?? ""} />
        {profile.error && <div className="form-error">{profile.error}</div>}
        {saved && <div className="form-ok">Perfil atualizado.</div>}
        <div className="modal-actions">
          <button className="btn primary" disabled={profile.busy || !displayName.trim() || bio === null}>
            Salvar perfil
          </button>
        </div>
      </form>

      <EmailSection />
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
