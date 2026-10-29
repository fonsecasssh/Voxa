// Push notifications (Web Push): reach people on devices where Voxa is closed, like a
// phone with the app installed. The VAPID keys identify this server to the browsers'
// push services; they're made on first start and kept in the database (or set with
// VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY).

import webpush from "web-push";
import type { PushSubscriptionRow, Store } from "./store.ts";

export interface PushPayload {
  title: string;
  body: string;
  /** Opened when the notification is clicked. */
  url: string;
  /** A newer notification with the same tag replaces the older one (one per conversation). */
  tag: string;
  /** Calls stay on screen until answered or dismissed. */
  call?: boolean;
}

export interface PushSender {
  publicKey: string;
  /** "gone" when the browser dropped the subscription (it should be forgotten). */
  send(sub: PushSubscriptionRow, payload: PushPayload): Promise<"ok" | "gone" | "error">;
}

export function createWebPush(store: Store, env: NodeJS.ProcessEnv, subject: string): PushSender {
  let keys = env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY } : null;
  if (!keys) {
    const saved = store.getSetting("vapid");
    keys = saved ? (JSON.parse(saved) as { publicKey: string; privateKey: string }) : webpush.generateVAPIDKeys();
    if (!saved) store.setSetting("vapid", JSON.stringify(keys));
  }
  const vapid = { subject, publicKey: keys.publicKey, privateKey: keys.privateKey };
  return {
    publicKey: keys.publicKey,
    async send(sub, payload) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), {
          vapidDetails: vapid,
          TTL: payload.call ? 60 : 24 * 3600,
          urgency: payload.call ? "high" : "normal",
        });
        return "ok";
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        return status === 404 || status === 410 ? "gone" : "error";
      }
    },
  };
}
