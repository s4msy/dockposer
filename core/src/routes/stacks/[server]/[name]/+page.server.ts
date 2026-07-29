import type { Actions, PageServerLoad } from './$types';
import { error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { servers, stacks } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { requireUser } from '$lib/server/guards';
import { decrypt } from '$lib/server/crypto';
import { fetchCompose, fetchStackPs, putCompose, AgentError } from '$lib/server/agents/client';
import { checkStackUpdates } from '$lib/server/updates/checker';

async function loadServer(serverId: string) {
	const [server] = await db.select().from(servers).where(eq(servers.id, Number(serverId)));
	if (!server) error(404, 'Server nicht gefunden');
	return server;
}

export const load: PageServerLoad = async ({ locals, params }) => {
	requireUser(locals);
	const server = await loadServer(params.server);
	const token = decrypt(server.agentTokenEnc);
	const [stack] = await db
		.select()
		.from(stacks)
		.where(and(eq(stacks.serverId, server.id), eq(stacks.name, params.name)));

	try {
		const [compose, containers] = await Promise.all([
			fetchCompose(server.baseUrl, token, params.name),
			fetchStackPs(server.baseUrl, token, params.name)
		]);
		return {
			server: { id: server.id, name: server.name },
			stack: stack ?? null,
			name: params.name,
			compose,
			containers,
			updates: stack?.updatesJson ? JSON.parse(stack.updatesJson) : [],
			lastUpdateCheck: stack?.lastUpdateCheck ?? null,
			updatePolicy: stack?.updatePolicy ?? 'manual',
			agentOffline: false
		};
	} catch (e) {
		if (e instanceof AgentError && e.status === 404) error(404, 'Stack nicht gefunden');
		// Agent nicht erreichbar → Seite trotzdem rendern, mit Cache-Stand
		return {
			server: { id: server.id, name: server.name },
			stack: stack ?? null,
			name: params.name,
			compose: null,
			containers: [],
			updates: stack?.updatesJson ? JSON.parse(stack.updatesJson) : [],
			lastUpdateCheck: stack?.lastUpdateCheck ?? null,
			updatePolicy: stack?.updatePolicy ?? 'manual',
			agentOffline: true
		};
	}
};

export const actions: Actions = {
	checkUpdates: async ({ locals, params }) => {
		requireUser(locals);
		const server = await loadServer(params.server);
		try {
			await checkStackUpdates(server, params.name);
			return { checked: true };
		} catch (e) {
			const msg = e instanceof AgentError ? e.message : 'Check fehlgeschlagen';
			return fail(502, { checkError: msg });
		}
	},

	setPolicy: async ({ locals, params, request }) => {
		requireUser(locals);
		const server = await loadServer(params.server);
		const policy = String((await request.formData()).get('policy') ?? '');
		if (!['manual', 'auto'].includes(policy)) return fail(400, { policyError: 'Ungültige Policy.' });
		await db.update(stacks).set({ updatePolicy: policy as 'manual' | 'auto' })
			.where(and(eq(stacks.serverId, server.id), eq(stacks.name, params.name)));
		return { policySaved: true };
	},

	saveCompose: async ({ locals, params, request }) => {
		requireUser(locals);
		const server = await loadServer(params.server);
		const content = String((await request.formData()).get('content') ?? '');
		if (!content.trim()) return fail(400, { saveError: 'Leere Datei speichere ich nicht.' });
		try {
			const res = await putCompose(server.baseUrl, decrypt(server.agentTokenEnc), params.name, content);
			return { saved: true, hash: res.hash };
		} catch (e) {
			const msg = e instanceof AgentError ? e.message : 'Unbekannter Fehler';
			// 422 = Agent hat die Datei abgelehnt (compose config invalide)
			return fail(422, { saveError: msg });
		}
	}
};
