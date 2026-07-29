import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { beginAuthentication, finishAuthentication } from '$lib/server/webauthn';
import { createSession, rateLimit } from '$lib/server/auth';

export const GET: RequestHandler = async ({ getClientAddress }) => {
	if (!rateLimit(`webauthn:${getClientAddress()}`, 20, 60_000)) error(429, 'zu viele Versuche');
	return json(await beginAuthentication());
};

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	const ip = getClientAddress();
	if (!rateLimit(`webauthn:${ip}`, 20, 60_000)) error(429, 'zu viele Versuche');
	const { challengeId, response } = await request.json();
	const result = await finishAuthentication(challengeId, response);
	if ('error' in result) error(400, result.error);
	await createSession(cookies, result.userId, {
		userAgent: request.headers.get('user-agent') ?? undefined,
		ip
	});
	return json({ ok: true });
};
