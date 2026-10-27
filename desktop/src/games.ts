// Game detection logic, kept free of Electron so it can be unit-tested.
//
// The desktop app lists running processes every few seconds and checks their
// executable names against a catalog (built-in list + the user's own entries).

import catalog from "./games-catalog.json" with { type: "json" };

export type GameCatalog = Record<string, string>; // lowercased exe name -> display name

export const BUILTIN_GAMES: GameCatalog = normalizeCatalog(catalog as Record<string, string>);

/** Lowercases keys and drops anything that isn't a plausible "name.exe" -> non-empty name pair. */
export function normalizeCatalog(raw: unknown): GameCatalog {
  const out: GameCatalog = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [exe, name] of Object.entries(raw)) {
    const key = exe.trim().toLowerCase();
    if (/^[^\\/:*?"<>|]+\.exe$/.test(key) && typeof name === "string" && name.trim()) {
      out[key] = name.trim().slice(0, 128);
    }
  }
  return out;
}

/**
 * Parses `tasklist /fo csv /nh` output into executable names.
 * Each line looks like: "Valorant.exe","1234","Console","1","1.234 K"
 */
export function parseTasklist(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * The game to show, or null. When several known games run at once, the one
 * already being shown wins (so the status doesn't flip back and forth);
 * otherwise the first in process order.
 */
export function detectGame(processNames: string[], games: GameCatalog, current: string | null): string | null {
  const found: string[] = [];
  for (const p of processNames) {
    const name = games[p.toLowerCase()];
    if (name && !found.includes(name)) found.push(name);
  }
  if (current && found.includes(current)) return current;
  return found[0] ?? null;
}
