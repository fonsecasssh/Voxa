// Push-to-talk that works while a game has focus: a global keyboard/mouse hook (uiohook)
// that tells the page only when THE chosen key or mouse button goes down or up. No other
// key ever leaves the main process. If the hook can't load, the page falls back to
// push-to-talk while Voxa has focus.

import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { IPC } from "./channels.ts";

/** What the page asks for: a key by its KeyboardEvent.code, or a mouse button by MouseEvent.button. */
export type PttBinding = { type: "key"; code: string } | { type: "mouse"; button: number };

type Hook = typeof import("uiohook-napi");

/** KeyboardEvent.code -> uiohook key name (the names uiohook's UiohookKey uses). */
export function uiohookKeyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return code;
  const map: Record<string, string> = {
    Backquote: "Backquote",
    Tab: "Tab",
    CapsLock: "CapsLock",
    Space: "Space",
    ShiftLeft: "Shift",
    ShiftRight: "ShiftRight",
    ControlLeft: "Ctrl",
    ControlRight: "CtrlRight",
    AltLeft: "Alt",
    AltRight: "AltRight",
    Minus: "Minus",
    Equal: "Equal",
    BracketLeft: "BracketLeft",
    BracketRight: "BracketRight",
    Backslash: "Backslash",
    Semicolon: "Semicolon",
    Quote: "Quote",
    Comma: "Comma",
    Period: "Period",
    Slash: "Slash",
    Insert: "Insert",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    NumpadAdd: "NumpadAdd",
    NumpadSubtract: "NumpadSubtract",
    NumpadMultiply: "NumpadMultiply",
    NumpadDivide: "NumpadDivide",
    NumpadDecimal: "NumpadDecimal",
    ScrollLock: "ScrollLock",
  };
  return Object.hasOwn(map, code) ? map[code] : null;
}

/** MouseEvent.button (0 left, 1 middle, 2 right, 3 back, 4 forward) -> uiohook's numbering (1, 3, 2, 4, 5). */
export const uiohookMouseButton = (button: number) => ({ 0: 1, 1: 3, 2: 2, 3: 4, 4: 5 })[button] ?? null;

export function isValidBinding(b: unknown): b is PttBinding {
  if (!b || typeof b !== "object") return false;
  const x = b as Record<string, unknown>;
  if (x.type === "key") return typeof x.code === "string" && uiohookKeyName(x.code) !== null;
  // Left and right click are never push-to-talk keys.
  return x.type === "mouse" && (x.button === 1 || x.button === 3 || x.button === 4);
}

let hook: Hook | null | undefined;
function loadHook(): Hook | null {
  if (hook !== undefined) return hook;
  try {
    // Shipped next to main.js (see scripts/build.mjs), outside the asar archive.
    hook = require(path.join(__dirname, "node_modules", "uiohook-napi")) as Hook;
  } catch (err) {
    console.warn("push-to-talk global indisponível:", (err as Error).message);
    hook = null;
  }
  return hook;
}

export function registerPttIpc(getWindow: () => BrowserWindow | null, fromApp: (e: IpcMainInvokeEvent) => boolean) {
  let target: { kind: "key"; code: number } | { kind: "mouse"; button: number } | null = null;
  let pressed = false;
  let started = false;

  const emit = (down: boolean) => {
    if (down === pressed) return;
    pressed = down;
    getWindow()?.webContents.send(IPC.pttState, down);
  };

  const start = (h: Hook) => {
    if (started) return;
    started = true;
    h.uIOhook.on("keydown", (e) => target?.kind === "key" && e.keycode === target.code && emit(true));
    h.uIOhook.on("keyup", (e) => target?.kind === "key" && e.keycode === target.code && emit(false));
    h.uIOhook.on("mousedown", (e) => target?.kind === "mouse" && e.button === target.button && emit(true));
    h.uIOhook.on("mouseup", (e) => target?.kind === "mouse" && e.button === target.button && emit(false));
    h.uIOhook.start();
    app.on("will-quit", () => h.uIOhook.stop());
  };

  /** Sets (or clears, with null) the binding; true when the global hook is active for it. */
  ipcMain.handle(IPC.pttSet, (e, binding: unknown) => {
    if (!fromApp(e)) return false;
    emit(false);
    if (binding === null) {
      target = null;
      return true;
    }
    if (!isValidBinding(binding)) return false;
    const h = loadHook();
    if (!h) return false;
    if (binding.type === "key") {
      const keys = h.UiohookKey as Record<string, number>;
      const name = uiohookKeyName(binding.code)!;
      if (!Object.hasOwn(keys, name)) return false;
      const code = keys[name];
      target = { kind: "key", code };
    } else {
      target = { kind: "mouse", button: uiohookMouseButton(binding.button)! };
    }
    start(h);
    return true;
  });

  return {
    /** The page reloaded: forget the binding until it sets one again. */
    release: () => {
      emit(false);
      target = null;
    },
  };
}
