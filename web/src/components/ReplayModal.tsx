// "Replay instantâneo": turn the rolling recording on or off, pick how many seconds a clip
// keeps and the quality, and see the clips saved this session (watch, download, post in chat).

import { useState } from "react";
import { MAX_CLIP_BYTES } from "../api.ts";
import { desktop } from "../desktop.ts";
import { desktopReplay, replay, replaySupported, useReplay, type Clip } from "../replay/replay.ts";
import { REPLAY_DURATIONS, REPLAY_HOTKEYS, REPLAY_QUALITIES, replaySettings, type ReplayHotkey, type ReplayQuality } from "../replay/settings.ts";
import { useReplaySettings } from "../replay/useReplaySettings.ts";
import { useVoice } from "../voice/useVoice.ts";
import { Icon } from "./Icon.tsx";
import { Modal } from "./Modals.tsx";

/** Where a clip can be posted right now: the text channel or DM that's open. */
export interface ShareTarget {
  channelId: string;
  label: string;
}

export const formatDuration = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
export const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB` : `${Math.ceil(bytes / 1024)} KB`;

export function ReplayModal({ onClose, shareTarget }: { onClose: () => void; shareTarget: ShareTarget | null }) {
  const state = useReplay();
  const settings = useReplaySettings();
  const [, vs] = useVoice();
  const recording = state.status === "recording";
  const sharing = vs.localScreen;

  return (
    <Modal title="Replay instantâneo" onClose={onClose} className="replay-modal">
      <div className={`replay-status ${recording ? "on" : ""}`}>
        {recording ? (
          <>
            <span className="rec-dot" aria-hidden />
            <div className="replay-status-text">
              <strong>Gravando em segundo plano</strong>
              <span className="muted small">
                {state.bufferedSeconds} s guardados de {settings.duration} s{state.hasAudio ? " · com áudio" : " · sem áudio"}
              </span>
            </div>
            <button className="btn primary" disabled={state.saving || state.bufferedSeconds < 1} onClick={() => replay.save()}>
              {state.saving ? "Salvando…" : `Salvar clipe${settings.hotkey ? ` (${settings.hotkey})` : ""}`}
            </button>
            <button className="btn subtle" onClick={() => replay.stop()}>
              Desativar
            </button>
          </>
        ) : (
          <>
            <span className="replay-status-icon" aria-hidden>
              <Icon name="replay" size={26} />
            </span>
            <div className="replay-status-text">
              <strong>Nunca perca uma jogada</strong>
              <span className="muted small">
                O Voxa grava a tela continuamente e guarda só os últimos segundos. Quando rolar algo bom, salve e mande no chat.
              </span>
            </div>
            <div className="replay-start">
              {sharing && (
                <button className="btn subtle" disabled={state.status !== "off"} onClick={() => replay.start(sharing)}>
                  Usar minha transmissão
                </button>
              )}
              <button className="btn primary" disabled={state.status !== "off" || !replaySupported} onClick={() => replay.start()}>
                {state.status === "starting" ? "Escolha a tela…" : "Ativar replay"}
              </button>
            </div>
          </>
        )}
      </div>
      {state.error && <div className="form-error">{state.error}</div>}
      {!replaySupported && <p className="form-error">Este navegador não grava replays. Use o app para Windows ou o Chrome/Edge atualizado.</p>}

      <div className="voice-settings replay-settings">
        <div className="field-label">Duração do clipe</div>
        <div className="segmented" role="radiogroup" aria-label="Duração do clipe">
          {REPLAY_DURATIONS.map((d) => (
            <button
              key={d}
              role="radio"
              aria-checked={settings.duration === d}
              className={settings.duration === d ? "active" : ""}
              onClick={() => replaySettings.update({ duration: d })}
            >
              {d} s
            </button>
          ))}
        </div>

        <div className="device-row">
          <label>
            Qualidade
            <select value={settings.quality} onChange={(e) => replaySettings.update({ quality: e.target.value as ReplayQuality })}>
              {Object.entries(REPLAY_QUALITIES).map(([k, q]) => (
                <option key={k} value={k}>
                  {q.label}
                </option>
              ))}
            </select>
            <span className="muted small no-transform">
              Cerca de {formatSize((REPLAY_QUALITIES[settings.quality].bitrate / 8) * settings.duration)} por clipe
              {recording && " (vale ao reativar)"}
            </span>
          </label>
          <label>
            Atalho para salvar
            <select value={settings.hotkey ?? ""} onChange={(e) => replaySettings.update({ hotkey: (e.target.value || null) as ReplayHotkey | null })}>
              {REPLAY_HOTKEYS.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
              <option value="">Nenhum</option>
            </select>
            <span className={`small no-transform ${state.hotkeyOk === false ? "form-error" : "muted"}`}>
              {state.hotkeyOk === false
                ? "Outro programa já usa esse atalho (ex.: GeForce Experience). Escolha outro."
                : desktopReplay
                  ? "Funciona mesmo com o jogo em tela cheia."
                  : desktop
                    ? "Atualize o app para o atalho funcionar dentro do jogo."
                    : "Só com o Voxa em foco. No app para Windows, funciona dentro do jogo."}
            </span>
          </label>
        </div>

        {desktopReplay && (
          <label className="toggle-row compact">
            <span>Salvar cada clipe também em Vídeos\Voxa</span>
            <input type="checkbox" checked={settings.saveToDisk} onChange={(e) => replaySettings.update({ saveToDisk: e.target.checked })} />
          </label>
        )}
      </div>

      <div className="group-label">Clipes desta sessão — {state.clips.length}</div>
      {state.clips.length === 0 ? (
        <p className="muted small">Os clipes que você salvar aparecem aqui.</p>
      ) : (
        <div className="clip-list">
          {state.clips.map((c) => (
            <ClipCard key={c.id} clip={c} shareTarget={shareTarget} highlight={state.justSaved === c.id} />
          ))}
        </div>
      )}
    </Modal>
  );
}

function ClipCard({ clip, shareTarget, highlight }: { clip: Clip; shareTarget: ShareTarget | null; highlight: boolean }) {
  const [caption, setCaption] = useState("");
  const share = clip.share;
  const uploading = !!share && !share.done && !share.error;
  const tooBig = clip.blob.size > MAX_CLIP_BYTES;
  const sentHere = share?.done && share.channelId === shareTarget?.channelId;

  return (
    <div className={`clip-card ${highlight ? "new" : ""}`}>
      <video src={clip.url} controls preload="metadata" playsInline />
      <div className="clip-card-body">
        <div className="clip-card-meta">
          <strong>{formatDuration(clip.duration)}</strong>
          <span className="muted small">
            {clip.height}p · {formatSize(clip.blob.size)} · {new Date(clip.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>

        {shareTarget && !tooBig && !sentHere && (
          <form
            className="clip-share"
            onSubmit={(e) => {
              e.preventDefault();
              replay.share(clip.id, shareTarget.channelId, caption.trim());
            }}
          >
            <input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Legenda (opcional)" maxLength={2000} disabled={uploading} aria-label="Legenda do clipe" />
            <button className="btn primary" disabled={uploading}>
              {uploading ? `Enviando ${Math.round((share?.progress ?? 0) * 100)}%` : `Enviar em ${shareTarget.label}`}
            </button>
          </form>
        )}
        {uploading && (
          <div className="progress" aria-label="Progresso do envio">
            <span style={{ width: `${Math.round((share?.progress ?? 0) * 100)}%` }} />
          </div>
        )}
        {sentHere && <p className="form-ok small">Enviado em {shareTarget!.label}!</p>}
        {share?.error && <p className="form-error small">{share.error}</p>}
        {!shareTarget && <p className="muted small">Abra um canal de texto ou uma conversa para enviar o clipe.</p>}
        {tooBig && <p className="muted small">Grande demais para o chat (máx. 100 MB): use menos segundos ou qualidade menor.</p>}

        <div className="clip-card-actions">
          {clip.savedPath && desktopReplay ? (
            <button className="btn subtle" onClick={() => desktopReplay?.show(clip.savedPath!)}>
              Mostrar na pasta
            </button>
          ) : (
            <a className="btn subtle" href={clip.url} download={clip.name}>
              Baixar
            </a>
          )}
          <button className="btn subtle danger" disabled={uploading} onClick={() => replay.remove(clip.id)}>
            Descartar
          </button>
        </div>
      </div>
    </div>
  );
}
