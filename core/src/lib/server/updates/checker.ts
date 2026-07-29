import { db } from '$lib/server/db';
import { stacks, type servers } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { decrypt } from '$lib/server/crypto';
import { fetchImages } from '$lib/server/agents/client';
import { parseImageRef, registryDigest, manifestChildDigests } from './registry';

export interface UpdateEntry {
	service: string;
	image: string;
	current: string; // sha256:… (lokal)
	latest: string; // sha256:… (Registry)
	status: 'update' | 'current' | 'unknown';
}

type Server = typeof servers.$inferSelect;

const toSha = (repoDigest: string) => repoDigest.split('@')[1] ?? '';

export async function checkStackUpdates(server: Server, stackName: string): Promise<UpdateEntry[]> {
	const images = await fetchImages(server.baseUrl, decrypt(server.agentTokenEnc), stackName);
	const entries: UpdateEntry[] = [];
	for (const img of images) {
		// Alle lokalen RepoDigests berücksichtigen — ein Image kann mehrere tragen
		const currents = (img.digests?.length ? img.digests : [img.digest ?? '']).map(toSha).filter(Boolean);
		if (currents.length === 0) {
			entries.push({ service: img.service, image: img.image, current: '', latest: '', status: 'unknown' });
			continue;
		}
		const ref = parseImageRef(img.image);
		const latest = await registryDigest(ref);
		if (!latest) {
			entries.push({ service: img.service, image: img.image, current: currents[0], latest: '', status: 'unknown' });
			continue;
		}
		let status: UpdateEntry['status'] = currents.includes(latest) ? 'current' : 'update';
		if (status === 'update') {
			// Gegenprüfung: lokaler Digest = Plattform-Manifest der aktuellen Liste? → doch current
			const children = await manifestChildDigests(ref);
			if (children.some((c) => currents.includes(c))) status = 'current';
		}
		entries.push({ service: img.service, image: img.image, current: currents[0], latest, status });
	}
	await db
		.update(stacks)
		.set({ updatesJson: JSON.stringify(entries), lastUpdateCheck: new Date() })
		.where(and(eq(stacks.serverId, server.id), eq(stacks.name, stackName)));
	return entries;
}
