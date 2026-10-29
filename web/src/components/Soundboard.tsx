// The soundboard in a call: the built-in sounds and the server's own. A click plays it for
// everyone in the channel (yourself included), with a short wait between two.

import { useEffect, useRef, useState } from "react";
import { api, type Sound } from "../api.ts";
import { DEFAULT_SOUNDS, SOUNDBOARD_COOLDOWN_MS, playBoardSound } from "../soundboard.ts";
import { useVoice } from "../voice/useVoice.ts";

export function SoundboardPanel({ serverId, serverName, onClose }: { serverId: string | null; serverName?: string; onClose: () => void }) {
  const [voice, vs] = useVoice();
  const [sounds, setSounds] = useState<Sound[] | null>(serverId ? null : []);
  const [error, setError] = useState<string | null>(null);
  const [cooling, setCooling] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!serverId) return;
    api.sounds(serverId).then((r) => setSounds(r.sounds), () => setSounds([]));
  }, [serverId]);

  useEffect(() => {
    const outside = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!ref.current?.contains(t) && !t.closest(".soundboard-toggle")) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", outside);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  const play = async (id: string) => {
    setError(null);
    const err = (await voice?.playBoardSound(id)) ?? "Entre num canal de voz para usar o soundboard.";
    if (err) return setError(err);
    setCooling(true);
    setTimeout(() => setCooling(false), SOUNDBOARD_COOLDOWN_MS);
  };

  const button = (s: { id: string; name: string; emoji: string | null }, preview?: Sound) => (
    <div key={s.id} className="sound-btn-wrap">
      <button type="button" className="sound-btn" disabled={cooling || vs.deafened} onClick={() => play(s.id)} title={`Tocar ${s.name} para todos`}>
        <span className="sound-emoji" aria-hidden>
          {s.emoji ?? "🔊"}
        </span>
        <span className="ellipsis">{s.name}</span>
      </button>
      <button
        type="button"
        className="sound-preview"
        title="Ouvir só para você"
        aria-label={`Ouvir ${s.name} só para você`}
        onClick={() => playBoardSound(preview ?? { id: s.id, name: s.name, emoji: s.emoji, volume: 1, url: null })}
      >
        ▶
      </button>
    </div>
  );

  return (
    <div className="soundboard" ref={ref} role="dialog" aria-label="Soundboard">
      <div className="soundboard-title">Soundboard</div>
      {vs.deafened && <p className="muted small">Ative o áudio para usar o soundboard.</p>}
      {error && <div className="form-error">{error}</div>}
      <div className="soundboard-scroll">
        {serverId && (
          <>
            <div className="group-label">{serverName ?? "Servidor"}</div>
            {sounds === null ? (
              <p className="muted small">Carregando…</p>
            ) : sounds.length === 0 ? (
              <p className="muted small">Nenhum som próprio ainda. Quem pode gerenciar emojis e sons adiciona em Configurações do servidor → Sons.</p>
            ) : (
              <div className="sound-grid">{sounds.map((s) => button(s, s))}</div>
            )}
          </>
        )}
        <div className="group-label">Padrão do Voxa</div>
        <div className="sound-grid">{DEFAULT_SOUNDS.map((s) => button(s))}</div>
      </div>
    </div>
  );
}
