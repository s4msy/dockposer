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
	const render = (a: (typeof openRows)[number]) => {
		if (!a.messageKey) return a;
		let params: Record<string, string | number> = {};
		try {
			params = a.messageParamsJson ? JSON.parse(a.messageParamsJson) : {};
		} catch {
			/* defekter Eintrag — mit leeren Parametern rendern */
		}
		const rendered = t(a.messageKey as MessageKey, params);
		// Ältere Einträge können Parameter tragen, die der aktuelle Text nicht
		// mehr kennt (z. B. {count} → {services}). Dann bleibt ein Platzhalter
		// stehen — in dem Fall lieber den gespeicherten Originaltext zeigen.
		return { ...a, message: /\{[a-z_]+\}/i.test(rendered) ? a.message : rendered };
	};
	return { open: openRows.map(render), resolved: resolvedRows.map(render), serverNames };
};

export const actions: Actions = {
	ack: async ({ locals, request }) => {
		requireUser(locals);
		const id = Number((await request.formData()).get('id'));
		await db.update(alerts).set({ acknowledgedAt: new Date() }).where(eq(alerts.id, id));
	},
	resolveAll: async ({ locals }) => {
		requireUser(locals);
		await db.update(alerts).set({ resolvedAt: new Date() }).where(isNull(alerts.resolvedAt));
	},

	resolve: async ({ locals, request }) => {
		requireUser(locals);
		const id = Number((await request.formData()).get('id'));
		await db.update(alerts).set({ resolvedAt: new Date() }).where(eq(alerts.id, id));
	}
};
