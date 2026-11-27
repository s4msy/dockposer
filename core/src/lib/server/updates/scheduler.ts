// Update-Scheduler: prüft periodisch alle Stacks gegen die Registries (Default 6h)
// und führt bei Policy 'auto' Updates mit Auto-Rollback direkt aus.
import { db } from '#lib/server/db/index.ts';
import { servers, stacks } from '#lib/server/db/schema.ts';
import { eq } from 'drizzle-orm';
import type { StackKind } from '#lib/updates.ts';
import { decrypt } from '#lib/server/crypto.ts';
import { agentStream, fetchAutoUpdateTimer, fetchImages } from '#lib/server/agents/client.ts';
import { checkStackUpdates, type UpdateEntry } from './checker';
import { recordUpdateRun } from './run';
import { syncUpdateAlert, clearUpdateAlert } from './notify';

const CHECK_INTERVAL_MS = Number(process.env.UPDATE_CHECK_HOURS ?? 6) * 3_600_000;
const INITIAL_DELAY_MS = 90_000;

async function runPolicyUpdate(server: typeof servers.$inferSelect, stackName: string, kind: StackKind) {
	console.log(`[updates] Auto-Update: ${server.name}/${stackName}${kind === 'pod' ? ' (Pod)' : ''}`);
	const startedAt = new Date();
	let buffer = '';
	try {
		const res = await agentStream(
			server.baseUrl,
			decrypt(server.agentTokenEnc),
			`/v1/${kind === 'pod' ? 'pods' : 'stacks'}/${encodeURIComponent(stackName)}/update`
		);
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			if (buffer.length > 40_000) buffer = buffer.slice(-30_000);
		}
	} catch (e) {
		buffer += `\nevent-los abgebrochen: ${e}`;
	}
	await recordUpdateRun(server.id, stackName, 'policy', buffer, startedAt, kind);
	// Nach dem Lauf frisch prüfen, damit der Feed stimmt
	const after = await checkStackUpdates(server, stackName, kind).catch(() => null);
	if (after) await syncUpdateAlert(server.id, stackName, after, 'auto', false).catch(() => {});
}

/**
 * Hat jemand außerhalb von Dockposer aktualisiert (podman-auto-update.timer,
 * oder per SSH)? Erkennbar daran, dass der laufende Digest nicht mehr der aus
 * dem letzten Prüflauf ist. Eigene Läufe prüfen danach sofort neu — für sie
 * stimmt der Feed schon. Wird als Lauf in die Historie eingetragen und gemeldet.
 */
async function recordExternalPodUpdate(server: typeof servers.$inferSelect, stack: typeof stacks.$inferSelect) {
	let feed: UpdateEntry[] = [];
	try {
		feed = stack.updatesJson ? JSON.parse(stack.updatesJson) : [];
	} catch {
		return;
	}
	if (!feed.length) return;
	const images = await fetchImages(server.baseUrl, decrypt(server.agentTokenEnc), stack.name, 'pod');
	const oldD: Record<string, string> = {};
	const newD: Record<string, string> = {};
	for (const img of images) {
		const before = feed.find((e) => e.service === img.service)?.current;
		const digests = img.digests ?? [];
		if (!before || !digests.length) continue;
		if (digests.some((d) => d.endsWith(before))) continue;
		oldD[img.service] = before;
		newD[img.service] = digests[0];
	}
	if (!Object.keys(newD).length) return;
	console.log(`[updates] ${server.name}/${stack.name}: von außen aktualisiert (${Object.keys(newD).join(', ')})`);
	const buffer =
		'Außerhalb von Dockposer aktualisiert (podman-auto-update.timer oder manuell), erkannt beim Prüflauf.\n\n' +
		`event: result\ndata: ${JSON.stringify({ result: 'success', old_digests: oldD, new_digests: newD })}\n\n`;
	await recordUpdateRun(server.id, stack.name, 'policy', buffer, new Date(), 'pod');
}

async function checkAll() {
	const allServers = await db.select().from(servers);
	for (const server of allServers) {
		// Pods: Automatisch heißt bei Podman der systemd-Timer des Servers — Dockposer
		// führt dort nichts selbst aus, sondern prüft, meldet und protokolliert.
		let podTimer = false;
		if (server.podsEnabled) {
			podTimer = await fetchAutoUpdateTimer(server.baseUrl, decrypt(server.agentTokenEnc))
				.then((t) => t.enabled)
				.catch(() => false);
		}
		const serverStacks = await db.select().from(stacks).where(eq(stacks.serverId, server.id));
		for (const stack of serverStacks) {
			try {
				// Gestoppte Stacks werden nicht geprüft. Ein Stack, den jemand bewusst
				// heruntergefahren hat (Watchtower, Testkram, Saisonales), ist kein
				// Rückstand: Die Meldung wäre nutzlos, sie holt den Stack über den
				// „gestoppte ausblenden"-Filter zurück in die Übersicht — und bei
				// Policy 'auto' hätte das folgende `up -d` ihn sogar wieder gestartet.
				// Der Check-Knopf in der Detailansicht prüft weiterhin auf Zuruf.
				if (stack.state === 'stopped') {
					await clearUpdateAlert(server.id, stack.name);
					continue;
				}
				if (stack.kind === 'pod') {
					await recordExternalPodUpdate(server, stack).catch((e) =>
						console.warn(`[updates] Abgleich fehlgeschlagen ${server.name}/${stack.name}:`, e)
					);
					const entries = await checkStackUpdates(server, stack.name, 'pod');
					// Timer an: Er holt das Update selbst — keine „verfügbar"-Meldung
					await syncUpdateAlert(server.id, stack.name, entries, podTimer ? 'auto' : 'manual', true);
					continue;
				}
				const entries = await checkStackUpdates(server, stack.name, stack.kind);
				// Nur echte, anwendbare Updates. Status 'pinned' bleibt bewusst außen vor:
				// ein Update kann an einem per Digest gepinnten Image nichts ändern, der
				// Lauf wäre garantiert wirkungslos (und erzeugte trotzdem Historie + Last).
				const hasUpdate = entries.some((e: UpdateEntry) => e.status === 'update');
				if (hasUpdate && stack.updatePolicy === 'auto') {
					await runPolicyUpdate(server, stack.name, stack.kind);
				} else {
					// Manuelle Stacks: einmal pro neuer Version aufs Handy melden
					await syncUpdateAlert(server.id, stack.name, entries, stack.updatePolicy, true);
				}
			} catch (e) {
				console.warn(`[updates] Check fehlgeschlagen ${server.name}/${stack.name}:`, e);
			}
		}
	}
	console.log('[updates] Registry-Check-Durchlauf beendet');
}

export function startUpdateSystem() {
	setTimeout(() => {
		checkAll().catch((e) => console.error('[updates] Fehler:', e));
		setInterval(() => checkAll().catch((e) => console.error('[updates] Fehler:', e)), CHECK_INTERVAL_MS);
	}, INITIAL_DELAY_MS);
	console.log(`[updates] Scheduler gestartet (Intervall ${CHECK_INTERVAL_MS / 3_600_000}h)`);
}
