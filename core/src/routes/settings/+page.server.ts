import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import QRCode from 'qrcode';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { requireUser } from '$lib/server/guards';
import { generateTotpSecret, verifyTotp, verifyPassword } from '$lib/server/auth';
import { translator } from '$lib/i18n';
import { alertRules, pushSubscriptions, webauthnCredentials } from '$lib/server/db/schema';
import { and } from 'drizzle-orm';

const LOCALE_OPTIONS = ['auto', 'de', 'en'];

// Anzeigereihenfolge der Alarm-Regeln: wichtigste zuerst
const ALERT_TYPE_ORDER = [
	'crash_loop',
	'container_exit',
	'unhealthy',
	'oom_kill',
	'update_rolled_back',
	'pull_failed',
	'update_success',
	'disk_space',
	'agent_offline'
] as const;

const THEMES = [
	'system',
	'dockposer-light',
	'dockposer-dark',
	'catppuccin-mocha',
	'catppuccin-latte',
	'nord',
	'dracula',
	'gruvbox-dark'
];

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);
	const { vapidPublicKey } = await import('$lib/server/push/vapid');
	const { pushHealth } = await import('$lib/server/push/dispatch');
	const health = await pushHealth(user.id);
	const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, user.id));
	const ruleRows = await db.select().from(alertRules).where(eq(alertRules.scope, 'global'));
	const rules = ALERT_TYPE_ORDER.flatMap((type) => {
		const row = ruleRows.find((r) => r.type === type);
		return row ? [{ id: row.id, type: row.type, enabled: row.enabled }] : [];
	});
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
		theme: user.theme,
		rules,
		localePref: user.locale,
		vapidPublicKey,
		webpushCount: subs.filter((s) => s.transport === 'webpush').length,
		ntfyTopic: subs.find((s) => s.transport === 'ntfy')?.ntfyTopic ?? '',
		pushHealth: health,
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
		if (!row?.totpSecret) return fail(400, { totpError: translator(locals.locale)('settings.totpNoSecret') });
		if (!verifyTotp(row.totpSecret, code)) return fail(400, { totpError: translator(locals.locale)('settings.totpInvalidCode') });
		await db.update(users).set({ totpEnabled: true }).where(eq(users.id, user.id));
		return { totpDone: true };
	},
	toggleRule: async ({ locals, request }) => {
		requireUser(locals);
		const id = Number((await request.formData()).get('id'));
		const [row] = await db.select().from(alertRules).where(eq(alertRules.id, id));
		if (!row) return fail(404, { error: translator(locals.locale)('reg.notFound') });
		await db.update(alertRules).set({ enabled: !row.enabled }).where(eq(alertRules.id, id));
		return { ruleToggled: id };
	},

	setLocale: async ({ locals, request }) => {
		const user = requireUser(locals);
		const locale = String((await request.formData()).get('locale') ?? '');
		if (!LOCALE_OPTIONS.includes(locale)) return fail(400, { error: translator(locals.locale)('reg.unknownLocale') });
		await db.update(users).set({ locale }).where(eq(users.id, user.id));
		return { localeSaved: locale };
	},

	setTheme: async ({ locals, request }) => {
		const user = requireUser(locals);
		const theme = String((await request.formData()).get('theme') ?? '');
		if (!THEMES.includes(theme)) return fail(400, { error: translator(locals.locale)('reg.unknownTheme') });
		await db.update(users).set({ theme }).where(eq(users.id, user.id));
		return { themeSaved: theme };
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
	testPush: async ({ locals }) => {
		const user = requireUser(locals);
		const { sendTestPush } = await import('$lib/server/push/dispatch');
		const { sent, errors } = await sendTestPush(user.id);
		if (!sent) return fail(502, { testError: errors[0] ?? 'no-recipients' });
		return { testSent: sent };
	},

	saveNtfy: async ({ locals, request }) => {
		const user = requireUser(locals);
		const topic = String((await request.formData()).get('ntfyTopic') ?? '').trim();
		await db.delete(pushSubscriptions).where(and(
			eq(pushSubscriptions.userId, user.id),
			eq(pushSubscriptions.transport, 'ntfy')
		));
		if (topic) {
			if (!/^https:\/\/.+\/.+/.test(topic)) {
				return fail(400, { ntfyError: translator(locals.locale)('settings.ntfyInvalid') });
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
			return fail(400, { totpError: translator(locals.locale)('settings.wrongPassword') });
		}
		await db.update(users).set({ totpEnabled: false, totpSecret: null }).where(eq(users.id, user.id));
		return { totpDisabled: true };
	}
};
