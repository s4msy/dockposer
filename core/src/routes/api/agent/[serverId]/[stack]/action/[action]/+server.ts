import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { servers } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { decrypt } from '$lib/server/crypto';
import { agentStream, AgentError } from '$lib/server/agents/client';
import { engine } from '$lib/server/alerts/engine';
import { recordUpdateRun } from '$lib/server/updates/run';
import { checkStackUpdates } from '$lib/server/updates/checker';
import { syncUpdateAlert } from '$lib/server/updates/notify';

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
			// Der Mitschnitt läuft im Hintergrund weiter, auch wenn der Browser abbricht.
			// Vorher hing das Lesen am `pull` des Client-Streams: Bildschirm aus, Tab in den
			// Hintergrund oder WLAN→Mobilfunk beendete den Stream, `cancel` kappte damit die
			// Verbindung zum Agent mitten im Stabilisierungsfenster — und weil kein
			// `event: result` mehr ankam, wurde ein erfolgreiches Update als fehlgeschlagen
			// verbucht (Push: „Update-Lauf ohne Ergebnis abgebrochen").
			const startedAt = new Date();
			const decoder = new TextDecoder();
			const reader = upstream.body!.getReader();
			let buffer = '';
			// Halter statt loser Variable: Der Controller wird erst im Callback gesetzt,
			// die Kontrollflussanalyse sähe ihn sonst dauerhaft als null.
			const sink: { client: ReadableStreamDefaultController<Uint8Array> | null } = { client: null };
			let queued = 0;

			body = new ReadableStream({
				start(controller) {
					sink.client = controller;
				},
				cancel() {
					// Nur den Weg zum Browser aufgeben — der Lauf läuft weiter.
					sink.client = null;
				}
			}) as typeof body;

			void (async () => {
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						if (buffer.length > 40_000) buffer = buffer.slice(-30_000);
						if (sink.client) {
							try {
								// Ohne Gegendruck: Wenn der Browser nicht mehr abholt, nicht
								// unbegrenzt puffern — der Mitschnitt ist das Wichtige.
								queued += value.byteLength;
								if (queued > 2_000_000) throw new Error('Client-Puffer voll');
								sink.client.enqueue(value);
							} catch {
								sink.client = null;
							}
						}
					}
					sink.client?.close();
				} catch (e) {
					buffer += `\nStream abgebrochen: ${e}`;
					try {
						sink.client?.close();
					} catch {
						/* Client war schon weg */
					}
				} finally {
					await recordUpdateRun(server.id, params.stack, 'manual', buffer, startedAt).catch((e) =>
						console.error('[updates] Aufzeichnung fehlgeschlagen:', e)
					);
					// Frisch nachprüfen: Der Feed stimmt sofort, und eine offene
					// „Update verfügbar"-Meldung verschwindet, statt bis zum nächsten
					// Prüflauf (Default 6 h) im Alert-Center stehen zu bleiben.
					await checkStackUpdates(server, params.stack)
						.then((entries) => syncUpdateAlert(server.id, params.stack, entries, 'manual', false))
						.catch((e) => console.warn('[updates] Nachprüfung fehlgeschlagen:', e));
				}
			})();
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
