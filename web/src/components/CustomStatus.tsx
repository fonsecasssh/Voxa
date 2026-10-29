// Custom status ("Status personalizado"): a short text and/or emoji shown under your name,
// optionally until a chosen time.

import { useState, type FormEvent } from "react";
import type { CustomStatus, Presence } from "../api.ts";
import { CUSTOM_EMOJI } from "../customEmojis.ts";
import { CustomEmojiImg } from "./Markdown.tsx";
import { EmojiPicker } from "./EmojiPicker.tsx";
import { Modal } from "./Modals.tsx";

/** The status, unless it has expired (the server also says so, but only when the time comes). */
export const activeCustom = (c: CustomStatus | null | undefined): CustomStatus | null =>
  c && (c.expiresAt === null || c.expiresAt > Date.now()) ? c : null;

export function StatusEmoji({ emoji, size = 16 }: { emoji: string; size?: number }) {
  const m = CUSTOM_EMOJI.exec(emoji);
  if (m) return <CustomEmojiImg id={m[3]} name={m[2]} size={size} />;
  return (
    <span className="status-emoji" style={{ fontSize: size * 0.9 }}>
      {emoji}
    </span>
  );
}

/** The custom status if there is one, otherwise what the person is playing (or nothing). */
export function PresenceLine({ presence, className = "muted small ellipsis" }: { presence: Presence | undefined; className?: string }) {
  const custom = activeCustom(presence?.custom);
  if (custom) {
    return (
      <span className={`custom-status ${className}`} title={custom.text ?? undefined}>
        {custom.emoji && <StatusEmoji emoji={custom.emoji} />}
        {custom.text && <span className="ellipsis">{custom.text}</span>}
      </span>
    );
  }
  if (presence?.activity) return <span className={className}>Jogando {presence.activity.name}</span>;
  return null;
}

const CLEAR_AFTER = [
  { value: "never", label: "Não limpar" },
  { value: "30m", label: "30 minutos" },
  { value: "1h", label: "1 hora" },
  { value: "4h", label: "4 horas" },
  { value: "today", label: "Hoje" },
] as const;
type ClearAfter = (typeof CLEAR_AFTER)[number]["value"];

function expiryOf(choice: ClearAfter): number | null {
  const now = Date.now();
  if (choice === "30m") return now + 30 * 60_000;
  if (choice === "1h") return now + 60 * 60_000;
  if (choice === "4h") return now + 4 * 60 * 60_000;
  if (choice === "today") {
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    return end.getTime();
  }
  return null;
}

export function CustomStatusModal({
  current,
  onSave,
  onClose,
}: {
  current: CustomStatus | null;
  onSave: (custom: CustomStatus | null) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState(current?.text ?? "");
  const [emoji, setEmoji] = useState<string | null>(current?.emoji ?? null);
  // An existing expiry is kept unless another choice is made.
  const [clearAfter, setClearAfter] = useState<ClearAfter | "keep">(current?.expiresAt ? "keep" : "never");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (custom: CustomStatus | null) => {
    setBusy(true);
    setError(null);
    try {
      await onSave(custom);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t && !emoji) return save(null);
    save({ text: t || null, emoji, expiresAt: clearAfter === "keep" ? (current?.expiresAt ?? null) : expiryOf(clearAfter) });
  };

  return (
    <Modal title="Definir status personalizado" onClose={onClose} className="custom-status-modal">
      <form onSubmit={submit}>
        <label>
          No que você está pensando?
          <div className="custom-status-input">
            <button
              type="button"
              className="custom-status-emoji-btn"
              title={emoji ? "Trocar emoji" : "Escolher emoji"}
              aria-label={emoji ? "Trocar emoji" : "Escolher emoji"}
              onClick={() => setPicking((p) => !p)}
            >
              {emoji ? <StatusEmoji emoji={emoji} size={20} /> : "🙂"}
            </button>
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={128} placeholder="Ex.: Estudando para a prova" aria-label="Texto do status" autoFocus />
            {(text || emoji) && (
              <button
                type="button"
                className="custom-status-clear"
                title="Apagar"
                onClick={() => {
                  setText("");
                  setEmoji(null);
                }}
              >
                ✕
              </button>
            )}
          </div>
        </label>
        {picking && (
          <EmojiPicker
            ignore=".custom-status-emoji-btn"
            onPick={(e) => {
              setEmoji(e);
              setPicking(false);
            }}
            onClose={() => setPicking(false)}
          />
        )}
        <label>
          Limpar após
          <select value={clearAfter} onChange={(e) => setClearAfter(e.target.value as ClearAfter)}>
            {clearAfter === "keep" && current?.expiresAt && (
              <option value="keep">Às {new Date(current.expiresAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</option>
            )}
            {CLEAR_AFTER.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          {current && (
            <button type="button" className="btn subtle danger" disabled={busy} onClick={() => save(null)}>
              Remover status
            </button>
          )}
          <button type="button" className="btn subtle" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy}>
            Salvar
          </button>
        </div>
      </form>
    </Modal>
  );
}
