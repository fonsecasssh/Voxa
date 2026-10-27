// Where the Voxa web app lives. The desktop app is a shell around it: the
// window loads that site, and everything below only adds what a browser can't.
//
// Resolution order: VOXA_URL env var (development), then app-config.json written
// at build time from VOXA_APP_URL, then a local server.

import { readFileSync } from "node:fs";
import path from "node:path";

function fromBuildConfig(): string | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(__dirname, "app-config.json"), "utf8"));
    return typeof raw.appUrl === "string" && raw.appUrl ? raw.appUrl : null;
  } catch {
    return null;
  }
}

export const APP_URL = (process.env.VOXA_URL || fromBuildConfig() || "http://localhost:3001").replace(/\/+$/, "");
export const APP_ORIGIN = new URL(APP_URL).origin;

/** Custom protocol for links like voxa://invite/CODE that open the app. */
export const PROTOCOL = "voxa";

/** Turns voxa://invite/CODE (or voxa://channels/...) into a path on the site, or null. */
export function deepLinkToPath(link: string): string | null {
  // URL parsing would silently resolve dot segments; a link that needs them is not one we made.
  if (/(^|[/\\])\.\.?([/\\]|$)|%2e/i.test(link)) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== `${PROTOCOL}:`) return null;
  // voxa://invite/CODE parses with host "invite" and pathname "/CODE".
  const parts = [url.host, ...url.pathname.split("/")].filter(Boolean);
  if (parts[0] === "invite" && parts[1] && /^[A-Za-z0-9]{1,32}$/.test(parts[1])) return `/invite/${parts[1]}`;
  if (parts[0] === "channels" && parts.slice(1).every((p) => /^[\w@-]{1,64}$/.test(p))) return `/${parts.join("/")}`;
  return null;
}

/** Whether a URL belongs to the Voxa site (the only place the window may navigate). */
export function isAppUrl(url: string): boolean {
  try {
    return new URL(url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}
