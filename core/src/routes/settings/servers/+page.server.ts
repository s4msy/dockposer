import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { createHash, randomBytes } from 'crypto';
import { db } from '$lib/server/db';
import { servers } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { requireUser } from '$lib/server/guards';
import { checkHealth, AgentError } from '$lib/server/agents/client';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export const load: PageServerLoad = async ({ locals }) => {
	requireUser(locals);
	const list = await db.query.servers.findMany({ orderBy: (s, { asc }) => [asc(s.name)] });
	return { servers: list };
};

export const actions: Actions = {
	add: async ({ locals, request }) => {
		requireUser(locals);
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const baseUrl = String(form.get('baseUrl') ?? '').trim().replace(/\/$/, '');
		const stacksPath = String(form.get('stacksPath') ?? '').trim() || '~/stacks';

		if (!name) return fail(400, { error: 'Name fehlt.' });
		if (!/^https?:\/\//.test(baseUrl)) return fail(400, { error: 'Base-URL muss mit http(s):// beginnen.' });
		const [existing] = await db.select().from(servers).where(eq(servers.name, name));
		if (existing) return fail(400, { error: `Server „${name}" existiert bereits.` });

		// Token: einmalig im Klartext anzeigen, nur Hash in die DB
		const token = randomBytes(32).toString('hex');
		const [server] = await db
			.insert(servers)
			.values({ name, baseUrl, stacksPath, agentTokenHash: sha256(token) })
			.returning();
		return { created: { id: server.id, name, token } };
	},

	remove: async ({ locals, request }) => {
		requireUser(locals);
		const id = Number((await request.formData()).get('id'));
		await db.delete(servers).where(eq(servers.id, id));
		return { removed: true };
	},

	// Verbindungstest: braucht das Klartext-Token (wird nie gespeichert)
	test: async ({ locals, request }) => {
		requireUser(locals);
		const form = await request.formData();
		const id = Number(form.get('id'));
		const token = String(form.get('token') ?? '').trim();
		const [server] = await db.select().from(servers).where(eq(servers.id, id));
		if (!server) return fail(404, { error: 'Server nicht gefunden.' });
		if (sha256(token) !== server.agentTokenHash) {
			return fail(400, { testResult: { id, ok: false, message: 'Token stimmt nicht mit dem registrierten überein.' } });
		}
		try {
			const health = await checkHealth(server.baseUrl, token);
			await db.update(servers).set({ status: 'online', lastSeenAt: new Date() }).where(eq(servers.id, id));
			return {
				testResult: {
					id,
					ok: true,
					message: `Agent v${health.version}, Docker ${health.docker_version}, frei: ${(health.disk.free_bytes / 1e9).toFixed(1)} GB`
				}
			};
		} catch (e) {
			await db.update(servers).set({ status: 'offline' }).where(eq(servers.id, id));
			const msg = e instanceof AgentError ? e.message : 'Unbekannter Fehler';
			return fail(502, { testResult: { id, ok: false, message: msg } });
		}
	}
};
