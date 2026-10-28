// Voxa's own interface sounds, synthesized on the fly (no audio files): short, soft,
// glassy tones that rise for "in/on" and fall for "out/off". They play on the output
// device chosen in the voice settings and follow the volume in "Aparência e sons".

import { appSettings } from "./appSettings.ts";
import { audioSettings } from "./voice/audioSettings.ts";

export type SoundName =
  | "join"
  | "leave"
  | "userJoin"
  | "userLeave"
  | "mute"
  | "unmute"
  | "deafen"
  | "undeafen"
  | "message"
  | "streamStart"
  | "replay";

/** freq (Hz), start (s), duration (s), optional glide target, waveform, relative gain. */
type Note = { f: number; t: number; d: number; to?: number; wave?: OscillatorType; g?: number };

const E5 = 659.3;
const G5 = 784;
const B5 = 987.8;
const C6 = 1046.5;
const E6 = 1318.5;

const SOUNDS: Record<SoundName, Note[]> = {
  join: [
    { f: E5, t: 0, d: 0.22 },
    { f: B5, t: 0.09, d: 0.32 },
  ],
  leave: [
    { f: B5, t: 0, d: 0.22 },
    { f: E5, t: 0.09, d: 0.32 },
  ],
  userJoin: [
    { f: G5, t: 0, d: 0.14, g: 0.7 },
    { f: C6, t: 0.07, d: 0.2, g: 0.7 },
  ],
  userLeave: [
    { f: C6, t: 0, d: 0.14, g: 0.7 },
    { f: G5, t: 0.07, d: 0.2, g: 0.7 },
  ],
  mute: [{ f: 520, to: 360, t: 0, d: 0.13, wave: "triangle" }],
  unmute: [{ f: 360, to: 560, t: 0, d: 0.13, wave: "triangle" }],
  deafen: [
    { f: 523, t: 0, d: 0.1, wave: "triangle" },
    { f: 392, t: 0.08, d: 0.16, wave: "triangle" },
  ],
  undeafen: [
    { f: 392, t: 0, d: 0.1, wave: "triangle" },
    { f: 523, t: 0.08, d: 0.16, wave: "triangle" },
  ],
  message: [
    { f: 1320, to: 990, t: 0, d: 0.1, g: 0.8 },
    { f: 1760, t: 0.05, d: 0.16, g: 0.45 },
  ],
  streamStart: [
    { f: E5, t: 0, d: 0.16, g: 0.8 },
    { f: 830.6, t: 0.06, d: 0.16, g: 0.8 },
    { f: B5, t: 0.12, d: 0.18, g: 0.8 },
    { f: E6, t: 0.18, d: 0.3, g: 0.8 },
  ],
  replay: [
    { f: 660, t: 0, d: 0.3 },
    { f: 990, t: 0.09, d: 0.3 },
  ],
};

export const SOUND_LABELS: Record<SoundName, string> = {
  join: "Entrar na voz",
  leave: "Sair da voz",
  userJoin: "Alguém entrou",
  userLeave: "Alguém saiu",
  mute: "Mutar",
  unmute: "Desmutar",
  deafen: "Desativar áudio",
  undeafen: "Ativar áudio",
  message: "Mensagem direta",
  streamStart: "Transmissão iniciada",
  replay: "Replay salvo",
};

let ctx: AudioContext | null = null;
let sinkId: string | null = null;

function context(): AudioContext | null {
  try {
    ctx ??= new AudioContext({ latencyHint: "interactive" });
  } catch {
    return null;
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  // Same headphones as the voices (Chrome, Edge and the desktop app can choose).
  const wanted = audioSettings.get().outputDeviceId;
  const sinkable = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (sinkable.setSinkId && wanted !== sinkId) {
    sinkId = wanted;
    sinkable.setSinkId(wanted).catch(() => sinkable.setSinkId?.("").catch(() => {}));
  }
  return ctx;
}

/** Plays a sound now (unless sounds are off). `force` plays it anyway, for the settings preview. */
export function playSound(name: SoundName, { force = false } = {}) {
  const { sounds, soundVolume } = appSettings.get();
  if ((!sounds && !force) || soundVolume <= 0) return;
  window.dispatchEvent(new CustomEvent("voxa:sound", { detail: name }));
  const c = context();
  if (!c) return;
  const master = c.createGain();
  master.gain.value = 0.22 * soundVolume;
  master.connect(c.destination);
  const now = c.currentTime + 0.01;
  let end = now;
  for (const n of SOUNDS[name]) {
    const start = now + n.t;
    const stop = start + n.d;
    end = Math.max(end, stop);
    // A soft octave above gives the tones their "glassy" shimmer.
    for (const [mult, level] of [
      [1, 1],
      [2, 0.18],
    ] as const) {
      const osc = c.createOscillator();
      const env = c.createGain();
      osc.type = n.wave ?? "sine";
      osc.frequency.setValueAtTime(n.f * mult, start);
      if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to * mult, stop);
      const peak = (n.g ?? 1) * level;
      env.gain.setValueAtTime(0.0001, start);
      env.gain.exponentialRampToValueAtTime(peak, start + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, stop);
      osc.connect(env).connect(master);
      osc.start(start);
      osc.stop(stop + 0.02);
    }
  }
  setTimeout(() => master.disconnect(), (end - c.currentTime + 0.2) * 1000);
}
