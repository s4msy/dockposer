// Registry-Digest-Abfrage per HEAD — billig, kein Pull. Anonymer Token-Flow
// (WWW-Authenticate) deckt Docker Hub, GHCR, Quay & Co. für öffentliche Images ab.
// Private Registries: bewusst M5 — bis dahin Status 'unknown' („Check nicht möglich").

const ACCEPT = [
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json',
	'application/vnd.oci.image.manifest.v1+json'
].join(', ');

export interface ImageRef {
	host: string;
	repo: string;
	tag: string;
}

export function parseImageRef(ref: string): ImageRef {
	let rest = ref.split('@')[0];
	let host = 'registry-1.docker.io';
	const slash = rest.indexOf('/');
	if (slash > -1) {
		const first = rest.slice(0, slash);
		if (first.includes('.') || first.includes(':') || first === 'localhost') {
			host = first;
			rest = rest.slice(slash + 1);
		}
	}
	if (host === 'docker.io') host = 'registry-1.docker.io';
	let tag = 'latest';
	const colon = rest.lastIndexOf(':');
	if (colon > -1 && !rest.slice(colon).includes('/')) {
		tag = rest.slice(colon + 1);
		rest = rest.slice(0, colon);
	}
	if (host === 'registry-1.docker.io' && !rest.includes('/')) rest = 'library/' + rest;
	return { host, repo: rest, tag };
}

async function anonymousToken(wwwAuth: string): Promise<string | null> {
	// Beispiel: Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"
	const params: Record<string, string> = {};
	for (const m of wwwAuth.matchAll(/(\w+)="([^"]*)"/g)) params[m[1]] = m[2];
	if (!params.realm) return null;
	const url = new URL(params.realm);
	if (params.service) url.searchParams.set('service', params.service);
	if (params.scope) url.searchParams.set('scope', params.scope);
	const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
	if (!res.ok) return null;
	const body = await res.json();
	return body.token ?? body.access_token ?? null;
}

/** Digest des Manifests für host/repo:tag — oder null, wenn nicht ermittelbar (privat, offline, exotisch). */
export async function registryDigest(ref: ImageRef): Promise<string | null> {
	const url = `https://${ref.host}/v2/${ref.repo}/manifests/${ref.tag}`;
	try {
		let res = await fetch(url, { method: 'HEAD', headers: { Accept: ACCEPT }, signal: AbortSignal.timeout(10_000) });
		if (res.status === 401) {
			const wwwAuth = res.headers.get('www-authenticate');
			const token = wwwAuth ? await anonymousToken(wwwAuth) : null;
			if (!token) return null; // Auth nötig → „Check nicht möglich"
			res = await fetch(url, {
				method: 'HEAD',
				headers: { Accept: ACCEPT, Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(10_000)
			});
		}
		if (!res.ok) return null;
		return res.headers.get('docker-content-digest');
	} catch {
		return null;
	}
}
