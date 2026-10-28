import { useSyncExternalStore } from "react";
import { audioSettings, type AudioSettings } from "./audioSettings.ts";

/** The device-local voice settings, re-rendering on change. */
export function useAudioSettings(): AudioSettings {
  return useSyncExternalStore(audioSettings.subscribe, audioSettings.get);
}
