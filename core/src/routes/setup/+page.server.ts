import type { Actions, PageServerLoad } from './$types';
import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { createSession, hashPassword } from '$lib/server/auth';
import { translator } from '$lib/i18n';

// Nur erreichbar, solange kein User existiert — danach 404-artig weg.
async function noUsersYet() {
	const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
	return !anyUser;
}

export const load: PageServerLoad = async () => {
	if (!(await noUsersYet())) redirect(303, '/login');
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress, locals }) => {
		const t = translator(locals.locale);
		if (!(await noUsersYet())) redirect(303, '/login');
		const form = await request.formData();
		const username = String(form.get('username') ?? '').trim();
		const password = String(form.get('password') ?? '');
		if (username.length < 2) return fail(400, { error: t('setup.usernameShort') });
		if (password.length < 12) return fail(400, { error: t('setup.passwordShort') });

		const [user] = await db
			.insert(users)
			.values({ username, passwordHash: await hashPassword(password) })
			.returning();
		await createSession(cookies, user.id, {
			userAgent: request.headers.get('user-agent') ?? undefined,
			ip: getClientAddress()
		});
		redirect(303, '/'); // TOTP-Einrichtung folgt unter /settings (M1, nächster Patch)
	}
};
