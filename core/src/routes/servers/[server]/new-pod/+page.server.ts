import type { Actions, PageServerLoad } from './$types';
import { error, fail, redirect } from '@sveltejs/kit';
import { db } from '#lib/server/db/index.ts';
import { servers, stacks } from '#lib/server/db/schema.ts';
import { and, eq } from 'drizzle-orm';
import { requireUser } from '#lib/server/guards.ts';
import { decrypt } from '#lib/server/crypto.ts';
import { createPod, fetchGitStatus, AgentError } from '#lib/server/agents/client.ts';
import { syncServer } from '#lib/server/agents/sync.ts';
import { translator } from '#lib/i18n/index.ts';

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.(pod|container|network|volume|image|build|env)$/;

async function loadServer(id: string) {
	const [server] = await db.select().from(servers).where(eq(servers.id, Number(id)));
	if (!server) error(404, 'Server nicht gefunden');
	if (!server.podsEnabled) error(404, 'Pods sind auf diesem Server nicht aktiv');
	return server;
}

export const load: PageServerLoad = async ({ locals, params }) => {
	requireUser(locals);
	const server = await loadServer(params.server);
	// Git-Haken nur anbieten, wenn das Pod-Repo eingerichtet ist
	let gitReady = false;
	try {
		gitReady = (await fetchGitStatus(server.baseUrl, decrypt(server.agentTokenEnc), 'pods')).is_repo;
	} catch {
		/* Agent zu alt oder offline — dann eben ohne */
	}
	return { server: { id: server.id, name: server.name, podmanVersion: server.podmanVersion }, gitReady };
};

export const actions: Actions = {
	default: async ({ locals, params, request }) => {
		const user = requireUser(locals);
		const t = translator(locals.locale);
		const server = await loadServer(params.server);
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const git = form.get('git') === 'on';
		// Dateien kommen als file.<n>.name / file.<n>.content
		const files: Record<string, string> = {};
		for (const [key, value] of form) {
			const m = key.match(/^file\.(\d+)\.name$/);
			if (!m) continue;
			const fileName = String(value).trim();
			const content = String(form.get(`file.${m[1]}.content`) ?? '').replace(/\r\n/g, '\n');
			if (!fileName) continue;
			if (!FILE_RE.test(fileName)) return fail(400, { error: t('pod.invalidFileName') + ` (${fileName})`, name });
			files[fileName] = content;
		}
		if (!NAME_RE.test(name)) return fail(400, { error: t('newstack.invalidName'), name });
		try {
			await createPod(
				server.baseUrl,
				decrypt(server.agentTokenEnc),
				name,
				files,
				git ? { message: `Pod ${name} angelegt via Dockposer (${user.username})` } : undefined
			);
		} catch (e) {
			return fail(422, { error: e instanceof AgentError ? e.message : t('stack.unknownError'), name });
		}
		// Sofort einlesen, damit die Pod-Seite den Eintrag kennt
		await syncServer(server).catch(() => {});
		if (git) {
			await db
				.update(stacks)
				.set({ gitTracking: true })
				.where(and(eq(stacks.serverId, server.id), eq(stacks.name, name), eq(stacks.kind, 'pod')));
		}
		redirect(303, `/pods/${server.id}/${encodeURIComponent(name)}`);
	}
};
