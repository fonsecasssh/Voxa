// Polls ("enquetes"): created from the message box, voted on in the message itself, with
// the results updating live for everyone until the time runs out (or the author ends it).

import { useEffect, useState, type FormEvent } from "react";
import { api, type Message } from "../api.ts";
import { Modal } from "./Modals.tsx";

const DURATIONS = [
  { hours: 1, label: "1 hora" },
  { hours: 4, label: "4 horas" },
  { hours: 8, label: "8 horas" },
  { hours: 24, label: "24 horas" },
  { hours: 72, label: "3 dias" },
  { hours: 168, label: "1 semana" },
];
const MAX_OPTIONS = 10;

/** Re-renders every so often while `live` (for the time left). */
function useNow(live: boolean, every = 30_000) {
  const [, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [live, every]);
}

function timeLeft(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} dias`;
}

export function PollView({ message, selfId, resolveName }: { message: Message; selfId: string; resolveName: (userId: string) => string }) {
  const poll = message.poll!;
  useNow(!poll.closed && poll.expiresAt > Date.now());
  const now = Date.now();
  const closed = poll.closed || poll.expiresAt <= now;
  const mine = poll.options.flatMap((o, i) => (o.userIds.includes(selfId) ? [i] : []));
  const voted = mine.length > 0;
  const [picked, setPicked] = useState<number[]>([]);
  const [peek, setPeek] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showResults = closed || voted || peek;
  const voters = new Set(poll.options.flatMap((o) => o.userIds)).size;
  const top = Math.max(...poll.options.map((o) => o.userIds.length));

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const vote = (options: number[]) =>
    run(async () => {
      await api.votePoll(message.channelId, message.id, options);
      setPicked([]);
      setPeek(false);
    });

  return (
    <div className={`poll ${closed ? "closed" : ""}`} role="group" aria-label={`Enquete: ${poll.question}`}>
      <div className="poll-question">{poll.question}</div>
      <div className="muted small poll-hint">
        {closed ? "Enquete encerrada" : showResults ? "Resultados" : poll.multi ? "Selecione uma ou mais respostas" : "Selecione uma resposta"}
      </div>
      <div className="poll-options">
        {poll.options.map((o, i) => {
          const count = o.userIds.length;
          const pct = voters ? Math.round((count / voters) * 100) : 0;
          const chosen = mine.includes(i);
          const winner = closed && count > 0 && count === top;
          if (showResults) {
            const names = o.userIds.map(resolveName);
            return (
              <div
                key={i}
                className={`poll-option result ${chosen ? "chosen" : ""} ${winner ? "winner" : ""}`}
                title={names.length ? names.slice(0, 10).join(", ") + (names.length > 10 ? ` e mais ${names.length - 10}` : "") : "Ninguém votou nessa"}
              >
                <span className="poll-bar" style={{ width: `${pct}%` }} />
                <span className="poll-text">
                  {o.text}
                  {chosen && <span className="poll-check" aria-label="Seu voto"> ✓</span>}
                </span>
                <span className="poll-count">
                  {count} {count === 1 ? "voto" : "votos"} · {pct}%
                </span>
              </div>
            );
          }
          const on = picked.includes(i);
          return (
            <button
              key={i}
              type="button"
              className={`poll-option ${on ? "picked" : ""}`}
              role={poll.multi ? "checkbox" : "radio"}
              aria-checked={on}
              disabled={busy}
              onClick={() => (poll.multi ? setPicked(on ? picked.filter((x) => x !== i) : [...picked, i]) : vote([i]))}
            >
              <span className={`poll-mark ${poll.multi ? "box" : ""}`} aria-hidden />
              <span className="poll-text">{o.text}</span>
            </button>
          );
        })}
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="poll-footer muted small">
        <span>
          {voters} {voters === 1 ? "voto" : "votos"} · {closed ? "Encerrada" : `${timeLeft(poll.expiresAt - now)} restantes`}
        </span>
        {!closed && !showResults && (
          <button type="button" className="link-btn" onClick={() => setPeek(true)}>
            Ver resultados
          </button>
        )}
        {!closed && peek && !voted && (
          <button type="button" className="link-btn" onClick={() => setPeek(false)}>
            Votar
          </button>
        )}
        {!closed && voted && (
          <button type="button" className="link-btn" disabled={busy} onClick={() => vote([])}>
            Remover voto
          </button>
        )}
        {!closed && message.author.id === selfId && (
          <button
            type="button"
            className="link-btn"
            disabled={busy}
            onClick={() => confirm("Encerrar a enquete agora? Ninguém mais vai poder votar.") && run(() => api.endPoll(message.channelId, message.id))}
          >
            Encerrar enquete
          </button>
        )}
        {!closed && !showResults && poll.multi && (
          <button type="button" className="btn primary small poll-vote" disabled={busy || picked.length === 0} onClick={() => vote(picked)}>
            Votar
          </button>
        )}
      </div>
    </div>
  );
}

export function PollModal({ where, onSubmit, onClose }: { where: string; onSubmit: (poll: { question: string; options: string[]; multi: boolean; hours: number }) => Promise<void>; onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [multi, setMulti] = useState(false);
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filled = options.map((o) => o.trim()).filter(Boolean);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ question: question.trim(), options: filled, multi, hours });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Criar enquete" onClose={onClose} className="poll-modal">
      <form onSubmit={submit}>
        <p className="muted small">Em {where}</p>
        <label>
          Pergunta
          <input value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={300} placeholder="Qual é a sua pergunta?" autoFocus />
        </label>
        <div className="poll-modal-options">
          <span className="field-label">Respostas</span>
          {options.map((o, i) => (
            <div key={i} className="poll-modal-option">
              <input
                value={o}
                maxLength={55}
                placeholder={`Resposta ${i + 1}`}
                aria-label={`Resposta ${i + 1}`}
                onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))}
              />
              {options.length > 2 && (
                <button type="button" className="icon-btn" title="Remover resposta" aria-label={`Remover resposta ${i + 1}`} onClick={() => setOptions(options.filter((_, j) => j !== i))}>
                  ✕
                </button>
              )}
            </div>
          ))}
          {options.length < MAX_OPTIONS && (
            <button type="button" className="btn subtle small" onClick={() => setOptions([...options, ""])}>
              + Adicionar resposta
            </button>
          )}
        </div>
        <label>
          Duração
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {DURATIONS.map((d) => (
              <option key={d.hours} value={d.hours}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="toggle-row compact">
          <span>
            Permitir várias respostas
            <span className="muted small block">Cada pessoa pode escolher mais de uma.</span>
          </span>
          <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn subtle" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy || !question.trim() || filled.length < 2}>
            Publicar
          </button>
        </div>
      </form>
    </Modal>
  );
}

