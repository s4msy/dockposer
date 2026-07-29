import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { pushSubscriptions } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, 'nicht angemeldet');
	const body = await request.json();
	const { endpoint, keys } = body ?? {};
	if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || !keys?.p256dh || !keys?.auth) {
		error(400, 'ungültige Subscription');
	}
	// Upsert per Endpoint: Gerät erneuert seine Subscription gelegentlich
	await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
	await db.insert(pushSubscriptions).values({
		userId: locals.user.id,
		transport: 'webpush',
		endpoint,
		keysP256dh: keys.p256dh,
		keysAuth: keys.auth
	});
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, 'nicht angemeldet');
	const { endpoint } = await request.json();
	if (typeof endpoint === 'string') {
		await db.delete(pushSubscriptions).where(and(
			eq(pushSubscriptions.userId, locals.user.id),
			eq(pushSubscriptions.endpoint, endpoint)
		));
	}
	return json({ ok: true });
};
