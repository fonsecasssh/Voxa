// User preferences for the desktop app, stored in userData/settings.json.

import { app } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DesktopSettings } from "./channels.ts";

const DEFAULTS: DesktopSettings = { startWithWindows: true, closeToTray: true, detectGames: true };

const file = () => path.join(app.getPath("userData"), "settings.json");

let cached: DesktopSettings | null = null;

export function getSettings(): DesktopSettings {
  if (cached) return cached;
  let stored: Partial<DesktopSettings> = {};
  try {
    stored = JSON.parse(readFileSync(file(), "utf8"));
  } catch {
    // First run, or a corrupt file: fall back to defaults.
  }
  cached = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof DesktopSettings)[]) {
    if (typeof stored[key] === "boolean") cached[key] = stored[key];
  }
  return cached;
}

/** Whether settings.json existed before this launch (to apply first-run defaults once). */
export function isFirstRun(): boolean {
  try {
    readFileSync(file());
    return false;
  } catch {
    return true;
  }
}

export function updateSettings(patch: Partial<DesktopSettings>): DesktopSettings {
  const next = { ...getSettings() };
  for (const key of Object.keys(DEFAULTS) as (keyof DesktopSettings)[]) {
    if (typeof patch[key] === "boolean") next[key] = patch[key];
  }
  cached = next;
  // Write-then-rename so a crash mid-write can't leave a half-written file.
  mkdirSync(path.dirname(file()), { recursive: true });
  writeFileSync(file() + ".tmp", JSON.stringify(next, null, 2));
  renameSync(file() + ".tmp", file());
  return next;
}
