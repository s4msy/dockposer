import { db } from '$lib/server/db';
import { stacks, type servers } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { decrypt } from '$lib/server/crypto';
import { fetchImages } from '$lib/server/agents/client';
import { parseImageRef, registryDigest } from './registry';

export interface UpdateEntry {
	service: string;
	image: string;
	current: string; // sha256:… (lokal)
	latest: string; // sha256:… (Registry)
	status: 'update' | 'current' | 'unknown';
}

type Server = typeof servers.$inferSelect;

const localSha = (repoDigest: string) => repoDigest.split('@')[1] ?? '';

export async function checkStackUpdates(server: Server, stackName: string): Promise<UpdateEntry[]> {
	const images = await fetchImages(server.baseUrl, decrypt(server.agentTokenEnc), stackName);
	const entries: UpdateEntry[] = [];
	for (const img of images) {
		const current = localSha(img.Digest ?? img.digest ?? '');
		if (!current) {
			entries.push({ service: img.service, image: img.image, current: '', latest: '', status: 'unknown' });
			continue;
		}
		const latest = await registryDigest(parseImageRef(img.image));
		if (!latest) {
			entries.push({ service: img.service, image: img.image, current, latest: '', status: 'unknown' });
		} else {
			entries.push({
				service: img.service,
				image: img.image,
				current,
				latest,
				status: latest === current ? 'current' : 'update'
			});
		}
	}
	await db
		.update(stacks)
		.set({ updatesJson: JSON.stringify(entries), lastUpdateCheck: new Date() })
		.where(and(eq(stacks.serverId, server.id), eq(stacks.name, stackName)));
	return entries;
}
