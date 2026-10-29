// The pinned messages of a channel, from the pin button in the header.

import { useEffect, useRef, useState } from "react";
import { api, type Message, type ServerDetails } from "../api.ts";
import { memberName } from "../members.ts";
import { Avatar } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";
import { formatTime } from "./MessageItem.tsx";

export function PinsButton({
  channelId,
  server,
  canPin,
  version,
  onJump,
}: {
  channelId: string;
  server?: ServerDetails;
  canPin: boolean;
  /** Changes when a message in the channel is pinned or unpinned (to refresh an open list). */
  version: string;
  onJump: (m: Message) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pins, setPins] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setOpen(false), [channelId]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    api.pins(channelId).then(
      (r) => live && setPins(r.messages),
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [open, channelId, version]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="pins" ref={ref}>
      <button className={`icon-btn ${open ? "active" : ""}`} title="Mensagens fixadas" aria-label="Mensagens fixadas" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="pin" size={20} />
      </button>
      {open && (
        <div className="pins-popover" role="dialog" aria-label="Mensagens fixadas">
          <header>
            <strong>Mensagens fixadas</strong>
          </header>
          {error && <div className="form-error">{error}</div>}
          {pins === null ? (
            <p className="muted small pad">Carregando…</p>
          ) : pins.length === 0 ? (
            <p className="muted small pad">Nenhuma mensagem fixada aqui ainda.{canPin ? " Passe o mouse numa mensagem e clique no alfinete." : ""}</p>
          ) : (
            <div className="pins-list">
              {pins.map((m) => (
                <div key={m.id} className="pin-item">
                  <div className="search-result-head">
                    <Avatar name={memberName(server, m.author)} id={m.author.id} size={24} src={m.author.avatar} />
                    <strong>{memberName(server, m.author)}</strong>
                    <span className="muted small">{formatTime(m.createdAt)}</span>
                  </div>
                  <p className="pin-text">{m.content || (m.poll ? `📊 ${m.poll.question}` : m.files.length ? `📎 ${m.files.map((f) => f.name).join(", ")}` : "🎬 Replay")}</p>
                  <div className="pin-actions">
                    <button
                      className="link"
                      onClick={() => {
                        setOpen(false);
                        onJump(m);
                      }}
                    >
                      Ir para a mensagem
                    </button>
                    {canPin && (
                      <button className="link danger" onClick={() => api.pin(channelId, m.id, false).catch((e) => setError((e as Error).message))}>
                        Desafixar
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
