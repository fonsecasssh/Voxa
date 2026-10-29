// Notification settings on this side (the server applies the same rules to push):
// a channel's own setting wins over its server's; DMs notify every message by default,
// servers only mentions; muting silences everything until it ends.

export type NotifyLevel = "all" | "mentions" | "none";
export type NotifySettings = Record<string, { level: NotifyLevel | null; mutedUntil: number | null }>;

/** Muted "until I turn it back on". */
export const FOREVER = 8_640_000_000_000_000;

export function notifyFor(settings: NotifySettings, channelId: string, serverId: string | null, now = Date.now()) {
  const ch = settings[channelId];
  const sv = serverId ? settings[serverId] : undefined;
  const active = (s?: { mutedUntil: number | null }) => !!s?.mutedUntil && s.mutedUntil > now;
  const level: NotifyLevel = ch?.level ?? sv?.level ?? (serverId ? "mentions" : "all");
  return { muted: active(ch) || active(sv) || level === "none", level };
}

/** Whether this target itself (not through its server) is muted right now. */
export const isMuted = (settings: NotifySettings, targetId: string, now = Date.now()) => {
  const until = settings[targetId]?.mutedUntil;
  return !!until && until > now;
};
