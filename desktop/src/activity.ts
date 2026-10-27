// Polls the running processes and reports which known game is being played.
//
// Windows only: other platforms report nothing. The user's own games live in
// userData/custom-games.json as { "jogo.exe": "Nome do jogo" } and take
// precedence over the built-in catalog.

import { app } from "electron";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BUILTIN_GAMES, detectGame, normalizeCatalog, parseTasklist, type GameCatalog } from "./games.ts";

const POLL_MS = 10_000;
const TASKLIST_TIMEOUT_MS = 8_000;

export const customGamesFile = () => path.join(app.getPath("userData"), "custom-games.json");

function loadCatalog(): GameCatalog {
  let custom: GameCatalog = {};
  try {
    custom = normalizeCatalog(JSON.parse(readFileSync(customGamesFile(), "utf8")));
  } catch {
    // No custom file (the normal case) or invalid JSON.
  }
  return { ...BUILTIN_GAMES, ...custom };
}

/** Process names, or null when they can't be read on this platform. */
function listProcesses(): Promise<string[] | null> {
  // Test seam: a file with one process name per line stands in for tasklist.
  const fake = process.env.VOXA_TEST_PROCESS_FILE;
  if (fake) {
    try {
      return Promise.resolve(readFileSync(fake, "utf8").split(/\r?\n/).filter(Boolean));
    } catch {
      return Promise.resolve([]);
    }
  }
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "tasklist",
      ["/fo", "csv", "/nh"],
      { timeout: TASKLIST_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : parseTasklist(stdout)),
    );
  });
}

export function startGameDetection(onChange: (game: string | null) => void) {
  let current: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async () => {
    const processes = await listProcesses();
    if (stopped) return;
    if (processes) {
      // The catalog is re-read every poll so edits to custom-games.json apply without a restart.
      const game = detectGame(processes, loadCatalog(), current);
      if (game !== current) {
        current = game;
        onChange(game);
      }
    }
    timer = setTimeout(tick, POLL_MS);
  };
  tick();

  return {
    current: () => current,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (current !== null) {
        current = null;
        onChange(null);
      }
    },
  };
}
