// Agent-Client: Core → Agent, HTTP + Bearer-Token. TLS macht der Proxy vor dem Agent.

export interface AgentHealth {
	version: string;
	/** leer auf reinen Podman-Hosts (Agent ohne Stacks-Ordner) */
	docker_version: string;
	disk: { stacks_path: string; free_bytes: number };
	/** ab Agent 0.5.0 */
	pods?: { enabled: boolean; path: string; podman_version: string; problem: string };
}

export class AgentError extends Error {
	constructor(
		message: string,
		public status?: number
	) {
		super(message);
	}
}

export async function agentFetch<T>(
	baseUrl: string,
	token: string,
	path: string,
	init: RequestInit = {},
	timeoutMs = 5000
): Promise<T> {
	const url = baseUrl.replace(/\/$/, '') + path;
	const res = await fetch(url, {
		...init,
		headers: { ...init.headers, Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(timeoutMs)
	}).catch((e) => {
		throw new AgentError(`Agent nicht erreichbar: ${e?.cause?.code ?? e.message}`);
	});
	if (!res.ok) {
		// Der Agent legt den Grund in `error` — ohne das Auslesen bekäme der Nutzer
		// nur „Agent antwortet mit 422" zu sehen, während die eigentliche Auskunft
		// (welche Zeile der compose.yaml nicht stimmt) im Body verpufft.
		let detail = '';
		try {
			const body = (await res.json()) as { error?: string };
			detail = typeof body?.error === 'string' ? body.error.trim() : '';
		} catch {
			/* kein JSON-Body — dann bleibt es beim Statuscode */
		}
		throw new AgentError(detail || `Agent antwortet mit ${res.status}`, res.status);
	}
	return res.json() as Promise<T>;
}

export const checkHealth = (baseUrl: string, token: string) =>
	agentFetch<AgentHealth>(baseUrl, token, '/v1/health');

export interface AgentStack {
	name: string;
	path: string;
	compose_hash: string;
	state: 'running' | 'partial' | 'stopped' | 'unknown';
	services_running: number;
	services_total: number;
	services_unhealthy?: number;
	drift_services?: string[];
	drift: boolean;
}

export const fetchStacks = (baseUrl: string, token: string) =>
	agentFetch<AgentStack[]>(baseUrl, token, '/v1/stacks');

export interface AgentCompose {
	file: string;
	content: string;
	hash: string;
	env_files: string[];
	/** true, wenn .dockposer-rollback.yaml im Stack-Ordner liegt */
	pinned?: boolean;
}

export const fetchCompose = (baseUrl: string, token: string, stack: string) =>
	agentFetch<AgentCompose>(baseUrl, token, `/v1/stacks/${encodeURIComponent(stack)}/compose`);

export async function putCompose(
	baseUrl: string,
	token: string,
	stack: string,
	content: string,
	git?: { message: string }
) {
	const query = git ? `?git=1&message=${encodeURIComponent(git.message)}` : '';
	return agentFetch<{ hash: string; committed?: boolean; git_error?: string }>(
		baseUrl,
		token,
		`/v1/stacks/${encodeURIComponent(stack)}/compose${query}`,
		{ method: 'PUT', body: content, headers: { 'Content-Type': 'application/yaml' } }
	);
}

export interface AgentContainer {
	ID: string;
	Name: string;
	Service: string;
	State: string;
	Health: string;
	Status: string;
}

export const fetchStackPs = (baseUrl: string, token: string, stack: string) =>
	agentFetch<AgentContainer[]>(baseUrl, token, `/v1/stacks/${encodeURIComponent(stack)}/ps`, {}, 20_000);

// Streaming-Requests (SSE): Response roh durchreichen, Timeout nur für den Verbindungsaufbau.
export async function agentStream(
	baseUrl: string,
	token: string,
	path: string,
	method: 'GET' | 'POST' = 'POST'
): Promise<Response> {
	const url = baseUrl.replace(/\/$/, '') + path;
	const res = await fetch(url, {
		method,
		headers: { Authorization: `Bearer ${token}` }
	}).catch((e) => {
		throw new AgentError(`Agent nicht erreichbar: ${e?.cause?.code ?? e.message}`);
	});
	if (!res.ok || !res.body) throw new AgentError(`Agent antwortet mit ${res.status}`, res.status);
	return res;
}

export interface AgentStat {
	Name: string;
	CPUPerc: string;
	MemPerc: string;
	MemUsage: string;
}

export const fetchStats = (baseUrl: string, token: string) =>
	agentFetch<AgentStat[]>(baseUrl, token, '/v1/stats', {}, 25_000);

export const createStack = (baseUrl: string, token: string, name: string, content: string) =>
	agentFetch<{ name: string; hash: string }>(baseUrl, token, '/v1/stacks', {
		method: 'POST',
		body: JSON.stringify({ name, content }),
		headers: { 'Content-Type': 'application/json' }
	}, 20_000);

export interface AgentImage {
	service: string;
	image: string;
	digest: string;
	digests?: string[]; // alle RepoDigests des Images
	Digest?: string; // Kompatibilität
	/** nur Pods: Wert von AutoUpdate= (leer = podman auto-update fasst ihn nicht an) */
	auto_update?: string;
}

export const fetchImages = (baseUrl: string, token: string, stack: string, kind: 'stack' | 'pod' = 'stack') =>
	agentFetch<AgentImage[]>(
		baseUrl,
		token,
		`/v1/${kind === 'pod' ? 'pods' : 'stacks'}/${encodeURIComponent(stack)}/images`,
		{},
		30_000
	);

export const deleteStack = (baseUrl: string, token: string, stack: string) =>
	agentFetch<{ deleted: boolean; name: string }>(baseUrl, token, `/v1/stacks/${encodeURIComponent(stack)}`, {
		method: 'DELETE'
	}, 90_000);

export interface AgentGitStatus {
	git_installed: boolean;
	is_repo: boolean;
	remote?: string;
	branch?: string;
	last_commit?: string;
	dirty_files?: number;
	gitignore?: string;
	/** ab Agent 0.6.0 */
	path?: string;
}

/** 'stacks' = Repo am Stacks-Pfad, 'pods' = eigenes Repo im Quadlet-Pfad */
export type GitScope = 'stacks' | 'pods';
const scopeQuery = (scope: GitScope) => (scope === 'pods' ? '?scope=pods' : '');

export const fetchGitStatus = (baseUrl: string, token: string, scope: GitScope = 'stacks') =>
	agentFetch<AgentGitStatus>(baseUrl, token, '/v1/git/status' + scopeQuery(scope), {}, 15_000);

export const initGit = (
	baseUrl: string,
	token: string,
	body: { remote?: string; write_gitignore?: boolean; overwrite_gitignore?: boolean },
	scope: GitScope = 'stacks'
) =>
	agentFetch<{ repo_created: boolean; gitignore_written: boolean; gitignore_existed: boolean }>(
		baseUrl,
		token,
		'/v1/git/init' + scopeQuery(scope),
		{ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } },
		20_000
	);

export interface AgentUnmanaged {
	name: string;
	image: string;
	project?: string;
	working_dir?: string;
	kind: 'external_stack' | 'standalone';
}

export const fetchUnmanaged = (baseUrl: string, token: string) =>
	agentFetch<AgentUnmanaged[]>(baseUrl, token, '/v1/unmanaged', {}, 20_000);

export interface EditableFile {
	name: string;
	size: number;
	secrets: boolean;
}

/** Bearbeitbare Konfigdateien im Stack-Ordner (Allowlist des Agents). */
export const fetchEditableFiles = (baseUrl: string, token: string, stack: string) =>
	agentFetch<{ files: EditableFile[]; allowed: string[] }>(
		baseUrl,
		token,
		`/v1/stacks/${encodeURIComponent(stack)}/files`
	);

export const fetchFile = (baseUrl: string, token: string, stack: string, name: string) =>
	agentFetch<{ exists: boolean; content: string; name: string }>(
		baseUrl,
		token,
		`/v1/stacks/${encodeURIComponent(stack)}/file?name=${encodeURIComponent(name)}`
	);

export const putFile = (baseUrl: string, token: string, stack: string, name: string, content: string) =>
	agentFetch<{ saved: boolean; name: string }>(
		baseUrl,
		token,
		`/v1/stacks/${encodeURIComponent(stack)}/file?name=${encodeURIComponent(name)}`,
		{ method: 'PUT', body: content, headers: { 'Content-Type': 'text/plain' } },
		20_000
	);

export interface AgentDriftDebug {
	agent_version: string;
	matched_by: string;
	file_mtimes: Record<string, string>;
	newest_file_mtime: string;
	oldest_container: string;
	files_newer: boolean;
	expected_hashes: Record<string, string>;
	actual_hashes: Record<string, string>;
	drift: boolean;
	drift_services: string[] | null;
	suspected_services?: string[] | null;
	compose_verdict?: string;
	reason: string;
}

export const fetchDriftDebug = (baseUrl: string, token: string, stack: string) =>
	agentFetch<AgentDriftDebug>(
		baseUrl,
		token,
		`/v1/stacks/${encodeURIComponent(stack)}/drift`,
		{},
		30_000
	);

export const deletePin = (baseUrl: string, token: string, stack: string) =>
	agentFetch<{ removed: boolean; reason?: string }>(
		baseUrl,
		token,
		`/v1/stacks/${encodeURIComponent(stack)}/pin`,
		{ method: 'DELETE' },
		20_000
	);

// ── Aufräumen ───────────────────────────────────────────────────────────
export interface AgentPrune {
	images: number;
	bytes: number;
	error?: string;
	output?: string;
}

/** Was ließe sich freigeben? Reine Auskunft, verändert nichts. */
export const fetchPruneInfo = (baseUrl: string, token: string) =>
	agentFetch<AgentPrune>(baseUrl, token, '/v1/prune/images', {}, 20_000);

/** Ungetaggte Images löschen. Antwort enthält die tatsächlich freigegebene Menge. */
export const runPrune = (baseUrl: string, token: string) =>
	// Löschen vieler Ebenen dauert auf langsamen Platten spürbar — großzügiges Limit.
	agentFetch<AgentPrune>(baseUrl, token, '/v1/prune/images', { method: 'POST' }, 180_000);

// ── Pods (Podman/Quadlet, ab Agent 0.5.0) ───────────────────────────────
// Gleiches Format wie Stacks: Liste, ps und Stats sind deckungsgleich.
export const fetchPods = (baseUrl: string, token: string) =>
	agentFetch<AgentStack[]>(baseUrl, token, '/v1/pods');

export const fetchPodPs = (baseUrl: string, token: string, pod: string) =>
	agentFetch<AgentContainer[]>(baseUrl, token, `/v1/pods/${encodeURIComponent(pod)}/ps`);

// ── Pods bearbeiten (Phase 2) ──────────────────────────────────────────────

export interface PodFile {
	name: string;
	content: string;
	/** .env — nie ins Git, Inhalt nur auf Wunsch anzeigen */
	secret: boolean;
}

export const fetchPodFiles = (baseUrl: string, token: string, pod: string) =>
	agentFetch<{ files: PodFile[]; path: string; hash: string }>(
		baseUrl,
		token,
		`/v1/pods/${encodeURIComponent(pod)}/files`
	);

/** Antwort jeder Pod-Änderung. Ungültige Dateien kommen als AgentError (422). */
export interface PodChangeResult {
	hash?: string;
	warnings?: string[] | null;
	restart_needed?: boolean;
	reload_error?: string;
	committed?: boolean;
	git_error?: string;
}

const gitQuery = (git?: { message: string }) =>
	git ? `?git=1&message=${encodeURIComponent(git.message)}` : '';

// Der Generator-Lauf prüft alle Pods des Servers — großzügiger Timeout.
const POD_EDIT_TIMEOUT = 45_000;

export const putPodFile = (
	baseUrl: string,
	token: string,
	pod: string,
	file: string,
	content: string,
	git?: { message: string }
) =>
	agentFetch<PodChangeResult>(
		baseUrl,
		token,
		`/v1/pods/${encodeURIComponent(pod)}/files/${encodeURIComponent(file)}${gitQuery(git)}`,
		{ method: 'PUT', body: content },
		POD_EDIT_TIMEOUT
	);

export const deletePodFile = (baseUrl: string, token: string, pod: string, file: string, git?: { message: string }) =>
	agentFetch<PodChangeResult>(
		baseUrl,
		token,
		`/v1/pods/${encodeURIComponent(pod)}/files/${encodeURIComponent(file)}${gitQuery(git)}`,
		{ method: 'DELETE' },
		POD_EDIT_TIMEOUT
	);

export const createPod = (
	baseUrl: string,
	token: string,
	name: string,
	files: Record<string, string>,
	git?: { message: string }
) =>
	agentFetch<PodChangeResult & { created: boolean; name: string }>(
		baseUrl,
		token,
		`/v1/pods${gitQuery(git)}`,
		{ method: 'POST', body: JSON.stringify({ name, files }), headers: { 'Content-Type': 'application/json' } },
		POD_EDIT_TIMEOUT
	);

export const deletePod = (baseUrl: string, token: string, pod: string, git?: { message: string }) =>
	agentFetch<PodChangeResult & { deleted: boolean }>(
		baseUrl,
		token,
		`/v1/pods/${encodeURIComponent(pod)}${gitQuery(git)}`,
		{ method: 'DELETE' },
		POD_EDIT_TIMEOUT
	);

// ── podman-auto-update.timer (serverweit) ──────────────────────────────────

export interface AutoUpdateTimer {
	enabled: boolean;
	active: boolean;
	next_run?: string;
	last_run?: string;
	/** systemd-Result des letzten Laufs: success, exit-code, … */
	last_result?: string;
}

export const fetchAutoUpdateTimer = (baseUrl: string, token: string) =>
	agentFetch<AutoUpdateTimer>(baseUrl, token, '/v1/pods-autoupdate', {}, 15_000);

export const setAutoUpdateTimer = (baseUrl: string, token: string, enabled: boolean) =>
	agentFetch<AutoUpdateTimer>(
		baseUrl,
		token,
		'/v1/pods-autoupdate',
		{ method: 'POST', body: JSON.stringify({ enabled }), headers: { 'Content-Type': 'application/json' } },
		30_000
	);
