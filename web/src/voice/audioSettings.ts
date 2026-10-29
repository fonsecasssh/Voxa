// Voice settings that belong to this device (microphones and headphones differ per
// machine), kept in localStorage and readable from React and from the voice engine.

export type NoiseSuppression = "off" | "light" | "strong";

/** Voice activity (the gate decides) or push-to-talk (only while the key is held). */
export type InputMode = "voice" | "ptt";

/** A keyboard key by KeyboardEvent.code, or a mouse button by MouseEvent.button (1 middle, 3 back, 4 forward). */
export type PttBinding = { type: "key"; code: string; label?: string } | { type: "mouse"; button: number };

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
  inputMode: InputMode;
  pttBinding: PttBinding;
  /** How long the mic stays open after the key is released, so the last syllable isn't cut. */
  pttReleaseMs: number;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  inputDeviceId: "",
  outputDeviceId: "",
  // GTCRN removes keyboard clicks almost entirely (about 45 dB quieter in our tests), RNNoise only partly.
  noiseSuppression: "strong",
  echoCancellation: true,
  autoSensitivity: true,
  sensitivityDb: -50,
  inputMode: "voice",
  pttBinding: { type: "key", code: "Backquote" },
  pttReleaseMs: 200,
};

export const PTT_RELEASE_RANGE = { min: 0, max: 1000 };

function isBinding(b: unknown): b is PttBinding {
  if (!b || typeof b !== "object") return false;
  const x = b as Record<string, unknown>;
  if (x.type === "key") {
    return typeof x.code === "string" && x.code.length > 0 && x.code.length < 32 && (x.label === undefined || (typeof x.label === "string" && x.label.length <= 4));
  }
  return x.type === "mouse" && (x.button === 1 || x.button === 3 || x.button === 4);
}

/** "`", "F", "Mouse 4"…: how a binding is shown in the app. */
export function bindingLabel(b: PttBinding): string {
  if (b.type === "mouse") return b.button === 1 ? "Botão do meio" : `Mouse ${b.button + 1}`;
  const c = b.code;
  // What the key printed when it was recorded (the layout decides, e.g. "Ç" on ABNT2).
  if (b.label) return b.label;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  if (/^Numpad[0-9]$/.test(c)) return `Num ${c.slice(6)}`;
  const names: Record<string, string> = {
    // The key left of 1: "'" on Brazilian keyboards, "`" on US ones.
    Backquote: "'",
    Space: "Espaço",
    CapsLock: "Caps Lock",
    Tab: "Tab",
    ShiftLeft: "Shift",
    ShiftRight: "Shift direito",
    ControlLeft: "Ctrl",
    ControlRight: "Ctrl direito",
    AltLeft: "Alt",
    AltRight: "Alt Gr",
  };
  return names[c] ?? c;
}

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
    if (raw.inputMode === "voice" || raw.inputMode === "ptt") s.inputMode = raw.inputMode;
    if (isBinding(raw.pttBinding)) s.pttBinding = raw.pttBinding;
    if (typeof raw.pttReleaseMs === "number") {
      s.pttReleaseMs = Math.min(PTT_RELEASE_RANGE.max, Math.max(PTT_RELEASE_RANGE.min, raw.pttReleaseMs));
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
  // Holding the key already says "I'm talking": no gate cutting soft words.
  if (s.inputMode === "ptt") return { openDb: -100, closeDb: -110 };
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
