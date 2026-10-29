// Bottom of every sidebar: voice connection panel, and the user's own card with
// mic / headphone toggles and the status menu.

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Activity, CustomStatus, User, UserStatus } from "../api.ts";
import { navigate } from "../router.ts";
import { useVoice } from "../voice/useVoice.ts";
import { DOWNLOAD_URL, desktop } from "../desktop.ts";
import { Avatar, STATUS_LABEL } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";
import { useAudioSettings } from "../voice/useAudioSettings.ts";
import { audioSettings, bindingLabel, type NoiseSuppression } from "../voice/audioSettings.ts";
import { replay, useReplay } from "../replay/replay.ts";
import { useReplaySettings } from "../replay/useReplaySettings.ts";
import { CustomStatusModal, StatusEmoji, activeCustom } from "./CustomStatus.tsx";

interface Props {
  user: User;
  status: UserStatus;
  activity: Activity | null;
  customStatus: CustomStatus | null;
  /** Where the active voice connection is, e.g. "Geral / Squad", and its URL. */
  voiceLocation: { label: string; path: string } | null;
  setPresence: SetPresence;
  onEditProfile: () => void;
  onVoiceSettings: () => void;
  onReplay: () => void;
  onAppSettings: () => void;
  onLogout: () => void;
}

export type SetPresence = (patch: { status?: UserStatus; activity?: string | null; custom?: CustomStatus | null }) => Promise<void>;

export function SidebarFooter({ user, status, activity, customStatus, voiceLocation, setPresence, onEditProfile, onVoiceSettings, onReplay, onAppSettings, onLogout }: Props) {
  const [voice, vs] = useVoice();
  const rp = useReplay();
  const replaySettings = useReplaySettings();
  const replayOn = rp.status !== "off";
  const settings = useAudioSettings();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingCustom, setEditingCustom] = useState(false);
  const custom = activeCustom(customStatus);
  const inVoice = vs.status !== "idle";
  const connected = vs.status === "connected";
  const micOff = vs.muted || vs.deafened;
  const suppressing = settings.noiseSuppression !== "off";
  // Remember the chosen model so the quick toggle turns the same one back on.
  const lastModel = useRef<NoiseSuppression>(settings.noiseSuppression === "off" ? "strong" : settings.noiseSuppression);
  if (settings.noiseSuppression !== "off") lastModel.current = settings.noiseSuppression;

  return (
    <div className="self-panel">
      {vs.error && <div className="voice-error">{vs.error}</div>}

      {activity && (
        <section className="panel-card activity-card" title={`Jogando ${activity.name}`}>
          <span className="activity-icon">
            <Icon name="gamepad" size={22} />
          </span>
          <span className="panel-texts">
            <strong className="ellipsis">{activity.name}</strong>
            <span className="muted small ellipsis">Jogando agora</span>
          </span>
          {!replayOn && (
            <button className="panel-icon" title="Ativar replay instantâneo" onClick={onReplay}>
              <Icon name="replay" />
            </button>
          )}
        </section>
      )}

      {replayOn && (
        <section className={`panel-card replay-card ${rp.justSaved ? "saved" : ""}`}>
          <span className={`rec-dot ${rp.status === "starting" ? "pending" : ""}`} aria-hidden />
          <button className="panel-texts voice-where" title="Abrir replay instantâneo" onClick={onReplay}>
            <strong className="ellipsis">{rp.justSaved ? "Clipe salvo!" : rp.saving ? "Salvando clipe…" : rp.status === "starting" ? "Escolha a tela…" : "Replay ativo"}</strong>
            <span className="muted small ellipsis">
              {rp.justSaved
                ? "Clique para ver e enviar"
                : `${rp.bufferedSeconds} de ${replaySettings.duration} s${replaySettings.hotkey ? ` · ${replaySettings.hotkey}` : ""}`}
            </span>
          </button>
          <button className="panel-icon" title="Salvar clipe" disabled={rp.status !== "recording" || rp.saving} onClick={() => replay.save()}>
            <Icon name="save" />
          </button>
          <button className="panel-icon" title="Desativar replay" onClick={() => replay.stop()}>
            <Icon name="close" size={18} />
          </button>
        </section>
      )}

      {inVoice && (
        <section className="panel-card voice-card">
          <div className="voice-card-top">
            <span className={`signal ${connected ? "ok" : "pending"}`} title={connected ? "Conectado" : "Conectando"}>
              <Icon name="signal" size={20} />
            </span>
            <button
              className="panel-texts voice-where"
              title="Ir para o canal de voz"
              onClick={() => voiceLocation && navigate(voiceLocation.path)}
            >
              <strong className={connected ? "ok" : "pending"}>{connected ? "Voz conectada" : "Conectando…"}</strong>
              <span className="muted small ellipsis">{voiceLocation?.label ?? "Canal de voz"}</span>
            </button>
            <button
              className={`panel-icon ${suppressing ? "active" : ""}`}
              title={suppressing ? "Supressão de ruído ligada (clique para desligar)" : "Supressão de ruído desligada (clique para ligar)"}
              aria-pressed={suppressing}
              onClick={() => audioSettings.update({ noiseSuppression: suppressing ? "off" : lastModel.current })}
            >
              <Icon name="waveform" />
            </button>
            <button className="panel-icon hangup" title="Desconectar" onClick={() => voice?.leave()}>
              <Icon name="hangup" />
            </button>
          </div>
          {settings.inputMode === "ptt" && (
            <div className={`ptt-hint ${vs.pttActive ? "live" : ""}`} aria-live="polite">
              <span className="ptt-dot" aria-hidden="true" />
              {vs.pttActive ? (
                "Transmitindo"
              ) : (
                <span>
                  Segure <kbd>{bindingLabel(settings.pttBinding)}</kbd> para falar
                </span>
              )}
            </div>
          )}
          <div className="voice-card-actions">
            <button
              className={`action-btn ${vs.localScreen ? "live" : ""}`}
              title={vs.localScreen ? "Parar de transmitir" : "Compartilhar tela"}
              disabled={!connected}
              onClick={() => (vs.localScreen ? voice?.stopScreenShare() : voice?.startScreenShare())}
            >
              <Icon name={vs.localScreen ? "screenOff" : "screen"} />
            </button>
            <button
              className={`action-btn ${vs.localCamera ? "live" : ""}`}
              title={vs.localCamera ? "Desligar câmera" : "Ligar câmera"}
              disabled={!connected}
              onClick={() => (vs.localCamera ? voice?.stopCamera() : voice?.startCamera())}
            >
              <Icon name={vs.localCamera ? "video" : "videoOff"} />
            </button>
            <button className={`action-btn ${replayOn ? "live" : ""}`} title="Replay instantâneo" onClick={onReplay}>
              <Icon name="replay" />
            </button>
            <button className="action-btn" title="Configurações de voz" onClick={onVoiceSettings}>
              <Icon name="mic" />
            </button>
            <button
              className="action-btn"
              title="Ir para o canal de voz"
              disabled={!voiceLocation}
              onClick={() => voiceLocation && navigate(voiceLocation.path)}
            >
              <Icon name="arrowRight" />
            </button>
          </div>
        </section>
      )}

      {editingCustom && (
        <CustomStatusModal current={custom} onSave={(c) => setPresence({ custom: c })} onClose={() => setEditingCustom(false)} />
      )}

      <footer className="user-panel">
        {menuOpen && (
          <StatusMenu
            status={status}
            activity={activity}
            hasCustom={!!custom}
            onCustom={() => {
              setMenuOpen(false);
              setEditingCustom(true);
            }}
            setPresence={setPresence}
            onClose={() => setMenuOpen(false)}
            onLogout={onLogout}
            onEditProfile={() => {
              setMenuOpen(false);
              onEditProfile();
            }}
            onReplay={() => {
              setMenuOpen(false);
              onReplay();
            }}
            onAppSettings={() => {
              setMenuOpen(false);
              onAppSettings();
            }}
          />
        )}
        <button className="user-card" title="Definir status" onClick={() => setMenuOpen((o) => !o)}>
          <Avatar name={user.displayName} id={user.id} size={32} status={status === "invisible" ? "offline" : status} src={user.avatar} />
          <span className="user-names">
            <strong className="ellipsis">{user.displayName}</strong>
            {custom ? (
              <span className="muted small ellipsis custom-status">
                {custom.emoji && <StatusEmoji emoji={custom.emoji} size={14} />}
                {custom.text && <span className="ellipsis">{custom.text}</span>}
              </span>
            ) : (
              <span className="muted small ellipsis">{activity ? `Jogando ${activity.name}` : STATUS_LABEL[status]}</span>
            )}
          </span>
        </button>
        <div className={`split-btn ${micOff ? "off" : ""}`}>
          <button
            className="split-main"
            title={vs.muted ? "Ativar microfone" : "Desativar microfone"}
            aria-pressed={vs.muted}
            onClick={() => voice?.setMuted(!vs.muted)}
          >
            <Icon name={micOff ? "micOff" : "mic"} />
          </button>
          <button className="split-more" title="Escolher microfone" onClick={onVoiceSettings}>
            <Icon name="chevron" size={14} />
          </button>
        </div>
        <div className={`split-btn ${vs.deafened ? "off" : ""}`}>
          <button
            className="split-main"
            title={vs.deafened ? "Ativar áudio" : "Desativar áudio"}
            aria-pressed={vs.deafened}
            onClick={() => voice?.setDeafened(!vs.deafened)}
          >
            <Icon name={vs.deafened ? "headphonesOff" : "headphones"} />
          </button>
          <button className="split-more" title="Escolher saída de áudio" onClick={onVoiceSettings}>
            <Icon name="chevron" size={14} />
          </button>
        </div>
        <button className="panel-icon" title="Configurações de voz" onClick={onVoiceSettings}>
          <Icon name="gear" />
        </button>
      </footer>
    </div>
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
  hasCustom,
  onCustom,
  setPresence,
  onClose,
  onLogout,
  onEditProfile,
  onReplay,
  onAppSettings,
}: {
  status: UserStatus;
  activity: Activity | null;
  hasCustom: boolean;
  onCustom: () => void;
  setPresence: SetPresence;
  onClose: () => void;
  onLogout: () => void;
  onEditProfile: () => void;
  onReplay: () => void;
  onAppSettings: () => void;
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
      <button className="status-option" onClick={onCustom}>
        <span aria-hidden>🙂</span>
        {hasCustom ? "Editar status personalizado" : "Definir status personalizado"}
      </button>
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
      <button className="status-option" onClick={onReplay}>
        Replay instantâneo
      </button>
      <button className="status-option" onClick={onAppSettings}>
        Aparência e sons
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
