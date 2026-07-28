import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { servers } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { decrypt } from '$lib/server/crypto';
import { agentStream, AgentError } from '$lib/server/agents/client';
import { engine } from '$lib/server/alerts/engine';

const ALLOWED = new Set(['up', 'down', 'pull', 'restart']);

export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, 'nicht angemeldet');
	if (!ALLOWED.has(params.action)) error(400, 'unbekannte Aktion');

	const [server] = await db.select().from(servers).where(eq(servers.id, Number(params.serverId)));
	if (!server) error(404, 'Server nicht gefunden');

	// Eigene Aktionen sollen keine Exit-Alerts auslösen (Projektname = normalisierter Ordnername)
	engine.suppress(server.id, params.stack.toLowerCase().replace(/[^a-z0-9_-]/g, ''));
	try {
		const upstream = await agentStream(
			server.baseUrl,
			decrypt(server.agentTokenEnc),
			`/v1/stacks/${encodeURIComponent(params.stack)}/${params.action}`
		);
		return new Response(upstream.body, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'X-Accel-Buffering': 'no'
			}
		});
	} catch (e) {
		const msg = e instanceof AgentError ? e.message : 'Agent-Fehler';
		error(502, msg);
	}
};
