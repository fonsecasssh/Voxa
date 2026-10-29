// "Configurações de voz": input/output devices, noise suppression, input sensitivity
// (with a live meter, like Discord's) and echo cancellation. Settings are per device.

import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modals.tsx";
import {
  AUTO_GATE,
  PTT_RELEASE_RANGE,
  SENSITIVITY_RANGE,
  bindingLabel,
  applyOutputDevice,
  audioSettings,
  canChooseOutput,
  gateThresholds,
  type NoiseSuppression,
  type PttBinding,
} from "../voice/audioSettings.ts";
import { desktop } from "../desktop.ts";
import {
  buildMicPipeline,
  getAudioContext,
  levelDb,
  openMic,
  type MicPipeline,
} from "../voice/audioPipeline.ts";
import { useAudioSettings } from "../voice/useAudioSettings.ts";

const SUPPRESSION: { value: NoiseSuppression; label: string; hint: string }[] =
  [
    {
      value: "off",
      label: "Desligada",
      hint: "Só a redução básica do navegador.",
    },
    {
      value: "light",
      label: "Leve",
      hint: "IA leve (RNNoise): reduz chiado e ventilador; o teclado ainda passa um pouco.",
    },
    {
      value: "strong",
      label: "Forte (recomendado)",
      hint: "IA (GTCRN): remove teclado, cliques, ventilador e chiado, mantendo a voz.",
    },
  ];

function useDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () =>
      navigator.mediaDevices
        ?.enumerateDevices()
        .then(setDevices)
        .catch(() => {});
    load();
    navigator.mediaDevices?.addEventListener("devicechange", load);
    return () =>
      navigator.mediaDevices?.removeEventListener("devicechange", load);
  }, []);
  return {
    devices,
    refresh: () =>
      navigator.mediaDevices
        ?.enumerateDevices()
        .then(setDevices)
        .catch(() => {}),
  };
}

/** Maps dBFS to 0..100% of the meter. */
const pct = (db: number) =>
  ((Math.min(SENSITIVITY_RANGE.max, Math.max(SENSITIVITY_RANGE.min, db)) -
    SENSITIVITY_RANGE.min) /
    (SENSITIVITY_RANGE.max - SENSITIVITY_RANGE.min)) *
  100;

/** "Gravar atalho": the next key or mouse button (middle, back, forward) becomes push-to-talk. */
function PttRecorder({
  binding,
  onChange,
}: {
  binding: PttBinding;
  onChange: (b: PttBinding) => void;
}) {
  const [recording, setRecording] = useState(false);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    if (!recording) return;
    const onChange = (b: PttBinding) => change.current(b);
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== "Escape") {
        const label =
          e.key.length === 1 && e.key !== " " ? e.key.toUpperCase() : undefined;
        onChange(
          label
            ? { type: "key", code: e.code, label }
            : { type: "key", code: e.code },
        );
      }
      setRecording(false);
    };
    const mouse = (e: MouseEvent) => {
      if (e.button !== 1 && e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      e.stopPropagation();
      onChange({ type: "mouse", button: e.button });
      setRecording(false);
    };
    const stop = () => setRecording(false);
    window.addEventListener("keydown", key, true);
    window.addEventListener("mousedown", mouse, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("mousedown", mouse, true);
      window.removeEventListener("blur", stop);
    };
  }, [recording]);
  return (
    <button
      type="button"
      className={`ptt-key ${recording ? "recording" : ""}`}
      onClick={() => setRecording((r) => !r)}
      aria-label="Gravar atalho"
    >
      {recording ? "Aperte uma tecla…" : <kbd>{bindingLabel(binding)}</kbd>}
    </button>
  );
}

export function VoiceSettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useAudioSettings();
  const { devices, refresh } = useDevices();
  const [level, setLevel] = useState(-100);
  const [error, setError] = useState<string | null>(null);
  const [hearSelf, setHearSelf] = useState(false);
  const test = useRef<{ raw: MediaStream; pipeline: MicPipeline } | null>(null);
  const monitor = useRef<HTMLAudioElement | null>(null);

  const inputs = devices.filter(
    (d) =>
      d.kind === "audioinput" &&
      d.deviceId !== "default" &&
      d.deviceId !== "communications",
  );
  const outputs = devices.filter(
    (d) =>
      d.kind === "audiooutput" &&
      d.deviceId !== "default" &&
      d.deviceId !== "communications",
  );
  const cameras = devices.filter((d) => d.kind === "videoinput" && d.deviceId);
  const { openDb } = gateThresholds(settings);

  // A private test pipeline with the current settings, rebuilt whenever they change.
  useEffect(() => {
    let cancelled = false;
    getAudioContext();
    (async () => {
      try {
        const raw = await openMic(settings);
        const pipeline = await buildMicPipeline(raw, settings);
        if (cancelled) {
          pipeline.dispose();
          raw.getTracks().forEach((t) => t.stop());
          return;
        }
        test.current = { raw, pipeline };
        setError(null);
        refresh(); // device names only appear once the mic is allowed
      } catch (err) {
        if (!cancelled) {
          setError(
            (err as Error).name === "NotAllowedError"
              ? "Permita o acesso ao microfone para testar."
              : "Não foi possível abrir o microfone.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      test.current?.pipeline.dispose();
      test.current?.raw.getTracks().forEach((t) => t.stop());
      test.current = null;
    };
    // Only input-related settings rebuild the test mic.
  }, [
    settings.inputDeviceId,
    settings.noiseSuppression,
    settings.echoCancellation,
    settings.autoSensitivity,
    settings.sensitivityDb,
    settings.inputMode,
  ]);

  // Meter.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setLevel(levelDb(test.current?.pipeline.inputAnalyser));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // "Ouvir meu microfone": play what would be sent, through the chosen output.
  useEffect(() => {
    if (!hearSelf) return;
    const el = new Audio();
    monitor.current = el;
    let stopped = false;
    const attach = () => {
      if (stopped) return;
      const stream = test.current?.pipeline.stream;
      if (stream && el.srcObject !== stream) {
        el.srcObject = stream;
        el.play().catch(() => {});
      }
    };
    const t = setInterval(attach, 300);
    attach();
    return () => {
      stopped = true;
      clearInterval(t);
      el.pause();
      el.srcObject = null;
      monitor.current = null;
    };
  }, [hearSelf]);

  useEffect(() => {
    if (monitor.current)
      applyOutputDevice(monitor.current, settings.outputDeviceId);
  }, [settings.outputDeviceId, hearSelf]);

  const open = level >= openDb;

  return (
    <Modal title="Configurações de voz" onClose={onClose}>
      <div className="voice-settings">
        <div className="device-row">
          <label>
            Microfone
            <select
              value={settings.inputDeviceId}
              onChange={(e) =>
                audioSettings.update({ inputDeviceId: e.target.value })
              }
            >
              <option value="">Padrão do sistema</option>
              {inputs.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microfone ${i + 1}`}
                </option>
              ))}
            </select>
          </label>
          <label>
            Saída (fone ou caixa)
            {canChooseOutput ? (
              <select
                value={settings.outputDeviceId}
                onChange={(e) =>
                  audioSettings.update({ outputDeviceId: e.target.value })
                }
              >
                <option value="">Padrão do sistema</option>
                {outputs.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Saída ${i + 1}`}
                  </option>
                ))}
              </select>
            ) : (
              <span className="muted small no-transform">
                Este navegador não permite escolher. Use o app desktop ou o
                Chrome.
              </span>
            )}
          </label>
        </div>

        {cameras.length > 0 && (
          <div className="device-row">
            <label>
              Câmera
              <select
                value={settings.videoDeviceId}
                onChange={(e) =>
                  audioSettings.update({ videoDeviceId: e.target.value })
                }
              >
                <option value="">Padrão do sistema</option>
                {cameras.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Câmera ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <div className="field-label">Supressão de ruído</div>
        <div
          className="segmented"
          role="radiogroup"
          aria-label="Supressão de ruído"
        >
          {SUPPRESSION.map((o) => (
            <button
              key={o.value}
              role="radio"
              aria-checked={settings.noiseSuppression === o.value}
              className={settings.noiseSuppression === o.value ? "active" : ""}
              onClick={() =>
                audioSettings.update({ noiseSuppression: o.value })
              }
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="muted small">
          {SUPPRESSION.find((o) => o.value === settings.noiseSuppression)?.hint}
        </p>

        <div className="field-label">Modo de entrada</div>
        <div
          className="segmented"
          role="radiogroup"
          aria-label="Modo de entrada"
        >
          {(
            [
              ["voice", "Detecção de voz"],
              ["ptt", "Aperte para falar"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              role="radio"
              aria-checked={settings.inputMode === value}
              className={settings.inputMode === value ? "active" : ""}
              onClick={() => audioSettings.update({ inputMode: value })}
            >
              {label}
            </button>
          ))}
        </div>
        {settings.inputMode === "ptt" && (
          <div className="ptt-settings">
            <div className="ptt-row">
              <span>Atalho</span>
              <PttRecorder
                binding={settings.pttBinding}
                onChange={(pttBinding) => audioSettings.update({ pttBinding })}
              />
            </div>
            <label className="ptt-row">
              <span>
                Atraso ao soltar{" "}
                <span className="muted">{settings.pttReleaseMs} ms</span>
              </span>
              <input
                type="range"
                className="sensitivity-slider"
                aria-label="Atraso ao soltar"
                min={PTT_RELEASE_RANGE.min}
                max={PTT_RELEASE_RANGE.max}
                step={20}
                value={settings.pttReleaseMs}
                onChange={(e) =>
                  audioSettings.update({ pttReleaseMs: Number(e.target.value) })
                }
              />
            </label>
            <p className="muted small">
              {desktop?.ptt
                ? "Funciona mesmo com o jogo em foco."
                : desktop
                  ? "Atualize o app desktop para o atalho funcionar com o jogo em foco; por enquanto, só com o Voxa em foco."
                  : "No navegador o atalho só funciona com o Voxa em foco. Use o app desktop para falar durante o jogo."}
            </p>
          </div>
        )}

        <div className="field-label">
          {settings.inputMode === "ptt"
            ? "Nível do microfone"
            : "Sensibilidade de entrada"}
        </div>
        {settings.inputMode === "voice" && (
          <label className="toggle-row compact">
            <span>Determinar automaticamente</span>
            <input
              type="checkbox"
              checked={settings.autoSensitivity}
              onChange={(e) =>
                audioSettings.update({ autoSensitivity: e.target.checked })
              }
            />
          </label>
        )}
        <div className="meter" aria-label="Nível do microfone">
          <div
            className={`meter-fill ${open ? "open" : ""}`}
            style={{ width: `${pct(level)}%` }}
          />
          {settings.inputMode === "voice" && (
            <div
              className="meter-threshold"
              style={{ left: `${pct(openDb)}%` }}
              title={`${openDb} dB`}
            />
          )}
        </div>
        {settings.inputMode === "ptt" ? null : !settings.autoSensitivity ? (
          <input
            type="range"
            className="sensitivity-slider"
            aria-label="Sensibilidade"
            min={SENSITIVITY_RANGE.min}
            max={SENSITIVITY_RANGE.max}
            step={1}
            value={settings.sensitivityDb}
            onChange={(e) =>
              audioSettings.update({ sensitivityDb: Number(e.target.value) })
            }
          />
        ) : null}
        <p className="muted small" hidden={settings.inputMode === "ptt"}>
          {open ? "🟢 Transmitindo" : "⚪ Em silêncio"} — fale e veja a barra:
          só o que passa da linha
          {settings.autoSensitivity
            ? ` (automática, ${AUTO_GATE.openDb} dB)`
            : ` (${settings.sensitivityDb} dB)`}{" "}
          chega aos outros.
        </p>

        <label className="toggle-row compact">
          <span>
            Ouvir meu microfone
            <span className="muted small block">
              Escute como os outros te ouvem (use fone para não dar microfonia).
            </span>
          </span>
          <input
            type="checkbox"
            checked={hearSelf}
            onChange={(e) => setHearSelf(e.target.checked)}
          />
        </label>
        <label className="toggle-row compact">
          <span>Cancelamento de eco</span>
          <input
            type="checkbox"
            checked={settings.echoCancellation}
            onChange={(e) =>
              audioSettings.update({ echoCancellation: e.target.checked })
            }
          />
        </label>

        {error && <div className="form-error">{error}</div>}
        <p className="muted small">
          Essas configurações valem para este computador e já se aplicam se você
          estiver numa chamada.
        </p>
        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Pronto
          </button>
        </div>
      </div>
    </Modal>
  );
}
