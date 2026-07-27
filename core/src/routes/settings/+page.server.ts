import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import QRCode from 'qrcode';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { requireUser } from '$lib/server/guards';
import { generateTotpSecret, verifyTotp, verifyPassword } from '$lib/server/auth';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);
	return { username: user.username, totpEnabled: user.totpEnabled };
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
