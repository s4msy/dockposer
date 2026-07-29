import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { beginRegistration, finishRegistration } from '$lib/server/webauthn';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'nicht angemeldet');
	return json(await beginRegistration(locals.user.id, locals.user.username));
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, 'nicht angemeldet');
	const { challengeId, response, deviceName } = await request.json();
	const result = await finishRegistration(locals.user.id, challengeId, response, String(deviceName ?? ''));
	if (!result.ok) error(400, result.error ?? 'fehlgeschlagen');
	return json({ ok: true });
};
