import { describe, expect, it } from "vitest";
import { BUILTIN_GAMES, detectGame, normalizeCatalog, parseTasklist } from "../src/games.ts";
import { deepLinkToPath } from "../src/config.ts";

const TASKLIST = [
  '"System Idle Process","0","Services","0","8 K"',
  '"explorer.exe","4321","Console","1","120.000 K"',
  '"VALORANT-Win64-Shipping.exe","9876","Console","1","2.100.000 K"',
  '"Voxa.exe","555","Console","1","300.000 K"',
  "",
].join("\r\n");

describe("parseTasklist", () => {
  it("extracts image names from CSV output", () => {
    expect(parseTasklist(TASKLIST)).toEqual(["System Idle Process", "explorer.exe", "VALORANT-Win64-Shipping.exe", "Voxa.exe"]);
  });
  it("ignores garbage lines", () => {
    expect(parseTasklist("INFO: No tasks are running\n\n")).toEqual([]);
  });
});

describe("detectGame", () => {
  const games = { "a.exe": "Jogo A", "b.exe": "Jogo B" };

  it("matches case-insensitively against the catalog", () => {
    expect(detectGame(parseTasklist(TASKLIST), BUILTIN_GAMES, null)).toBe("VALORANT");
    expect(detectGame(["A.EXE"], games, null)).toBe("Jogo A");
  });
  it("returns null when nothing known runs", () => {
    expect(detectGame(["explorer.exe", "chrome.exe"], games, null)).toBeNull();
  });
  it("sticks with the current game when several run", () => {
    expect(detectGame(["a.exe", "b.exe"], games, null)).toBe("Jogo A");
    expect(detectGame(["a.exe", "b.exe"], games, "Jogo B")).toBe("Jogo B");
    expect(detectGame(["a.exe"], games, "Jogo B")).toBe("Jogo A");
  });
});

describe("normalizeCatalog", () => {
  it("keeps valid exe -> name pairs and lowercases keys", () => {
    expect(normalizeCatalog({ "Meu Jogo.EXE": " Meu Jogo ", "notexe.bat": "x", "bad/path.exe": "y", "empty.exe": "" })).toEqual({
      "meu jogo.exe": "Meu Jogo",
    });
  });
  it("tolerates invalid input", () => {
    expect(normalizeCatalog(null)).toEqual({});
    expect(normalizeCatalog(["a.exe"])).toEqual({});
  });
  it("ships a sane built-in catalog", () => {
    expect(Object.keys(BUILTIN_GAMES).length).toBeGreaterThan(50);
    expect(BUILTIN_GAMES["javaw.exe"]).toBeUndefined(); // too generic to mean "Minecraft"
  });
});

describe("deepLinkToPath", () => {
  it("maps invite and channel links to site paths", () => {
    expect(deepLinkToPath("voxa://invite/AbC123")).toBe("/invite/AbC123");
    expect(deepLinkToPath("voxa://channels/@me")).toBe("/channels/@me");
  });
  it("rejects other schemes and odd paths", () => {
    expect(deepLinkToPath("https://evil.com/invite/x")).toBeNull();
    expect(deepLinkToPath("voxa://invite/../../etc")).toBeNull();
    expect(deepLinkToPath("voxa://settings")).toBeNull();
    expect(deepLinkToPath("not a url")).toBeNull();
  });
});
