import type { PageServerLoad } from './$types';
import { requireUser } from '$lib/server/guards';
import { db } from '$lib/server/db';
import { syncAll } from '$lib/server/agents/sync';

export const load: PageServerLoad = async ({ locals }) => {
	requireUser(locals);
	await syncAll(); // Agents sind localhost/LAN — die paar ms sind ok. Timeout: 5s pro Agent.
	const servers = await db.query.servers.findMany({ orderBy: (s, { asc }) => [asc(s.name)] });
	const stacks = await db.query.stacks.findMany({ orderBy: (s, { asc }) => [asc(s.name)] });
	return { servers, stacks };
};
