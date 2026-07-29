import { db } from '$lib/server/db';
import { servers, stacks, updateRuns } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { engine } from '$lib/server/alerts/engine';

interface AgentResult {
	result: 'success' | 'rolled_back' | 'failed';
	stage?: string;
	reason?: string;
	old_digests?: Record<string, string>;
	new_digests?: Record<string, string>;
}

export function parseResultEvent(buffer: string): AgentResult | null {
	const matches = [...buffer.matchAll(/event: result\ndata: (.*)\n/g)];
	if (matches.length === 0) return null;
	try {
		return JSON.parse(matches[matches.length - 1][1]);
	} catch {
		return null;
	}
}

export async function recordUpdateRun(
	serverId: number,
	stackName: string,
	trigger: 'manual' | 'policy',
	buffer: string,
	startedAt: Date
) {
	const parsed = parseResultEvent(buffer);
	const [stackRow] = await db
		.select({ id: stacks.id })
		.from(stacks)
		.where(and(eq(stacks.serverId, serverId), eq(stacks.name, stackName)));
	if (stackRow) {
		await db.insert(updateRuns).values({
			stackId: stackRow.id,
			trigger,
			result: parsed?.result ?? 'failed',
			oldDigestsJson: parsed?.old_digests ? JSON.stringify(parsed.old_digests) : null,
			newDigestsJson: parsed?.new_digests ? JSON.stringify(parsed.new_digests) : null,
			logExcerpt: buffer.slice(-4000),
			startedAt,
			finishedAt: new Date()
		});
	}

	if (!parsed || parsed.result === 'failed' || parsed.result === 'rolled_back') {
		const kind = parsed?.stage === 'pull' ? 'pull_failed' : 'update_rolled_back';
		const detail = parsed?.reason ?? 'Update-Lauf ohne Ergebnis abgebrochen';
		const message =
			kind === 'pull_failed'
				? `Update von ${stackName}: Pull fehlgeschlagen`
				: parsed?.result === 'rolled_back'
					? `Update von ${stackName} fehlgeschlagen — Rollback aktiv. Läuft wieder auf altem Stand. (${detail})`
					: `Update von ${stackName} fehlgeschlagen: ${detail}`;
		await engine.updateProblem(serverId, stackName, kind, message);
	} else if (parsed.result === 'success') {
		await engine.updateOk(serverId, stackName);
	}

	// Feed direkt neu prüfen, damit erledigte Updates sofort verschwinden
	try {
		const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
		if (server) {
			const { checkStackUpdates } = await import('./checker');
			await checkStackUpdates(server, stackName);
		}
	} catch {
		/* nächster Scheduler-Lauf korrigiert es */
	}
	return parsed;
}
