import type { PageServerLoad } from './$types';
import { requireUser } from '$lib/server/guards';
import { db } from '$lib/server/db';
import { servers as serversTable } from '$lib/server/db/schema';
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
	const hiddenPerServer: Record<number, number> = {};
	const visibleStacks = stacksWithMeta.filter((s) => {
		if (!hideStopped || s.state !== 'stopped') return true;
		hiddenPerServer[s.serverId] = (hiddenPerServer[s.serverId] ?? 0) + 1;
		return false;
	});

	return { servers, stacks: visibleStacks, unmanaged, hiddenPerServer, hideStopped };
};
