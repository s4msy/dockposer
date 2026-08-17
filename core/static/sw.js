self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
	let payload = { title: 'Dockposer', body: 'Neuer Alert', severity: 'warning' };
	try {
		payload = { ...payload, ...event.data.json() };
	} catch {}
	event.waitUntil(
		self.registration.showNotification(payload.title, {
			body: payload.body,
			icon: '/icons/icon-192.png',
			badge: '/icons/icon-192.png',
			tag: payload.tag || 'dockposer-alert',
			renotify: true,
			data: { url: '/alerts' }
		})
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();

	// Absolute URL: relative Pfade lässt openWindow auf manchen Plattformen
	// ins Leere laufen — genau das erzeugt den leeren Browser-Tab.
	const target = new URL(event.notification.data?.url || '/alerts', self.location.origin).href;

	event.waitUntil(
		(async () => {
			const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

			// Bereits offenes Fenster bevorzugen — das ist bei installierter PWA
			// deren Fenster, nicht der Browser.
			for (const client of clients) {
				if (new URL(client.url).origin !== self.location.origin) continue;
				try {
					// focus() und navigate() liefern Promises. Wurden sie nicht
					// abgewartet, konnte der Service Worker vorher beendet werden —
					// das Fenster blieb dann leer.
					await client.focus();
					if (client.url !== target && 'navigate' in client) {
						await client.navigate(target);
					}
					return;
				} catch {
					// Manche Clients lassen sich nicht steuern → nächsten versuchen
				}
			}
			await self.clients.openWindow(target);
		})()
	);
});
