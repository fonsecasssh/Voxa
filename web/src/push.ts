// Push notifications on this device (Web Push): DMs, mentions and calls arrive even with
// Voxa closed. Needs the service worker (see pwa.ts); iPhone only when installed on the
// home screen.

import { api } from "./api.ts";
import { desktop } from "./desktop.ts";

export type PushState = "unsupported" | "denied" | "off" | "on";

export const pushSupported = () => !desktop && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function registration() {
  return navigator.serviceWorker.getRegistration();
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
}

const toBytes = (base64url: string) => {
  const b64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

/** Asks permission (call from a click) and subscribes this device. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if ((await Notification.requestPermission()) !== "granted") return Notification.permission === "denied" ? "denied" : "off";
  const reg = (await registration()) ?? (await navigator.serviceWorker.register("/sw.js"));
  await navigator.serviceWorker.ready;
  const { publicKey } = await api.pushKey();
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(publicKey) }));
  await api.pushSubscribe(sub.toJSON());
  return "on";
}

/** Stops push on this device (also on logout, so the next person here doesn't get yours). */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
