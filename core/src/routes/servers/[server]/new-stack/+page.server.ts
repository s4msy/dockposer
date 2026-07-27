import type { Actions, PageServerLoad } from './$types';
import { error, fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { servers } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { requireUser } from '$lib/server/guards';
import { decrypt } from '$lib/server/crypto';
import { createStack, AgentError } from '$lib/server/agents/client';

export const load: PageServerLoad = async ({ locals, params }) => {
	requireUser(locals);
	const [server] = await db.select().from(servers).where(eq(servers.id, Number(params.server)));
	if (!server) error(404, 'Server nicht gefunden');
	return { server: { id: server.id, name: server.name } };
};

export const actions: Actions = {
	default: async ({ locals, params, request }) => {
		requireUser(locals);
		const [server] = await db.select().from(servers).where(eq(servers.id, Number(params.server)));
		if (!server) error(404, 'Server nicht gefunden');
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const content = String(form.get('content') ?? '');
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
			return fail(400, { error: 'Ungültiger Name (erlaubt: a-z, 0-9, . _ -).', name, content });
		}
		try {
			await createStack(server.baseUrl, decrypt(server.agentTokenEnc), name, content);
		} catch (e) {
			const msg = e instanceof AgentError ? e.message : 'Unbekannter Fehler';
			return fail(422, { error: msg, name, content });
		}
		redirect(303, `/stacks/${server.id}/${encodeURIComponent(name)}`);
	}
};
