// The Voxa mark: a "V" drawn as equalizer bars, in the violet → cyan gradient.
// The same drawing is in web/public/favicon.svg and the desktop app icons.

import { useId } from "react";

/** Bars as [x, y, height] on a 24×24 grid; their tops trace the V. */
export const LOGO_BARS: [number, number, number][] = [
  [2, 3, 15],
  [5.6, 6.5, 11.5],
  [9.2, 10.5, 10.5],
  [12.8, 10.5, 10.5],
  [16.4, 6.5, 11.5],
  [20, 3, 15],
];

export function Logo({ size = 28, title }: { size?: number; title?: string }) {
  // useId() contains characters like ":" or "«" that url(#…) references don't like.
  const gradient = "vx-logo" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <svg
      className="logo"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--grad-1)" }} />
          <stop offset="1" style={{ stopColor: "var(--grad-2)" }} />
        </linearGradient>
      </defs>
      <g fill={`url(#${gradient})`}>
        {LOGO_BARS.map(([x, y, h]) => (
          <rect key={x} x={x} y={y} width={2.6} height={h} rx={1.3} />
        ))}
      </g>
    </svg>
  );
}

/** The mark next to the "voxa" wordmark, for the login and invite pages. */
export function Wordmark({ size = 34 }: { size?: number }) {
  return (
    <span className="wordmark" style={{ fontSize: size }}>
      <Logo size={size * 1.05} />
      <span className="wordmark-text">voxa</span>
    </span>
  );
}
