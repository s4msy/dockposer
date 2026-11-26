import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { db } from '#lib/server/db/index.ts';
import { servers } from '#lib/server/db/schema.ts';
import { eq } from 'drizzle-orm';
import { decrypt } from '#lib/server/crypto.ts';
import { fetchStackPs, fetchPodPs, fetchStats, AgentError } from '#lib/server/agents/client.ts';

export const GET: RequestHandler = async ({ locals, params, url }) => {
	if (!locals.user) error(401, 'nicht angemeldet');
	const [server] = await db.select().from(servers).where(eq(servers.id, Number(params.serverId)));
	if (!server) error(404, 'Server nicht gefunden');
	const token = decrypt(server.agentTokenEnc);
	try {
		const [containers, stats] = await Promise.all([
			url.searchParams.get('kind') === 'pod'
				? fetchPodPs(server.baseUrl, token, params.stack)
				: fetchStackPs(server.baseUrl, token, params.stack),
			fetchStats(server.baseUrl, token).catch(() => []) // Stats sind nice-to-have
		]);
		return Response.json({ containers, stats });
	} catch (e) {
		const msg = e instanceof AgentError ? e.message : 'Agent-Fehler';
		error(502, msg);
	}
};
