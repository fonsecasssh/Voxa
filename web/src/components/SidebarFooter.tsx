// Bottom of every sidebar: voice connection panel, and the user's own card with
// mic / headphone toggles and the status menu.

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Activity, User, UserStatus } from "../api.ts";
import { navigate } from "../router.ts";
import { useVoice } from "../voice/useVoice.ts";
import { DOWNLOAD_URL, desktop } from "../desktop.ts";
import { Avatar, STATUS_LABEL } from "./Avatar.tsx";

interface Props {
  user: User;
  status: UserStatus;
  activity: Activity | null;
  /** Where the active voice connection is, e.g. "Geral / Squad", and its URL. */
  voiceLocation: { label: string; path: string } | null;
  setPresence: SetPresence;
  onEditProfile: () => void;
  onLogout: () => void;
}

export type SetPresence = (patch: { status?: UserStatus; activity?: string | null }) => Promise<void>;

export function SidebarFooter({ user, status, activity, voiceLocation, setPresence, onEditProfile, onLogout }: Props) {
  const [voice, vs] = useVoice();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <>
      {vs.error && <div className="voice-error">{vs.error}</div>}

      {vs.status !== "idle" && (
        <div className="voice-panel">
          <div className="voice-panel-info">
            <strong className={vs.status === "connected" ? "ok" : "pending"}>
              {vs.status === "connected" ? "Voz conectada" : "Conectando…"}
            </strong>
            <button className="link small ellipsis" onClick={() => voiceLocation && navigate(voiceLocation.path)}>
              {voiceLocation?.label ?? "Canal de voz"}
            </button>
          </div>
          <button
            className={`icon-btn ${vs.localScreen ? "on" : ""}`}
            title={vs.localScreen ? "Parar de transmitir" : "Compartilhar tela"}
            disabled={vs.status !== "connected"}
            onClick={() => (vs.localScreen ? voice?.stopScreenShare() : voice?.startScreenShare())}
          >
            🖥
          </button>
          <button className="icon-btn danger" title="Desconectar" onClick={() => voice?.leave()}>
            ✆
          </button>
        </div>
      )}

      <footer className="user-panel">
        {menuOpen && (
          <StatusMenu
            status={status}
            activity={activity}
            setPresence={setPresence}
            onClose={() => setMenuOpen(false)}
            onLogout={onLogout}
            onEditProfile={() => {
              setMenuOpen(false);
              onEditProfile();
            }}
          />
        )}
        <button className="user-card" title="Definir status" onClick={() => setMenuOpen((o) => !o)}>
          <Avatar name={user.displayName} id={user.id} size={32} status={status === "invisible" ? "offline" : status} />
          <span className="user-names">
            <strong className="ellipsis">{user.displayName}</strong>
            <span className="muted small ellipsis">{activity ? `Jogando ${activity.name}` : STATUS_LABEL[status]}</span>
          </span>
        </button>
        <button
          className={`icon-btn ${vs.muted || vs.deafened ? "off" : ""}`}
          title={vs.muted ? "Ativar microfone" : "Desativar microfone"}
          aria-pressed={vs.muted}
          onClick={() => voice?.setMuted(!vs.muted)}
        >
          {vs.muted || vs.deafened ? "🔇" : "🎙"}
        </button>
        <button
          className={`icon-btn ${vs.deafened ? "off" : ""}`}
          title={vs.deafened ? "Ativar áudio" : "Desativar áudio"}
          aria-pressed={vs.deafened}
          onClick={() => voice?.setDeafened(!vs.deafened)}
        >
          {vs.deafened ? "🔕" : "🎧"}
        </button>
      </footer>
    </>
  );
}

const STATUS_OPTIONS: { value: UserStatus; hint?: string }[] = [
  { value: "online" },
  { value: "idle" },
  { value: "dnd", hint: "Você não vai receber notificações." },
  { value: "invisible", hint: "Você aparece offline, mas continua usando tudo normalmente." },
];

function StatusMenu({
  status,
  activity,
  setPresence,
  onClose,
  onLogout,
  onEditProfile,
}: {
  status: UserStatus;
  activity: Activity | null;
  setPresence: SetPresence;
  onClose: () => void;
  onLogout: () => void;
  onEditProfile: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [game, setGame] = useState(activity?.name ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const card = (e.target as Element).closest(".user-card");
      if (ref.current && !ref.current.contains(e.target as Node) && !card) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const update = async (patch: Parameters<SetPresence>[0]) => {
    setError(null);
    try {
      await setPresence(patch);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  const saveGame = async (e: FormEvent) => {
    e.preventDefault();
    if (await update({ activity: game.trim() || null })) onClose();
  };

  return (
    <div className="status-menu" ref={ref} role="menu">
      {STATUS_OPTIONS.map((o) => (
        <button
          key={o.value}
          role="menuitemradio"
          aria-checked={status === o.value}
          className={`status-option ${status === o.value ? "current" : ""}`}
          onClick={async () => (await update({ status: o.value })) && onClose()}
        >
          <span className={`presence-dot inline ${o.value === "invisible" ? "offline" : o.value}`} />
          <span>
            {STATUS_LABEL[o.value]}
            {o.hint && <span className="muted small block">{o.hint}</span>}
          </span>
        </button>
      ))}
      <hr />
      <form onSubmit={saveGame} className="game-form">
        <label>
          Jogando agora
          <input value={game} onChange={(e) => setGame(e.target.value)} placeholder="Ex.: Valorant" maxLength={128} />
        </label>
        <div className="modal-actions">
          {activity && (
            <button type="button" className="btn subtle" onClick={async () => (await update({ activity: null })) && onClose()}>
              Limpar
            </button>
          )}
          <button className="btn primary">Salvar</button>
        </div>
      </form>
      {error && <div className="form-error">{error}</div>}
      <hr />
      <button className="status-option" onClick={onEditProfile}>
        Editar perfil
      </button>
      {!desktop && (
        <a className="status-option" href={DOWNLOAD_URL}>
          Baixar app para Windows
        </a>
      )}
      <button className="status-option danger" onClick={onLogout}>
        Sair da conta
      </button>
    </div>
  );
}
