// Auto-update from GitHub Releases (configured in electron-builder.yml).
// Updates download in the background and install on the next quit, or right
// away when the user clicks "Reiniciar" in the app.

import { app, type BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { IPC } from "./channels.ts";

const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 4 * 60 * 60_000;

let readyVersion: string | null = null;

export function initUpdater(getMainWindow: () => BrowserWindow | null) {
  // Only packaged builds have an update feed; in development there is nothing to check.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", (info) => {
    readyVersion = info.version;
    getMainWindow()?.webContents.send(IPC.updateReady, info.version);
  });
  autoUpdater.on("error", (err) => console.warn("update check failed:", err.message));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
}

/** Re-announce a downloaded update after the page reloads (the first announcement may have gone unheard). */
export function announcePendingUpdate(window: BrowserWindow) {
  if (readyVersion) window.webContents.send(IPC.updateReady, readyVersion);
}

export function installUpdate() {
  if (readyVersion) autoUpdater.quitAndInstall();
}
