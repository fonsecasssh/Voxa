// Screen picker. Electron doesn't ship Chrome's "choose what to share" dialog,
// so without this getDisplayMedia() simply fails. When the page asks to share,
// we open a small window listing screens and windows, and hand the choice back.

import { BrowserWindow, desktopCapturer, ipcMain, session, type DesktopCapturerSource } from "electron";
import path from "node:path";
import { IPC, type PickerChoice, type PickerData } from "./channels.ts";

// Loopback audio capture of the whole system mix is available on Windows.
const AUDIO_SUPPORTED = process.platform === "win32";

let pending: {
  window: BrowserWindow;
  sources: DesktopCapturerSource[];
  resolve: (choice: PickerChoice | null) => void;
} | null = null;

function openPicker(parent: BrowserWindow, sources: DesktopCapturerSource[]): Promise<PickerChoice | null> {
  return new Promise((resolve) => {
    const window = new BrowserWindow({
      parent,
      modal: true,
      width: 760,
      height: 560,
      minWidth: 520,
      minHeight: 400,
      title: "Compartilhar tela",
      backgroundColor: "#1c1d24",
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "picker-preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    pending = { window, sources, resolve };
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      if (pending?.window === window) {
        pending = null;
        resolve(null);
      }
    });
    window.loadFile(path.join(__dirname, "picker.html"));
  });
}

export function registerPicker(getMainWindow: () => BrowserWindow | null) {
  ipcMain.handle(IPC.pickerList, (event): PickerData => {
    if (!pending || event.sender !== pending.window.webContents) return { sources: [], audioSupported: false };
    return {
      audioSupported: AUDIO_SUPPORTED,
      sources: pending.sources.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith("screen:") ? "screen" : "window",
        thumbnail: s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      })),
    };
  });

  ipcMain.on(IPC.pickerChoose, (event, choice: unknown) => {
    if (!pending || event.sender !== pending.window.webContents) return;
    const { window, sources, resolve } = pending;
    pending = null;
    const c = choice as Partial<PickerChoice> | null;
    const valid = c && typeof c.sourceId === "string" && sources.some((s) => s.id === c.sourceId);
    resolve(valid ? { sourceId: c.sourceId!, audio: !!c.audio && AUDIO_SUPPORTED } : null);
    window.close();
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const parent = getMainWindow();
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    // Don't offer our own windows: sharing them shows an infinite mirror.
    const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
    const offered = sources.filter((s) => !own.has(s.id));

    const choice = parent && offered.length ? await openPicker(parent, offered) : null;
    const source = choice && offered.find((s) => s.id === choice.sourceId);
    if (!source) {
      // Calling back with nothing rejects getDisplayMedia, like cancelling Chrome's dialog.
      callback({});
      return;
    }
    callback(choice.audio && request.audioRequested ? { video: source, audio: "loopback" } : { video: source });
  });
}
