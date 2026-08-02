import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { randomBytes } from 'crypto';
import { db } from '$lib/server/db';
import { servers } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { requireUser } from '$lib/server/guards';
import { translator, type Translator } from '$lib/i18n';
import { checkHealth, AgentError } from '$lib/server/agents/client';
import { decrypt, encrypt } from '$lib/server/crypto';

/** ssh://user@host[:port] — fängt insbesondere den Doppelpunkt-Tippfehler ab. */
function validateSshUrl(
	raw: string,
	t: Translator
): { ok: true; value: string | null } | { ok: false; error: string } {
	const value = raw.trim();
	if (!value) return { ok: true, value: null };
	if (!value.startsWith('ssh://')) return { ok: false, error: t('servers.sshPrefix') };
	const rest = value.slice(6);
	if (!rest.includes('@') && rest.includes(':') && !/:\d{1,5}$/.test(rest)) {
		return { ok: false, error: t('servers.sshColonTypo') };
	}
	if (!/^(?:[\w.-]+@)?[\w.-]+(?::\d{1,5})?$/.test(rest)) {
		return { ok: false, error: t('servers.sshFormat') };
	}
	return { ok: true, value };
}

export const load: PageServerLoad = async ({ locals }) => {
	requireUser(locals);
	const list = await db.query.servers.findMany({ orderBy: (s, { asc }) => [asc(s.name)] });
	return { servers: list };
};

export const actions: Actions = {
	add: async ({ locals, request }) => {
		requireUser(locals);
		const t = translator(locals.locale);
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const baseUrl = String(form.get('baseUrl') ?? '').trim().replace(/\/$/, '');
		const stacksPath = String(form.get('stacksPath') ?? '').trim() || '~/stacks';
		const sshCheck = validateSshUrl(String(form.get('sshUrl') ?? ''), t);
		if (!sshCheck.ok) return fail(400, { error: sshCheck.error });
		const sshUrl = sshCheck.value;

		if (!name) return fail(400, { error: t('servers.nameMissing') });
		if (!/^https?:\/\//.test(baseUrl)) return fail(400, { error: t('servers.urlInvalid') });
		const [existing] = await db.select().from(servers).where(eq(servers.name, name));
		if (existing) return fail(400, { error: t('servers.exists', { name }) });

		// Token: entweder vorgegeben (lokaler Agent aus .env) oder frisch generiert.
		// Anzeige nur bei generierten Tokens — vorgegebene kennt der User schon.
		const customToken = String(form.get('token') ?? '').trim();
		if (customToken && !/^[a-f0-9]{64}$/i.test(customToken)) {
			return fail(400, { error: t('servers.tokenInvalid') });
		}
		const token = customToken || randomBytes(32).toString('hex');
		const [server] = await db
			.insert(servers)
			.values({ name, baseUrl, stacksPath, sshUrl, agentTokenEnc: encrypt(token) })
			.returning();
		return { created: { id: server.id, name, token: customToken ? null : token } };
	},

	setSsh: async ({ locals, request }) => {
		requireUser(locals);
		const t = translator(locals.locale);
		const form = await request.formData();
		const id = Number(form.get('id'));
		const sshCheck = validateSshUrl(String(form.get('sshUrl') ?? ''), t);
		if (!sshCheck.ok) return fail(400, { error: sshCheck.error });
		await db.update(servers).set({ sshUrl: sshCheck.value }).where(eq(servers.id, id));
		return { sshSaved: id };
	},

	remove: async ({ locals, request }) => {
		requireUser(locals);
		const id = Number((await request.formData()).get('id'));
		await db.delete(servers).where(eq(servers.id, id));
		return { removed: true };
	},

	test: async ({ locals, request }) => {
		requireUser(locals);
		const t = translator(locals.locale);
		const id = Number((await request.formData()).get('id'));
		const [server] = await db.select().from(servers).where(eq(servers.id, id));
		if (!server) return fail(404, { error: t('stack.serverNotFound') });
		try {
			const health = await checkHealth(server.baseUrl, decrypt(server.agentTokenEnc));
			await db.update(servers).set({ status: 'online', lastSeenAt: new Date() }).where(eq(servers.id, id));
			return {
				testResult: {
					id,
					ok: true,
					message: t('servers.healthOk', {
						version: health.version,
						docker: health.docker_version,
						free: (health.disk.free_bytes / 1e9).toFixed(1)
					})
				}
			};
		} catch (e) {
			await db.update(servers).set({ status: 'offline' }).where(eq(servers.id, id));
			const msg = e instanceof AgentError ? e.message : t('stack.unknownError');
			return fail(502, { testResult: { id, ok: false, message: msg } });
		}
	}
};
