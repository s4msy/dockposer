import type { PageServerLoad } from './$types';
import { requireUser } from '$lib/server/guards';
import { db } from '$lib/server/db';

export const load: PageServerLoad = async ({ locals }) => {
	requireUser(locals);
	const servers = await db.query.servers.findMany();
	const stacks = await db.query.stacks.findMany();
	return { servers, stacks };
};
