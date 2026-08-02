import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import QRCode from 'qrcode';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { requireUser } from '$lib/server/guards';
import { generateTotpSecret, verifyTotp, verifyPassword } from '$lib/server/auth';
import { pushSubscriptions, webauthnCredentials } from '$lib/server/db/schema';
import { and } from 'drizzle-orm';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);
	const { vapidPublicKey } = await import('$lib/server/push/vapid');
	const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, user.id));
	const passkeys = await db
		.select({
			id: webauthnCredentials.id,
			deviceName: webauthnCredentials.deviceName,
			createdAt: webauthnCredentials.createdAt,
			lastUsedAt: webauthnCredentials.lastUsedAt
		})
		.from(webauthnCredentials)
		.where(eq(webauthnCredentials.userId, user.id));
	return {
		username: user.username,
		totpEnabled: user.totpEnabled,
		hideStoppedStacks: user.hideStoppedStacks,
		vapidPublicKey,
		webpushCount: subs.filter((s) => s.transport === 'webpush').length,
		ntfyTopic: subs.find((s) => s.transport === 'ntfy')?.ntfyTopic ?? '',
		passkeys
	};
};

export const actions: Actions = {
	// Schritt 1: Secret erzeugen (enabled bleibt false bis zur Bestätigung)
	totpStart: async ({ locals }) => {
		const user = requireUser(locals);
		const { encrypted, otpauthUrl } = generateTotpSecret(user.username);
		await db.update(users).set({ totpSecret: encrypted, totpEnabled: false }).where(eq(users.id, user.id));
		const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { width: 240, margin: 1 });
		return { qrDataUrl, otpauthUrl };
	},
	// Schritt 2: Code prüfen → aktivieren
	totpConfirm: async ({ locals, request }) => {
		const user = requireUser(locals);
		const code = String((await request.formData()).get('code') ?? '');
		const [row] = await db.select().from(users).where(eq(users.id, user.id));
		if (!row?.totpSecret) return fail(400, { totpError: 'Kein Secret vorhanden — neu starten.' });
		if (!verifyTotp(row.totpSecret, code)) return fail(400, { totpError: 'Code ungültig.' });
		await db.update(users).set({ totpEnabled: true }).where(eq(users.id, user.id));
		return { totpDone: true };
	},
	// Anzeige-Einstellung: Stacks ohne laufende Container ausblenden
	toggleHideStopped: async ({ locals }) => {
		const user = requireUser(locals);
		const [row] = await db
			.select({ hideStoppedStacks: users.hideStoppedStacks })
			.from(users)
			.where(eq(users.id, user.id));
		await db
			.update(users)
			.set({ hideStoppedStacks: !row?.hideStoppedStacks })
			.where(eq(users.id, user.id));
		return { displaySaved: true };
	},

	removePasskey: async ({ locals, request }) => {
		const user = requireUser(locals);
		const id = Number((await request.formData()).get('id'));
		await db.delete(webauthnCredentials).where(and(
			eq(webauthnCredentials.id, id),
			eq(webauthnCredentials.userId, user.id)
		));
		return { passkeyRemoved: true };
	},

	// ntfy-Fallback: eine Topic-URL pro User
	saveNtfy: async ({ locals, request }) => {
		const user = requireUser(locals);
		const topic = String((await request.formData()).get('ntfyTopic') ?? '').trim();
		await db.delete(pushSubscriptions).where(and(
			eq(pushSubscriptions.userId, user.id),
			eq(pushSubscriptions.transport, 'ntfy')
		));
		if (topic) {
			if (!/^https:\/\/.+\/.+/.test(topic)) {
				return fail(400, { ntfyError: 'Vollständige Topic-URL angeben, z. B. https://ntfy.sh/mein-topic' });
			}
			await db.insert(pushSubscriptions).values({ userId: user.id, transport: 'ntfy', ntfyTopic: topic });
		}
		return { ntfySaved: true };
	},

	// Deaktivieren nur mit Passwort
	totpDisable: async ({ locals, request }) => {
		const user = requireUser(locals);
		const password = String((await request.formData()).get('password') ?? '');
		const [row] = await db.select().from(users).where(eq(users.id, user.id));
		if (!row || !(await verifyPassword(password, row.passwordHash))) {
			return fail(400, { totpError: 'Passwort falsch.' });
		}
		await db.update(users).set({ totpEnabled: false, totpSecret: null }).where(eq(users.id, user.id));
		return { totpDisabled: true };
	}
};
