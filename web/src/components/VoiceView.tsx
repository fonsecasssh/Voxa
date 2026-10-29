import { useEffect, useRef, useState } from "react";
import type { Channel, ServerDetails } from "../api.ts";
import { memberName } from "../members.ts";
import { useVoice } from "../voice/useVoice.ts";
import { useAudioSettings } from "../voice/useAudioSettings.ts";
import { applyOutputDevice } from "../voice/audioSettings.ts";
import type { VoiceMember } from "../voice/types.ts";
import { Avatar } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";
import { MobileNavButton } from "./MobileNav.tsx";
import { useUserVolumeMenu, useUserVolumes } from "./UserVolumeMenu.tsx";
import { SoundboardPanel } from "./Soundboard.tsx";

interface Tile {
  key: string;
  kind: "user" | "screen";
  member: VoiceMember;
  stream?: MediaStream;
  isSelf: boolean;
  /** For someone else's screen share: whether we're watching it. */
  watching?: boolean;
}

/** A voice channel's page: who is there and "Entrar na voz", or the call itself. */
export function VoiceView({ channel, members, server }: { channel: Channel; members: VoiceMember[]; server?: ServerDetails }) {
  const [voice, vs] = useVoice();
  const inThisChannel = vs.status !== "idle" && vs.channelId === channel.id;
  return (
    <main className="main voice-view">
      <header className="chat-header">
        <MobileNavButton />
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
        <VoiceStage members={members} server={server} />
      )}
    </main>
  );
}

/** The call we are in: everyone's tiles (camera, screen shares) and the call controls. */
export function VoiceStage({ members, server, compact = false }: { members: VoiceMember[]; server?: ServerDetails; compact?: boolean }) {
  const [voice, vs] = useVoice();
  const [focused, setFocused] = useState<string | null>(null);
  const volumes = useUserVolumes();
  const menu = useUserVolumeMenu();
  const [board, setBoard] = useState(false);
  // The last soundboard sound shows over its player's tile for a moment.
  const [bubble, setBubble] = useState<NonNullable<typeof vs.lastSound> | null>(null);
  useEffect(() => {
    if (!vs.lastSound) return;
    setBubble(vs.lastSound);
    const t = setTimeout(() => setBubble(null), 2500);
    return () => clearTimeout(t);
  }, [vs.lastSound]);

  const tiles: Tile[] = [];
  for (const m of members) {
    const isSelf = m.socketId === vs.selfSocketId;
    if (m.screenStreamId) {
      const watching = isSelf || vs.watching.includes(m.socketId);
      const stream = isSelf ? (vs.localScreen ?? undefined) : watching ? vs.remoteStreams[m.socketId]?.[m.screenStreamId] : undefined;
      tiles.push({ key: `screen:${m.socketId}`, kind: "screen", member: m, stream, isSelf, watching });
    }
  }
  for (const m of members) {
    tiles.push({ key: `user:${m.socketId}`, kind: "user", member: m, isSelf: m.socketId === vs.selfSocketId });
  }

  const focusedTile = tiles.find((t) => t.key === focused);
  useEffect(() => {
    if (focused && !focusedTile) setFocused(null);
  }, [focused, focusedTile]);

  const watch = (t: Tile) => {
    voice?.watch(t.member.socketId);
    setFocused(t.key); // like Discord, a stream you start watching opens big
  };
  const stopWatching = (t: Tile) => {
    voice?.unwatch(t.member.socketId);
    if (focused === t.key) setFocused(null);
  };

  const renderTile = (t: Tile, big = false) => {
    const speaking = vs.speaking.includes(t.isSelf ? "self" : t.member.socketId);
    const name = memberName(server, t.member.user);
    const label = (
      <div className="tile-label">
        {t.kind === "screen" && <span className="live-badge">AO VIVO</span>}
        <span className="ellipsis">
          {name}
          {t.isSelf && " (você)"}
        </span>
        {t.kind === "user" && !t.isSelf && volumes[t.member.user.id]?.muted && (
          <span className="state-icon" title="Silenciado para você">
            <Icon name="speakerOff" size={15} />
          </span>
        )}
        {t.kind === "user" && (t.member.deafened || t.member.muted) && (
          <span className="state-icon" title={t.member.deafened ? "Áudio desativado" : "Microfone desativado"}>
            <Icon name={t.member.deafened ? "headphonesOff" : "micOff"} size={15} />
          </span>
        )}
      </div>
    );

    if (t.kind === "user") {
      const cam = t.member.cameraStreamId
        ? t.isSelf
          ? vs.localCamera
          : vs.remoteStreams[t.member.socketId]?.[t.member.cameraStreamId]
        : null;
      return (
        <div
          key={t.key}
          className={`tile user ${speaking ? "speaking" : ""} ${big ? "big" : ""} ${cam ? "camera" : ""}`}
          onClick={cam ? () => setFocused(focused === t.key ? null : t.key) : undefined}
          onContextMenu={t.isSelf ? undefined : (e) => menu.open(e, t.member.user.id, name)}
          title={t.isSelf ? undefined : "Clique com o botão direito para ajustar o volume"}
        >
          {cam ? (
            <CameraVideo stream={cam} mirrored={t.isSelf} />
          ) : (
            <Avatar name={name} id={t.member.user.id} size={big ? 96 : 64} src={t.member.user.avatar} />
          )}
          {label}
          {bubble?.socketId === t.member.socketId && (
            <span key={bubble.n} className="sound-bubble" title={bubble.name}>
              {bubble.emoji ?? "🔊"} <span className="ellipsis">{bubble.name}</span>
            </span>
          )}
        </div>
      );
    }

    // Someone else's stream we aren't watching: a card with "Assistir", like Discord.
    if (!t.watching) {
      return (
        <div key={t.key} className="tile screen preview">
          <div className="preview-inner">
            <Avatar name={name} id={t.member.user.id} size={48} src={t.member.user.avatar} />
            <span className="muted small">{name} está transmitindo</span>
            <button className="btn primary watch-btn" onClick={() => watch(t)}>
              Assistir transmissão
            </button>
          </div>
          {label}
        </div>
      );
    }

    const isFocused = focused === t.key;
    return (
      <div key={t.key} className={`tile screen ${big ? "big" : ""}`} onClick={() => setFocused(isFocused ? null : t.key)}>
        {t.stream ? <StreamVideo stream={t.stream} muted={t.isSelf || vs.deafened} /> : <span className="muted">Conectando à transmissão…</span>}
        {label}
        <div className="tile-controls" onClick={(e) => e.stopPropagation()}>
          <button className="tile-btn" title={isFocused ? "Reduzir" : "Ampliar"} onClick={() => setFocused(isFocused ? null : t.key)}>
            <Icon name={isFocused ? "shrink" : "expand"} size={16} />
          </button>
          <button
            className="tile-btn"
            title="Tela cheia"
            onClick={(e) => (e.currentTarget.closest(".tile") as HTMLElement | null)?.requestFullscreen?.().catch(() => {})}
          >
            <Icon name="fullscreen" size={16} />
          </button>
          {t.isSelf ? (
            <button className="tile-btn text danger" title="Parar de transmitir" onClick={() => voice?.stopScreenShare()}>
              Parar de transmitir
            </button>
          ) : (
            <button className="tile-btn text" title="Parar de assistir" onClick={() => stopWatching(t)}>
              Parar de assistir
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className={`voice-stage ${compact ? "compact" : ""}`}>
      {menu.menu}
      <div className={`stage ${focusedTile ? "has-focus" : ""}`}>
        {focusedTile && <div className="stage-focus">{renderTile(focusedTile, true)}</div>}
        <div className="tiles">{tiles.filter((t) => t.key !== focused).map((t) => renderTile(t))}</div>
      </div>

      <div className="voice-controls">
        <button
          className={`round-btn ${vs.muted || vs.deafened ? "off" : ""}`}
          title={vs.muted ? "Ativar microfone" : "Desativar microfone"}
          aria-pressed={vs.muted}
          onClick={() => voice?.setMuted(!vs.muted)}
        >
          <Icon name={vs.muted || vs.deafened ? "micOff" : "mic"} size={24} />
        </button>
        <button
          className={`round-btn ${vs.deafened ? "off" : ""}`}
          title={vs.deafened ? "Ativar áudio" : "Desativar áudio"}
          aria-pressed={vs.deafened}
          onClick={() => voice?.setDeafened(!vs.deafened)}
        >
          <Icon name={vs.deafened ? "headphonesOff" : "headphones"} size={24} />
        </button>
        <button
          className={`round-btn ${vs.localCamera ? "on" : ""}`}
          title={vs.localCamera ? "Desligar câmera" : "Ligar câmera"}
          aria-pressed={!!vs.localCamera}
          disabled={vs.status !== "connected"}
          onClick={() => (vs.localCamera ? voice?.stopCamera() : voice?.startCamera())}
        >
          <Icon name={vs.localCamera ? "video" : "videoOff"} size={24} />
        </button>
        <button
          className={`round-btn ${vs.localScreen ? "on" : ""}`}
          title={vs.localScreen ? "Parar de transmitir" : "Compartilhar tela"}
          disabled={vs.status !== "connected"}
          onClick={() => (vs.localScreen ? voice?.stopScreenShare() : voice?.startScreenShare())}
        >
          <Icon name={vs.localScreen ? "screenOff" : "screen"} size={24} />
        </button>
        <div className="soundboard-anchor">
          <button
            className={`round-btn soundboard-toggle ${board ? "on" : ""}`}
            title="Soundboard"
            aria-expanded={board}
            disabled={vs.status !== "connected"}
            onClick={() => setBoard((b) => !b)}
          >
            <Icon name="soundboard" size={24} />
          </button>
          {board && <SoundboardPanel serverId={server?.server.id ?? null} serverName={server?.server.name} onClose={() => setBoard(false)} />}
        </div>
        <button className="round-btn danger" title="Desconectar" onClick={() => voice?.leave()}>
          <Icon name="hangup" size={26} />
        </button>
      </div>
      {vs.error && <div className="stage-error">{vs.error}</div>}
    </div>
  );
}

/** A camera: video only (its sound is the microphone, played elsewhere); our own is mirrored, like a mirror. */
function CameraVideo({ stream, mirrored }: { stream: MediaStream; mirrored: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (v && v.srcObject !== stream) v.srcObject = stream;
  }, [stream]);
  return <video ref={ref} className={`camera-video ${mirrored ? "mirrored" : ""}`} autoPlay playsInline muted />;
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
