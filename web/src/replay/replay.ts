// Instant replay: turn it on once and it keeps the last 30–120 s of your screen; press the
// shortcut (or "Salvar") after a good play and that moment becomes a clip you can download
// or post in chat. One controller for the whole app, read from React with useReplay().

import { useSyncExternalStore } from "react";
import { MAX_CLIP_BYTES, api } from "../api.ts";
import { desktop, notify } from "../desktop.ts";
import { ReplayRecorder, canRecordReplay } from "./recorder.ts";
import { REPLAY_QUALITIES, matchesHotkey, replaySettings } from "./settings.ts";
import { playSound } from "../sounds.ts";

export interface ClipShare {
  channelId: string;
  progress: number;
  error: string | null;
  done: boolean;
}

export interface Clip {
  id: string;
  name: string;
  blob: Blob;
  url: string;
  duration: number;
  width: number;
  height: number;
  createdAt: number;
  /** Where the desktop app saved it, if it did. */
  savedPath: string | null;
  share: ClipShare | null;
}

export interface ReplayState {
  status: "off" | "starting" | "recording";
  error: string | null;
  bufferedSeconds: number;
  hasAudio: boolean;
  saving: boolean;
  /** Most recent first; only the last few are kept in memory. */
  clips: Clip[];
  /** Whether the desktop global shortcut could be registered (null when not applicable). */
  hotkeyOk: boolean | null;
  /** The clip saved a moment ago, for the "Clipe salvo" confirmation. */
  justSaved: string | null;
}

const MAX_CLIPS = 5;

export const replaySupported = canRecordReplay();
export const desktopReplay = desktop?.replay ?? null;

/** "Voxa 2026-10-28 21-14-03.mp4" (the desktop app only accepts this pattern). */
function clipName(at: Date, ext: string) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `Voxa ${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}.${ext}`;
}

class ReplayController {
  private state: ReplayState = {
    status: "off",
    error: null,
    bufferedSeconds: 0,
    hasAudio: false,
    saving: false,
    clips: [],
    hotkeyOk: null,
    justSaved: null,
  };
  private listeners = new Set<() => void>();
  private recorder: ReplayRecorder | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private justSavedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    desktopReplay?.onHotkey(() => this.save());
    // In the browser the shortcut only works while Voxa has focus (the desktop app's is global).
    if (!desktopReplay) {
      window.addEventListener("keydown", (e) => {
        const { hotkey } = replaySettings.get();
        if (hotkey && this.state.status === "recording" && matchesHotkey(e, hotkey)) {
          e.preventDefault();
          this.save();
        }
      });
    }
    let last = replaySettings.get();
    replaySettings.subscribe(() => {
      const s = replaySettings.get();
      if (this.recorder) this.recorder.maxSeconds = s.duration;
      if (s.hotkey !== last.hotkey && this.state.status === "recording") this.registerHotkey();
      last = s;
    });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getState = () => this.state;

  private set(patch: Partial<ReplayState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  private updateClip(id: string, patch: Partial<Clip>) {
    this.set({ clips: this.state.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  }

  private async registerHotkey() {
    if (!desktopReplay) return;
    const { hotkey } = replaySettings.get();
    const ok = await desktopReplay.setHotkey(hotkey).catch(() => false);
    this.set({ hotkeyOk: hotkey ? ok : null });
  }

  /**
   * Starts recording. With `share`, records the screen already being streamed to the call
   * (no second picker); otherwise asks which screen or window to record.
   */
  async start(share?: MediaStream | null) {
    if (this.state.status !== "off") return;
    if (!replaySupported) {
      this.set({ error: "O replay instantâneo precisa do app para Windows ou do Chrome/Edge atualizado." });
      return;
    }
    this.set({ status: "starting", error: null });
    const { quality, duration } = replaySettings.get();
    const q = REPLAY_QUALITIES[quality];
    let stream: MediaStream;
    try {
      stream = share
        ? new MediaStream(share.getTracks().map((t) => t.clone()))
        : await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: q.fps, height: { max: q.height } },
            audio: true,
            // Chrome: offer system audio and keep Voxa's own tab out of the list.
            ...({ systemAudio: "include", selfBrowserSurface: "exclude" } as object),
          });
    } catch (err) {
      const cancelled = (err as DOMException).name === "NotAllowedError" || (err as DOMException).name === "AbortError";
      this.set({ status: "off", error: cancelled ? null : `Não foi possível capturar a tela (${(err as Error).message}).` });
      return;
    }

    try {
      const rec = await ReplayRecorder.start(stream, { maxSeconds: duration, height: q.height, fps: q.fps, bitrate: q.bitrate });
      rec.onStop = (error) => this.stopped(error ?? "A captura foi encerrada, então o replay parou.");
      this.recorder = rec;
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      this.set({ status: "off", error: (err as Error).message });
      return;
    }
    this.set({ status: "recording", bufferedSeconds: 0, hasAudio: false });
    this.ticker = setInterval(() => {
      const r = this.recorder;
      if (r) this.set({ bufferedSeconds: Math.floor(r.bufferedSeconds), hasAudio: r.hasAudio });
    }, 1000);
    this.registerHotkey();
  }

  stop() {
    this.recorder?.stop();
    this.stopped(null);
  }

  private stopped(error: string | null) {
    this.recorder = null;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    desktopReplay?.setHotkey(null).catch(() => {});
    this.set({ status: "off", error, bufferedSeconds: 0, hotkeyOk: null });
  }

  /** Saves the last N seconds (from the settings) as a clip. */
  async save(): Promise<Clip | null> {
    const rec = this.recorder;
    if (!rec || this.state.saving) return null;
    const snap = rec.snapshot(replaySettings.get().duration);
    if (!snap) return null;
    this.set({ saving: true, error: null });
    try {
      const { muxClip } = await import("./mux.ts");
      const { blob, duration } = await muxClip(snap);
      const at = new Date();
      const name = clipName(at, snap.container);
      const clip: Clip = {
        id: crypto.randomUUID(),
        name,
        blob,
        url: URL.createObjectURL(blob),
        duration,
        width: snap.width,
        height: snap.height,
        createdAt: at.getTime(),
        savedPath: null,
        share: null,
      };
      const dropped = this.state.clips.slice(MAX_CLIPS - 1);
      dropped.forEach((c) => URL.revokeObjectURL(c.url));
      this.set({ clips: [clip, ...this.state.clips.slice(0, MAX_CLIPS - 1)], saving: false, justSaved: clip.id });
      if (this.justSavedTimer) clearTimeout(this.justSavedTimer);
      this.justSavedTimer = setTimeout(() => this.set({ justSaved: null }), 4000);
      playSound("replay"); // so you know it saved without leaving the game

      if (desktopReplay && replaySettings.get().saveToDisk) {
        const path = await desktopReplay.save(name, new Uint8Array(await blob.arrayBuffer())).catch(() => null);
        if (path) this.updateClip(clip.id, { savedPath: path });
      }
      if (document.visibilityState !== "visible" || !document.hasFocus()) {
        notify("Replay salvo", `${Math.round(duration)} s salvos. Abra o Voxa para enviar no chat.`, "voxa-replay", () => {});
      }
      return clip;
    } catch (err) {
      this.set({ saving: false, error: `Não foi possível salvar o clipe (${(err as Error).message}).` });
      return null;
    }
  }

  remove(id: string) {
    const clip = this.state.clips.find((c) => c.id === id);
    if (clip) URL.revokeObjectURL(clip.url);
    this.set({ clips: this.state.clips.filter((c) => c.id !== id) });
  }

  /** Posts a clip as a message in a channel or DM. */
  async share(id: string, channelId: string, content: string) {
    const clip = this.state.clips.find((c) => c.id === id);
    if (!clip || (clip.share && !clip.share.done && !clip.share.error)) return;
    if (clip.blob.size > MAX_CLIP_BYTES) {
      this.updateClip(id, { share: { channelId, progress: 0, error: "Grande demais para o chat (máx. 100 MB).", done: false } });
      return;
    }
    const share: ClipShare = { channelId, progress: 0, error: null, done: false };
    this.updateClip(id, { share });
    try {
      await api.uploadClip(channelId, { blob: clip.blob, duration: clip.duration, width: clip.width, height: clip.height, content }, (progress) =>
        this.updateClip(id, { share: { ...share, progress } }),
      );
      this.updateClip(id, { share: { ...share, progress: 1, done: true } });
    } catch (err) {
      this.updateClip(id, { share: { ...share, error: (err as Error).message } });
    }
  }
}

export const replay = new ReplayController();

export function useReplay(): ReplayState {
  return useSyncExternalStore(replay.subscribe, replay.getState);
}
