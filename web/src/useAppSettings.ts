import { useSyncExternalStore } from "react";
import { appSettings, type AppSettings } from "./appSettings.ts";

/** The device-local look and sound settings, re-rendering on change. */
export function useAppSettings(): AppSettings {
  return useSyncExternalStore(appSettings.subscribe, appSettings.get);
}
