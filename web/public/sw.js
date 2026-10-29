// Voxa's service worker: makes the site installable and opens it instantly (and offline)
// from the cache. Built files have content hashes, so they're cached for good; the page
// itself is always fetched fresh when online, so a deploy shows up on the next open.
// The API, the realtime socket and uploaded media are never cached.

const CACHE = "voxa-v2";
const SHELL = ["/", "/manifest.webmanifest", "/favicon.svg", "/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (/^\/(api|socket\.io|media|download)(\/|$)/.test(url.pathname)) return;

  // Pages: the network first (fresh after a deploy), the cached app when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put("/", res.clone()));
          return res;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  // Hashed build files and icons: the cache first.
  if (url.pathname.startsWith("/assets/") || SHELL.includes(url.pathname) || url.pathname.endsWith(".png")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});

// --- push notifications --------------------------------------------------------------
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    return;
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      // Already looking at Voxa: the page shows it itself.
      if (windows.some((w) => w.visibilityState === "visible")) return;
      return self.registration.showNotification(data.title || "Voxa", {
        body: data.body || "",
        tag: data.tag,
        renotify: !!data.call,
        requireInteraction: !!data.call,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        data: { url: data.url || "/channels" },
      });
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/channels", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url.startsWith(self.location.origin));
      if (open) return open.navigate(url).then((w) => (w ?? open).focus());
      return self.clients.openWindow(url);
    }),
  );
});
