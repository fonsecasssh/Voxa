// Voxa's own interface sounds, synthesized on the fly (no audio files): short, soft,
// glassy tones that rise for "in/on" and fall for "out/off". They play on the output
// device chosen in the voice settings and follow the volume in "Aparência e sons".
//
// The call sounds (joining, leaving, someone arriving) are richer: arpeggiated bell
// chords (FM synthesis), a warm pad underneath, a filter that opens on the way in and
// closes on the way out, a breath of air sweeping across the stereo field, and a short
// room reverb. The small UI sounds stay simple so they never get in the way.

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

interface Note {
  /** Frequency (Hz), start and duration (s). */
  f: number;
  t: number;
  d: number;
  /** Glide to this frequency over the note. */
  to?: number;
  /** Starts at another pitch and slides into f quickly: the round "bloop" of chat apps. */
  slide?: { from: number; d: number };
  wave?: OscillatorType;
  /** Relative gain. */
  g?: number;
  attack?: number;
  /** Bell timbre: a modulator at f × ratio whose depth (f × index) fades over the note. */
  fm?: { ratio: number; index: number };
  /** Part of the note over which the FM depth fades (default 0.6); short = a mallet hit. */
  fmDecay?: number;
  /** Lowpass on this note, sweeping from → to over d: closing fast gives a "pluck". */
  lp?: { from: number; to: number; d: number };
  /** Stereo position, -1 (left) to 1 (right). */
  pan?: number;
  /** Adds a second voice this many cents apart, for a gentle chorus. */
  detune?: number;
}

interface Sound {
  notes: Note[];
  /** Lowpass on the whole sound, sweeping from → to over d seconds. */
  filter?: { from: number; to: number; d: number };
  /** Filtered noise sweeping from → to (Hz) and across the stereo field. */
  air?: { from: number; to: number; d: number; g: number; pan: [number, number] };
  /** Reverb send level. */
  reverb?: number;
  /** Loudness trim, so every style plays at about the same level. */
  gain?: number;
}

const A3 = 220;
const E3 = 164.8;
const E4 = 329.6;
const A4 = 440;
const Cs5 = 554.4;
const E5 = 659.3;
const Gs5 = 830.6;
const B5 = 987.8;
const E6 = 1318.5;

const bell = (f: number, t: number, d: number, pan: number, g = 0.8, index = 1.1): Note => ({
  f,
  t,
  d,
  pan,
  g,
  fm: { ratio: 3, index },
});

const SOUNDS: Record<SoundName, Sound> = {
  // You joined: an A major 9 chord blooming upward, left to right, as the filter opens.
  join: {
    notes: [
      { f: A3, t: 0, d: 1.0, wave: "triangle", g: 0.3, attack: 0.09, detune: 9 },
      bell(A4, 0, 0.75, -0.55),
      bell(Cs5, 0.065, 0.75, -0.2),
      bell(E5, 0.13, 0.8, 0.2),
      bell(B5, 0.2, 0.95, 0.55, 0.7),
      { f: E6, t: 0.26, d: 0.6, g: 0.16, pan: 0.6 },
    ],
    filter: { from: 900, to: 7000, d: 0.4 },
    air: { from: 600, to: 3800, d: 0.5, g: 0.2, pan: [-0.7, 0.7] },
    reverb: 0.4,
  },
  // You left: the same chord folding back down and to the left, the filter closing.
  leave: {
    notes: [
      { f: A3, to: E3, t: 0, d: 0.95, wave: "triangle", g: 0.26, attack: 0.05, detune: 9 },
      bell(B5, 0, 0.6, 0.55, 0.6),
      bell(E5, 0.07, 0.65, 0.2),
      bell(Cs5, 0.14, 0.7, -0.2),
      bell(A4, 0.21, 0.9, -0.55),
    ],
    filter: { from: 6000, to: 650, d: 0.7 },
    air: { from: 3200, to: 450, d: 0.5, g: 0.15, pan: [0.7, -0.7] },
    reverb: 0.4,
  },
  // Someone joined: a lighter, glassy fifth with a sparkle on top.
  userJoin: {
    notes: [
      bell(E5, 0, 0.55, -0.35, 0.8, 0.8),
      bell(B5, 0.08, 0.65, 0.35, 0.72, 0.8),
      { f: E6, t: 0.15, d: 0.45, g: 0.18, pan: 0.5 },
      { f: E4, t: 0, d: 0.6, wave: "triangle", g: 0.14, attack: 0.04 },
    ],
    filter: { from: 1800, to: 7500, d: 0.25 },
    air: { from: 1500, to: 4500, d: 0.28, g: 0.07, pan: [-0.4, 0.4] },
    reverb: 0.32,
  },
  // Someone left: the same fifth, falling, a little darker.
  userLeave: {
    notes: [
      bell(B5, 0, 0.45, 0.35, 0.7, 0.7),
      bell(E5, 0.08, 0.6, -0.35, 0.76, 0.7),
      { f: E4, t: 0.04, d: 0.55, wave: "triangle", g: 0.12, attack: 0.03 },
    ],
    filter: { from: 6000, to: 1400, d: 0.45 },
    reverb: 0.3,
  },
  mute: { notes: [{ f: 520, to: 360, t: 0, d: 0.13, wave: "triangle" }] },
  unmute: { notes: [{ f: 360, to: 560, t: 0, d: 0.13, wave: "triangle" }] },
  deafen: {
    notes: [
      { f: 523, t: 0, d: 0.1, wave: "triangle" },
      { f: 392, t: 0.08, d: 0.16, wave: "triangle" },
    ],
  },
  undeafen: {
    notes: [
      { f: 392, t: 0, d: 0.1, wave: "triangle" },
      { f: 523, t: 0.08, d: 0.16, wave: "triangle" },
    ],
  },
  message: {
    notes: [
      { f: 1320, to: 990, t: 0, d: 0.1, g: 0.8 },
      { f: 1760, t: 0.05, d: 0.16, g: 0.45 },
    ],
  },
  streamStart: {
    notes: [
      { f: E5, t: 0, d: 0.16, g: 0.8 },
      { f: Gs5, t: 0.06, d: 0.16, g: 0.8 },
      { f: B5, t: 0.12, d: 0.18, g: 0.8 },
      { f: E6, t: 0.18, d: 0.3, g: 0.8 },
    ],
  },
  replay: {
    notes: [
      { f: 660, t: 0, d: 0.3 },
      { f: 990, t: 0.09, d: 0.3 },
    ],
  },
};

export type SoundStyle = "impacto" | "arcade" | "marimba" | "classic" | "voxa";
export const SOUND_STYLES: { id: SoundStyle; label: string; hint: string }[] = [
  { id: "impacto", label: "Impacto", hint: "Pluck de sintetizador com um grave forte no ataque. Marcante e moderno." },
  { id: "arcade", label: "Arcade", hint: "Ondas quadradas brilhantes, como um level up de videogame." },
  { id: "marimba", label: "Marimba", hint: "Uma pequena melodia de marimba, como a vinheta de uma marca." },
  { id: "classic", label: "Clássico", hint: "Curtos e arredondados, discretos." },
  { id: "voxa", label: "Sinos", hint: "Acordes com timbre de sino, estéreo e um pouco de ambiente." },
];

/**
 * "Clássico": the familiar chat-app style — short, round sine "bloops" that slide up
 * when something starts and down when it ends, no reverb. Overrides the call and
 * toggle sounds; the rest are shared with the "Voxa" (bells) style above.
 */
const bloop = (from: number, f: number, t: number, d: number, g = 0.95): Note => ({ f, t, d, g, slide: { from, d: 0.045 }, attack: 0.006 });
const ROUND = { from: 2800, to: 2800, d: 0.01 };

// --- "Impacto": saw plucks (filter snapping shut) over a sub "thump" ---
const pluck = (f: number, t: number, d: number, g: number, pan = 0): Note => ({
  f,
  t,
  d,
  g,
  pan,
  wave: "sawtooth",
  attack: 0.003,
  detune: 7,
  lp: { from: 5200, to: 500, d: d * 0.8 },
});
const thump = (from: number, to: number, g = 0.9): Note => ({ f: to, t: 0, d: 0.16, g, attack: 0.002, slide: { from, d: 0.05 } });
const E5n = 659.3;
const B5n = 987.8;
const E6n = 1318.5;
const IMPACTO: Partial<Record<SoundName, Sound>> = {
  join: { notes: [thump(180, 62), pluck(E5n, 0, 0.3, 0.42, -0.3), pluck(B5n, 0.07, 0.32, 0.42), pluck(E6n, 0.14, 0.5, 0.46, 0.3)], reverb: 0.18, gain: 1.25 },
  leave: { notes: [thump(150, 48), pluck(E6n, 0, 0.26, 0.38, 0.3), pluck(B5n, 0.07, 0.3, 0.42), pluck(E5n, 0.14, 0.5, 0.46, -0.3)], reverb: 0.18, gain: 1.25 },
  userJoin: { notes: [thump(160, 70, 0.6), pluck(B5n, 0, 0.22, 0.38, -0.2), pluck(E6n, 0.07, 0.36, 0.4, 0.2)], reverb: 0.14, gain: 1.3 },
  userLeave: { notes: [thump(140, 55, 0.6), pluck(E6n, 0, 0.22, 0.36, 0.2), pluck(B5n, 0.07, 0.36, 0.4, -0.2)], reverb: 0.14, gain: 1.3 },
  mute: { notes: [pluck(784, 0, 0.12, 0.4), pluck(523.3, 0.05, 0.18, 0.4)], gain: 1.8 },
  unmute: { notes: [pluck(523.3, 0, 0.12, 0.4), pluck(784, 0.05, 0.18, 0.4)], gain: 1.8 },
  deafen: { notes: [thump(130, 55, 0.5), pluck(523.3, 0, 0.12, 0.4), pluck(349.2, 0.05, 0.2, 0.4)], gain: 1.6 },
  undeafen: { notes: [thump(130, 70, 0.5), pluck(349.2, 0, 0.12, 0.4), pluck(523.3, 0.05, 0.2, 0.4)], gain: 1.6 },
};

// --- "Arcade": bright square waves, a little "level up" ---
const sq = (f: number, t: number, d: number, g = 0.3, pan = 0): Note => ({ f, t, d, g, pan, wave: "square", attack: 0.004, lp: { from: 4200, to: 2600, d } });
const ARCADE: Partial<Record<SoundName, Sound>> = {
  join: { notes: [sq(523.3, 0, 0.09), sq(784, 0.075, 0.09), sq(1046.5, 0.15, 0.3, 0.32), sq(1568, 0.15, 0.3, 0.1)], reverb: 0.12, gain: 2.25 },
  leave: { notes: [sq(1046.5, 0, 0.09), sq(784, 0.075, 0.09), sq(523.3, 0.15, 0.3, 0.32), sq(392, 0.15, 0.3, 0.1)], reverb: 0.12, gain: 2.25 },
  userJoin: { notes: [sq(784, 0, 0.08, 0.26), sq(1174.7, 0.07, 0.22, 0.28)], reverb: 0.1, gain: 2.25 },
  userLeave: { notes: [sq(1174.7, 0, 0.08, 0.26), sq(784, 0.07, 0.22, 0.28)], reverb: 0.1, gain: 2.25 },
  mute: { notes: [{ f: 330, t: 0, d: 0.1, g: 0.28, wave: "square", slide: { from: 660, d: 0.06 }, lp: { from: 3500, to: 2000, d: 0.1 } }], gain: 3.2 },
  unmute: { notes: [{ f: 660, t: 0, d: 0.1, g: 0.28, wave: "square", slide: { from: 330, d: 0.06 }, lp: { from: 3500, to: 2000, d: 0.1 } }], gain: 3.2 },
  deafen: { notes: [sq(523.3, 0, 0.07, 0.26), sq(261.6, 0.06, 0.14, 0.26)], gain: 2.8 },
  undeafen: { notes: [sq(261.6, 0, 0.07, 0.26), sq(523.3, 0.06, 0.14, 0.26)], gain: 2.8 },
};

// --- "Marimba": mallet hits playing a short signature melody ---
const mallet = (f: number, t: number, d = 0.45, g = 0.85, pan = 0): Note => ({
  f,
  t,
  d,
  g,
  pan,
  attack: 0.002,
  fm: { ratio: 4, index: 2.2 },
  fmDecay: 0.12,
});
const MARIMBA: Partial<Record<SoundName, Sound>> = {
  join: { notes: [mallet(784, 0, 0.3, 0.8, -0.3), mallet(987.8, 0.09, 0.3, 0.8, -0.1), mallet(1174.7, 0.18, 0.3, 0.8, 0.1), mallet(1568, 0.27, 0.6, 0.85, 0.3)], reverb: 0.22, gain: 1.4 },
  leave: { notes: [mallet(1174.7, 0, 0.3, 0.8, 0.3), mallet(987.8, 0.09, 0.3, 0.8, 0.1), mallet(784, 0.18, 0.3, 0.8, -0.1), mallet(587.3, 0.27, 0.6, 0.9, -0.3)], reverb: 0.22, gain: 1.4 },
  userJoin: { notes: [mallet(987.8, 0, 0.3, 0.75, -0.2), mallet(1174.7, 0.09, 0.45, 0.75, 0.2)], reverb: 0.18, gain: 1.2 },
  userLeave: { notes: [mallet(1174.7, 0, 0.3, 0.75, 0.2), mallet(987.8, 0.09, 0.45, 0.75, -0.2)], reverb: 0.18, gain: 1.2 },
  mute: { notes: [mallet(784, 0, 0.18, 0.8), mallet(587.3, 0.06, 0.25, 0.8)], gain: 0.95 },
  unmute: { notes: [mallet(587.3, 0, 0.18, 0.8), mallet(784, 0.06, 0.25, 0.8)], gain: 0.95 },
  deafen: { notes: [mallet(587.3, 0, 0.18, 0.8), mallet(392, 0.06, 0.3, 0.85)], gain: 0.95 },
  undeafen: { notes: [mallet(392, 0, 0.18, 0.8), mallet(587.3, 0.06, 0.3, 0.85)], gain: 0.95 },
};

const CLASSIC: Partial<Record<SoundName, Sound>> = {
  join: { notes: [bloop(587.3, 698.5, 0, 0.13), bloop(880, 1046.5, 0.085, 0.2)], filter: ROUND },
  leave: { notes: [bloop(1046.5, 880, 0, 0.13), bloop(698.5, 587.3, 0.085, 0.22)], filter: ROUND },
  userJoin: { notes: [bloop(554.4, 659.3, 0, 0.11, 0.75), bloop(740, 880, 0.07, 0.17, 0.75)], filter: ROUND },
  userLeave: { notes: [bloop(880, 740, 0, 0.11, 0.75), bloop(659.3, 554.4, 0.07, 0.17, 0.75)], filter: ROUND },
  mute: { notes: [{ f: 392, t: 0, d: 0.12, g: 0.9, slide: { from: 740, d: 0.07 } }], filter: ROUND },
  unmute: { notes: [{ f: 784, t: 0, d: 0.12, g: 0.9, slide: { from: 415, d: 0.07 } }], filter: ROUND },
  deafen: { notes: [bloop(784, 523.3, 0, 0.09, 0.85), bloop(523.3, 349.2, 0.075, 0.12, 0.85)], filter: ROUND },
  undeafen: { notes: [bloop(349.2, 523.3, 0, 0.09, 0.85), bloop(523.3, 784, 0.075, 0.12, 0.85)], filter: ROUND },
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

const REVERB_SECONDS = 1.6;
const reverbs = new WeakMap<BaseAudioContext, AudioBuffer>();
const noises = new WeakMap<BaseAudioContext, AudioBuffer>();

/** A small, dark room: decaying stereo noise, smoothed so the tail isn't hissy. */
function reverbImpulse(c: BaseAudioContext): AudioBuffer {
  let buf = reverbs.get(c);
  if (buf) return buf;
  const len = Math.round(c.sampleRate * REVERB_SECONDS);
  const pre = Math.round(c.sampleRate * 0.012);
  buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let y = 0;
    for (let i = pre; i < len; i++) {
      const x = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
      y += 0.28 * (x - y);
      data[i] = y * 1.9;
    }
  }
  reverbs.set(c, buf);
  return buf;
}

function noiseBuffer(c: BaseAudioContext): AudioBuffer {
  let buf = noises.get(c);
  if (buf) return buf;
  buf = c.createBuffer(1, c.sampleRate, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noises.set(c, buf);
  return buf;
}

function panner(c: BaseAudioContext, pan: number | undefined, into: AudioNode): AudioNode {
  if (!pan) return into;
  const p = c.createStereoPanner();
  p.pan.value = pan;
  p.connect(into);
  return p;
}

/**
 * Schedules a sound on any audio context (live, or offline to render a preview)
 * starting at `when`, and returns its output node and the time it has fully died away.
 */
export function renderSound(c: BaseAudioContext, out: AudioNode, name: SoundName, volume: number, when: number, style: SoundStyle = "impacto") {
  const overrides: Record<SoundStyle, Partial<Record<SoundName, Sound>>> = {
    impacto: IMPACTO,
    arcade: ARCADE,
    marimba: MARIMBA,
    classic: CLASSIC,
    voxa: {},
  };
  const s = overrides[style][name] ?? SOUNDS[name];
  // Everything ends in `bus`, so disconnecting it releases the whole sound (reverb included).
  const bus = c.createGain();
  bus.connect(out);
  const master = c.createGain();
  master.gain.value = 0.3 * volume * (s.gain ?? 1);
  master.connect(bus);

  let input: AudioNode = master;
  if (s.filter) {
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 0.6;
    lp.frequency.setValueAtTime(s.filter.from, when);
    lp.frequency.exponentialRampToValueAtTime(s.filter.to, when + s.filter.d);
    lp.connect(master);
    input = lp;
  }
  if (s.reverb) {
    const send = c.createGain();
    send.gain.value = s.reverb;
    const conv = c.createConvolver();
    conv.buffer = reverbImpulse(c);
    master.connect(send).connect(conv).connect(bus);
  }

  let end = when;
  for (const n of s.notes) {
    const start = when + n.t;
    const stop = start + n.d;
    end = Math.max(end, stop);
    const env = c.createGain();
    const peak = n.g ?? 1;
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(peak, start + (n.attack ?? 0.008));
    env.gain.exponentialRampToValueAtTime(0.0001, stop);
    env.connect(panner(c, n.pan, input));
    let into: AudioNode = env;
    if (n.lp) {
      const lp = c.createBiquadFilter();
      lp.type = "lowpass";
      lp.Q.value = 1.2;
      lp.frequency.setValueAtTime(n.lp.from, start);
      lp.frequency.exponentialRampToValueAtTime(n.lp.to, start + n.lp.d);
      lp.connect(env);
      into = lp;
    }

    // Plain notes get a soft octave above (the "glassy" shimmer); bells get FM instead.
    const voices: [number, number, number][] = n.fm ? [[1, 1, 0]] : [[1, 1, 0], [2, 0.18, 0]];
    if (n.detune) voices.push([1, 0.7, n.detune]);
    for (const [mult, level, cents] of voices) {
      const osc = c.createOscillator();
      osc.type = n.wave ?? "sine";
      osc.detune.value = cents;
      if (n.slide) {
        osc.frequency.setValueAtTime(n.slide.from * mult, start);
        osc.frequency.exponentialRampToValueAtTime(n.f * mult, start + n.slide.d);
      } else {
        osc.frequency.setValueAtTime(n.f * mult, start);
      }
      if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to * mult, stop);
      if (n.fm) {
        const mod = c.createOscillator();
        const depth = c.createGain();
        mod.frequency.value = n.f * n.fm.ratio;
        depth.gain.setValueAtTime(n.f * n.fm.index, start);
        depth.gain.exponentialRampToValueAtTime(n.f * n.fm.index * 0.04 + 0.01, start + n.d * (n.fmDecay ?? 0.6));
        mod.connect(depth).connect(osc.frequency);
        mod.start(start);
        mod.stop(stop + 0.02);
      }
      const lvl = c.createGain();
      lvl.gain.value = level;
      osc.connect(lvl).connect(into);
      osc.start(start);
      osc.stop(stop + 0.02);
    }
  }

  if (s.air) {
    const { from, to, d, g, pan } = s.air;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c);
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.3;
    bp.frequency.setValueAtTime(from, when);
    bp.frequency.exponentialRampToValueAtTime(to, when + d);
    const env = c.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(g, when + d * 0.45);
    env.gain.exponentialRampToValueAtTime(0.0001, when + d);
    const p = c.createStereoPanner();
    p.pan.setValueAtTime(pan[0], when);
    p.pan.linearRampToValueAtTime(pan[1], when + d);
    src.connect(bp).connect(env).connect(p).connect(master);
    src.start(when);
    src.stop(when + d + 0.02);
    end = Math.max(end, when + d);
  }

  return { output: bus, end: end + (s.reverb ? REVERB_SECONDS : 0) };
}

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
  const { sounds, soundVolume, soundStyle } = appSettings.get();
  if ((!sounds && !force) || soundVolume <= 0) return;
  window.dispatchEvent(new CustomEvent("voxa:sound", { detail: name }));
  const c = context();
  if (!c) return;
  const { output, end } = renderSound(c, c.destination, name, soundVolume, c.currentTime + 0.01, soundStyle);
  setTimeout(() => output.disconnect(), (end - c.currentTime + 0.2) * 1000);
}
