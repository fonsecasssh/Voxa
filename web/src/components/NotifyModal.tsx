// "Notificações" for a server, a channel or a DM: which messages notify you, and muting
// for a while (or until you turn it back on). Kept on the server, so it applies to push
// notifications and to every device.

import { useState } from "react";
import { api } from "../api.ts";
import { FOREVER, isMuted, type NotifyLevel, type NotifySettings } from "../notifications.ts";
import { Modal } from "./Modals.tsx";

const DURATIONS: { label: string; ms: number }[] = [
  { label: "15 minutos", ms: 15 * 60_000 },
  { label: "1 hora", ms: 3_600_000 },
  { label: "8 horas", ms: 8 * 3_600_000 },
  { label: "24 horas", ms: 24 * 3_600_000 },
  { label: "Até eu reativar", ms: FOREVER },
];

export interface NotifyTarget {
  id: string;
  kind: "server" | "channel" | "dm";
  /** Shown in the title: "Servidor X", "#geral", "@ana". */
  label: string;
}

export function NotifyModal({ target, settings, onClose }: { target: NotifyTarget; settings: NotifySettings; onClose: () => void }) {
  // Shown right away; the server confirms (and tells your other devices).
  const [current, setCurrent] = useState<NotifySettings[string] | undefined>(settings[target.id]);
  const [error, setError] = useState<string | null>(null);
  const muted = !!current && isMuted({ [target.id]: current }, target.id);
  const save = (level: NotifyLevel | null, mutedUntil: number | null) => {
    const before = current;
    setCurrent(level === null && mutedUntil === null ? undefined : { level, mutedUntil });
    api.setNotify(target.id, level, mutedUntil).catch((e) => {
      setCurrent(before);
      setError((e as Error).message);
    });
  };

  const levels: { value: NotifyLevel | null; label: string; hint: string }[] = [
    ...(target.kind === "channel" ? [{ value: null, label: "Padrão do servidor", hint: "Segue o que você escolheu para o servidor." }] : []),
    { value: "all", label: "Todas as mensagens", hint: "Avisa a cada mensagem nova." },
    { value: "mentions", label: "Só @menções", hint: "Avisa quando te mencionarem ou responderem." },
    { value: "none", label: "Nada", hint: "Nunca avisa (as mensagens continuam aqui)." },
  ];
  const defaultLevel: NotifyLevel = target.kind === "dm" ? "all" : "mentions";
  const level = current?.level ?? (target.kind === "channel" ? null : defaultLevel);

  return (
    <Modal title={`Notificações · ${target.label}`} onClose={onClose}>
      <div className="notify-settings">
        <div className="field-label">Silenciar</div>
        {muted ? (
          <p className="muted small">
            Silenciado {current!.mutedUntil! >= FOREVER ? "até você reativar" : `até ${new Date(current!.mutedUntil!).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`}.{" "}
            <button className="link" onClick={() => save(current?.level ?? null, null)}>
              Reativar agora
            </button>
          </p>
        ) : (
          <div className="chip-row" role="group" aria-label="Silenciar por">
            {DURATIONS.map((d) => (
              <button key={d.label} type="button" className="chip" onClick={() => save(current?.level ?? null, d.ms >= FOREVER ? FOREVER : Date.now() + d.ms)}>
                {d.label}
              </button>
            ))}
          </div>
        )}
        <p className="muted small">Silenciado, não aparece como não lido e não toca som nem notificação.</p>

        <div className="field-label">Avisar sobre</div>
        <div className="radio-list" role="radiogroup" aria-label="Avisar sobre">
          {levels.map((l) => (
            <label key={String(l.value)} className={`radio ${level === l.value ? "checked" : ""}`}>
              <input type="radio" name="level" checked={level === l.value} onChange={() => save(l.value, current?.mutedUntil ?? null)} />
              <span>
                {l.label}
                <span className="muted small block">{l.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Pronto
          </button>
        </div>
      </div>
    </Modal>
  );
}
