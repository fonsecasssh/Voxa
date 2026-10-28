import { useSyncExternalStore } from "react";
import { replaySettings, type ReplaySettings } from "./settings.ts";

/** The device-local replay settings, re-rendering on change. */
export function useReplaySettings(): ReplaySettings {
  return useSyncExternalStore(replaySettings.subscribe, replaySettings.get);
}
