import { useEffect, useRef, useState } from "react";
import type { Channel, ServerDetails } from "../api.ts";
import { memberName } from "../members.ts";
import { useVoice } from "../voice/useVoice.ts";
import { useAudioSettings } from "../voice/useAudioSettings.ts";
import { applyOutputDevice } from "../voice/audioSettings.ts";
import type { VoiceMember } from "../voice/types.ts";
import { Avatar } from "./Avatar.tsx";

interface Tile {
  key: string;
  kind: "user" | "screen";
  member: VoiceMember;
  stream?: MediaStream;
  isSelf: boolean;
}

export function VoiceView({ channel, members, server }: { channel: Channel; members: VoiceMember[]; server?: ServerDetails }) {
  const [voice, vs] = useVoice();
  const [focused, setFocused] = useState<string | null>(null);
  const inThisChannel = vs.status !== "idle" && vs.channelId === channel.id;

  const tiles: Tile[] = [];
  for (const m of members) {
    const isSelf = m.socketId === vs.selfSocketId;
    if (m.screenStreamId && inThisChannel) {
      const stream = isSelf ? (vs.localScreen ?? undefined) : vs.remoteStreams[m.socketId]?.[m.screenStreamId];
      tiles.push({ key: `screen:${m.socketId}`, kind: "screen", member: m, stream, isSelf });
    }
  }
  for (const m of members) {
    tiles.push({ key: `user:${m.socketId}`, kind: "user", member: m, isSelf: m.socketId === vs.selfSocketId });
  }

  const focusedTile = tiles.find((t) => t.key === focused);
  useEffect(() => {
    if (focused && !focusedTile) setFocused(null);
  }, [focused, focusedTile]);

  const renderTile = (t: Tile, big = false) => {
    const speaking = vs.speaking.includes(t.isSelf ? "self" : t.member.socketId);
    return (
      <div
        key={t.key}
        className={`tile ${t.kind} ${speaking && t.kind === "user" ? "speaking" : ""} ${big ? "big" : ""}`}
        onClick={() => t.kind === "screen" && setFocused(focused === t.key ? null : t.key)}
        title={t.kind === "screen" ? (focused === t.key ? "Clique para reduzir" : "Clique para ampliar") : undefined}
      >
        {t.kind === "screen" ? (
          t.stream ? (
            <StreamVideo stream={t.stream} muted={t.isSelf || vs.deafened} />
          ) : (
            <span className="muted">Conectando à transmissão…</span>
          )
        ) : (
          <Avatar name={memberName(server, t.member.user)} id={t.member.user.id} size={big ? 96 : 72} />
        )}
        <div className="tile-label">
          {t.kind === "screen" && <span className="live-badge">AO VIVO</span>}
          <span className="ellipsis">
            {memberName(server, t.member.user)}
            {t.isSelf && " (você)"}
          </span>
          {t.kind === "user" && (t.member.deafened ? "🔕" : t.member.muted ? "🔇" : "")}
        </div>
      </div>
    );
  };

  return (
    <main className="main voice-view">
      <header className="chat-header">
        <span className="channel-icon">🔊</span>
        <strong>{channel.name}</strong>
      </header>

      {!inThisChannel ? (
        <div className="voice-lobby">
          <h2>🔊 {channel.name}</h2>
          <p className="muted">
            {members.length === 0
              ? "Ninguém na voz agora."
              : `${members.map((m) => memberName(server, m.user)).join(", ")} ${members.length === 1 ? "está" : "estão"} aqui.`}
          </p>
          <button className="btn primary" onClick={() => channel.serverId && voice?.join(channel.id, channel.serverId)}>
            Entrar na voz
          </button>
        </div>
      ) : (
        <>
          <div className={`stage ${focusedTile ? "has-focus" : ""}`}>
            {focusedTile && <div className="stage-focus">{renderTile(focusedTile, true)}</div>}
            <div className="tiles">{tiles.filter((t) => t.key !== focused).map((t) => renderTile(t))}</div>
          </div>

          <div className="voice-controls">
            <button
              className={`round-btn ${vs.muted || vs.deafened ? "off" : ""}`}
              title={vs.muted ? "Ativar microfone" : "Desativar microfone"}
              onClick={() => voice?.setMuted(!vs.muted)}
            >
              {vs.muted || vs.deafened ? "🔇" : "🎙"}
            </button>
            <button
              className={`round-btn ${vs.deafened ? "off" : ""}`}
              title={vs.deafened ? "Ativar áudio" : "Desativar áudio"}
              onClick={() => voice?.setDeafened(!vs.deafened)}
            >
              {vs.deafened ? "🔕" : "🎧"}
            </button>
            <button
              className={`round-btn ${vs.localScreen ? "on" : ""}`}
              title={vs.localScreen ? "Parar de transmitir" : "Compartilhar tela"}
              disabled={vs.status !== "connected"}
              onClick={() => (vs.localScreen ? voice?.stopScreenShare() : voice?.startScreenShare())}
            >
              🖥
            </button>
            <button className="round-btn danger" title="Desconectar" onClick={() => voice?.leave()}>
              ✆
            </button>
          </div>
        </>
      )}
    </main>
  );
}

function StreamVideo({ stream, muted }: { stream: MediaStream; muted: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const { outputDeviceId } = useAudioSettings();
  useEffect(() => {
    const v = ref.current;
    if (v && v.srcObject !== stream) v.srcObject = stream;
  }, [stream]);
  // Screen-share audio goes to the same headphones as voices.
  useEffect(() => {
    if (ref.current) applyOutputDevice(ref.current, outputDeviceId);
  }, [outputDeviceId]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      onDoubleClick={(e) => {
        e.stopPropagation();
        e.currentTarget.requestFullscreen?.().catch(() => {});
      }}
    />
  );
}
