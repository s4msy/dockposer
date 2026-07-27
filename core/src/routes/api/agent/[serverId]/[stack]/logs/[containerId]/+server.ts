import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { servers } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { decrypt } from '$lib/server/crypto';
import { agentStream, AgentError } from '$lib/server/agents/client';

export const GET: RequestHandler = async ({ locals, params, url }) => {
	if (!locals.user) error(401, 'nicht angemeldet');
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(params.containerId)) error(400, 'ungültige Container-ID');

	const [server] = await db.select().from(servers).where(eq(servers.id, Number(params.serverId)));
	if (!server) error(404, 'Server nicht gefunden');

	const tail = /^\d{1,5}$/.test(url.searchParams.get('tail') ?? '') ? url.searchParams.get('tail') : '200';
	try {
		const upstream = await agentStream(
			server.baseUrl,
			decrypt(server.agentTokenEnc),
			`/v1/containers/${params.containerId}/logs?tail=${tail}`,
			'GET'
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
