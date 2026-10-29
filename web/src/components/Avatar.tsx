import type { Presence, PresenceStatus, Server } from "../api.ts";

// Deep tones that sit well on the Galáxia background and keep white initials readable.
const COLORS = ["#5b3fd1", "#2f6fd6", "#16808f", "#1f8a62", "#b0457a", "#c2553a", "#7a3fb8", "#3d4fc4"];

function hashOf(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function colorFor(id: string): string {
  return COLORS[hashOf(id) % COLORS.length];
}

/** A server's own two-tone gradient (from its id), so servers without an icon still look different. */
export function serverGradient(id: string): string {
  const h = hashOf(id);
  const hue = h % 360;
  const shift = 35 + ((h >>> 9) % 50);
  const angle = 120 + ((h >>> 3) % 4) * 30;
  return `linear-gradient(${angle}deg, hsl(${hue} 70% 56%), hsl(${(hue + shift) % 360} 72% 40%))`;
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

interface AvatarProps {
  name: string;
  id: string;
  size?: number;
  status?: PresenceStatus;
  /** Profile picture URL; the colored initials are shown without one. */
  src?: string | null;
}

export function Avatar({ name, id, size = 40, status, src }: AvatarProps) {
  return (
    <span
      className={`avatar ${src ? "has-image" : ""}`}
      style={{ width: size, height: size, background: src ? undefined : colorFor(id), fontSize: size * 0.38 }}
    >
      {src ? <img src={src} alt="" draggable={false} /> : initials(name)}
      {status && <span className={`presence-dot ${status}`} title={STATUS_LABEL[status]} />}
    </span>
  );
}

/** A server's icon image, or its initials when it has none. */
export function ServerIcon({ server, size = 48 }: { server: Pick<Server, "id" | "name" | "icon">; size?: number }) {
  if (!server.icon) {
    return (
      <span className="avatar server-initials" style={{ width: size, height: size, background: serverGradient(server.id), fontSize: size * 0.36 }}>
        {initials(server.name)}
      </span>
    );
  }
  return <img className="avatar server-icon" src={server.icon} alt="" width={size} height={size} draggable={false} />;
}
