// "Aparência e sons": the app's theme and its interface sounds, for this device.

import { THEMES, appSettings } from "../appSettings.ts";
import { SOUND_LABELS, playSound, type SoundName } from "../sounds.ts";
import { useAppSettings } from "../useAppSettings.ts";
import { Icon } from "./Icon.tsx";
import { Modal } from "./Modals.tsx";

const PREVIEW_SOUNDS: SoundName[] = ["join", "leave", "userJoin", "mute", "unmute", "message", "streamStart", "replay"];

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

      <p className="muted small">Essas preferências valem para este dispositivo.</p>
      <div className="modal-actions">
        <button className="btn primary" onClick={onClose}>
          Pronto
        </button>
      </div>
    </Modal>
  );
}
