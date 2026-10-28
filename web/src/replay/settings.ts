// Instant replay settings for this device (kept in localStorage, like the voice settings).

export const REPLAY_DURATIONS = [30, 60, 90, 120] as const;
export type ReplayDuration = (typeof REPLAY_DURATIONS)[number];

export const REPLAY_QUALITIES = {
  "720p30": { label: "720p · 30 fps (leve)", height: 720, fps: 30, bitrate: 3_500_000 },
  "1080p30": { label: "1080p · 30 fps", height: 1080, fps: 30, bitrate: 6_000_000 },
  "1080p60": { label: "1080p · 60 fps", height: 1080, fps: 60, bitrate: 10_000_000 },
} as const;
export type ReplayQuality = keyof typeof REPLAY_QUALITIES;

/** Same list as the desktop app's REPLAY_HOTKEYS (it refuses anything else). */
export const REPLAY_HOTKEYS = ["Alt+C", "Alt+F10", "Alt+F9", "Ctrl+Shift+C"] as const;
export type ReplayHotkey = (typeof REPLAY_HOTKEYS)[number];

export interface ReplaySettings {
  /** Seconds saved when you press "Salvar". */
  duration: ReplayDuration;
  quality: ReplayQuality;
  hotkey: ReplayHotkey | null;
  /** Desktop app: also write every clip to Videos\Voxa. */
  saveToDisk: boolean;
}

export const DEFAULT_REPLAY_SETTINGS: ReplaySettings = { duration: 60, quality: "1080p30", hotkey: "Alt+C", saveToDisk: true };

const KEY = "voxa.replay";

function load(): ReplaySettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const s = { ...DEFAULT_REPLAY_SETTINGS };
    if ((REPLAY_DURATIONS as readonly unknown[]).includes(raw.duration)) s.duration = raw.duration;
    if (typeof raw.quality === "string" && raw.quality in REPLAY_QUALITIES) s.quality = raw.quality;
    if (raw.hotkey === null || (REPLAY_HOTKEYS as readonly unknown[]).includes(raw.hotkey)) s.hotkey = raw.hotkey;
    if (typeof raw.saveToDisk === "boolean") s.saveToDisk = raw.saveToDisk;
    return s;
  } catch {
    return { ...DEFAULT_REPLAY_SETTINGS };
  }
}

let current = load();
const listeners = new Set<() => void>();

export const replaySettings = {
  get: () => current,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  update(patch: Partial<ReplaySettings>) {
    current = { ...current, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      // Storage unavailable: settings last for this session only.
    }
    listeners.forEach((l) => l());
  },
};

/** Whether a keydown matches a shortcut like "Alt+C" or "Ctrl+Shift+C". */
export function matchesHotkey(e: KeyboardEvent, hotkey: string): boolean {
  const parts = hotkey.split("+");
  const key = parts.at(-1)!;
  const want = new Set(parts.slice(0, -1));
  if (e.altKey !== want.has("Alt") || e.ctrlKey !== want.has("Ctrl") || e.shiftKey !== want.has("Shift") || e.metaKey) return false;
  // e.code survives keyboard layouts and Alt combinations that change e.key (e.g. Alt+C = "ç" on a Mac).
  return e.code === (key.length === 1 ? `Key${key}` : key);
}
