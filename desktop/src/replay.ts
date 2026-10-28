// Instant replay support for the web page: a global shortcut that works while a game has
// focus, and saving clips to Videos\Voxa. The recording itself happens in the page
// (WebCodecs); the main process only ever writes files it names and checks itself.

import { app, globalShortcut, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { IPC } from "./channels.ts";

/** Shortcuts the page may ask for (never arbitrary accelerators from remote content). */
export const REPLAY_HOTKEYS = ["Alt+C", "Alt+F10", "Alt+F9", "Ctrl+Shift+C"] as const;
export const MAX_SAVED_CLIP_BYTES = 1024 * 1024 * 1024;

/** File names the page may save: what it generates, e.g. "Voxa 2026-10-28 21-14-03.mp4". */
export function isClipFileName(name: unknown): name is string {
  return typeof name === "string" && /^Voxa [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}-[0-9]{2}-[0-9]{2}( \([0-9]{1,3}\))?\.(mp4|webm)$/.test(name);
}

export const clipsFolder = () => path.join(app.getPath("videos"), "Voxa");

/** Whether `file` is directly inside the clips folder (the only place "show in folder" may reveal). */
export function isInFolder(folder: string, file: unknown): file is string {
  return typeof file === "string" && path.dirname(path.resolve(file)) === path.resolve(folder) && isClipFileName(path.basename(file));
}

export function registerReplayIpc(getWindow: () => BrowserWindow | null, fromApp: (e: IpcMainInvokeEvent) => boolean) {
  let hotkey: string | null = null;

  const setHotkey = (accelerator: string | null): boolean => {
    if (hotkey) globalShortcut.unregister(hotkey);
    hotkey = null;
    if (!accelerator) return true;
    // Fails when another program (e.g. GeForce Experience) already owns the shortcut.
    const ok = globalShortcut.register(accelerator, () => getWindow()?.webContents.send(IPC.replayHotkey));
    if (ok) hotkey = accelerator;
    return ok;
  };

  ipcMain.handle(IPC.replaySetHotkey, (e, accelerator: unknown) => {
    if (!fromApp(e)) return false;
    if (accelerator !== null && !(REPLAY_HOTKEYS as readonly unknown[]).includes(accelerator)) return false;
    return setHotkey(accelerator as string | null);
  });

  ipcMain.handle(IPC.replaySave, async (e, name: unknown, data: unknown) => {
    if (!fromApp(e) || !isClipFileName(name) || !(data instanceof Uint8Array) || data.byteLength > MAX_SAVED_CLIP_BYTES) return null;
    const folder = clipsFolder();
    await mkdir(folder, { recursive: true });
    // Never overwrite: two clips saved in the same second get "(1)", "(2)"...
    for (let i = 0; i < 100; i++) {
      const file = path.join(folder, i === 0 ? name : name.replace(/(\.[a-z0-9]+)$/, ` (${i})$1`));
      try {
        await writeFile(file, data, { flag: "wx" });
        return file;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    return null;
  });

  ipcMain.handle(IPC.replayShow, (e, file: unknown) => {
    if (fromApp(e) && isInFolder(clipsFolder(), file)) shell.showItemInFolder(file);
  });

  // The page reloaded or closed: it re-registers when it records again.
  const release = () => setHotkey(null);
  app.on("will-quit", release);
  return { release };
}
