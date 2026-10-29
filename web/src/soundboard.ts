// Soundboard playback. The built-in sounds are synthesized here (no audio files), the
// server's own are fetched once and decoded. They play on the voice headphones, at the
// soundboard volume from "Aparência e sons" times the sound's own volume.

import { appSettings } from "./appSettings.ts";
import { context } from "./sounds.ts";

export { DEFAULT_SOUNDS, SOUNDBOARD_COOLDOWN_MS } from "../../shared/soundboard.ts";

/** A sound as it's played: built-in ones have no url. */
export interface PlayedSound {
  id: string;
  name: string;
  emoji: string | null;
  volume: number;
  url: string | null;
}

type Synth = (c: BaseAudioContext, out: AudioNode, t: number) => number;

let noise: AudioBuffer | null = null;
function noiseBuffer(c: BaseAudioContext): AudioBuffer {
  if (noise && noise.sampleRate === c.sampleRate) return noise;
  noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noise;
}

/** An envelope: up to `peak` in `attack`, held, then down to silence over `release`. */
function env(c: BaseAudioContext, t: number, peak: number, attack: number, hold: number, release: number): GainNode {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.setValueAtTime(peak, t + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  return g;
}

function osc(c: BaseAudioContext, type: OscillatorType, f: number, t: number, d: number, into: AudioNode, detune = 0) {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  o.detune.value = detune;
  o.connect(into);
  o.start(t);
  o.stop(t + d + 0.05);
  return o;
}

function noiseBurst(c: BaseAudioContext, t: number, d: number, into: AudioNode, offset = Math.random()) {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  src.connect(into);
  src.start(t, offset, d + 0.05);
  return src;
}

const SYNTHS: Record<string, Synth> = {
  // Three blasts of a brassy, slightly out-of-tune chord.
  "default:buzina": (c, out, t) => {
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3200;
    lp.connect(out);
    [
      [0, 0.14],
      [0.2, 0.14],
      [0.4, 0.75],
    ].forEach(([at, d]) => {
      const g = env(c, t + at, 0.22, 0.015, d, 0.08);
      g.connect(lp);
      for (const [f, det] of [
        [415, 0],
        [523, 8],
        [622, -6],
        [830, 4],
      ]) {
        const o = osc(c, "sawtooth", f, t + at, d + 0.1, g, det);
        o.frequency.setValueAtTime(f * 0.97, t + at);
        o.frequency.linearRampToValueAtTime(f, t + at + 0.04);
      }
    });
    return 1.3;
  },

  // A small crowd clapping: short bursts of filtered noise at uneven times.
  "default:palmas": (c, out, t) => {
    let at = 0;
    for (let i = 0; i < 26; i++) {
      at += 0.04 + Math.random() * 0.08;
      const bp = c.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 900 + Math.random() * 1400;
      bp.Q.value = 1.2;
      const g = env(c, t + at, 1.1 * (0.6 + Math.random() * 0.4) * (i > 20 ? 0.5 : 1), 0.002, 0.005, 0.06);
      bp.connect(g).connect(out);
      noiseBurst(c, t + at, 0.08, bp);
    }
    return at + 0.2;
  },

  // Two tom hits and a crash.
  "default:badumtss": (c, out, t) => {
    const tom = (at: number, from: number, to: number) => {
      const g = env(c, t + at, 0.8, 0.003, 0.02, 0.28);
      g.connect(out);
      const o = osc(c, "sine", from, t + at, 0.35, g);
      o.frequency.exponentialRampToValueAtTime(to, t + at + 0.2);
    };
    tom(0, 220, 110);
    tom(0.2, 170, 80);
    const hp = c.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 5500;
    const g = env(c, t + 0.45, 0.45, 0.004, 0.05, 1.4);
    hp.connect(g).connect(out);
    noiseBurst(c, t + 0.45, 1.5, hp, 0);
    // A bit of metal in the crash.
    const ring = env(c, t + 0.45, 0.04, 0.004, 0.05, 1.1);
    ring.connect(out);
    for (const f of [5200, 6700, 8300]) osc(c, "square", f, t + 0.45, 1.2, ring);
    return 2;
  },

  // Crickets at night: quick high chirps in pairs, from two of them.
  "default:grilos": (c, out, t) => {
    const chirp = (at: number, f: number, pan: number) => {
      const p = c.createStereoPanner();
      p.pan.value = pan;
      p.connect(out);
      for (let k = 0; k < 4; k++) {
        const g = env(c, t + at + k * 0.032, 0.25, 0.004, 0.012, 0.012);
        g.connect(p);
        osc(c, "sine", f, t + at + k * 0.032, 0.03, g);
      }
    };
    for (let i = 0; i < 4; i++) {
      chirp(i * 0.55, 4300, -0.5);
      chirp(i * 0.55 + 0.27, 4700, 0.5);
    }
    return 2.4;
  },

  // Wah, wah, wah, waaah.
  "default:triste": (c, out, t) => {
    const notes: [number, number, number][] = [
      [196, 0, 0.38],
      [185, 0.45, 0.38],
      [174.6, 0.9, 0.38],
      [164.8, 1.35, 1.3],
    ];
    for (const [f, at, d] of notes) {
      const lp = c.createBiquadFilter();
      lp.type = "lowpass";
      lp.Q.value = 6;
      lp.frequency.setValueAtTime(350, t + at);
      lp.frequency.linearRampToValueAtTime(1500, t + at + Math.min(0.18, d / 2));
      lp.frequency.linearRampToValueAtTime(400, t + at + d);
      const g = env(c, t + at, 0.3, 0.03, d - 0.08, 0.12);
      lp.connect(g).connect(out);
      const o = osc(c, "sawtooth", f, t + at, d, lp);
      if (d > 1) {
        // The last one wobbles.
        const lfo = c.createOscillator();
        lfo.frequency.value = 5.5;
        const depth = c.createGain();
        depth.gain.value = 5;
        lfo.connect(depth).connect(o.frequency);
        lfo.start(t + at + 0.2);
        lfo.stop(t + at + d);
      }
    }
    return 2.8;
  },

  // A short fanfare: a quick pickup and a big chord.
  "default:tada": (c, out, t) => {
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2600;
    lp.connect(out);
    const chord = (at: number, d: number, fs: number[], peak: number) => {
      const g = env(c, t + at, peak, 0.012, d, 0.25);
      g.connect(lp);
      for (const f of fs) {
        osc(c, "sawtooth", f, t + at, d + 0.25, g, 5);
        osc(c, "square", f, t + at, d + 0.25, g, -5);
      }
    };
    chord(0, 0.08, [523.3, 659.3], 0.08);
    chord(0.14, 0.9, [261.6, 329.6, 392, 523.3], 0.1);
    return 1.4;
  },
};

const buffers = new Map<string, Promise<AudioBuffer>>();
function load(c: AudioContext, url: string): Promise<AudioBuffer> {
  let b = buffers.get(url);
  if (!b) {
    b = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.arrayBuffer();
      })
      .then((data) => c.decodeAudioData(data));
    b.catch(() => buffers.delete(url));
    buffers.set(url, b);
  }
  return b;
}

/** Plays a soundboard sound now; `volume` overrides the soundboard volume (for previews). */
export async function playBoardSound(sound: PlayedSound, volume = appSettings.get().soundboardVolume): Promise<void> {
  const level = volume * sound.volume;
  if (level <= 0) return;
  const c = context();
  if (!c) return;
  const out = c.createGain();
  out.gain.value = level;
  out.connect(c.destination);
  let seconds: number;
  if (sound.url) {
    const buffer = await load(c, sound.url).catch(() => null);
    if (!buffer) return out.disconnect();
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(out);
    src.start();
    seconds = buffer.duration;
  } else {
    const synth = SYNTHS[sound.id];
    if (!synth) return out.disconnect();
    seconds = synth(c, out, c.currentTime + 0.02);
  }
  setTimeout(() => out.disconnect(), (seconds + 0.5) * 1000);
}

/** Longest a server sound may last. */
export const MAX_SOUND_SECONDS = 5;
export const MAX_SOUND_BYTES = 512 * 1024;

/** Checks a file before uploading: real audio, at most 5 s and 512 KB. Returns its length. */
export async function checkSoundFile(file: File): Promise<number> {
  if (file.size > MAX_SOUND_BYTES) throw new Error("O som passa de 512 KB.");
  const c = new OfflineAudioContext(1, 1, 44_100);
  let buffer: AudioBuffer;
  try {
    buffer = await c.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error("Não deu para ler esse áudio. Use MP3, OGG, WAV, WebM ou M4A.");
  }
  if (buffer.duration > MAX_SOUND_SECONDS + 0.2) throw new Error(`O som pode ter até ${MAX_SOUND_SECONDS} segundos (esse tem ${buffer.duration.toFixed(1)} s).`);
  return buffer.duration;
}
