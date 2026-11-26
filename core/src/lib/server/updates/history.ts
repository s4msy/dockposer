import { db } from '#lib/server/db/index.ts';
import { updateRuns } from '#lib/server/db/schema.ts';
import { desc, eq } from 'drizzle-orm';
import type { HistoryRun, ServiceChange } from '#lib/updates.ts';

/** Die letzten Update-Läufe eines Stacks oder Pods, aufbereitet für die Anzeige. */
export async function loadHistory(stackId: number | undefined, limit = 15): Promise<HistoryRun[]> {
	if (!stackId) return [];
	const runs = await db
		.select()
		.from(updateRuns)
		.where(eq(updateRuns.stackId, stackId))
		.orderBy(desc(updateRuns.startedAt))
		.limit(limit);
	return runs.map((r) => {
		// Für die Anzeige interessiert nur, welche Dienste sich geändert haben
		let changed: string[] = [];
		try {
			const oldD: Record<string, string> = r.oldDigestsJson ? JSON.parse(r.oldDigestsJson) : {};
			const newD: Record<string, string> = r.newDigestsJson ? JSON.parse(r.newDigestsJson) : {};
			changed = Object.keys(newD).filter((svc) => oldD[svc] !== newD[svc]);
		} catch {
			/* alter Eintrag ohne Digest-Daten */
		}
		let changes: ServiceChange[] = [];
		try {
			changes = r.changesJson ? JSON.parse(r.changesJson) : [];
		} catch {
			/* defekter Eintrag → ohne Zusatzinfo anzeigen */
		}
		return {
			id: r.id,
			trigger: r.trigger,
			result: r.result,
			changed,
			changes,
			logExcerpt: r.logExcerpt,
			startedAt: r.startedAt,
			finishedAt: r.finishedAt
		};
	});
}
