// Minimal service worker: makes the CRM installable as a home-screen app.
// Deliberately does NOT cache anything -- the CRM is one file that changes
// often, and a stale cached copy would be worse than a slow load.
self.addEventListener("install", function(){ self.skipWaiting(); });
self.addEventListener("activate", function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function(){});
