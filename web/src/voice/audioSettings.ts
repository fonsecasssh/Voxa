// Voice settings that belong to this device (microphones and headphones differ per
// machine), kept in localStorage and readable from React and from the voice engine.

export type NoiseSuppression = "off" | "light" | "strong";

export interface AudioSettings {
  /** "" means the system default device. */
  inputDeviceId: string;
  outputDeviceId: string;
  /** light = RNNoise, strong = GTCRN (both neural networks, run on this device). */
  noiseSuppression: NoiseSuppression;
  echoCancellation: boolean;
  /** Automatic input sensitivity, or the manual threshold below. */
  autoSensitivity: boolean;
  /** Manual gate threshold in dBFS: the mic only transmits above it. */
  sensitivityDb: number;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  inputDeviceId: "",
  outputDeviceId: "",
  // GTCRN removes keyboard clicks almost entirely (about 45 dB quieter in our tests), RNNoise only partly.
  noiseSuppression: "strong",
  echoCancellation: true,
  autoSensitivity: true,
  sensitivityDb: -50,
};

/** Gate thresholds used in automatic mode (tuned for speech after noise suppression). */
export const AUTO_GATE = { openDb: -52, closeDb: -60 };

export const SENSITIVITY_RANGE = { min: -80, max: -10 };

const KEY = "voxa.audio";

function load(): AudioSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const s = { ...DEFAULT_AUDIO_SETTINGS };
    if (typeof raw.inputDeviceId === "string") s.inputDeviceId = raw.inputDeviceId;
    if (typeof raw.outputDeviceId === "string") s.outputDeviceId = raw.outputDeviceId;
    if (["off", "light", "strong"].includes(raw.noiseSuppression)) s.noiseSuppression = raw.noiseSuppression;
    if (typeof raw.echoCancellation === "boolean") s.echoCancellation = raw.echoCancellation;
    if (typeof raw.autoSensitivity === "boolean") s.autoSensitivity = raw.autoSensitivity;
    if (typeof raw.sensitivityDb === "number") {
      s.sensitivityDb = Math.min(SENSITIVITY_RANGE.max, Math.max(SENSITIVITY_RANGE.min, raw.sensitivityDb));
    }
    return s;
  } catch {
    return { ...DEFAULT_AUDIO_SETTINGS };
  }
}

let current = load();
const listeners = new Set<() => void>();

export const audioSettings = {
  get: () => current,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  update(patch: Partial<AudioSettings>) {
    current = { ...current, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      // Storage unavailable: settings last for this session only.
    }
    listeners.forEach((l) => l());
  },
};

/** Gate thresholds for the current settings. */
export function gateThresholds(s: AudioSettings): { openDb: number; closeDb: number } {
  return s.autoSensitivity ? AUTO_GATE : { openDb: s.sensitivityDb, closeDb: s.sensitivityDb - 8 };
}

/** Whether this browser can choose the output device (Chrome, Edge and the desktop app can). */
export const canChooseOutput = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

/** Routes an audio/video element to the chosen output device ("" = system default). */
export function applyOutputDevice(el: HTMLMediaElement, deviceId: string) {
  if (!canChooseOutput) return;
  const media = el as HTMLMediaElement & { sinkId?: string; setSinkId(id: string): Promise<void> };
  if (media.sinkId === deviceId) return;
  media.setSinkId(deviceId).catch(() => {
    // The device was unplugged: fall back to the default instead of going silent.
    if (deviceId) media.setSinkId("").catch(() => {});
  });
}
