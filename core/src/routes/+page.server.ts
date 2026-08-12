import type { PageServerLoad } from './$types';
import { requireUser } from '$lib/server/guards';
import { db } from '$lib/server/db';
import { and, desc, gte, inArray, isNull } from 'drizzle-orm';
import { alerts, servers as serversTable, updateRuns } from '$lib/server/db/schema';
import { syncAll } from '$lib/server/agents/sync';
import { fetchUnmanaged } from '$lib/server/agents/client';
import { decrypt } from '$lib/server/crypto';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);

	const serverList = await db.select().from(serversTable);
	// Sync und Unmanaged-Abfrage laufen nebeneinander statt nacheinander —
	// spart bei mehreren Servern eine komplette Roundtrip-Runde.
	const [, unmanagedPairs] = await Promise.all([
		syncAll(),
		Promise.all(
			serverList.map(async (server) => {
				try {
					const list = await fetchUnmanaged(server.baseUrl, decrypt(server.agentTokenEnc));
					return [server.id, list] as const;
				} catch {
					// Alte Agents kennen die Route nicht, offline-Server antworten gar nicht
					return [server.id, []] as const;
				}
			})
		)
	]);
	const unmanaged = Object.fromEntries(unmanagedPairs);

	// Nach dem Sync frisch aus dem Cache lesen
	const servers = await db.query.servers.findMany({ orderBy: (s, { asc }) => [asc(s.name)] });
	const stacks = await db.query.stacks.findMany({ orderBy: (s, { asc }) => [asc(s.name)] });
	const stacksWithMeta = stacks.map((s) => {
		let updatesCount = 0;
		try {
			const entries: { status: string }[] = s.updatesJson ? JSON.parse(s.updatesJson) : [];
			updatesCount = entries.filter((e) => e.status === 'update').length;
		} catch {
			/* alter/kaputter Cache-Eintrag — kein Badge */
		}
		return { ...s, updatesCount };
	});

	// Optional: Stacks ausblenden, von denen nichts läuft (Ordner vorhanden,
	// Container gestoppt oder weggeräumt). Nie stillschweigend — die Anzahl
	// wird pro Server angezeigt, damit nichts unbemerkt verschwindet.
	const hideStopped = user.hideStoppedStacks;

	// Stacks mit einem Problem dürfen NIE ausgeblendet werden. Ein Stack, der
	// wegen eines fehlgeschlagenen Updates unten liegt, ist genau der, den man
	// sehen muss — ihn zu verstecken war der gefährlichste Fall dieser Funktion.
	// Nur AKTUELLE Probleme halten einen gestoppten Stack sichtbar. Ohne die
	// Zeitgrenze würde ein Monate alter, nie quittierter Alert den Stack für
	// immer einblenden — genau das war beim ersten Wurf der Fall.
	const RECENT_MS = 7 * 24 * 3600 * 1000;
	const since = new Date(Date.now() - RECENT_MS);
	const troubled = new Set<number>();
	if (hideStopped) {
		const stackIds = stacksWithMeta.map((s) => s.id);
		if (stackIds.length > 0) {
			// a) jüngster Update-Lauf ging schief und liegt nicht lange zurück
			const runs = await db
				.select({ stackId: updateRuns.stackId, result: updateRuns.result, startedAt: updateRuns.startedAt })
				.from(updateRuns)
				.where(inArray(updateRuns.stackId, stackIds))
				.orderBy(desc(updateRuns.startedAt));
			const seen = new Set<number>();
			for (const run of runs) {
				if (seen.has(run.stackId)) continue; // nur der jüngste Lauf zählt
				seen.add(run.stackId);
				if (run.result !== 'success' && run.startedAt >= since) troubled.add(run.stackId);
			}
			// b) offener, noch nicht quittierter Alert aus den letzten Tagen
			for (const row of await db
				.select({ stackId: alerts.stackId })
				.from(alerts)
				.where(
					and(
						isNull(alerts.resolvedAt),
						isNull(alerts.acknowledgedAt),
						gte(alerts.firedAt, since),
						inArray(alerts.stackId, stackIds)
					)
				)) {
				if (row.stackId != null) troubled.add(row.stackId);
			}
		}
	}

	const hiddenPerServer: Record<number, number> = {};
	const visibleStacks = stacksWithMeta.filter((s) => {
		if (!hideStopped || s.state !== 'stopped') return true;
		if (troubled.has(s.id)) return true; // Problemfälle bleiben sichtbar
		hiddenPerServer[s.serverId] = (hiddenPerServer[s.serverId] ?? 0) + 1;
		return false;
	});

	return { servers, stacks: visibleStacks, unmanaged, hiddenPerServer, hideStopped };
};
