// The voice engine: microphone, peer connections, screen sharing and playback.
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
import { applyOutputDevice, audioSettings, type AudioSettings } from "./audioSettings.ts";
import { buildMicPipeline, getAudioContext, openMic, type MicPipeline } from "./audioPipeline.ts";

type Signal = {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  /** A viewer asking us to start (true) or stop (false) sending them our screen share. */
  watch?: boolean;
};

interface Peer {
  socketId: string;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** Remote streams by id: the mic stream, and the screen stream while they share. */
  streams: Map<string, MediaStream>;
  audio: HTMLAudioElement;
  analyser?: AnalyserNode;
}

export interface VoiceSnapshot {
  status: "idle" | "connecting" | "connected";
  channelId: string | null;
  serverId: string | null;
  /** Our socket id while connected, to find ourselves in the member list. */
  selfSocketId: string | null;
  muted: boolean;
  deafened: boolean;
  localScreen: MediaStream | null;
  /** socketId -> remote streams (by stream id). */
  remoteStreams: Record<string, Record<string, MediaStream>>;
  /** socketIds currently speaking; "self" for the local user. */
  speaking: string[];
  /** socketIds whose screen share we are watching. */
  watching: string[];
  /** socketId -> connection state, for diagnostics. */
  connections: Record<string, RTCPeerConnectionState>;
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
  localScreen: null,
  remoteStreams: {},
  speaking: [],
  watching: [],
  connections: {},
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
  private iceServers: RTCIceServer[] | null = null;
  private speakingTimer: ReturnType<typeof setInterval> | null = null;
  private settings: AudioSettings = audioSettings.get();
  /** Peers watching our screen share: only they receive its tracks (like Discord, watching is opt-in). */
  private watchers = new Set<string>();
  /** Bumped on every mic (re)open, so a slow, outdated one is discarded. */
  private micVersion = 0;

  constructor(private socket: AppSocket) {
    socket.on("voice:signal", ({ from, data }) => this.onSignal(from, data as Signal));
    socket.on("voice:update", ({ channelId, members }) => {
      if (channelId !== this.snapshot.channelId || this.snapshot.status === "idle") return;
      const present = new Set(members.map((m) => m.socketId));
      for (const id of [...this.peers.keys()]) if (!present.has(id)) this.closePeer(id);
      // A stream that ended can't be watched anymore; starting a new one needs a new click.
      const live = new Set(members.filter((m) => m.screenStreamId).map((m) => m.socketId));
      const watching = this.snapshot.watching.filter((id) => live.has(id));
      if (watching.length !== this.snapshot.watching.length) this.set({ watching });
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
      connections[id] = p.pc.connectionState;
    }
    this.set({ remoteStreams, connections });
  }

  // --- joining and leaving ------------------------------------------------------
  async join(channelId: string, serverId: string) {
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

    this.set({ status: "connected", selfSocketId: this.socket.id ?? null });
    if (this.snapshot.muted || this.snapshot.deafened) this.emitState();
    for (const p of res.peers) this.createPeer(p.socketId);
  }

  leave() {
    if (this.snapshot.status === "idle") return;
    this.socket.emit("voice:leave");
    this.cleanup(null);
  }

  private cleanup(error: string | null) {
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.micVersion++;
    this.pipeline?.dispose();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.screen?.getTracks().forEach((t) => t.stop());
    this.mic = this.screen = null;
    this.pipeline = null;
    this.watchers.clear();
    if (this.speakingTimer) clearInterval(this.speakingTimer);
    this.speakingTimer = null;
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

  private applyLocalState() {
    const { muted, deafened } = this.snapshot;
    if (this.pipeline) this.pipeline.track.enabled = !muted && !deafened;
    for (const p of this.peers.values()) p.audio.muted = deafened;
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
    const { muted, deafened } = this.snapshot;
    pipeline.track.enabled = !muted && !deafened;
    const old = this.pipeline;
    for (const p of this.peers.values()) {
      const sender = p.pc.getSenders().find((x) => x.track && x.track === old?.track);
      if (sender) await sender.replaceTrack(pipeline.track).catch(() => {});
    }
    old?.dispose();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = raw;
    this.pipeline = pipeline;
  }

  private onSettingsChange(next: AudioSettings) {
    const prev = this.settings;
    this.settings = next;
    if (next.outputDeviceId !== prev.outputDeviceId) {
      for (const p of this.peers.values()) applyOutputDevice(p.audio, next.outputDeviceId);
    }
    const inputChanged =
      next.inputDeviceId !== prev.inputDeviceId ||
      next.echoCancellation !== prev.echoCancellation ||
      next.noiseSuppression !== prev.noiseSuppression ||
      next.autoSensitivity !== prev.autoSensitivity ||
      next.sensitivityDb !== prev.sensitivityDb;
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
    });
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
    this.set({ localScreen: stream });
    this.emitState();
  }

  stopScreenShare() {
    if (!this.screen) return;
    for (const p of this.peers.values()) this.removeScreenTracks(p);
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
    this.socket.emit("voice:signal", { to: socketId, data: { watch: true } });
  }

  /** Stops watching: they stop sending us the video, which saves bandwidth on both sides. */
  unwatch(socketId: string) {
    if (!this.snapshot.watching.includes(socketId)) return;
    this.set({ watching: this.snapshot.watching.filter((id) => id !== socketId) });
    this.socket.emit("voice:signal", { to: socketId, data: { watch: false } });
    const p = this.peers.get(socketId);
    if (p) {
      // Keep only the microphone stream; the screen stream goes away right now, not after renegotiation.
      for (const id of [...p.streams.keys()]) if (p.streams.get(id) !== p.audio.srcObject) p.streams.delete(id);
      this.syncRemote();
    }
  }

  private removeScreenTracks(p: Peer) {
    if (!this.screen) return;
    const tracks = new Set(this.screen.getTracks());
    for (const sender of p.pc.getSenders()) if (sender.track && tracks.has(sender.track)) p.pc.removeTrack(sender);
  }

  private addScreenTracks(p: Peer) {
    if (!this.screen || !this.watchers.has(p.socketId)) return;
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
    audio.muted = this.snapshot.deafened;
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
      }
      this.syncRemote();
    };

    if (this.pipeline) pc.addTrack(this.pipeline.track, this.pipeline.stream);
    this.addScreenTracks(peer);
    this.syncRemote();
    return peer;
  }

  private closePeer(socketId: string) {
    const p = this.peers.get(socketId);
    if (!p) return;
    this.watchers.delete(socketId);
    if (this.snapshot.watching.includes(socketId)) this.set({ watching: this.snapshot.watching.filter((id) => id !== socketId) });
    p.pc.close();
    p.audio.srcObject = null;
    this.peers.delete(socketId);
    this.syncRemote();
  }

  private async onSignal(from: string, { description, candidate, watch }: Signal) {
    if (this.snapshot.status !== "connected") return;
    const peer = this.createPeer(from);
    const { pc } = peer;
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
      const { muted, deafened } = this.snapshot;
      // Our own indicator follows what is actually sent (after noise suppression and the gate).
      if (!muted && !deafened && level(this.pipeline?.outputAnalyser) > SPEAKING_THRESHOLD) lastLoud.set("self", now);
      if (muted || deafened) lastLoud.delete("self");
      for (const [id, p] of this.peers) if (level(p.analyser) > SPEAKING_THRESHOLD) lastLoud.set(id, now);
      for (const id of lastLoud.keys()) if (id !== "self" && !this.peers.has(id)) lastLoud.delete(id);
      const speaking = [...lastLoud].filter(([, t]) => now - t < SPEAKING_HOLD_MS).map(([id]) => id).sort();
      const prev = this.snapshot.speaking;
      if (speaking.length !== prev.length || speaking.some((s, i) => s !== prev[i])) this.set({ speaking });
    }, SPEAKING_POLL_MS);
  }
}
