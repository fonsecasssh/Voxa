// Small in-memory rate limiters, enough to slow down password guessing and
// signup spam on a single server instance.

import type { NextFunction, Request, Response } from "express";

type Window = { count: number; resetAt: number };

function windows(windowMs: number) {
  const map = new Map<string, Window>();
  // Forget expired windows now and then so the map can't grow without bound.
  setInterval(() => {
    const now = Date.now();
    for (const [key, v] of map) if (v.resetAt <= now) map.delete(key);
  }, windowMs).unref();

  return {
    get(key: string): Window | undefined {
      const w = map.get(key);
      return w && w.resetAt > Date.now() ? w : undefined;
    },
    hit(key: string): Window {
      let w = this.get(key);
      if (!w) {
        w = { count: 0, resetAt: Date.now() + windowMs };
        map.set(key, w);
      }
      w.count++;
      return w;
    },
    clear(key: string) {
      map.delete(key);
    },
  };
}

/** Express middleware limiting requests per client IP. Only meaningful when req.ip is the real client address. */
export function rateLimit({ windowMs, max, message }: { windowMs: number; max: number; message: string }) {
  const w = windows(windowMs);
  return (req: Request, res: Response, next: NextFunction) => {
    const entry = w.hit(req.ip ?? "unknown");
    if (entry.count > max) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - Date.now()) / 1000));
      res.status(429).json({ error: message });
      return;
    }
    next();
  };
}

/**
 * Counts failures per key (e.g. per account for logins) and blocks once there are too many.
 * Unlike an IP limit, it can't be dodged by switching addresses and doesn't depend on proxies.
 */
export function failureLimiter({ windowMs, max }: { windowMs: number; max: number }) {
  const w = windows(windowMs);
  return {
    /** Seconds until the key may try again, or 0 if it may try now. */
    blockedFor(key: string): number {
      const entry = w.get(key);
      return entry && entry.count >= max ? Math.ceil((entry.resetAt - Date.now()) / 1000) : 0;
    },
    fail: (key: string) => void w.hit(key),
    succeed: (key: string) => w.clear(key),
  };
}
