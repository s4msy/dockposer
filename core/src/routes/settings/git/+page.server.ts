import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { db } from '#lib/server/db/index.ts';
import { servers, stacks } from '#lib/server/db/schema.ts';
import { eq } from 'drizzle-orm';
import { requireUser } from '#lib/server/guards.ts';
import { translator } from '#lib/i18n/index.ts';
import { decrypt, encrypt } from '#lib/server/crypto.ts';
import { fetchGitStatus, initGit, AgentError, type AgentGitStatus, type GitScope } from '#lib/server/agents/client.ts';

export const load: PageServerLoad = async ({ locals }) => {
	requireUser(locals);
	const t = translator(locals.locale);
	const list = await db.query.servers.findMany({ orderBy: (s, { asc }) => [asc(s.name)] });
	const tracked = await db
		.select({ serverId: stacks.serverId, name: stacks.name, kind: stacks.kind, gitTracking: stacks.gitTracking })
		.from(stacks);

	// Ein Eintrag pro Repo: Stacks-Repo (wenn Docker aktiv) und Pod-Repo im
	// Quadlet-Pfad (wenn Pods aktiv). Beide sind unabhängig voneinander.
	const jobs = list.flatMap((server) => {
		const scopes: GitScope[] = [];
		if (server.dockerEnabled) scopes.push('stacks');
		if (server.podsEnabled) scopes.push('pods');
		return scopes.map(async (scope) => {
			let status: AgentGitStatus | null = null;
			let error: string | null = null;
			try {
				status = await fetchGitStatus(server.baseUrl, decrypt(server.agentTokenEnc), scope);
				if (status.remote) status.remote = maskRemote(status.remote);
			} catch (e) {
				if (e instanceof AgentError && e.status === 404) {
					// Route unbekannt = Agent kennt das Git-Backend (bzw. Pod-Repos) noch nicht
					error = t('git.agentOutdated');
				} else {
					error = e instanceof AgentError ? e.message : t('git.agentUnreachable');
				}
			}
			const kind = scope === 'pods' ? 'pod' : 'stack';
			return {
				key: `${server.id}:${scope}`,
				id: server.id,
				scope,
				name: server.name,
				path: scope === 'pods' ? (status?.path ?? '') : server.stacksPath,
				// Remote wird nur maskiert ausgeliefert — kann Zugangsdaten enthalten.
				// Gespeichert wird es nur fürs Stacks-Repo (Altbestand); beim Pod-Repo
				// liegt es allein im Repo selbst.
				storedRemote: scope === 'stacks' && server.gitRemoteEnc ? maskRemote(decrypt(server.gitRemoteEnc)) : '',
				hasStoredRemote: scope === 'stacks' && !!server.gitRemoteEnc,
				status,
				error,
				tracked: tracked
					.filter((s) => s.serverId === server.id && s.kind === kind && s.gitTracking)
					.map((s) => s.name)
			};
		});
	});
	return { repos: await Promise.all(jobs) };
};

/** Zeigt das Remote ohne eingebettete Zugangsdaten an. */
function maskRemote(remote: string): string {
	return remote.replace(/\/\/([^@/]+)@/, '//***@');
}

export const actions: Actions = {
	setup: async ({ locals, request }) => {
		requireUser(locals);
		const t = translator(locals.locale);
		const form = await request.formData();
		const id = Number(form.get('id'));
		const remoteRaw = String(form.get('remote') ?? '').trim();
		const writeGitignore = form.get('writeGitignore') === 'on';
		const overwrite = form.get('overwriteGitignore') === 'on';
		const scope: GitScope = form.get('scope') === 'pods' ? 'pods' : 'stacks';

		const [server] = await db.select().from(servers).where(eq(servers.id, id));
		if (!server) return fail(404, { error: t('stack.serverNotFound') });

		// Leeres Feld = bestehendes Remote beibehalten
		let remote = remoteRaw;
		if (!remote && scope === 'stacks' && server.gitRemoteEnc) remote = decrypt(server.gitRemoteEnc);
		if (remote && !/^(https?:\/\/|git@|ssh:\/\/)/.test(remote)) {
			return fail(400, { error: t('git.remoteInvalid') });
		}

		try {
			const res = await initGit(server.baseUrl, decrypt(server.agentTokenEnc), {
				remote: remote || undefined,
				write_gitignore: writeGitignore,
				overwrite_gitignore: overwrite
			}, scope);
			if (remoteRaw && scope === 'stacks') {
				await db.update(servers).set({ gitRemoteEnc: encrypt(remoteRaw) }).where(eq(servers.id, id));
			}
			return { setupDone: `${id}:${scope}`, ...res };
		} catch (e) {
			const msg = e instanceof AgentError ? e.message : t('git.setupFailed');
			return fail(502, { error: msg });
		}
	},

	clearRemote: async ({ locals, request }) => {
		requireUser(locals);
		const id = Number((await request.formData()).get('id'));
		await db.update(servers).set({ gitRemoteEnc: null }).where(eq(servers.id, id));
		return { remoteCleared: true };
	}
};
