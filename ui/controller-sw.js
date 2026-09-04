const CACHE = "sovereignbot-remote-controller-v1";
const ASSETS = ["./controller.html", "./controller.css", "./controller-app.js", "./controller-manifest.json"];
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS))));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => event.respondWith(caches.match(event.request).then((cached) => cached ?? new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } }))));
