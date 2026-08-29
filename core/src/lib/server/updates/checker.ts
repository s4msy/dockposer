import { db } from '$lib/server/db';
import { stacks, type servers } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { decrypt } from '$lib/server/crypto';
import { fetchImages } from '$lib/server/agents/client';
import { parseImageRef, registryDigest, manifestChildDigests } from './registry';
import { credentialFor } from './credentials';

export interface UpdateEntry {
	service: string;
	image: string;
	current: string; // sha256:… (lokal bzw. der gepinnte Digest)
	latest: string; // sha256:… (Registry)
	status: 'update' | 'current' | 'unknown' | 'pinned';
	/**
	 * Nur bei 'pinned': Der Tag zeigt inzwischen auf ein anderes Image.
	 * Rein informativ — anwendbar ist das nur durch Ändern der compose.yaml.
	 */
	newer?: boolean;
	/** Bei 'unknown': Host, für den Zugangsdaten fehlen könnten. */
	host?: string;
	authRequired?: boolean;
}

type Server = typeof servers.$inferSelect;

const toSha = (repoDigest: string) => repoDigest.split('@')[1] ?? '';

export async function checkStackUpdates(server: Server, stackName: string): Promise<UpdateEntry[]> {
	const images = await fetchImages(server.baseUrl, decrypt(server.agentTokenEnc), stackName);
	const entries: UpdateEntry[] = [];
	for (const img of images) {
		const ref = parseImageRef(img.image);
		// Per Digest gepinnte Images (`repo:tag@sha256:…`) kann kein `pull` und kein
		// Update verändern — der Digest IST die Referenz. Sie als 'update' zu melden
		// hat Auto-Policy-Läufe ausgelöst, die zwangsläufig nichts bewirken konnten.
		const pinned = Boolean(ref.digest);

		// Alle lokalen RepoDigests berücksichtigen — ein Image kann mehrere tragen
		const currents = (img.digests?.length ? img.digests : [img.digest ?? '']).map(toSha).filter(Boolean);
		if (currents.length === 0 && !pinned) {
			entries.push({ service: img.service, image: img.image, current: '', latest: '', status: 'unknown' });
			continue;
		}
		const current = ref.digest ?? currents[0];

		// Ohne expliziten Tag (`repo@sha256:…`) gibt es nichts zu vergleichen —
		// `latest` zu raten liefert nur Phantom-Vergleiche gegen ein fremdes Image.
		if (pinned && !ref.explicitTag) {
			entries.push({ service: img.service, image: img.image, current, latest: '', status: 'pinned' });
			continue;
		}

		// Hinterlegte Zugangsdaten für diesen Registry-Host verwenden, falls vorhanden
		const cred = await credentialFor(ref.host);
		const latest = await registryDigest(ref, cred);
		if (!latest) {
			// Gepinnt: Ein fehlgeschlagener Check ändert nichts an der Lage — der Pin
			// bleibt der Pin. Kein „Check nicht möglich" und keine Zugangsdaten-Frage.
			entries.push(
				pinned
					? { service: img.service, image: img.image, current, latest: '', status: 'pinned' }
					: {
							service: img.service,
							image: img.image,
							current,
							latest: '',
							status: 'unknown',
							host: ref.host,
							// Ohne hinterlegte Zugangsdaten ist fehlende Auth die wahrscheinlichste Ursache
							authRequired: !cred
						}
			);
			continue;
		}
		const known = pinned ? [ref.digest!, ...currents] : currents;
		let status: UpdateEntry['status'] = known.includes(latest) ? 'current' : 'update';
		if (status === 'update') {
			// Gegenprüfung: lokaler Digest = Plattform-Manifest der aktuellen Liste? → doch current
			const children = await manifestChildDigests(ref, cred);
			if (children.some((c) => known.includes(c))) status = 'current';
		}
		if (pinned) {
			// Der Tag darf sich bewegt haben — das ist eine Information, kein Update.
			entries.push({
				service: img.service,
				image: img.image,
				current,
				latest,
				status: 'pinned',
				newer: status === 'update'
			});
			continue;
		}
		entries.push({ service: img.service, image: img.image, current, latest, status });
	}
	await db
		.update(stacks)
		.set({ updatesJson: JSON.stringify(entries), lastUpdateCheck: new Date() })
		.where(and(eq(stacks.serverId, server.id), eq(stacks.name, stackName)));
	return entries;
}
