import { db } from '$lib/server/db';
import { pushSubscriptions, users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { onAlert, type FiredAlert } from '$lib/server/alerts/engine';
import { webpush } from './vapid';
import { translator, isLocale, type Locale } from '$lib/i18n';

const SEV_ICON: Record<string, string> = { critical: '🔴', warning: '🟡', info: 'ℹ️' };
const SEV_KEY = { critical: 'push.critical', warning: 'push.warning', info: 'push.info' } as const;

type Sub = typeof pushSubscriptions.$inferSelect;

interface Payload {
	title: string;
	body: string;
	severity: 'critical' | 'warning' | 'info';
	tag: string;
}

/**
 * Zustellung an einen Empfänger. Erfolg und Fehler werden festgehalten — das
 * ist die einzige Spur, aus der sich ablesen lässt, ob Alarme überhaupt noch
 * ankommen. Rückgabe: Fehlertext, oder null bei Erfolg.
 */
async function sendOne(sub: Sub, payload: Payload): Promise<string | null> {
	try {
		if (sub.transport === 'webpush' && sub.endpoint && sub.keysP256dh && sub.keysAuth) {
			await webpush.sendNotification(
				{ endpoint: sub.endpoint, keys: { p256dh: sub.keysP256dh, auth: sub.keysAuth } },
				JSON.stringify(payload),
				{ urgency: payload.severity === 'critical' ? 'high' : 'normal', TTL: 3600 }
			);
		} else if (sub.transport === 'ntfy' && sub.ntfyTopic) {
			const res = await fetch(sub.ntfyTopic, {
				method: 'POST',
				headers: {
					Title: payload.title,
					Priority: payload.severity === 'critical' ? 'high' : 'default',
					Tags: payload.severity === 'critical' ? 'rotating_light' : 'warning'
				},
				body: payload.body,
				signal: AbortSignal.timeout(10_000)
			});
			// fetch wirft nur bei Netzwerkfehlern. Ein 403 vom ntfy-Server (falsches
			// Topic, Auth nötig) galt bisher als Erfolg — genau der stille Ausfall,
			// um den es hier geht.
			if (!res.ok) throw new Error(`ntfy antwortete ${res.status}`);
		} else {
			throw new Error('Empfänger unvollständig konfiguriert');
		}
		await db
			.update(pushSubscriptions)
			.set({ lastSuccessAt: new Date(), lastErrorAt: null, lastError: null })
			.where(eq(pushSubscriptions.id, sub.id));
		return null;
	} catch (e: unknown) {
		const status = (e as { statusCode?: number })?.statusCode;
		if (status === 404 || status === 410) {
			// Subscription tot (App deinstalliert, Berechtigung entzogen) → aufräumen
			await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
			console.log('[push] Tote Subscription entfernt:', sub.id);
			return 'Empfänger abgemeldet';
		}
		const msg = e instanceof Error ? e.message : String(e);
		await db
			.update(pushSubscriptions)
			.set({ lastErrorAt: new Date(), lastError: msg.slice(0, 300) })
			.where(eq(pushSubscriptions.id, sub.id));
		console.error('[push] Versand fehlgeschlagen:', msg);
		return msg;
	}
}

async function recipients(userId?: number) {
	const rows = await db
		.select({ sub: pushSubscriptions, locale: users.locale })
		.from(pushSubscriptions)
		.innerJoin(users, eq(pushSubscriptions.userId, users.id));
	return userId === undefined ? rows : rows.filter((r) => r.sub.userId === userId);
}

const localized = (locale: string | null) => {
	const lang: Locale = locale && isLocale(locale) ? locale : 'en';
	return translator(lang);
};

async function dispatch(alert: FiredAlert) {
	// Jede Subscription gehört einem Benutzer — in dessen Sprache zustellen
	for (const { sub, locale } of await recipients()) {
		const t = localized(locale);
		const severityLabel = `${SEV_ICON[alert.severity] ?? ''} ${t(SEV_KEY[alert.severity])}`.trim();
		await sendOne(sub, {
			title: `Dockposer · ${severityLabel}`,
			body: t(alert.messageKey, alert.params),
			severity: alert.severity,
			tag: `${alert.type}:${alert.serverId}:${alert.container ?? ''}`
		});
	}
}

/**
 * Testzustellung an die Empfänger eines Benutzers — der einzige Weg, die Kette
 * Core → Push-Dienst → Gerät zu prüfen, ohne auf einen Störfall zu warten.
 */
export async function sendTestPush(userId: number): Promise<{ sent: number; errors: string[] }> {
	const errors: string[] = [];
	let sent = 0;
	for (const { sub, locale } of await recipients(userId)) {
		const t = localized(locale);
		const err = await sendOne(sub, {
			title: `Dockposer · ${t('push.testTitle')}`,
			body: t('push.testBody'),
			severity: 'info',
			tag: 'test'
		});
		if (err) errors.push(err);
		else sent++;
	}
	return { sent, errors };
}

// ── Lebenszeichen ───────────────────────────────────────────────────────
// Ohne echten Alarm bleibt es still — und Stille ist von einem kaputten
// Versandweg nicht zu unterscheiden. Deshalb ein Lebenszeichen, aber nur für
// Empfänger, die ohnehin länger nichts bekommen haben: Wer gestern einen echten
// Alarm erhalten hat, braucht keine Bestätigung.
const HEARTBEAT_DAYS = Number(process.env.PUSH_HEARTBEAT_DAYS ?? 7);

async function heartbeat() {
	const cutoff = Date.now() - HEARTBEAT_DAYS * 86_400_000;
	for (const { sub, locale } of await recipients()) {
		const last = sub.lastSuccessAt ?? sub.createdAt;
		if (last.getTime() > cutoff) continue;
		const t = localized(locale);
		await sendOne(sub, {
			title: `Dockposer · ${t('push.heartbeatTitle')}`,
			body: t('push.heartbeatBody', { days: HEARTBEAT_DAYS }),
			severity: 'info',
			tag: 'heartbeat'
		});
	}
}

/** Zustand der Zustellung — Grundlage für Hinweis und Einstellungsseite. */
export async function pushHealth(userId?: number) {
	const rows = (await recipients(userId)).map((r) => r.sub);
	const failing = rows.filter(
		(r) => r.lastErrorAt && (!r.lastSuccessAt || r.lastErrorAt > r.lastSuccessAt)
	);
	const lastSuccessAt = rows
		.map((r) => r.lastSuccessAt)
		.filter((d): d is Date => d instanceof Date)
		.sort((a, b) => b.getTime() - a.getTime())[0];
	return {
		total: rows.length,
		failing: failing.length,
		lastError: failing[0]?.lastError ?? null,
		lastSuccessAt: lastSuccessAt ?? null,
		heartbeatDays: HEARTBEAT_DAYS
	};
}

let registered = false;
export function initPushDispatcher() {
	if (registered) return;
	registered = true;
	onAlert((alert) => void dispatch(alert));
	if (HEARTBEAT_DAYS > 0) {
		// Stündlich nachsehen, ob ein Lebenszeichen fällig ist; gesendet wird je
		// Empfänger höchstens alle HEARTBEAT_DAYS Tage.
		setTimeout(() => void heartbeat(), 5 * 60_000).unref?.();
		setInterval(() => void heartbeat(), 3_600_000).unref?.();
	}
	console.log('[push] Dispatcher registriert');
}
