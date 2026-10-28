// Small line icons (24x24 viewBox, drawn with the current text color).

import type { ReactNode } from "react";

export type IconName =
  | "mic"
  | "micOff"
  | "headphones"
  | "headphonesOff"
  | "gear"
  | "hangup"
  | "signal"
  | "screen"
  | "screenOff"
  | "waveform"
  | "gamepad"
  | "chevron"
  | "arrowRight"
  | "expand"
  | "shrink"
  | "fullscreen";

/** A gear outline: `teeth` rectangular teeth around a ring. */
function gearPath(teeth = 8, outer = 10, inner = 7.6): string {
  const pts: string[] = [];
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const corners = [
      [inner, a - step * 0.32],
      [outer, a - step * 0.2],
      [outer, a + step * 0.2],
      [inner, a + step * 0.32],
    ];
    for (const [r, t] of corners) pts.push(`${(12 + r * Math.cos(t)).toFixed(2)} ${(12 + r * Math.sin(t)).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
}
const GEAR = gearPath();

const slash = <path d="M4 4l16 16" />;

const ICONS: Record<IconName, ReactNode> = {
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" />
    </>
  ),
  micOff: (
    <>
      <path d="M15 10.5V6a3 3 0 0 0-5.6-1.5M9 9v2a3 3 0 0 0 4.7 2.5" />
      <path d="M5.5 11a6.5 6.5 0 0 0 10.6 5M18.4 12.5a6.5 6.5 0 0 0 .1-1.5M12 17.5V21M9 21h6" />
      {slash}
    </>
  ),
  headphones: (
    <>
      <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
      <rect x="3" y="14" width="4.5" height="7" rx="1.6" />
      <rect x="16.5" y="14" width="4.5" height="7" rx="1.6" />
    </>
  ),
  headphonesOff: (
    <>
      <path d="M4 15v-3a8 8 0 0 1 12.2-6.8M19.5 9.5c.3.8.5 1.6.5 2.5v3" />
      <rect x="3" y="14" width="4.5" height="7" rx="1.6" />
      <rect x="16.5" y="14" width="4.5" height="7" rx="1.6" />
      {slash}
    </>
  ),
  gear: (
    <>
      <path d={GEAR} />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  hangup: <path d="M3.5 14.5c4.7-4.6 12.3-4.6 17 0l-1.9 2.6-3.7-1.2.1-2.4a10 10 0 0 0-6 0l.1 2.4-3.7 1.2z" />,
  signal: (
    <>
      <path d="M5 19v-3M9.5 19v-6M14 19v-9M18.5 19V6" />
    </>
  ),
  screen: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4M9.5 10l2.5-2.5L14.5 10M12 7.5V13" />
    </>
  ),
  screenOff: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4M9.5 8l5 5M14.5 8l-5 5" />
    </>
  ),
  waveform: <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />,
  gamepad: (
    <>
      <path d="M7 8h10a4 4 0 0 1 4 4.4l-.5 3.6a2.6 2.6 0 0 1-4.6 1.3L14.5 15h-5l-1.4 2.3A2.6 2.6 0 0 1 3.5 16L3 12.4A4 4 0 0 1 7 8z" />
      <path d="M8 11v3M6.5 12.5h3M15.5 12h.01M17.5 13.5h.01" />
    </>
  ),
  chevron: <path d="M7 10l5 5 5-5" />,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  expand: <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />,
  shrink: <path d="M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7" />,
  fullscreen: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
};

export function Icon({ name, size = 20, title }: { name: IconName; size?: number; title?: string }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title && <title>{title}</title>}
      {ICONS[name]}
    </svg>
  );
}
