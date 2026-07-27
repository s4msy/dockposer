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
