import type { Actions, PageServerLoad } from './$types';
import { error, fail, redirect } from '@sveltejs/kit';
import { db } from '#lib/server/db/index.ts';
import { servers, stacks } from '#lib/server/db/schema.ts';
import { and, eq } from 'drizzle-orm';
import { requireUser } from '#lib/server/guards.ts';
import { decrypt } from '#lib/server/crypto.ts';
import { translator } from '#lib/i18n/index.ts';
import {
	AgentError,
	deletePod,
	deletePodFile,
	fetchPodFiles,
	fetchPodPs,
	putPodFile,
	type AgentContainer
} from '#lib/server/agents/client.ts';
import { checkStackUpdates } from '#lib/server/updates/checker.ts';
import { syncUpdateAlert } from '#lib/server/updates/notify.ts';
import { loadHistory } from '#lib/server/updates/history.ts';
import type { UpdateEntry } from '#lib/updates.ts';

// Pod = Quadlet-Ordner im Podman-Pfad des Servers. Dateien bearbeiten (vom
// Agent mit dem Quadlet-Generator geprüft), Pod löschen, Git im eigenen Repo
// des Quadlet-Pfads, Updates: geprüft wie bei Stacks gegen die Registry,
// ausgeführt mit `podman auto-update` plus Stabilisierungsfenster.

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.(pod|container|network|volume|image|build|env)$/;

async function loadServer(serverId: string) {
	const [server] = await db.select().from(servers).where(eq(servers.id, Number(serverId)));
	if (!server) error(404, 'Server nicht gefunden');
	return server;
}

const podWhere = (serverId: number, name: string) =>
	and(eq(stacks.serverId, serverId), eq(stacks.name, name), eq(stacks.kind, 'pod'));

async function gitFor(serverId: number, name: string, message: string) {
	const [row] = await db.select({ gitTracking: stacks.gitTracking }).from(stacks).where(podWhere(serverId, name));
	return row?.gitTracking ? { message } : undefined;
}

export const load: PageServerLoad = async ({ locals, params }) => {
	requireUser(locals);
	const server = await loadServer(params.server);
	const [pod] = await db.select().from(stacks).where(podWhere(server.id, params.name));
	if (!pod) error(404, 'Pod nicht gefunden');
	const token = decrypt(server.agentTokenEnc);

	let containers: AgentContainer[] = [];
	let files: { name: string; secret: boolean; content: string | null }[] = [];
	let path = '';
	let agentOffline = false;
	let filesError: string | null = null;
	try {
		containers = await fetchPodPs(server.baseUrl, token, params.name);
	} catch {
		agentOffline = true;
	}
	if (!agentOffline) {
		try {
			const res = await fetchPodFiles(server.baseUrl, token, params.name);
			path = res.path;
			// .env-Inhalte gehen nicht als Beifang an den Browser — nur auf Anforderung
			files = res.files.map((f) => ({ name: f.name, secret: f.secret, content: f.secret ? null : f.content }));
		} catch (e) {
			// 404 bei Agent < 0.6: Bearbeiten gibt es dort noch nicht
			filesError = e instanceof AgentError ? e.message : String(e);
		}
	}

	let updates: UpdateEntry[] = [];
	try {
		updates = pod.updatesJson ? JSON.parse(pod.updatesJson) : [];
	} catch {
		/* defekter Cache → leerer Feed bis zur nächsten Prüfung */
	}

	return {
		server: { id: server.id, name: server.name, sshUrl: server.sshUrl, podmanVersion: server.podmanVersion },
		name: params.name,
		state: pod.state,
		gitTracking: pod.gitTracking,
		updates,
		lastUpdateCheck: pod.lastUpdateCheck,
		updatePolicy: pod.updatePolicy,
		history: await loadHistory(pod.id),
		containers,
		files,
		path,
		filesError,
		agentOffline
	};
};

export const actions: Actions = {
	checkUpdates: async ({ locals, params }) => {
		requireUser(locals);
		const t = translator(locals.locale);
		const server = await loadServer(params.server);
		try {
			const entries = await checkStackUpdates(server, params.name, 'pod');
			// Der Mensch sieht das Ergebnis gerade selbst — nur aufräumen, nicht pushen
			await syncUpdateAlert(server.id, params.name, entries, 'manual', false).catch(() => {});
			return { checked: true };
		} catch (e) {
			return fail(502, { checkError: e instanceof AgentError ? e.message : t('stack.checkFailed') });
		}
	},

	setPolicy: async ({ locals, params, request }) => {
		requireUser(locals);
		const t = translator(locals.locale);
		const server = await loadServer(params.server);
		const policy = String((await request.formData()).get('policy') ?? '');
		if (!['manual', 'auto'].includes(policy)) return fail(400, { checkError: t('stack.invalidPolicy') });
		await db
			.update(stacks)
			.set({ updatePolicy: policy as 'manual' | 'auto' })
			.where(podWhere(server.id, params.name));
		return { policySaved: true };
	},

	saveFile: async ({ locals, params, request }) => {
		const user = requireUser(locals);
		const t = translator(locals.locale);
		const server = await loadServer(params.server);
		const form = await request.formData();
		const fileName = String(form.get('fileName') ?? '').trim();
		// Zeilenenden vereinheitlichen: Textareas schicken CRLF
		const content = String(form.get('content') ?? '').replace(/\r\n/g, '\n');
		if (!FILE_RE.test(fileName)) return fail(400, { fileName, saveError: t('pod.invalidFileName') });
		const isEnv = fileName.endsWith('.env');
		if (!isEnv && !content.trim()) return fail(400, { fileName, saveError: t('stack.emptyFile') });
		try {
			const res = await putPodFile(
				server.baseUrl,
				decrypt(server.agentTokenEnc),
				params.name,
				fileName,
				content,
				// .env ist ohnehin gitignored — kein leerer Commit-Versuch
				isEnv ? undefined : await gitFor(server.id, params.name, `${params.name}/${fileName} geändert via Dockposer (${user.username})`)
			);
			return {
				saved: true,
				fileName,
				warnings: res.warnings ?? [],
				restartNeeded: res.restart_needed ?? false,
				reloadError: res.reload_error ?? null,
				committed: res.committed ?? false,
				gitError: res.git_error ?? null
			};
		} catch (e) {
			// 422 = Quadlet hat die Datei abgelehnt; Text und Inhalt zurückgeben,
			// damit nichts Getipptes verloren geht
			const msg = e instanceof AgentError ? e.message : t('stack.unknownError');
			return fail(422, { fileName, saveError: msg, content });
		}
	},

	loadFile: async ({ locals, params, request }) => {
		requireUser(locals);
		const t = translator(locals.locale);
		const server = await loadServer(params.server);
		const fileName = String((await request.formData()).get('fileName') ?? '');
		try {
			const res = await fetchPodFiles(server.baseUrl, decrypt(server.agentTokenEnc), params.name);
			const f = res.files.find((x) => x.name === fileName);
			if (!f) return fail(404, { fileName, saveError: t('pod.fileGone') });
			return { fileName, secretLoaded: true, content: f.content };
		} catch (e) {
			return fail(502, { fileName, saveError: e instanceof AgentError ? e.message : t('stack.loadFailed') });
		}
	},

	deleteFile: async ({ locals, params, request }) => {
		const user = requireUser(locals);
		const t = translator(locals.locale);
		const server = await loadServer(params.server);
		const fileName = String((await request.formData()).get('fileName') ?? '');
		if (!FILE_RE.test(fileName)) return fail(400, { fileName, saveError: t('pod.invalidFileName') });
		try {
			const res = await deletePodFile(
				server.baseUrl,
				decrypt(server.agentTokenEnc),
				params.name,
				fileName,
				fileName.endsWith('.env')
					? undefined
					: await gitFor(server.id, params.name, `${params.name}/${fileName} gelöscht via Dockposer (${user.username})`)
			);
			return {
				fileDeleted: fileName,
				warnings: res.warnings ?? [],
				restartNeeded: res.restart_needed ?? false,
				gitError: res.git_error ?? null
			};
		} catch (e) {
			return fail(422, { fileName, saveError: e instanceof AgentError ? e.message : t('stack.unknownError') });
		}
	},

	deletePod: async ({ locals, params, request }) => {
		const user = requireUser(locals);
		const t = translator(locals.locale);
		const server = await loadServer(params.server);
		const confirmName = String((await request.formData()).get('confirmName') ?? '').trim();
		if (confirmName !== params.name) return fail(400, { deleteError: t('stack.deleteNameMismatch') });
		try {
			// Der Agent prüft selbst live, ob noch etwas läuft (409)
			await deletePod(
				server.baseUrl,
				decrypt(server.agentTokenEnc),
				params.name,
				await gitFor(server.id, params.name, `Pod ${params.name} gelöscht via Dockposer (${user.username})`)
			);
		} catch (e) {
			return fail(502, { deleteError: e instanceof AgentError ? e.message : t('stack.deleteFailed') });
		}
		await db.delete(stacks).where(podWhere(server.id, params.name));
		redirect(303, '/');
	},

	toggleGit: async ({ locals, params }) => {
		requireUser(locals);
		const server = await loadServer(params.server);
		const [row] = await db.select({ gitTracking: stacks.gitTracking }).from(stacks).where(podWhere(server.id, params.name));
		await db.update(stacks).set({ gitTracking: !row?.gitTracking }).where(podWhere(server.id, params.name));
		return { gitToggled: true };
	}
};
