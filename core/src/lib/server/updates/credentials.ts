// Zugangsdaten für private Registries — Nachschlagen nach Host, mit kurzem
// Cache, damit ein Check-Durchlauf über viele Stacks nicht dutzendfach die DB
// befragt. Secrets liegen AES-verschlüsselt und werden nur hier entschlüsselt.
import { db } from '$lib/server/db';
import { registryCredentials } from '$lib/server/db/schema';
import { decrypt } from '$lib/server/crypto';
import type { RegistryCredential } from './registry';

const CACHE_TTL_MS = 60_000;
let cache: Map<string, RegistryCredential> | null = null;
let cachedAt = 0;

/** Cache verwerfen — nach jeder Änderung an den Zugangsdaten aufrufen. */
export function invalidateCredentialCache() {
	cache = null;
}

async function loadAll(): Promise<Map<string, RegistryCredential>> {
	if (cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;
	const rows = await db.select().from(registryCredentials);
	const map = new Map<string, RegistryCredential>();
	for (const row of rows) {
		try {
			map.set(normalizeHost(row.host), { username: row.username, secret: decrypt(row.secretEnc) });
		} catch {
			console.error('[registry] Zugangsdaten für', row.host, 'nicht entschlüsselbar');
		}
	}
	cache = map;
	cachedAt = Date.now();
	return map;
}

/** docker.io und registry-1.docker.io sind derselbe Host. */
export function normalizeHost(host: string): string {
	const h = host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
	if (h === 'docker.io' || h === 'index.docker.io') return 'registry-1.docker.io';
	return h;
}

export async function credentialFor(host: string): Promise<RegistryCredential | undefined> {
	return (await loadAll()).get(normalizeHost(host));
}
