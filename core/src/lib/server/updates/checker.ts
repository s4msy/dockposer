import { db } from '#lib/server/db/index.ts';
import { stacks, type servers } from '#lib/server/db/schema.ts';
import { and, eq } from 'drizzle-orm';
import { decrypt } from '#lib/server/crypto.ts';
import { fetchImages } from '#lib/server/agents/client.ts';
import {
	parseImageRef,
	registryDigest,
	manifestChildDigests,
	imageMeta,
	type ImageMeta,
	type RegistryCredential
} from './registry';
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
	/** Nur bei 'update': Herkunft und Bauzeit — beantwortet „ist das wirklich neu?". */
	newMeta?: ImageMeta;
	/** Dasselbe für das laufende Image, als Vergleichspunkt. */
	oldMeta?: ImageMeta;
}

type Server = typeof servers.$inferSelect;

const toSha = (repoDigest: string) => repoDigest.split('@')[1] ?? '';

/**
 * Bereits ermittelte Metadaten aus dem letzten Prüflauf, nach Digest abgelegt.
 *
 * Ein Digest beschreibt genau ein Image — was einmal darüber bekannt ist, gilt
 * für immer. Ohne diesen Vorrat verschwanden Herkunft und Bauzeit wieder aus
 * der Anzeige, sobald eine einzelne Registry-Abfrage scheiterte (Zeitlimit,
 * Rate-Limit bei Docker Hub). Nebenbei spart es Abfragen: Für einen schon
 * bekannten Digest wird gar nicht erst gefragt.
 */
async function knownMeta(serverId: number, stackName: string): Promise<Map<string, ImageMeta>> {
	const cache = new Map<string, ImageMeta>();
	const [row] = await db
		.select({ json: stacks.updatesJson })
		.from(stacks)
		.where(and(eq(stacks.serverId, serverId), eq(stacks.name, stackName), eq(stacks.kind, 'stack')))
		.limit(1);
	if (!row?.json) return cache;
	try {
		for (const e of JSON.parse(row.json) as UpdateEntry[]) {
			if (e.newMeta && e.latest) cache.set(e.latest, e.newMeta);
			if (e.oldMeta && e.current) cache.set(e.current, e.oldMeta);
		}
	} catch {
		/* unlesbarer Altbestand → einfach ohne Vorrat weiter */
	}
	return cache;
}

export async function checkStackUpdates(server: Server, stackName: string): Promise<UpdateEntry[]> {
	const images = await fetchImages(server.baseUrl, decrypt(server.agentTokenEnc), stackName);
	const metaCache = await knownMeta(server.id, stackName);
	const metaFor = async (ref: ReturnType<typeof parseImageRef>, digest: string, cred?: RegistryCredential) => {
		if (!digest) return null;
		const cached = metaCache.get(digest);
		if (cached) return cached;
		const fetched = await imageMeta(ref, digest, cred).catch(() => null);
		if (!fetched) {
			console.warn(`[updates] Keine Metadaten für ${ref.repo}@${digest.slice(7, 19)}`);
			return null;
		}
		metaCache.set(digest, fetched);
		return fetched;
	};
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
		if (status === 'update') {
			// Zwei zusätzliche Abfragen je Seite, aber nur bei echten Updates:
			// Ohne Bauzeitpunkt bleibt jede Meldung eine Behauptung, die man nur
			// glauben oder anzweifeln kann.
			const [newMeta, oldMeta] = await Promise.all([
				metaFor(ref, latest, cred),
				metaFor(ref, current, cred)
			]);
			entries.push({
				service: img.service,
				image: img.image,
				current,
				latest,
				status,
				...(newMeta ? { newMeta } : {}),
				...(oldMeta ? { oldMeta } : {})
			});
			continue;
		}
		entries.push({ service: img.service, image: img.image, current, latest, status });
	}
	await db
		.update(stacks)
		.set({ updatesJson: JSON.stringify(entries), lastUpdateCheck: new Date() })
		.where(and(eq(stacks.serverId, server.id), eq(stacks.name, stackName), eq(stacks.kind, 'stack')));
	return entries;
}
