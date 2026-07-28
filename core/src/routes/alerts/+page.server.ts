import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { alerts, servers } from '$lib/server/db/schema';
import { desc, eq, isNull, isNotNull } from 'drizzle-orm';
import { requireUser } from '$lib/server/guards';

export const load: PageServerLoad = async ({ locals }) => {
	requireUser(locals);
	const serverRows = await db.select({ id: servers.id, name: servers.name }).from(servers);
	const serverNames = Object.fromEntries(serverRows.map((s) => [s.id, s.name]));
	const open = await db.select().from(alerts).where(isNull(alerts.resolvedAt)).orderBy(desc(alerts.firedAt));
	const resolved = await db
		.select()
		.from(alerts)
		.where(isNotNull(alerts.resolvedAt))
		.orderBy(desc(alerts.resolvedAt))
		.limit(20);
	return { open, resolved, serverNames };
};

export const actions: Actions = {
	ack: async ({ locals, request }) => {
		requireUser(locals);
		const id = Number((await request.formData()).get('id'));
		await db.update(alerts).set({ acknowledgedAt: new Date() }).where(eq(alerts.id, id));
	},
	resolve: async ({ locals, request }) => {
		requireUser(locals);
		const id = Number((await request.formData()).get('id'));
		await db.update(alerts).set({ resolvedAt: new Date() }).where(eq(alerts.id, id));
	}
};
