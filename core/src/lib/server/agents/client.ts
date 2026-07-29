// Agent-Client: Core → Agent, HTTP + Bearer-Token. TLS macht der Proxy vor dem Agent.

export interface AgentHealth {
	version: string;
	docker_version: string;
	disk: { stacks_path: string; free_bytes: number };
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
	if (!res.ok) throw new AgentError(`Agent antwortet mit ${res.status}`, res.status);
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
	drift: boolean;
}

export const fetchStacks = (baseUrl: string, token: string) =>
	agentFetch<AgentStack[]>(baseUrl, token, '/v1/stacks');

export interface AgentCompose {
	file: string;
	content: string;
	hash: string;
	env_files: string[];
}

export const fetchCompose = (baseUrl: string, token: string, stack: string) =>
	agentFetch<AgentCompose>(baseUrl, token, `/v1/stacks/${encodeURIComponent(stack)}/compose`);

export async function putCompose(baseUrl: string, token: string, stack: string, content: string) {
	return agentFetch<{ hash: string }>(baseUrl, token, `/v1/stacks/${encodeURIComponent(stack)}/compose`, {
		method: 'PUT',
		body: content,
		headers: { 'Content-Type': 'application/yaml' }
	});
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
	Digest?: string; // Kompatibilität
}

export const fetchImages = (baseUrl: string, token: string, stack: string) =>
	agentFetch<AgentImage[]>(baseUrl, token, `/v1/stacks/${encodeURIComponent(stack)}/images`, {}, 30_000);
