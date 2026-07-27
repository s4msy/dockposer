import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { servers } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { decrypt } from '$lib/server/crypto';
import { fetchStackPs, fetchStats, AgentError } from '$lib/server/agents/client';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, 'nicht angemeldet');
	const [server] = await db.select().from(servers).where(eq(servers.id, Number(params.serverId)));
	if (!server) error(404, 'Server nicht gefunden');
	const token = decrypt(server.agentTokenEnc);
	try {
		const [containers, stats] = await Promise.all([
			fetchStackPs(server.baseUrl, token, params.stack),
			fetchStats(server.baseUrl, token).catch(() => []) // Stats sind nice-to-have
		]);
		return json({ containers, stats });
	} catch (e) {
		const msg = e instanceof AgentError ? e.message : 'Agent-Fehler';
		error(502, msg);
	}
};
