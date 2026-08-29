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
	/** Bei `repo:tag@sha256:…` oder `repo@sha256:…`: der in compose.yaml gepinnte Digest. */
	digest?: string;
	/** false, wenn der Tag nicht in der Referenz stand und auf `latest` geraten wurde. */
	explicitTag: boolean;
}

export function parseImageRef(ref: string): ImageRef {
	const [beforeAt, afterAt] = ref.split('@');
	const digest = afterAt?.startsWith('sha256:') ? afterAt : undefined;
	let rest = beforeAt;
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
	let explicitTag = false;
	const colon = rest.lastIndexOf(':');
	if (colon > -1 && !rest.slice(colon).includes('/')) {
		tag = rest.slice(colon + 1);
		rest = rest.slice(0, colon);
		explicitTag = true;
	}
	if (host === 'registry-1.docker.io' && !rest.includes('/')) rest = 'library/' + rest;
	return { host, repo: rest, tag, digest, explicitTag };
}

export interface RegistryCredential {
	username: string;
	secret: string;
}

/**
 * Holt einen Bearer-Token vom Auth-Endpunkt der Registry.
 * Ohne Credentials anonym (öffentliche Images), mit Credentials per Basic-Auth
 * — so machen es Docker Hub, GHCR, Quay und die Forgejo/Gitea-Registry.
 */
async function fetchRegistryToken(wwwAuth: string, cred?: RegistryCredential): Promise<string | null> {
	// Beispiel: Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"
	const params: Record<string, string> = {};
	for (const m of wwwAuth.matchAll(/(\w+)="([^"]*)"/g)) params[m[1]] = m[2];
	if (!params.realm) return null;
	const url = new URL(params.realm);
	if (params.service) url.searchParams.set('service', params.service);
	if (params.scope) url.searchParams.set('scope', params.scope);

	const headers: Record<string, string> = {};
	if (cred) {
		headers.Authorization = 'Basic ' + Buffer.from(`${cred.username}:${cred.secret}`).toString('base64');
	}
	const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
	if (!res.ok) return null;
	const body = await res.json();
	return body.token ?? body.access_token ?? null;
}

async function authedFetch(
	url: string,
	method: 'HEAD' | 'GET',
	cred?: RegistryCredential
): Promise<Response | null> {
	try {
		let res = await fetch(url, { method, headers: { Accept: ACCEPT }, signal: AbortSignal.timeout(10_000) });
		if (res.status === 401) {
			const wwwAuth = res.headers.get('www-authenticate') ?? '';
			if (/^bearer/i.test(wwwAuth)) {
				const token = await fetchRegistryToken(wwwAuth, cred);
				if (!token) return null; // ohne (gültige) Credentials → „Check nicht möglich"
				res = await fetch(url, {
					method,
					headers: { Accept: ACCEPT, Authorization: `Bearer ${token}` },
					signal: AbortSignal.timeout(10_000)
				});
			} else if (cred) {
				// Manche Registries verlangen direkt Basic-Auth statt eines Token-Flows
				res = await fetch(url, {
					method,
					headers: {
						Accept: ACCEPT,
						Authorization: 'Basic ' + Buffer.from(`${cred.username}:${cred.secret}`).toString('base64')
					},
					signal: AbortSignal.timeout(10_000)
				});
			} else {
				return null;
			}
		}
		return res.ok ? res : null;
	} catch {
		return null;
	}
}

/** Digest des Manifests für host/repo:tag — oder null, wenn nicht ermittelbar (privat, offline, exotisch). */
export async function registryDigest(ref: ImageRef, cred?: RegistryCredential): Promise<string | null> {
	const res = await authedFetch(`https://${ref.host}/v2/${ref.repo}/manifests/${ref.tag}`, 'HEAD', cred);
	return res?.headers.get('docker-content-digest') ?? null;
}

/** Verbindungstest für hinterlegte Zugangsdaten: /v2/ verlangt Auth und ist überall vorhanden. */
export async function testCredential(host: string, cred: RegistryCredential): Promise<{ ok: boolean; message: string }> {
	try {
		const res = await authedFetch(`https://${host}/v2/`, 'GET', cred);
		if (res) return { ok: true, message: 'Anmeldung erfolgreich.' };
		return { ok: false, message: 'Anmeldung abgelehnt — Benutzername oder Token prüfen.' };
	} catch (e) {
		return { ok: false, message: `Registry nicht erreichbar: ${e}` };
	}
}

/**
 * Gegenprüfung für Multi-Arch: Digests der Plattform-Manifeste in der Manifestliste.
 * Lokal kann statt des Listen-Digests der amd64-Manifest-Digest hinterlegt sein —
 * gleiche Version, anderer Hash. Ohne diese Prüfung: ewige Phantom-Updates.
 */
export async function manifestChildDigests(ref: ImageRef, cred?: RegistryCredential): Promise<string[]> {
	const res = await authedFetch(`https://${ref.host}/v2/${ref.repo}/manifests/${ref.tag}`, 'GET', cred);
	if (!res) return [];
	try {
		const body = await res.json();
		if (Array.isArray(body.manifests)) {
			return body.manifests.map((m: { digest?: string }) => m.digest).filter(Boolean);
		}
	} catch {
		/* kein Index/Liste — dann gibt es keine Kinder */
	}
	return [];
}
