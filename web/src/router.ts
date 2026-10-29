// A minimal pushState router: the app has only a handful of URL shapes.

import { useEffect, useState } from "react";

const listeners = new Set<() => void>();

export function navigate(path: string, replace = false) {
  if (path === location.pathname) return;
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  listeners.forEach((l) => l());
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return path;
}

export type Route =
  | { name: "channels"; serverId?: string; channelId?: string }
  | { name: "invite"; code: string }
  | { name: "reset"; token: string }
  | { name: "verifyEmail"; token: string };

export function parseRoute(path: string): Route {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "invite" && parts[1]) return { name: "invite", code: parts[1] };
  if (parts[0] === "reset" && parts[1]) return { name: "reset", token: parts[1] };
  if (parts[0] === "verify-email" && parts[1]) return { name: "verifyEmail", token: parts[1] };
  if (parts[0] === "channels") return { name: "channels", serverId: parts[1], channelId: parts[2] };
  return { name: "channels" };
}
