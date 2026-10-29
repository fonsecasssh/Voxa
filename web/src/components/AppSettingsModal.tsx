// "Aparência e sons": the app's theme and its interface sounds, for this device.

import { THEMES, appSettings } from "../appSettings.ts";
import { SOUND_LABELS, SOUND_STYLES, playSound, type SoundName } from "../sounds.ts";
import { useAppSettings } from "../useAppSettings.ts";
import { DEFAULT_SOUNDS, playBoardSound } from "../soundboard.ts";
import { Icon } from "./Icon.tsx";
import { Modal } from "./Modals.tsx";
import { install, isIos, isStandalone, useCanInstall } from "../pwa.ts";
import { desktop } from "../desktop.ts";
import { disablePush, enablePush, pushState, pushSupported, type PushState } from "../push.ts";
import { getFeatures } from "../features.ts";
import { useEffect, useState } from "react";

const PREVIEW_SOUNDS: SoundName[] = ["join", "leave", "userJoin", "mute", "unmute", "message", "streamStart", "replay"];

/** Push notifications on this device (DMs, mentions and calls with Voxa closed). */
function PushSection() {
  const [state, setState] = useState<PushState | "busy" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    pushState().then(setState, () => setState("unsupported"));
  }, []);
  if (!getFeatures().push || !pushSupported() || state === null) return null;
  const toggle = async () => {
    setError(null);
    const was = state;
    setState("busy");
    try {
      if (was === "on") {
        await disablePush();
        setState("off");
      } else setState(await enablePush());
    } catch (err) {
      setError((err as Error).message || "Não foi possível ativar as notificações.");
      setState(was);
    }
  };
  return (
    <>
      <div className="field-label">Notificações</div>
      <label className="toggle-row compact">
        <span>
          Notificar neste dispositivo com o Voxa fechado
          <span className="muted small block">Mensagens diretas, menções e chamadas, seguindo o que você silenciou.</span>
        </span>
        <input type="checkbox" checked={state === "on"} disabled={state === "busy" || state === "denied"} onChange={toggle} />
      </label>
      {state === "denied" && <p className="muted small">As notificações estão bloqueadas para este site. Libere nas configurações do navegador.</p>}
      {isIos() && !isStandalone() && <p className="muted small">No iPhone, instale o Voxa na Tela de Início para receber notificações.</p>}
      {error && <div className="form-error">{error}</div>}
    </>
  );
}

/** "Instalar o Voxa" on phones and browsers that allow it (the desktop app is already installed). */
function InstallSection() {
  const canInstall = useCanInstall();
  if (desktop || isStandalone()) return null;
  if (!canInstall && !isIos()) return null;
  return (
    <>
      <div className="field-label">App</div>
      {canInstall ? (
        <button type="button" className="btn primary install-btn" onClick={() => install()}>
          Instalar o Voxa neste dispositivo
        </button>
      ) : (
        <p className="muted small">No iPhone ou iPad, toque em Compartilhar e depois em "Adicionar à Tela de Início" para usar o Voxa como app.</p>
      )}
    </>
  );
}

export function AppSettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useAppSettings();

  return (
    <Modal title="Aparência e sons" onClose={onClose} className="app-settings-modal">
      <div className="field-label">Tema</div>
      <div className="theme-grid" role="radiogroup" aria-label="Tema">
        {THEMES.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={settings.theme === t.id}
            className={`theme-card ${settings.theme === t.id ? "active" : ""}`}
            onClick={() => appSettings.update({ theme: t.id })}
          >
            <span className="theme-swatch" style={{ background: t.bg }}>
              <span style={{ background: `linear-gradient(135deg, ${t.g1}, ${t.g2})` }} />
            </span>
            <span className="theme-texts">
              <strong>{t.name}</strong>
              <span className="muted small">{t.hint}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="field-label">Sons</div>
      <label className="toggle-row compact">
        <span>
          Sons do Voxa
          <span className="muted small block">Entrar e sair da voz, alguém entrar, mutar, mensagens diretas, transmissões e replays.</span>
        </span>
        <input type="checkbox" checked={settings.sounds} onChange={(e) => appSettings.update({ sounds: e.target.checked })} />
      </label>
      <div className="segmented" role="radiogroup" aria-label="Estilo dos sons">
        {SOUND_STYLES.map((st) => (
          <button
            key={st.id}
            type="button"
            role="radio"
            aria-checked={settings.soundStyle === st.id}
            className={settings.soundStyle === st.id ? "active" : ""}
            disabled={!settings.sounds}
            onClick={() => {
              appSettings.update({ soundStyle: st.id, soundStyleChosen: true });
              playSound("join");
            }}
          >
            {st.label}
          </button>
        ))}
      </div>
      <p className="muted small">{SOUND_STYLES.find((st) => st.id === settings.soundStyle)?.hint}</p>
      <label className="volume-row">
        Volume
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={settings.soundVolume}
          disabled={!settings.sounds}
          onChange={(e) => appSettings.update({ soundVolume: Number(e.target.value) })}
          onPointerUp={() => playSound("unmute")}
          aria-label="Volume dos sons"
        />
        <span className="muted small">{Math.round(settings.soundVolume * 100)}%</span>
      </label>
      <div className="sound-chips" aria-label="Ouvir os sons">
        {PREVIEW_SOUNDS.map((s) => (
          <button key={s} type="button" className="chip" disabled={!settings.sounds} onClick={() => playSound(s)}>
            <Icon name="headphones" size={14} />
            {SOUND_LABELS[s]}
          </button>
        ))}
      </div>

      <label className="volume-row">
        Soundboard
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={settings.soundboardVolume}
          onChange={(e) => appSettings.update({ soundboardVolume: Number(e.target.value) })}
          onPointerUp={() => playBoardSound({ ...DEFAULT_SOUNDS[5], volume: 1, url: null })}
          aria-label="Volume do soundboard"
        />
        <span className="muted small">{settings.soundboardVolume ? `${Math.round(settings.soundboardVolume * 100)}%` : "Desligado"}</span>
      </label>

      <PushSection />
      <InstallSection />

      <p className="muted small">Essas preferências valem para este dispositivo.</p>
      <div className="modal-actions">
        <button className="btn primary" onClick={onClose}>
          Pronto
        </button>
      </div>
    </Modal>
  );
}
