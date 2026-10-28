import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "C:\\\\Users\\\\x\\\\Videos" }, globalShortcut: {}, ipcMain: {}, shell: {} }));
const { REPLAY_HOTKEYS, isClipFileName, isInFolder } = await import("../src/replay.ts");

describe("replay file checks", () => {
  it("accepts only the names the page generates", () => {
    expect(isClipFileName("Voxa 2026-10-28 21-14-03.mp4")).toBe(true);
    expect(isClipFileName("Voxa 2026-10-28 21-14-03 (2).webm")).toBe(true);
    expect(isClipFileName("../Voxa 2026-10-28 21-14-03.mp4")).toBe(false);
    expect(isClipFileName("Voxa 2026-10-28 21-14-03.exe")).toBe(false);
    expect(isClipFileName("Voxa 2026-10-28 21-14-03.mp4\u0000.exe")).toBe(false);
    expect(isClipFileName(42)).toBe(false);
  });

  it("only reveals clips directly inside the clips folder", () => {
    const folder = "/home/x/Videos/Voxa";
    expect(isInFolder(folder, "/home/x/Videos/Voxa/Voxa 2026-10-28 21-14-03.mp4")).toBe(true);
    expect(isInFolder(folder, "/home/x/Videos/Voxa/../Voxa 2026-10-28 21-14-03.mp4")).toBe(false);
    expect(isInFolder(folder, "/home/x/Videos/Voxa/sub/Voxa 2026-10-28 21-14-03.mp4")).toBe(false);
    expect(isInFolder(folder, "/etc/passwd")).toBe(false);
  });

  it("offers a fixed set of shortcuts", () => {
    expect(REPLAY_HOTKEYS).toContain("Alt+C");
  });
});
