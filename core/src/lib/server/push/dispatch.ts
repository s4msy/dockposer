import { db } from '$lib/server/db';
import { pushSubscriptions } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { onAlert, type FiredAlert } from '$lib/server/alerts/engine';
import { webpush } from './vapid';

const SEV_LABEL: Record<string, string> = { critical: '🔴 Kritisch', warning: '🟡 Warnung', info: 'ℹ️ Info' };

async function dispatch(alert: FiredAlert) {
	const subs = await db.select().from(pushSubscriptions);
	for (const sub of subs) {
		try {
			if (sub.transport === 'webpush' && sub.endpoint && sub.keysP256dh && sub.keysAuth) {
				await webpush.sendNotification(
					{ endpoint: sub.endpoint, keys: { p256dh: sub.keysP256dh, auth: sub.keysAuth } },
					JSON.stringify({
						title: `Dockposer · ${SEV_LABEL[alert.severity] ?? alert.severity}`,
						body: alert.message,
						severity: alert.severity,
						tag: `${alert.type}:${alert.serverId}:${alert.container ?? ''}`
					}),
					{ urgency: alert.severity === 'critical' ? 'high' : 'normal', TTL: 3600 }
				);
			} else if (sub.transport === 'ntfy' && sub.ntfyTopic) {
				await fetch(sub.ntfyTopic, {
					method: 'POST',
					headers: {
						Title: `Dockposer: ${SEV_LABEL[alert.severity] ?? alert.severity}`,
						Priority: alert.severity === 'critical' ? 'high' : 'default',
						Tags: alert.severity === 'critical' ? 'rotating_light' : 'warning'
					},
					body: alert.message,
					signal: AbortSignal.timeout(10_000)
				});
			}
			await db.update(pushSubscriptions).set({ lastSuccessAt: new Date() }).where(eq(pushSubscriptions.id, sub.id));
		} catch (e: unknown) {
			const status = (e as { statusCode?: number })?.statusCode;
			if (status === 404 || status === 410) {
				// Subscription tot (App deinstalliert, Berechtigung entzogen) → aufräumen
				await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
				console.log('[push] Tote Subscription entfernt:', sub.id);
			} else {
				console.error('[push] Versand fehlgeschlagen:', e);
			}
		}
	}
}

let registered = false;
export function initPushDispatcher() {
	if (registered) return;
	registered = true;
	onAlert((alert) => void dispatch(alert));
	console.log('[push] Dispatcher registriert');
}
