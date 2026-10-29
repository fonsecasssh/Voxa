import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, ipcMain: {} }));
const { isValidBinding, uiohookKeyName, uiohookMouseButton } = await import("../src/ptt.ts");
const { UiohookKey } = createRequire(import.meta.url)("uiohook-napi") as { UiohookKey: Record<string, number> };

describe("push-to-talk bindings", () => {
  it("maps every key the page can record to a real uiohook key", () => {
    const codes = ["KeyA", "KeyZ", "Digit0", "Digit9", "F1", "F13", "F24", "Numpad5", "Backquote", "Space", "CapsLock", "Tab"];
    codes.push("ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "Minus", "Equal", "BracketLeft");
    codes.push("BracketRight", "Backslash", "Semicolon", "Quote", "Comma", "Period", "Slash", "Insert", "Delete", "Home", "End");
    codes.push("PageUp", "PageDown", "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal", "ScrollLock");
    for (const code of codes) {
      const name = uiohookKeyName(code);
      expect(name, code).not.toBeNull();
      expect(UiohookKey[name!], code).toBeTypeOf("number");
    }
    expect(UiohookKey[uiohookKeyName("Backquote")!]).toBe(41);
    expect(UiohookKey[uiohookKeyName("ControlRight")!]).toBe(3613);
  });

  it("rejects unknown keys and left/right click", () => {
    expect(uiohookKeyName("F25")).toBeNull();
    expect(uiohookKeyName("Key")).toBeNull();
    expect(uiohookKeyName("constructor")).toBeNull();
    expect(isValidBinding({ type: "key", code: "Backquote" })).toBe(true);
    expect(isValidBinding({ type: "key", code: "__proto__" })).toBe(false);
    expect(isValidBinding({ type: "mouse", button: 0 })).toBe(false);
    expect(isValidBinding({ type: "mouse", button: 2 })).toBe(false);
    expect(isValidBinding({ type: "mouse", button: 3 })).toBe(true);
    expect(isValidBinding(null)).toBe(false);
    expect(isValidBinding("Backquote")).toBe(false);
  });

  it("translates DOM mouse buttons to uiohook's numbering", () => {
    expect(uiohookMouseButton(1)).toBe(3);
    expect(uiohookMouseButton(3)).toBe(4);
    expect(uiohookMouseButton(4)).toBe(5);
  });
});
