// The voice engine: microphone, peer connections, screen sharing and playback.
//
// Calls in DMs work the same way on the DM's channel (serverId is then null).
//
// Topology is a full mesh — every participant has one RTCPeerConnection to each
// other participant — which is simple and has the lowest latency, and is fine
// for small groups (up to ~8 people). Larger rooms would need an SFU.
//
// Each connection uses the "perfect negotiation" pattern, so either side may
// (re)negotiate at any time — e.g. when someone starts sharing their screen —
// without the two offers colliding.
//
// This lives outside React: voice must keep running while the user browses
// text channels. Components read it through useVoice (useSyncExternalStore).

import { api } from "../api.ts";
import type { AppSocket } from "../socket.ts";
import { playBoardSound as playLocally } from "../soundboard.ts";
import { applyOutputDevice, audioSettings, type AudioSettings } from "./audioSettings.ts";
import { buildMicPipeline, getAudioContext, openMic, type MicPipeline } from "./audioPipeline.ts";
import { DEFAULT_USER_VOLUME, type UserVolume } from "./userVolumes.ts";
import type { SfuLink, SfuTrackKind } from "./sfu.ts";

type Signal = {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  /** A viewer asking us to start (true) or stop (false) sending them our screen share. */
  watch?: boolean;
};

interface Peer {
  socketId: string;
  /** The connection to them in the mesh; null through a media server (SFU). */
  pc: RTCPeerConnection | null;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** Remote streams by id: the mic stream, and the screen stream while they share. */
  streams: Map<string, MediaStream>;
  audio: HTMLAudioElement;
  analyser?: AnalyserNode;
  /** Above 100%, the mic plays through a gain node instead (a media element can't go past 1). */
  boost?: { el: HTMLAudioElement; gain: GainNode; source: MediaStreamAudioSourceNode };
}

export interface VoiceSnapshot {
  status: "idle" | "connecting" | "connected";
  channelId: string | null;
  /** null for a call in a DM. */
  serverId: string | null;
  /** Our socket id while connected, to find ourselves in the member list. */
  selfSocketId: string | null;
  muted: boolean;
  deafened: boolean;
  /** Push-to-talk mode: whether the key is held (or within its release delay). */
  pttActive: boolean;
  localScreen: MediaStream | null;
  localCamera: MediaStream | null;
  /** socketId -> remote streams (by stream id). */
  remoteStreams: Record<string, Record<string, MediaStream>>;
  /** socketIds currently speaking; "self" for the local user. */
  speaking: string[];
  /** socketIds whose screen share we are watching. */
  watching: string[];
  /** socketId -> connection state, for diagnostics. */
  connections: Record<string, RTCPeerConnectionState>;
  /** The last soundboard sound played in the call (for a moment on screen); `n` counts them. */
  lastSound: { socketId: string; userId: string; name: string; emoji: string | null; n: number } | null;
  error: string | null;
}

const SPEAKING_THRESHOLD = 0.02;
const SPEAKING_POLL_MS = 100;
/** Keep the indicator lit briefly after the level drops, so it doesn't flicker between words. */
const SPEAKING_HOLD_MS = 400;

const initial: VoiceSnapshot = {
  status: "idle",
  channelId: null,
  serverId: null,
  selfSocketId: null,
  muted: false,
  deafened: false,
  pttActive: false,
  localScreen: null,
  localCamera: null,
  remoteStreams: {},
  speaking: [],
  watching: [],
  connections: {},
  lastSound: null,
  error: null,
};

export class VoiceClient {
  private snapshot: VoiceSnapshot = initial;
  private listeners = new Set<() => void>();
  private peers = new Map<string, Peer>();
  /** Raw microphone, and the processed audio actually sent (noise suppression + gate). */
  private mic: MediaStream | null = null;
  private pipeline: MicPipeline | null = null;
  private screen: MediaStream | null = null;
  private camera: MediaStream | null = null;
  /** Each peer's camera stream id (from the member list), to tell it from a screen share. */
  private remoteCameras = new Map<string, string | null>();
  private iceServers: RTCIceServer[] | null = null;
  private speakingTimer: ReturnType<typeof setInterval> | null = null;
  private settings: AudioSettings = audioSettings.get();
  /** Peers watching our screen share: only they receive its tracks (like Discord, watching is opt-in). */
  private watchers = new Set<string>();
  /** The media server connection, when the Voxa server has one (else the mesh). */
  private sfu: SfuLink | null = null;
  /** Bumped on every mic (re)open, so a slow, outdated one is discarded. */
  private micVersion = 0;
  private pttRelease: ReturnType<typeof setTimeout> | null = null;
  /** Per-person volume, by socket id (the page maps its per-user choices onto who is in the call). */
  private volumes = new Map<string, UserVolume>();

  constructor(private socket: AppSocket) {
    socket.on("voice:signal", ({ from, data }) => this.onSignal(from, data as Signal));
    socket.on("voice:update", ({ channelId, members }) => {
      if (channelId !== this.snapshot.channelId || this.snapshot.status === "idle") return;
      const present = new Set(members.map((m) => m.socketId));
      this.remoteCameras = new Map(members.map((m) => [m.socketId, m.cameraStreamId ?? null]));
      for (const id of [...this.peers.keys()]) if (!present.has(id)) this.closePeer(id);
      // A stream that ended can't be watched anymore; starting a new one needs a new click.
      const live = new Set(members.filter((m) => m.screenStreamId).map((m) => m.socketId));
      const watching = this.snapshot.watching.filter((id) => live.has(id));
      if (watching.length !== this.snapshot.watching.length) this.set({ watching });
    });
    socket.on("soundboard:play", ({ channelId, socketId, userId, sound }) => {
      if (channelId !== this.snapshot.channelId || this.snapshot.status === "idle") return;
      if (!this.snapshot.deafened) playLocally(sound);
      this.set({ lastSound: { socketId, userId, name: sound.name, emoji: sound.emoji, n: (this.snapshot.lastSound?.n ?? 0) + 1 } });
    });
    socket.on("voice:replaced", () => this.cleanup("Você entrou na voz em outra aba ou dispositivo."));
    socket.on("voice:kicked", ({ reason }) => this.cleanup(reason));
    // A reconnect gets a new socket id, so the old session is gone server-side.
    socket.on("disconnect", () => {
      if (this.snapshot.status !== "idle") this.cleanup("Conexão perdida com o servidor.");
    });
    audioSettings.subscribe(() => this.onSettingsChange(audioSettings.get()));
  }

  // --- store plumbing ---------------------------------------------------------
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private set(patch: Partial<VoiceSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }

  private syncRemote() {
    const remoteStreams: VoiceSnapshot["remoteStreams"] = {};
    const connections: VoiceSnapshot["connections"] = {};
    for (const [id, p] of this.peers) {
      remoteStreams[id] = Object.fromEntries(p.streams);
      connections[id] = p.pc?.connectionState ?? "connected";
    }
    this.set({ remoteStreams, connections });
  }

  // --- joining and leaving ------------------------------------------------------
  async join(channelId: string, serverId: string | null) {
    if (this.snapshot.channelId === channelId && this.snapshot.status !== "idle") return;
    if (this.snapshot.status !== "idle") this.leave();
    this.set({ status: "connecting", channelId, serverId, error: null });

    try {
      // Created during the click that joins, so the browser lets it start.
      getAudioContext();
      this.iceServers ??= (await api.rtcConfig()).iceServers;
      await this.openMic();
    } catch (err) {
      this.cleanup(
        (err as Error).name === "NotAllowedError"
          ? "Permita o acesso ao microfone para entrar na voz."
          : "Não foi possível acessar o microfone.",
      );
      return;
    }
    if (this.snapshot.channelId !== channelId) return;
    this.startSpeakingDetection();

    const res = await this.socket.emitWithAck("voice:join", { channelId });
    // The user may have left (or switched channel) while we were waiting.
    if (this.snapshot.channelId !== channelId) return;
    if ("error" in res) return this.cleanup(res.error);

    if (res.sfu) {
      try {
        await this.connectSfu(res.sfu.url, res.sfu.token);
      } catch (err) {
        console.warn("media server", err);
        this.socket.emit("voice:leave");
        return this.cleanup("Não foi possível conectar ao servidor de voz.");
      }
      if (this.snapshot.channelId !== channelId) return;
    }
    this.set({ status: "connected", selfSocketId: this.socket.id ?? null });
    if (this.snapshot.muted || this.snapshot.deafened) this.emitState();
    if (!this.sfu) for (const p of res.peers) this.createPeer(p.socketId);
  }

  // --- media server (SFU) ------------------------------------------------------------
  private async connectSfu(url: string, token: string) {
    const { SfuLink } = await import("./sfu.ts");
    // Assigned after connecting; a disconnect while still connecting is reported by connect() itself.
    let link: SfuLink | null = null;
    link = await SfuLink.connect(url, token, {
      onTrack: (identity, kind, name, track) => this.onSfuTrack(identity, kind, name, track),
      onTrackEnded: (identity, kind, name, track) => {
        const p = this.peers.get(identity);
        if (!p || kind === "mic") return;
        const stream = p.streams.get(name);
        stream?.removeTrack(track);
        if (stream && stream.getTracks().length === 0) p.streams.delete(name);
        this.syncRemote();
      },
      onLeft: (identity) => this.closePeer(identity),
      onDisconnected: () => {
        if (link && this.sfu === link && this.snapshot.status !== "idle") {
          this.socket.emit("voice:leave");
          this.cleanup("A conexão com o servidor de voz caiu.");
        }
      },
    });
    if (this.snapshot.status === "idle") {
      link.disconnect();
      return;
    }
    this.sfu = link;
    if (this.pipeline) await link.publishMic(this.pipeline.track);
  }

  /** Someone's microphone, camera or screen arriving from the media server. */
  private onSfuTrack(identity: string, kind: SfuTrackKind, name: string, track: MediaStreamTrack) {
    let peer = this.peers.get(identity);
    if (!peer) {
      const audio = new Audio();
      audio.autoplay = true;
      applyOutputDevice(audio, this.settings.outputDeviceId);
      peer = { socketId: identity, pc: null, polite: false, makingOffer: false, ignoreOffer: false, streams: new Map(), audio };
      this.peers.set(identity, peer);
    }
    if (kind === "mic") {
      const stream = new MediaStream([track]);
      peer.audio.srcObject = stream;
      peer.audio.play().catch(() => {});
      peer.analyser = this.analyse(stream);
      this.dropBoost(peer);
      this.applyPeerAudio(peer);
    } else {
      // A camera or screen share, under the stream id the member list announces.
      const stream = peer.streams.get(name) ?? new MediaStream();
      stream.addTrack(track);
      peer.streams.set(name, stream);
    }
    this.syncRemote();
  }

  /** Plays a soundboard sound for everyone in the call; resolves with an error message, or null. */
  async playBoardSound(soundId: string): Promise<string | null> {
    if (this.snapshot.status === "idle") return "Entre num canal de voz para usar o soundboard.";
    const r = await this.socket.timeout(5000).emitWithAck("soundboard:play", { soundId }).catch(() => ({ error: "O servidor não respondeu." }));
    return "error" in r ? r.error : null;
  }

  leave() {
    if (this.snapshot.status === "idle") return;
    this.socket.emit("voice:leave");
    this.cleanup(null);
  }

  private cleanup(error: string | null) {
    this.sfu?.disconnect();
    this.sfu = null;
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.micVersion++;
    this.pipeline?.dispose();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.screen?.getTracks().forEach((t) => t.stop());
    this.camera?.getTracks().forEach((t) => t.stop());
    this.mic = this.screen = this.camera = null;
    this.remoteCameras.clear();
    this.pipeline = null;
    this.watchers.clear();
    if (this.speakingTimer) clearInterval(this.speakingTimer);
    this.speakingTimer = null;
    if (this.pttRelease) clearTimeout(this.pttRelease);
    this.pttRelease = null;
    this.set({ ...initial, muted: this.snapshot.muted, deafened: this.snapshot.deafened, error });
  }

  // --- local controls -------------------------------------------------------------
  setMuted(muted: boolean) {
    // Unmuting while deafened also undeafens, like Discord.
    const deafened = muted ? this.snapshot.deafened : false;
    this.set({ muted, deafened });
    this.applyLocalState();
  }

  setDeafened(deafened: boolean) {
    this.set({ deafened });
    this.applyLocalState();
  }

  /** Push-to-talk key down/up. Releasing keeps the mic open for the configured delay. */
  setPushToTalk(down: boolean) {
    if (this.pttRelease) clearTimeout(this.pttRelease);
    this.pttRelease = null;
    if (down) {
      if (!this.snapshot.pttActive) this.set({ pttActive: true });
    } else if (this.snapshot.pttActive) {
      this.pttRelease = setTimeout(() => {
        this.pttRelease = null;
        this.set({ pttActive: false });
        this.applyTransmit();
      }, this.settings.pttReleaseMs);
    }
    this.applyTransmit();
  }

  /** Whether our mic reaches the others right now. */
  private transmitting() {
    const { muted, deafened, pttActive } = this.snapshot;
    return !muted && !deafened && (this.settings.inputMode === "voice" || pttActive);
  }

  private applyTransmit() {
    if (this.pipeline) this.pipeline.track.enabled = this.transmitting();
  }

  /** How loud someone in the call is for us (0–2), or silenced for us only. */
  setPeerVolume(socketId: string, v: UserVolume) {
    const prev = this.volumes.get(socketId) ?? DEFAULT_USER_VOLUME;
    if (prev.volume === v.volume && prev.muted === v.muted) return;
    this.volumes.set(socketId, v);
    const peer = this.peers.get(socketId);
    if (peer) this.applyPeerAudio(peer);
  }

  private applyPeerAudio(peer: Peer) {
    const { volume, muted } = this.volumes.get(peer.socketId) ?? DEFAULT_USER_VOLUME;
    const silent = this.snapshot.deafened || muted;
    const stream = peer.audio.srcObject as MediaStream | null;
    if (volume > 1 && stream) {
      if (!peer.boost) {
        try {
          const ctx = getAudioContext();
          const source = ctx.createMediaStreamSource(stream);
          const gain = ctx.createGain();
          const dest = ctx.createMediaStreamDestination();
          source.connect(gain).connect(dest);
          const el = new Audio();
          el.autoplay = true;
          el.srcObject = dest.stream;
          applyOutputDevice(el, this.settings.outputDeviceId);
          el.play().catch(() => {});
          peer.boost = { el, gain, source };
        } catch {
          // No Web Audio: stay at 100%.
        }
      }
    } else if (peer.boost) {
      this.dropBoost(peer);
    }
    if (peer.boost) {
      peer.boost.gain.gain.value = volume;
      peer.boost.el.muted = silent;
      // The raw element must keep playing (muted) or Chrome delivers no audio to Web Audio.
      peer.audio.volume = 1;
      peer.audio.muted = true;
    } else {
      peer.audio.volume = Math.min(1, volume);
      peer.audio.muted = silent;
    }
  }

  private dropBoost(peer: Peer) {
    if (!peer.boost) return;
    peer.boost.source.disconnect();
    peer.boost.el.pause();
    peer.boost.el.srcObject = null;
    peer.boost = undefined;
  }

  private applyLocalState() {
    this.applyTransmit();
    for (const p of this.peers.values()) this.applyPeerAudio(p);
    this.emitState();
  }

  // --- microphone and devices ------------------------------------------------------

  /** Opens the mic with the current settings and swaps it into every call, without renegotiating. */
  private async openMic() {
    const version = ++this.micVersion;
    const raw = await openMic(this.settings);
    let pipeline: MicPipeline;
    try {
      pipeline = await buildMicPipeline(raw, this.settings);
    } catch (err) {
      raw.getTracks().forEach((t) => t.stop());
      throw err;
    }
    // Left, or a newer change superseded this one while it was opening.
    if (version !== this.micVersion || this.snapshot.status === "idle") {
      pipeline.dispose();
      raw.getTracks().forEach((t) => t.stop());
      return;
    }
    pipeline.track.enabled = this.transmitting();
    const old = this.pipeline;
    for (const p of this.peers.values()) {
      const sender = p.pc?.getSenders().find((x) => x.track && x.track === old?.track);
      if (sender) await sender.replaceTrack(pipeline.track).catch(() => {});
    }
    await this.sfu?.replaceMic(pipeline.track).catch(() => {});
    old?.dispose();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = raw;
    this.pipeline = pipeline;
  }

  private onSettingsChange(next: AudioSettings) {
    const prev = this.settings;
    this.settings = next;
    if (next.outputDeviceId !== prev.outputDeviceId) {
      for (const p of this.peers.values()) {
        applyOutputDevice(p.audio, next.outputDeviceId);
        if (p.boost) applyOutputDevice(p.boost.el, next.outputDeviceId);
      }
    }
    if (next.videoDeviceId !== prev.videoDeviceId && this.camera) {
      this.stopCamera();
      this.startCamera();
    }
    if (next.inputMode !== prev.inputMode) {
      if (this.pttRelease) clearTimeout(this.pttRelease);
      this.pttRelease = null;
      this.set({ pttActive: false });
      this.applyTransmit();
    }
    const inputChanged =
      next.inputDeviceId !== prev.inputDeviceId ||
      next.echoCancellation !== prev.echoCancellation ||
      next.noiseSuppression !== prev.noiseSuppression ||
      next.autoSensitivity !== prev.autoSensitivity ||
      next.sensitivityDb !== prev.sensitivityDb ||
      next.inputMode !== prev.inputMode;
    if (inputChanged && this.pipeline) {
      this.openMic().catch(() => this.set({ error: "Não foi possível usar o microfone escolhido." }));
    }
  }

  private emitState() {
    if (this.snapshot.status !== "connected") return;
    this.socket.emit("voice:state", {
      muted: this.snapshot.muted || this.snapshot.deafened,
      deafened: this.snapshot.deafened,
      screenStreamId: this.screen?.id ?? null,
      cameraStreamId: this.camera?.id ?? null,
    });
  }

  // --- camera -------------------------------------------------------------------------
  async startCamera() {
    if (this.snapshot.status !== "connected" || this.camera) return;
    let stream: MediaStream;
    const id = this.settings.videoDeviceId;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { ...(id ? { deviceId: { exact: id } } : {}), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
    } catch (err) {
      const denied = (err as Error).name === "NotAllowedError";
      this.set({ error: denied ? "Permita o acesso à câmera para ligá-la." : "Não foi possível abrir a câmera." });
      return;
    }
    // Left the call (or turned it on twice) while the camera was opening.
    if (this.snapshot.status !== "connected" || this.camera) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.camera = stream;
    stream.getVideoTracks()[0]?.addEventListener("ended", () => this.stopCamera());
    for (const p of this.peers.values()) this.addCameraTracks(p);
    this.sfu?.publishCamera(stream).catch(() => this.set({ error: "Não foi possível enviar a câmera." }));
    this.set({ localCamera: stream, error: null });
    this.emitState();
  }

  stopCamera() {
    if (!this.camera) return;
    const tracks = new Set(this.camera.getTracks());
    for (const { pc } of this.peers.values()) {
      for (const sender of pc?.getSenders() ?? []) if (sender.track && tracks.has(sender.track)) pc!.removeTrack(sender);
    }
    this.sfu?.unpublish(this.camera);
    this.camera.getTracks().forEach((t) => t.stop());
    this.camera = null;
    this.set({ localCamera: null });
    this.emitState();
  }

  /** Unlike a screen share, the camera goes to everyone in the call. */
  private addCameraTracks(p: Peer) {
    if (!this.camera || !p.pc) return;
    const sending = new Set(p.pc.getSenders().map((x) => x.track));
    for (const track of this.camera.getVideoTracks()) {
      if (sending.has(track)) continue;
      track.contentHint = "motion";
      const sender = p.pc.addTrack(track, this.camera);
      // Everyone sends to everyone (mesh): keep each copy light.
      const params = sender.getParameters();
      params.encodings = [{ ...(params.encodings?.[0] ?? {}), maxBitrate: this.peers.size > 3 ? 600_000 : 1_200_000 }];
      sender.setParameters(params).catch(() => {});
    }
  }

  async startScreenShare() {
    if (this.snapshot.status !== "connected" || this.screen) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: true,
      });
    } catch {
      return; // The user closed the picker.
    }
    this.screen = stream;
    stream.getVideoTracks()[0]?.addEventListener("ended", () => this.stopScreenShare());
    this.watchers.clear(); // a new stream starts with no viewers
    // Through a media server it's sent once; the server only forwards it to who watches.
    this.sfu?.publishScreen(stream).catch(() => this.set({ error: "Não foi possível transmitir a tela." }));
    this.set({ localScreen: stream });
    this.emitState();
  }

  stopScreenShare() {
    if (!this.screen) return;
    for (const p of this.peers.values()) this.removeScreenTracks(p);
    this.sfu?.unpublish(this.screen);
    this.screen.getTracks().forEach((t) => t.stop());
    this.screen = null;
    this.watchers.clear();
    this.set({ localScreen: null });
    this.emitState();
  }

  /** Starts watching someone's screen share: they begin sending it to us. */
  watch(socketId: string) {
    if (this.snapshot.status !== "connected" || this.snapshot.watching.includes(socketId)) return;
    this.set({ watching: [...this.snapshot.watching, socketId] });
    if (this.sfu) this.sfu.setWatching(socketId, true);
    else this.socket.emit("voice:signal", { to: socketId, data: { watch: true } });
  }

  /** Stops watching: they stop sending us the video, which saves bandwidth on both sides. */
  unwatch(socketId: string) {
    if (!this.snapshot.watching.includes(socketId)) return;
    this.set({ watching: this.snapshot.watching.filter((id) => id !== socketId) });
    if (this.sfu) this.sfu.setWatching(socketId, false);
    else this.socket.emit("voice:signal", { to: socketId, data: { watch: false } });
    const p = this.peers.get(socketId);
    if (p) {
      // Keep the microphone and camera; the screen stream goes away right now, not after renegotiation.
      const camera = this.remoteCameras.get(socketId);
      for (const id of [...p.streams.keys()]) if (p.streams.get(id) !== p.audio.srcObject && id !== camera) p.streams.delete(id);
      this.syncRemote();
    }
  }

  private removeScreenTracks(p: Peer) {
    if (!this.screen || !p.pc) return;
    const tracks = new Set(this.screen.getTracks());
    for (const sender of p.pc.getSenders()) if (sender.track && tracks.has(sender.track)) p.pc.removeTrack(sender);
  }

  private addScreenTracks(p: Peer) {
    if (!this.screen || !p.pc || !this.watchers.has(p.socketId)) return;
    const sending = new Set(p.pc.getSenders().map((x) => x.track));
    for (const track of this.screen.getTracks()) {
      if (sending.has(track)) continue;
      const sender = p.pc.addTrack(track, this.screen);
      if (track.kind === "video") {
        // Favor sharpness over smoothness: text on a shared screen must stay readable.
        track.contentHint = "detail";
        const params = sender.getParameters();
        params.encodings = [{ ...(params.encodings?.[0] ?? {}), maxBitrate: 2_500_000 }];
        sender.setParameters(params).catch(() => {});
      }
    }
  }

  // --- peer connections ------------------------------------------------------------
  private createPeer(socketId: string): Peer {
    const existing = this.peers.get(socketId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers ?? [] });
    const audio = new Audio();
    audio.autoplay = true;
    applyOutputDevice(audio, this.settings.outputDeviceId);

    const peer: Peer = {
      socketId,
      pc,
      // Deterministic roles: exactly one side of each pair yields on collision.
      polite: (this.socket.id ?? "") < socketId,
      makingOffer: false,
      ignoreOffer: false,
      streams: new Map(),
      audio,
    };
    this.peers.set(socketId, peer);
    this.applyPeerAudio(peer);

    const send = (data: Signal) => this.socket.emit("voice:signal", { to: socketId, data });

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        send({ description: pc.localDescription!.toJSON() });
      } catch (err) {
        console.warn("negotiation failed", err);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => candidate && send({ candidate: candidate.toJSON() });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") pc.restartIce();
      this.syncRemote();
    };
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] ?? new MediaStream([track]);
      peer.streams.set(stream.id, stream);
      stream.onremovetrack = () => {
        if (stream.getTracks().length === 0) {
          peer.streams.delete(stream.id);
          this.syncRemote();
        }
      };
      // The mic is always added before any screen track, so the first audio stream is the microphone.
      // It plays here, outside React, so voice keeps working while the user browses text channels.
      if (track.kind === "audio" && !peer.audio.srcObject) {
        peer.audio.srcObject = stream;
        peer.audio.play().catch(() => {});
        peer.analyser = this.analyse(stream);
        this.applyPeerAudio(peer);
      }
      this.syncRemote();
    };

    if (this.pipeline) pc.addTrack(this.pipeline.track, this.pipeline.stream);
    this.addCameraTracks(peer);
    this.addScreenTracks(peer);
    this.syncRemote();
    return peer;
  }

  private closePeer(socketId: string) {
    const p = this.peers.get(socketId);
    if (!p) return;
    this.watchers.delete(socketId);
    if (this.snapshot.watching.includes(socketId)) this.set({ watching: this.snapshot.watching.filter((id) => id !== socketId) });
    p.pc?.close();
    this.dropBoost(p);
    p.audio.srcObject = null;
    this.peers.delete(socketId);
    this.syncRemote();
  }

  private async onSignal(from: string, { description, candidate, watch }: Signal) {
    if (this.snapshot.status !== "connected" || this.sfu) return;
    const peer = this.createPeer(from);
    const pc = peer.pc!;
    try {
      if (typeof watch === "boolean") {
        if (watch) {
          this.watchers.add(from);
          this.addScreenTracks(peer);
        } else {
          this.watchers.delete(from);
          this.removeScreenTracks(peer);
        }
      } else if (description) {
        const collision = description.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(description);
        if (description.type === "offer") {
          await pc.setLocalDescription();
          this.socket.emit("voice:signal", { to: from, data: { description: pc.localDescription!.toJSON() } });
        }
      } else if (candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          if (!peer.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.warn("signaling error", err);
    }
  }

  // --- speaking indicators -----------------------------------------------------------
  private analyse(stream: MediaStream): AnalyserNode | undefined {
    try {
      const ctx = getAudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      return analyser;
    } catch {
      return undefined;
    }
  }

  private startSpeakingDetection() {
    const buf = new Float32Array(512);
    const level = (a?: AnalyserNode | null) => {
      if (!a) return 0;
      a.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      return Math.sqrt(sum / buf.length);
    };

    const lastLoud = new Map<string, number>();
    this.speakingTimer = setInterval(() => {
      const now = Date.now();
      // Our own indicator follows what is actually sent (after noise suppression, the gate and push-to-talk).
      const sending = this.transmitting();
      if (sending && level(this.pipeline?.outputAnalyser) > SPEAKING_THRESHOLD) lastLoud.set("self", now);
      if (!sending) lastLoud.delete("self");
      for (const [id, p] of this.peers) if (level(p.analyser) > SPEAKING_THRESHOLD) lastLoud.set(id, now);
      for (const id of lastLoud.keys()) if (id !== "self" && !this.peers.has(id)) lastLoud.delete(id);
      const speaking = [...lastLoud].filter(([, t]) => now - t < SPEAKING_HOLD_MS).map(([id]) => id).sort();
      const prev = this.snapshot.speaking;
      if (speaking.length !== prev.length || speaking.some((s, i) => s !== prev[i])) this.set({ speaking });
    }, SPEAKING_POLL_MS);
  }
}
