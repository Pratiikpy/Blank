// Blank service worker.
//
// Currently scoped to web push only — we do not cache app shell, do not
// intercept fetches, and let Vite/Vercel handle delivery normally. This keeps
// SW updates predictable and avoids cache poisoning during deploys.
//
// Lifecycle:
//   - install: skip waiting so a new SW activates immediately on reload
//   - activate: claim all clients so already-open tabs get the new SW
//   - push: render a notification from the JSON payload
//   - notificationclick: focus an existing tab if any, else open the link
//
// Push payload shape (JSON, sent from /api/push/notify):
//   {
//     "title": "Acme paid your invoice",
//     "body":  "$3,700 received",
//     "url":   "/app/history",                 // path to focus/open
//     "tag":   "invoice:0042",                  // optional — collapses repeats
//     "icon":  "/ghost.svg"                     // optional override
//   }

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_err) {
    payload = { title: "Blank", body: event.data ? event.data.text() : "" };
  }

  const title = payload.title || "Blank";
  const options = {
    body: payload.body || "",
    icon: payload.icon || "/ghost.svg",
    badge: payload.badge || "/ghost.svg",
    tag: payload.tag,
    data: { url: payload.url || "/" },
    // Re-show even if a notification with the same tag exists; otherwise
    // repeated invoice "viewed" pings would silently disappear.
    renotify: !!payload.tag,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    (async () => {
      const clientsArr = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Focus an existing Blank tab if one is already open.
      for (const client of clientsArr) {
        try {
          const url = new URL(client.url);
          if (url.origin === self.location.origin) {
            await client.focus();
            // Best-effort navigate — only works when the page consents.
            if ("navigate" in client) {
              try {
                await client.navigate(targetUrl);
              } catch (_navErr) {
                // ignore — focus alone is fine
              }
            }
            return;
          }
        } catch (_e) {
          // skip malformed client URL
        }
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});
