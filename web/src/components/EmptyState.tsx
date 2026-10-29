// Empty screens (a new channel, no friends yet, nothing found): a small drawing in the
// Voxa style (a planet with an orbit and a few stars, in the theme's colors), a line of
// text, and what to do next.

import { useId, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon.tsx";

export function EmptyArt({ icon, size = 150 }: { icon: IconName; size?: number }) {
  const id = useId().replace(/:/g, "");
  const grad = `url(#g${id})`;
  const star = (x: number, y: number, r: number, o: number) => (
    <path d={`M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z`} fill="currentColor" opacity={o} />
  );
  return (
    <svg className="empty-art" width={size} height={size * 0.75} viewBox="0 0 160 120" aria-hidden="true">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--grad-1)" />
          <stop offset="1" stopColor="var(--grad-2)" />
        </linearGradient>
        <radialGradient id={`r${id}`}>
          <stop offset="0" stopColor="var(--grad-1)" stopOpacity="0.35" />
          <stop offset="1" stopColor="var(--grad-1)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="80" cy="62" r="56" fill={`url(#r${id})`} />
      <g className="empty-art-orbit">
        <ellipse cx="80" cy="62" rx="70" ry="19" transform="rotate(-14 80 62)" fill="none" stroke={grad} strokeWidth="1.5" opacity="0.55" />
        <circle cx="146" cy="47" r="5" fill={grad} />
      </g>
      <circle cx="80" cy="62" r="31" fill="var(--bg-float)" stroke={grad} strokeWidth="2" />
      <g transform="translate(62 44)" className="empty-art-icon">
        <Icon name={icon} size={36} />
      </g>
      {star(22, 24, 5, 0.7)}
      {star(136, 98, 4, 0.55)}
      {star(128, 16, 3, 0.45)}
      {star(30, 100, 3, 0.4)}
    </svg>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  actions,
  compact = false,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state-box ${compact ? "compact" : ""}`}>
      <EmptyArt icon={icon} size={compact ? 110 : 150} />
      <strong className="empty-title">{title}</strong>
      {children && <p className="muted">{children}</p>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  );
}
