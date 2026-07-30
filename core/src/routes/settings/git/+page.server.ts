import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { servers, stacks } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { requireUser } from '$lib/server/guards';
import { decrypt, encrypt } from '$lib/server/crypto';
import { fetchGitStatus, initGit, AgentError, type AgentGitStatus } from '$lib/server/agents/client';

export const load: PageServerLoad = async ({ locals }) => {
	requireUser(locals);
	const list = await db.query.servers.findMany({ orderBy: (s, { asc }) => [asc(s.name)] });
	const trackedStacks = await db
		.select({ serverId: stacks.serverId, name: stacks.name, gitTracking: stacks.gitTracking })
		.from(stacks);

	const rows = await Promise.all(
		list.map(async (server) => {
			let status: AgentGitStatus | null = null;
			let error: string | null = null;
			try {
				status = await fetchGitStatus(server.baseUrl, decrypt(server.agentTokenEnc));
			} catch (e) {
				error = e instanceof AgentError ? e.message : 'Agent nicht erreichbar';
			}
			return {
				id: server.id,
				name: server.name,
				stacksPath: server.stacksPath,
				// Remote wird nur maskiert ausgeliefert — kann Zugangsdaten enthalten
				storedRemote: server.gitRemoteEnc ? maskRemote(decrypt(server.gitRemoteEnc)) : '',
				hasStoredRemote: !!server.gitRemoteEnc,
				status,
				error,
				tracked: trackedStacks.filter((s) => s.serverId === server.id && s.gitTracking).map((s) => s.name)
			};
		})
	);
	return { servers: rows };
};

/** Zeigt das Remote ohne eingebettete Zugangsdaten an. */
function maskRemote(remote: string): string {
	return remote.replace(/\/\/([^@/]+)@/, '//***@');
}

export const actions: Actions = {
	setup: async ({ locals, request }) => {
		requireUser(locals);
		const form = await request.formData();
		const id = Number(form.get('id'));
		const remoteRaw = String(form.get('remote') ?? '').trim();
		const writeGitignore = form.get('writeGitignore') === 'on';
		const overwrite = form.get('overwriteGitignore') === 'on';

		const [server] = await db.select().from(servers).where(eq(servers.id, id));
		if (!server) return fail(404, { error: 'Server nicht gefunden.' });

		// Leeres Feld = bestehendes Remote beibehalten
		let remote = remoteRaw;
		if (!remote && server.gitRemoteEnc) remote = decrypt(server.gitRemoteEnc);
		if (remote && !/^(https?:\/\/|git@|ssh:\/\/)/.test(remote)) {
			return fail(400, { error: 'Remote muss mit https://, ssh:// oder git@ beginnen.' });
		}

		try {
			const res = await initGit(server.baseUrl, decrypt(server.agentTokenEnc), {
				remote: remote || undefined,
				write_gitignore: writeGitignore,
				overwrite_gitignore: overwrite
			});
			if (remoteRaw) {
				await db.update(servers).set({ gitRemoteEnc: encrypt(remoteRaw) }).where(eq(servers.id, id));
			}
			return { setupDone: id, ...res };
		} catch (e) {
			const msg = e instanceof AgentError ? e.message : 'Einrichtung fehlgeschlagen';
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
