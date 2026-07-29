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
	event.waitUntil(
		self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
			for (const client of list) {
				if ('focus' in client) {
					client.focus();
					client.navigate('/alerts');
					return;
				}
			}
			return self.clients.openWindow('/alerts');
		})
	);
});
