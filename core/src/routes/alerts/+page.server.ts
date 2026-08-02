import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { alerts, servers } from '$lib/server/db/schema';
import { desc, eq, isNull, isNotNull } from 'drizzle-orm';
import { requireUser } from '$lib/server/guards';
import { translator, type MessageKey } from '$lib/i18n';

export const load: PageServerLoad = async ({ locals }) => {
	requireUser(locals);
	const serverRows = await db.select({ id: servers.id, name: servers.name }).from(servers);
	const serverNames = Object.fromEntries(serverRows.map((s) => [s.id, s.name]));
	const openRows = await db.select().from(alerts).where(isNull(alerts.resolvedAt)).orderBy(desc(alerts.firedAt));
	const resolvedRows = await db
		.select()
		.from(alerts)
		.where(isNotNull(alerts.resolvedAt))
		.orderBy(desc(alerts.resolvedAt))
		.limit(20);

	// Meldung erst hier übersetzen; Alerts ohne Schlüssel stammen aus älteren
	// Versionen und behalten ihren gespeicherten Text.
	const t = translator(locals.locale);
	const render = (a: typeof openRows[number]) => ({
		...a,
		message: a.messageKey
			? t(a.messageKey as MessageKey, a.messageParamsJson ? JSON.parse(a.messageParamsJson) : {})
			: a.message
	});
	return { open: openRows.map(render), resolved: resolvedRows.map(render), serverNames };
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
