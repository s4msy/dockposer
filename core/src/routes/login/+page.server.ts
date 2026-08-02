import type { Actions, PageServerLoad } from './$types';
import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { createSession, rateLimit, verifyPassword, verifyTotp } from '$lib/server/auth';
import { translator } from '$lib/i18n';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) redirect(303, '/');
	const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
	if (!anyUser) redirect(303, '/setup');
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress, locals }) => {
		const t = translator(locals.locale);
		const ip = getClientAddress();
		if (!rateLimit(`login:${ip}`, 10, 60_000)) {
			return fail(429, { error: t('login.rateLimited') });
		}
		const form = await request.formData();
		const username = String(form.get('username') ?? '').trim();
		const password = String(form.get('password') ?? '');
		const totpCode = String(form.get('totp') ?? '').trim();

		const [user] = await db.select().from(users).where(eq(users.username, username));
		if (!user || !(await verifyPassword(password, user.passwordHash))) {
			return fail(400, { error: t('login.failed'), username });
		}
		if (user.totpEnabled && user.totpSecret) {
			if (!totpCode) return fail(400, { needTotp: true, username });
			if (!verifyTotp(user.totpSecret, totpCode)) {
				return fail(400, { error: t('login.totpInvalid'), needTotp: true, username });
			}
		}
		await createSession(cookies, user.id, { userAgent: request.headers.get('user-agent') ?? undefined, ip });
		redirect(303, '/');
	}
};
