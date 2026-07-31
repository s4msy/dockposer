import type { Actions, PageServerLoad } from './$types';
import { error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { servers, stacks } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { requireUser } from '$lib/server/guards';
import { decrypt } from '$lib/server/crypto';
import { fetchCompose, fetchStackPs, putCompose, deleteStack, fetchEditableFiles, fetchFile, putFile, AgentError } from '$lib/server/agents/client';
import { checkStackUpdates } from '$lib/server/updates/checker';
import { redirect } from '@sveltejs/kit';

async function loadServer(serverId: string) {
	const [server] = await db.select().from(servers).where(eq(servers.id, Number(serverId)));
	if (!server) error(404, 'Server nicht gefunden');
	return server;
}

export const load: PageServerLoad = async ({ locals, params }) => {
	requireUser(locals);
	const server = await loadServer(params.server);
	const token = decrypt(server.agentTokenEnc);
	const [stack] = await db
		.select()
		.from(stacks)
		.where(and(eq(stacks.serverId, server.id), eq(stacks.name, params.name)));

	try {
		const [compose, containers, editable] = await Promise.all([
			fetchCompose(server.baseUrl, token, params.name),
			fetchStackPs(server.baseUrl, token, params.name),
			// Alte Agents kennen die Route nicht — dann bleibt der Bereich leer
			fetchEditableFiles(server.baseUrl, token, params.name).catch(() => ({ files: [], allowed: [] }))
		]);
		return {
			server: { id: server.id, name: server.name, sshUrl: server.sshUrl },
			stack: stack ?? null,
			name: params.name,
			compose,
			containers,
			editableFiles: editable.files,
			allowedPatterns: editable.allowed,
			updates: stack?.updatesJson ? JSON.parse(stack.updatesJson) : [],
			lastUpdateCheck: stack?.lastUpdateCheck ?? null,
			updatePolicy: stack?.updatePolicy ?? 'manual',
			gitTracking: stack?.gitTracking ?? false,
			agentOffline: false
		};
	} catch (e) {
		if (e instanceof AgentError && e.status === 404) error(404, 'Stack nicht gefunden');
		// Agent nicht erreichbar → Seite trotzdem rendern, mit Cache-Stand
		return {
			server: { id: server.id, name: server.name, sshUrl: server.sshUrl },
			stack: stack ?? null,
			name: params.name,
			compose: null,
			containers: [],
			editableFiles: [],
			allowedPatterns: [],
			updates: stack?.updatesJson ? JSON.parse(stack.updatesJson) : [],
			lastUpdateCheck: stack?.lastUpdateCheck ?? null,
			updatePolicy: stack?.updatePolicy ?? 'manual',
			gitTracking: stack?.gitTracking ?? false,
			agentOffline: true
		};
	}
};

export const actions: Actions = {
	checkUpdates: async ({ locals, params }) => {
		requireUser(locals);
		const server = await loadServer(params.server);
		try {
			await checkStackUpdates(server, params.name);
			return { checked: true };
		} catch (e) {
			const msg = e instanceof AgentError ? e.message : 'Check fehlgeschlagen';
			return fail(502, { checkError: msg });
		}
	},

	setPolicy: async ({ locals, params, request }) => {
		requireUser(locals);
		const server = await loadServer(params.server);
		const policy = String((await request.formData()).get('policy') ?? '');
		if (!['manual', 'auto'].includes(policy)) return fail(400, { policyError: 'Ungültige Policy.' });
		await db.update(stacks).set({ updatePolicy: policy as 'manual' | 'auto' })
			.where(and(eq(stacks.serverId, server.id), eq(stacks.name, params.name)));
		return { policySaved: true };
	},

	saveCompose: async ({ locals, params, request }) => {
		const user = requireUser(locals);
		const server = await loadServer(params.server);
		const content = String((await request.formData()).get('content') ?? '');
		if (!content.trim()) return fail(400, { saveError: 'Leere Datei speichere ich nicht.' });
		const [stackRow] = await db
			.select({ gitTracking: stacks.gitTracking })
			.from(stacks)
			.where(and(eq(stacks.serverId, server.id), eq(stacks.name, params.name)));
		try {
			const res = await putCompose(
				server.baseUrl,
				decrypt(server.agentTokenEnc),
				params.name,
				content,
				stackRow?.gitTracking ? { message: `compose geändert via Dockposer (${user.username})` } : undefined
			);
			return { saved: true, hash: res.hash, committed: res.committed ?? false, gitError: res.git_error ?? null };
		} catch (e) {
			const msg = e instanceof AgentError ? e.message : 'Unbekannter Fehler';
			// 422 = Agent hat die Datei abgelehnt (compose config invalide)
			return fail(422, { saveError: msg });
		}
	},

	deleteStack: async ({ locals, params, request }) => {
		requireUser(locals);
		const server = await loadServer(params.server);
		// Doppelte Bestätigung: Name muss exakt getippt werden
		const confirmName = String((await request.formData()).get('confirmName') ?? '').trim();
		if (confirmName !== params.name) {
			return fail(400, { deleteError: 'Zur Bestätigung den Stack-Namen exakt eingeben.' });
		}
		// Live prüfen, dass wirklich nichts läuft (Cache könnte veraltet sein)
		try {
			const containers = await fetchStackPs(server.baseUrl, decrypt(server.agentTokenEnc), params.name);
			if (containers.some((c) => c.State === 'running' || c.State === 'restarting')) {
				return fail(409, { deleteError: 'Stack läuft noch — erst „down", dann löschen.' });
			}
			await deleteStack(server.baseUrl, decrypt(server.agentTokenEnc), params.name);
		} catch (e) {
			const msg = e instanceof AgentError ? e.message : 'Löschen fehlgeschlagen';
			return fail(502, { deleteError: msg });
		}
		// Cache-Eintrag entfernen, damit die Übersicht sofort stimmt
		await db.delete(stacks).where(and(eq(stacks.serverId, server.id), eq(stacks.name, params.name)));
		redirect(303, '/');
	},

	// Datei-Inhalt nur auf ausdrückliche Anforderung laden — nie als Beifang
	loadFile: async ({ locals, params, request }) => {
		requireUser(locals);
		const server = await loadServer(params.server);
		const fileName = String((await request.formData()).get('fileName') ?? '');
		try {
			const res = await fetchFile(server.baseUrl, decrypt(server.agentTokenEnc), params.name, fileName);
			return { fileLoaded: true, fileName, fileExists: res.exists, fileContent: res.content };
		} catch (e) {
			const msg = e instanceof AgentError ? e.message : 'Laden fehlgeschlagen';
			return fail(502, { fileError: msg, fileName });
		}
	},

	saveFile: async ({ locals, params, request }) => {
		requireUser(locals);
		const server = await loadServer(params.server);
		const form = await request.formData();
		const fileName = String(form.get('fileName') ?? '');
		const content = String(form.get('fileContent') ?? '');
		try {
			await putFile(server.baseUrl, decrypt(server.agentTokenEnc), params.name, fileName, content);
			// Bewusst kein Git-Commit: .env-artige Dateien enthalten Secrets
			return { fileSaved: true, fileLoaded: true, fileName, fileExists: true, fileContent: content };
		} catch (e) {
			const msg = e instanceof AgentError ? e.message : 'Speichern fehlgeschlagen';
			return fail(422, { fileError: msg, fileLoaded: true, fileName, fileExists: true, fileContent: content });
		}
	},

	toggleGit: async ({ locals, params }) => {
		requireUser(locals);
		const server = await loadServer(params.server);
		const [row] = await db
			.select({ gitTracking: stacks.gitTracking })
			.from(stacks)
			.where(and(eq(stacks.serverId, server.id), eq(stacks.name, params.name)));
		await db
			.update(stacks)
			.set({ gitTracking: !row?.gitTracking })
			.where(and(eq(stacks.serverId, server.id), eq(stacks.name, params.name)));
		return { gitToggled: true };
	}
};
