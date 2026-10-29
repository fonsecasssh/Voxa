// How loud each person is for you ("Volume do usuário" and "Silenciar para mim"), by user
// id so it survives reconnecting. Kept in this browser only; the others never know.

export interface UserVolume {
  /** 0..2 (0–200%). */
  volume: number;
  muted: boolean;
}

export const DEFAULT_USER_VOLUME: UserVolume = { volume: 1, muted: false };
export const MAX_USER_VOLUME = 2;

const KEY = "voxa.userVolumes";

function load(): Record<string, UserVolume> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Partial<UserVolume>>;
    const out: Record<string, UserVolume> = {};
    for (const [id, v] of Object.entries(raw)) {
      const volume = typeof v?.volume === "number" ? Math.min(MAX_USER_VOLUME, Math.max(0, v.volume)) : 1;
      out[id] = { volume, muted: v?.muted === true };
    }
    return out;
  } catch {
    return {};
  }
}

let current = load();
const listeners = new Set<() => void>();

export const userVolumes = {
  all: () => current,
  get: (userId: string): UserVolume => current[userId] ?? DEFAULT_USER_VOLUME,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  set(userId: string, patch: Partial<UserVolume>) {
    const next = { ...userVolumes.get(userId), ...patch };
    current = { ...current };
    // Back to normal: forget it, so the stored list only holds real choices.
    if (next.volume === 1 && !next.muted) delete current[userId];
    else current[userId] = next;
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      // Storage unavailable: lasts for this session only.
    }
    listeners.forEach((l) => l());
  },
};
