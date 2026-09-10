// Update-Scheduler: prüft periodisch alle Stacks gegen die Registries (Default 6h)
// und führt bei Policy 'auto' Updates mit Auto-Rollback direkt aus.
import { db } from '$lib/server/db';
import { servers, stacks } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { decrypt } from '$lib/server/crypto';
import { agentStream } from '$lib/server/agents/client';
import { checkStackUpdates, type UpdateEntry } from './checker';
import { recordUpdateRun } from './run';
import { syncUpdateAlert } from './notify';

const CHECK_INTERVAL_MS = Number(process.env.UPDATE_CHECK_HOURS ?? 6) * 3_600_000;
const INITIAL_DELAY_MS = 90_000;

async function runPolicyUpdate(server: typeof servers.$inferSelect, stackName: string) {
	console.log(`[updates] Auto-Update: ${server.name}/${stackName}`);
	const startedAt = new Date();
	let buffer = '';
	try {
		const res = await agentStream(
			server.baseUrl,
			decrypt(server.agentTokenEnc),
			`/v1/stacks/${encodeURIComponent(stackName)}/update`
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
	await recordUpdateRun(server.id, stackName, 'policy', buffer, startedAt);
	// Nach dem Lauf frisch prüfen, damit der Feed stimmt
	const after = await checkStackUpdates(server, stackName).catch(() => null);
	if (after) await syncUpdateAlert(server.id, stackName, after, 'auto', false).catch(() => {});
}

async function checkAll() {
	const allServers = await db.select().from(servers);
	for (const server of allServers) {
		const serverStacks = await db.select().from(stacks).where(eq(stacks.serverId, server.id));
		for (const stack of serverStacks) {
			try {
				const entries = await checkStackUpdates(server, stack.name);
				// Nur echte, anwendbare Updates. Status 'pinned' bleibt bewusst außen vor:
				// ein Update kann an einem per Digest gepinnten Image nichts ändern, der
				// Lauf wäre garantiert wirkungslos (und erzeugte trotzdem Historie + Last).
				const hasUpdate = entries.some((e: UpdateEntry) => e.status === 'update');
				if (hasUpdate && stack.updatePolicy === 'auto') {
					await runPolicyUpdate(server, stack.name);
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
