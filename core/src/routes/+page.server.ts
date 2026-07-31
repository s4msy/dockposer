import type { PageServerLoad } from './$types';
import { requireUser } from '$lib/server/guards';
import { db } from '$lib/server/db';
import { servers } from '$lib/server/db/schema';
import { syncAll } from '$lib/server/agents/sync';
import { fetchUnmanaged } from '$lib/server/agents/client';
import { decrypt } from '$lib/server/crypto';

export const load: PageServerLoad = async ({ locals }) => {
	requireUser(locals);
	const serverList = await db.select().from(servers);
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
					return [server.id, []] as const;
				}
			})
		)
	]);
	const unmanaged = Object.fromEntries(unmanagedPairs);
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
	return { servers, stacks: stacksWithMeta, unmanaged };
};
