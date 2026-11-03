/*
 * MuseLaunch service worker: shows the notifications the server pushes (Web Push) while every
 * MuseLaunch tab is closed, and opens the right page when one is clicked. It caches nothing and
 * never handles fetches. Registered by src/lib/web-push.ts with scope "/".
 *
 * A push carries JSON: { v: 1, title, body, url, tag, kind } (contracts/web-push.ts WebPushPayload).
 * `url` is a path in this app; anything pointing elsewhere opens the home page instead.
 */
const ICON = "/apple-icon.png";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** A same-origin URL for `raw`, else the app's home page. */
function sameOrigin(raw) {
  try {
    const u = new URL(typeof raw === "string" && raw ? raw : "/", self.location.origin);
    return u.origin === self.location.origin ? u.href : `${self.location.origin}/`;
  } catch {
    return `${self.location.origin}/`;
  }
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = String(data.title || "MuseLaunch").slice(0, 120);
  const tag = typeof data.tag === "string" && data.tag ? data.tag.slice(0, 100) : undefined;
  event.waitUntil(
    self.registration.showNotification(title, {
      body: String(data.body || "").slice(0, 240),
      icon: ICON,
      // Same tag: the newer note replaces the older one (and still alerts).
      tag,
      renotify: Boolean(tag),
      timestamp: Date.now(),
      data: { url: sameOrigin(data.url), kind: typeof data.kind === "string" ? data.kind : undefined },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = sameOrigin(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const tabs = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter((c) => {
        try {
          return new URL(c.url).origin === self.location.origin;
        } catch {
          return false;
        }
      });
      // A MuseLaunch tab is open: bring it forward and take it to the page.
      const tab = tabs.find((c) => c.url === url) || tabs.find((c) => c.focused) || tabs[0];
      if (tab) {
        try {
          const focused = await tab.focus();
          if (focused.url !== url && "navigate" in focused) await focused.navigate(url);
          return;
        } catch {
          /* not ours to steer (uncontrolled): open a new tab instead */
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// The push service replaced this browser's subscription: subscribe again with the same server key.
// The next MuseLaunch visit sends the new one to the server (the page can sign the request; this can't).
self.addEventListener("pushsubscriptionchange", (event) => {
  const key = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
  if (!key) return;
  event.waitUntil(self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }).catch(() => undefined));
});
