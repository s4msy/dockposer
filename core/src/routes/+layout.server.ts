import type { LayoutServerLoad } from './$types';
import { db } from '$lib/server/db';
import { alerts } from '$lib/server/db/schema';
import { isNull } from 'drizzle-orm';
import { count } from 'drizzle-orm';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) return { openAlerts: 0 };
	const [row] = await db.select({ n: count() }).from(alerts).where(isNull(alerts.resolvedAt));
	return { openAlerts: row?.n ?? 0 };
};
