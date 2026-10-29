// Small line icons (24x24 viewBox, drawn with the current text color).

import type { ReactNode } from "react";

export type IconName =
  | "mic"
  | "speaker"
  | "speakerOff"
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
  | "fullscreen"
  | "replay"
  | "save"
  | "close"
  | "trash"
  | "smile"
  | "plus"
  | "file"
  | "reply"
  | "pencil";

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
  speaker: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
    </>
  ),
  speakerOff: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      <path d="M16 9.5l5 5M21 9.5l-5 5" />
    </>
  ),
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
  replay: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4 4v4h4" />
      <path d="M10.5 9.2v5.6l4.6-2.8z" />
    </>
  ),
  save: <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12a2 2 0 0 0 2 1.8h7a2 2 0 0 0 2-1.8l1-12M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  reply: <path d="M10 7 5 12l5 5M5 12h9a5 5 0 0 1 5 5v1" />,
  pencil: <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4" />,
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  smile: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01" />
    </>
  ),
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
