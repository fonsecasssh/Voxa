// Bridge to the Voxa desktop app. `desktop` is undefined in a normal browser.

export interface DesktopSettings {
  startWithWindows: boolean;
  closeToTray: boolean;
  detectGames: boolean;
}

export interface VoxaDesktop {
  platform: string;
  setBadge(count: number): void;
  flash(): void;
  getActivity(): Promise<string | null>;
  onActivity(cb: (game: string | null) => void): () => void;
  getSettings(): Promise<DesktopSettings>;
  setSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  onUpdateReady(cb: (version: string) => void): () => void;
  installUpdate(): void;
}

export const desktop: VoxaDesktop | undefined = (window as unknown as { voxaDesktop?: VoxaDesktop }).voxaDesktop;

/** Latest Windows installer (GitHub Releases, published by the "Desktop" workflow). */
export const DOWNLOAD_URL = "https://github.com/fonsecasssh/Voxa/releases/latest";

/** Asks for notification permission once; call from a user gesture (browsers require it). */
export function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

/** Shows a system notification; clicking it focuses the app and runs `onClick`. */
export function notify(title: string, body: string, tag: string, onClick: () => void) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, tag, silent: false });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    // Some environments (e.g. Android Chrome) only allow notifications from a service worker.
  }
}
