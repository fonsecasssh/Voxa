import type { Presence, PresenceStatus } from "../api.ts";

const COLORS = ["#5865f2", "#3ba55c", "#faa61a", "#ed4245", "#eb459e", "#1abc9c", "#9b59b6", "#e67e22"];

function colorFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

export const STATUS_LABEL: Record<PresenceStatus | "invisible", string> = {
  online: "Disponível",
  idle: "Ausente",
  dnd: "Não perturbe",
  invisible: "Invisível",
  offline: "Offline",
};

/** One line describing what someone is up to: their activity, or else their status. */
export function presenceText(p: Presence | undefined): string {
  if (p?.activity) return `Jogando ${p.activity.name}`;
  return STATUS_LABEL[p?.status ?? "offline"];
}

export function Avatar({ name, id, size = 40, status }: { name: string; id: string; size?: number; status?: PresenceStatus }) {
  return (
    <span className="avatar" style={{ width: size, height: size, background: colorFor(id), fontSize: size * 0.38 }}>
      {initials(name)}
      {status && <span className={`presence-dot ${status}`} title={STATUS_LABEL[status]} />}
    </span>
  );
}
