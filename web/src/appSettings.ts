// Look and sound of the app on this device (kept in localStorage, like the voice settings).

export const THEMES = [
  { id: "galaxia", name: "Galáxia", hint: "Violeta → ciano (padrão)", g1: "#9d5cff", g2: "#3dd6ff", bg: "#181728" },
  { id: "amoled", name: "AMOLED", hint: "Preto puro, para jogar à noite", g1: "#9d5cff", g2: "#3dd6ff", bg: "#000000" },
  { id: "pulso", name: "Pulso", hint: "Roxo → magenta", g1: "#8b6bff", g2: "#ff4fa3", bg: "#1b1928" },
  { id: "oceano", name: "Oceano", hint: "Azul → ciano", g1: "#3a7bff", g2: "#2ee6d6", bg: "#141b28" },
  { id: "boreal", name: "Boreal", hint: "Menta → azul", g1: "#2ee6a8", g2: "#6b8cff", bg: "#131d1f" },
  { id: "por-do-sol", name: "Pôr do sol", hint: "Laranja → dourado", g1: "#ff6a3d", g2: "#ffc24b", bg: "#1f1813" },
  { id: "cereja", name: "Cereja", hint: "Vermelho-rosa → pêssego", g1: "#ff3d6e", g2: "#ff9a62", bg: "#1f1519" },
  { id: "fogo-gelo", name: "Fogo e gelo", hint: "Ciano → coral", g1: "#3dd6ff", g2: "#ff6a5c", bg: "#161c21" },
  { id: "neblina", name: "Neblina", hint: "Lavanda → pêssego, pastel", g1: "#c3b1ff", g2: "#ffb8a0", bg: "#1b1a20" },
] as const;
export type ThemeId = (typeof THEMES)[number]["id"];

export interface AppSettings {
  theme: ThemeId;
  sounds: boolean;
  /** 0..1 */
  soundVolume: number;
}

export const DEFAULT_APP_SETTINGS: AppSettings = { theme: "galaxia", sounds: true, soundVolume: 0.6 };

const KEY = "voxa.app";

function load(): AppSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const s = { ...DEFAULT_APP_SETTINGS };
    if (THEMES.some((t) => t.id === raw.theme)) s.theme = raw.theme;
    if (typeof raw.sounds === "boolean") s.sounds = raw.sounds;
    if (typeof raw.soundVolume === "number") s.soundVolume = Math.min(1, Math.max(0, raw.soundVolume));
    return s;
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

let current = load();
const listeners = new Set<() => void>();

export const appSettings = {
  get: () => current,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  update(patch: Partial<AppSettings>) {
    current = { ...current, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      // Storage unavailable: settings last for this session only.
    }
    if (patch.theme) applyTheme(current.theme);
    listeners.forEach((l) => l());
  },
};

/** Switches the CSS tokens (see the themes section of styles.css) and the browser's UI color. */
export function applyTheme(theme: ThemeId) {
  const root = document.documentElement;
  if (theme === "galaxia") delete root.dataset.theme;
  else root.dataset.theme = theme;
  const bar = getComputedStyle(root).getPropertyValue("--bg-rail").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bar || "#08070f");
}
