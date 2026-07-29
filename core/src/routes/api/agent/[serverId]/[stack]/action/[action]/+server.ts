import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { servers } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { decrypt } from '$lib/server/crypto';
import { agentStream, AgentError } from '$lib/server/agents/client';
import { engine } from '$lib/server/alerts/engine';
import { recordUpdateRun } from '$lib/server/updates/run';

const ALLOWED = new Set(['up', 'down', 'pull', 'restart', 'update']);

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

		let body = upstream.body!;
		if (params.action === 'update') {
			// Tee: Stream zum Browser durchreichen UND mitschneiden → update_runs + Alerts
			const startedAt = new Date();
			const decoder = new TextDecoder();
			let buffer = '';
			let finalized = false;
			const finalize = async () => {
				if (finalized) return;
				finalized = true;
				await recordUpdateRun(server.id, params.stack, 'manual', buffer, startedAt).catch((e) =>
					console.error('[updates] Aufzeichnung fehlgeschlagen:', e)
				);
			};
			const reader = upstream.body!.getReader();
			body = new ReadableStream({
				async pull(controller) {
					const { done, value } = await reader.read();
					if (done) {
						controller.close();
						await finalize();
						return;
					}
					buffer += decoder.decode(value, { stream: true });
					if (buffer.length > 40_000) buffer = buffer.slice(-30_000);
					controller.enqueue(value);
				},
				cancel(reason) {
					reader.cancel(reason);
					void finalize();
				}
			});
		}

		return new Response(body, {
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
