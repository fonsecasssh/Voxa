// IPC channel names shared by the main process and the preloads, so a rename
// can't leave one side listening on a string the other stopped sending.

export const IPC = {
  /** renderer -> main: number of unread conversations, and the badge image drawn by the preload. */
  setBadge: "voxa:badge:set",
  /** main -> renderer: the detected game changed (name or null). */
  activity: "voxa:activity",
  /** renderer -> main: the game currently detected, to sync after a page load. */
  activityGet: "voxa:activity:get",
  /** renderer -> main: app settings (start with Windows, close to tray, game detection). */
  settingsGet: "voxa:settings:get",
  settingsSet: "voxa:settings:set",
  /** renderer -> main: flash the taskbar button to draw attention (new DM while unfocused). */
  flash: "voxa:flash",
  /** main -> renderer: an update was downloaded and will install on restart. */
  updateReady: "voxa:update:ready",
  /** renderer -> main: restart now to install it. */
  updateInstall: "voxa:update:install",

  /** renderer -> main: global shortcut that saves an instant replay (one of REPLAY_HOTKEYS, or null for none). */
  replaySetHotkey: "voxa:replay:hotkey:set",
  /** main -> renderer: the replay shortcut was pressed. */
  replayHotkey: "voxa:replay:hotkey",
  /** renderer -> main: save a clip to Videos\Voxa (returns its path). */
  replaySave: "voxa:replay:save",
  /** renderer -> main: show a saved clip in Explorer. */
  replayShow: "voxa:replay:show",

  /** picker -> main: sources to choose from. */
  pickerList: "voxa:picker:list",
  /** picker -> main: the choice, or null when cancelled. */
  pickerChoose: "voxa:picker:choose",
} as const;

export interface DesktopSettings {
  startWithWindows: boolean;
  closeToTray: boolean;
  detectGames: boolean;
}

export interface PickerSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnail: string; // data URL
  icon: string | null; // data URL
}

export interface PickerData {
  sources: PickerSource[];
  /** Whether system audio can be shared on this OS. */
  audioSupported: boolean;
}

export interface PickerChoice {
  sourceId: string;
  audio: boolean;
}
