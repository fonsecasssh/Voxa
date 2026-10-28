// Microphone processing: mic -> noise suppression -> noise gate -> the track we send.
//
//   - Noise suppression runs a small neural network (GTCRN, or RNNoise for "light")
//     in an AudioWorklet, entirely on this device. It removes keyboard clicks, fans and
//     other steady or transient noise while keeping speech.
//   - The gate ("input sensitivity") only lets sound through above a level, so the
//     silence between sentences stays silent.
//
// Both models expect 48 kHz audio, so all of Voxa's audio runs in one 48 kHz context.

import {
  GtcrnWorkletNode,
  NoiseGateWorkletNode,
  RnnoiseWorkletNode,
  loadGtcrn,
  loadRnnoise,
} from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import gtcrnWorkletUrl from "@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url";
import noiseGateWorkletUrl from "@sapphi-red/web-noise-suppressor/noiseGateWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import gtcrnWasmUrl from "@sapphi-red/web-noise-suppressor/gtcrn.wasm?url";
import { gateThresholds, type AudioSettings } from "./audioSettings.ts";

let ctx: AudioContext | null = null;

/** The shared 48 kHz audio context (created on first use, which must follow a user gesture). */
export function getAudioContext(): AudioContext {
  ctx ??= new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

// Worklet modules and model binaries load once and are reused.
const modules = new Map<string, Promise<void>>();
const addModule = (c: AudioContext, url: string) => {
  if (!modules.has(url)) modules.set(url, c.audioWorklet.addModule(url));
  return modules.get(url)!;
};
let rnnoiseWasm: Promise<ArrayBuffer> | null = null;
let gtcrnWasm: Promise<ArrayBuffer> | null = null;

/** Constraints for getUserMedia; the browser's own noise suppression is off when ours runs (stacking both sounds worse). */
export function micConstraints(s: AudioSettings): MediaTrackConstraints {
  return {
    deviceId: s.inputDeviceId ? { exact: s.inputDeviceId } : undefined,
    echoCancellation: s.echoCancellation,
    autoGainControl: true,
    noiseSuppression: s.noiseSuppression === "off",
    channelCount: 1,
  };
}

/** Opens the microphone, falling back to the default device if the saved one is gone. */
export async function openMic(s: AudioSettings): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: micConstraints(s) });
  } catch (err) {
    if (s.inputDeviceId && (err as Error).name === "OverconstrainedError") {
      return navigator.mediaDevices.getUserMedia({ audio: micConstraints({ ...s, inputDeviceId: "" }) });
    }
    throw err;
  }
}

export interface MicPipeline {
  /** The processed audio to send. */
  track: MediaStreamTrack;
  stream: MediaStream;
  /** Level after noise suppression, before the gate (for the sensitivity meter). */
  inputAnalyser: AnalyserNode;
  /** Level actually transmitted (for the speaking indicator). */
  outputAnalyser: AnalyserNode;
  dispose(): void;
}

async function suppressor(c: AudioContext, mode: AudioSettings["noiseSuppression"]): Promise<AudioWorkletNode | null> {
  if (mode === "light") {
    rnnoiseWasm ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
    const [wasmBinary] = await Promise.all([rnnoiseWasm, addModule(c, rnnoiseWorkletUrl)]);
    return new RnnoiseWorkletNode(c, { wasmBinary, maxChannels: 1 });
  }
  if (mode === "strong") {
    gtcrnWasm ??= loadGtcrn({ url: gtcrnWasmUrl });
    const [wasmBinary] = await Promise.all([gtcrnWasm, addModule(c, gtcrnWorkletUrl)]);
    return new GtcrnWorkletNode(c, { wasmBinary, maxChannels: 1 });
  }
  return null;
}

/** Builds the processing chain for a raw microphone stream. */
export async function buildMicPipeline(raw: MediaStream, s: AudioSettings): Promise<MicPipeline> {
  const c = getAudioContext();
  const source = c.createMediaStreamSource(raw);
  // Everything downstream is mono: some mics deliver stereo, and the gate stays silent on
  // more channels than it was built for. A 1-channel "speakers" node mixes stereo down.
  const mono = c.createGain();
  mono.channelCount = 1;
  mono.channelCountMode = "explicit";
  mono.channelInterpretation = "speakers";
  source.connect(mono);

  let denoise: AudioWorkletNode | null = null;
  try {
    denoise = await suppressor(c, s.noiseSuppression);
  } catch (err) {
    // Without AudioWorklet/WASM support the call still works, just without our suppression.
    console.warn("noise suppression unavailable", err);
  }

  await addModule(c, noiseGateWorkletUrl);
  const { openDb, closeDb } = gateThresholds(s);
  const gate = new NoiseGateWorkletNode(c, { openThreshold: openDb, closeThreshold: closeDb, holdMs: 250, maxChannels: 1 });

  const inputAnalyser = c.createAnalyser();
  inputAnalyser.fftSize = 1024;
  const outputAnalyser = c.createAnalyser();
  outputAnalyser.fftSize = 1024;
  const dest = c.createMediaStreamDestination();

  const head: AudioNode = denoise ?? mono;
  if (denoise) mono.connect(denoise);
  head.connect(inputAnalyser);
  head.connect(gate);
  gate.connect(dest);
  gate.connect(outputAnalyser);

  const track = dest.stream.getAudioTracks()[0];
  return {
    track,
    stream: dest.stream,
    inputAnalyser,
    outputAnalyser,
    dispose() {
      source.disconnect();
      mono.disconnect();
      denoise?.disconnect();
      (denoise as { destroy?: () => void } | null)?.destroy?.();
      gate.disconnect();
      track.stop();
    },
  };
}

const buf = new Float32Array(1024);

/** Current level of an analyser in dBFS (-100 for silence). */
export function levelDb(a: AnalyserNode | null | undefined): number {
  if (!a) return -100;
  a.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < a.fftSize; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / a.fftSize);
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}
