import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { registryCredentials, stacks } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { requireUser } from '$lib/server/guards';
import { decrypt, encrypt } from '$lib/server/crypto';
import { testCredential } from '$lib/server/updates/registry';
import { invalidateCredentialCache, normalizeHost } from '$lib/server/updates/credentials';

export const load: PageServerLoad = async ({ locals }) => {
	requireUser(locals);
	const rows = await db.select().from(registryCredentials);
	const credentials = rows.map((r) => ({
		id: r.id,
		host: r.host,
		username: r.username,
		note: r.note,
		lastCheckAt: r.lastCheckAt,
		lastCheckOk: r.lastCheckOk,
		lastCheckMessage: r.lastCheckMessage
	}));

	// Hosts vorschlagen, bei denen der letzte Check an fehlender Auth scheiterte
	const known = new Set(rows.map((r) => normalizeHost(r.host)));
	const suggestions = new Map<string, number>();
	for (const stack of await db.select({ updatesJson: stacks.updatesJson }).from(stacks)) {
		if (!stack.updatesJson) continue;
		try {
			const entries: { status: string; host?: string; authRequired?: boolean }[] = JSON.parse(stack.updatesJson);
			for (const e of entries) {
				if (e.status !== 'unknown' || !e.authRequired || !e.host) continue;
				if (known.has(normalizeHost(e.host))) continue;
				suggestions.set(e.host, (suggestions.get(e.host) ?? 0) + 1);
			}
		} catch {
			/* alter Cache-Eintrag ohne host-Feld */
		}
	}
	return {
		credentials,
		suggestions: [...suggestions.entries()].map(([host, count]) => ({ host, count }))
	};
};

export const actions: Actions = {
	save: async ({ locals, request }) => {
		requireUser(locals);
		const form = await request.formData();
		const host = normalizeHost(String(form.get('host') ?? ''));
		const username = String(form.get('username') ?? '').trim();
		const secret = String(form.get('secret') ?? '');
		const note = String(form.get('note') ?? '').trim() || null;

		if (!host || !/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) {
			return fail(400, { error: 'Host angeben, z. B. git.example.com (ohne https:// und Pfad).' });
		}
		if (!username) return fail(400, { error: 'Benutzername fehlt.' });

		const [existing] = await db.select().from(registryCredentials).where(eq(registryCredentials.host, host));
		if (existing) {
			// Leeres Secret = bestehendes beibehalten (Bearbeiten ohne Neueingabe)
			await db
				.update(registryCredentials)
				.set({
					username,
					note,
					...(secret ? { secretEnc: encrypt(secret) } : {}),
					lastCheckAt: null,
					lastCheckOk: null,
					lastCheckMessage: null
				})
				.where(eq(registryCredentials.id, existing.id));
		} else {
			if (!secret) return fail(400, { error: 'Token/Passwort fehlt.' });
			await db.insert(registryCredentials).values({ host, username, secretEnc: encrypt(secret), note });
		}
		invalidateCredentialCache();
		return { saved: host };
	},

	test: async ({ locals, request }) => {
		requireUser(locals);
		const id = Number((await request.formData()).get('id'));
		const [row] = await db.select().from(registryCredentials).where(eq(registryCredentials.id, id));
		if (!row) return fail(404, { error: 'Eintrag nicht gefunden.' });
		const result = await testCredential(row.host, {
			username: row.username,
			secret: decrypt(row.secretEnc)
		});
		await db
			.update(registryCredentials)
			.set({ lastCheckAt: new Date(), lastCheckOk: result.ok, lastCheckMessage: result.message })
			.where(eq(registryCredentials.id, id));
		return { tested: id, ok: result.ok, message: result.message };
	},

	remove: async ({ locals, request }) => {
		requireUser(locals);
		const id = Number((await request.formData()).get('id'));
		await db.delete(registryCredentials).where(eq(registryCredentials.id, id));
		invalidateCredentialCache();
		return { removed: true };
	}
};
