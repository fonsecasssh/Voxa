// The only thing the (remote) web page gets from the desktop app: a small,
// explicit API on window.voxaDesktop. No Node, no raw ipcRenderer.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type DesktopSettings } from "./channels.ts";

/** Draws the taskbar overlay badge (a red dot with the count) as a PNG data URL. */
function drawBadge(count: number): string | null {
  if (count <= 0) return null;
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ed4245";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  const text = count > 9 ? "9+" : String(count);
  ctx.fillStyle = "#fff";
  ctx.font = `bold ${text.length > 1 ? 17 : 21}px "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, size / 2, size / 2 + 1);
  return canvas.toDataURL("image/png");
}

function subscribe<T>(channel: string, cb: (value: T) => void) {
  const listener = (_e: IpcRendererEvent, value: T) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("voxaDesktop", {
  platform: process.platform,

  setBadge(count: number) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    ipcRenderer.send(IPC.setBadge, n, drawBadge(n));
  },
  flash: () => ipcRenderer.send(IPC.flash),

  getActivity: (): Promise<string | null> => ipcRenderer.invoke(IPC.activityGet),
  onActivity: (cb: (game: string | null) => void) => subscribe(IPC.activity, cb),

  getSettings: (): Promise<DesktopSettings> => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch: Partial<DesktopSettings>): Promise<DesktopSettings> => ipcRenderer.invoke(IPC.settingsSet, patch),

  onUpdateReady: (cb: (version: string) => void) => subscribe(IPC.updateReady, cb),
  installUpdate: () => ipcRenderer.send(IPC.updateInstall),
});
