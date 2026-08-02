import { db } from '$lib/server/db';
import { pushSubscriptions, users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { onAlert, type FiredAlert } from '$lib/server/alerts/engine';
import { webpush } from './vapid';
import { translator, isLocale, type Locale } from '$lib/i18n';

const SEV_ICON: Record<string, string> = { critical: '🔴', warning: '🟡', info: 'ℹ️' };
const SEV_KEY = { critical: 'push.critical', warning: 'push.warning', info: 'push.info' } as const;

async function dispatch(alert: FiredAlert) {
	// Jede Subscription gehört einem Benutzer — in dessen Sprache zustellen
	const subs = await db
		.select({ sub: pushSubscriptions, locale: users.locale })
		.from(pushSubscriptions)
		.innerJoin(users, eq(pushSubscriptions.userId, users.id));
	for (const { sub, locale } of subs) {
		const lang: Locale = isLocale(locale) ? locale : 'en';
		const t = translator(lang);
		const severityLabel = `${SEV_ICON[alert.severity] ?? ''} ${t(SEV_KEY[alert.severity])}`.trim();
		const body = t(alert.messageKey, alert.params);
		try {
			if (sub.transport === 'webpush' && sub.endpoint && sub.keysP256dh && sub.keysAuth) {
				await webpush.sendNotification(
					{ endpoint: sub.endpoint, keys: { p256dh: sub.keysP256dh, auth: sub.keysAuth } },
					JSON.stringify({
						title: `Dockposer · ${severityLabel}`,
						body,
						severity: alert.severity,
						tag: `${alert.type}:${alert.serverId}:${alert.container ?? ''}`
					}),
					{ urgency: alert.severity === 'critical' ? 'high' : 'normal', TTL: 3600 }
				);
			} else if (sub.transport === 'ntfy' && sub.ntfyTopic) {
				await fetch(sub.ntfyTopic, {
					method: 'POST',
					headers: {
						Title: `Dockposer: ${severityLabel}`,
						Priority: alert.severity === 'critical' ? 'high' : 'default',
						Tags: alert.severity === 'critical' ? 'rotating_light' : 'warning'
					},
					body,
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
