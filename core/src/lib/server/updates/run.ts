import { db } from '$lib/server/db';
import { servers, stacks, updateRuns } from '$lib/server/db/schema';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { engine } from '$lib/server/alerts/engine';
import { translator } from '$lib/i18n';
import { parseImageRef, imageMeta, type ImageMeta } from './registry';
import { credentialFor } from './credentials';

/** Was sich bei einem Dienst geändert hat — für die Update-Historie. */
export interface ServiceChange {
	service: string;
	from?: string; // Version/Commit vorher
	to?: string; // Version/Commit nachher
	created?: string; // Bauzeit des neuen Images
	releases?: string; // Release-Übersicht des Projekts
}

const sha = (repoDigest: string) => repoDigest.split('@')[1] ?? '';
const label = (m?: ImageMeta | null) => m?.version || m?.revision || undefined;

/**
 * Herkunft der geänderten Images ermitteln. Zuerst aus dem Feed-Eintrag vor
 * dem Update — dort stehen die Angaben zum neuen Digest meist schon, weil der
 * Prüflauf sie bei der Meldung „Update verfügbar" geholt hat. Nur was fehlt,
 * wird bei der Registry nachgefragt. Scheitert das, bleibt der Eintrag
 * schlicht ohne Zusatzinfo — ein Update ist deshalb nicht weniger erfolgreich.
 */
async function collectChanges(
	feedJson: string | null,
	oldD: Record<string, string>,
	newD: Record<string, string>
): Promise<ServiceChange[]> {
	const known = new Map<string, ImageMeta>();
	try {
		for (const e of (feedJson ? JSON.parse(feedJson) : []) as {
			current?: string;
			latest?: string;
			newMeta?: ImageMeta;
			oldMeta?: ImageMeta;
		}[]) {
			if (e.newMeta && e.latest) known.set(e.latest, e.newMeta);
			if (e.oldMeta && e.current) known.set(e.current, e.oldMeta);
		}
	} catch {
		/* unlesbarer Feed → alles frisch erfragen */
	}

	const metaFor = async (repoDigest: string | undefined) => {
		const digest = repoDigest ? sha(repoDigest) : '';
		if (!digest) return null;
		const hit = known.get(digest);
		if (hit) return hit;
		const ref = parseImageRef(repoDigest!);
		const cred = await credentialFor(ref.host).catch(() => undefined);
		return imageMeta(ref, digest, cred).catch(() => null);
	};

	const services = Object.keys(newD)
		.filter((svc) => oldD[svc] !== newD[svc])
		.sort();
	return Promise.all(
		services.map(async (service) => {
			const [after, before] = await Promise.all([metaFor(newD[service]), metaFor(oldD[service])]);
			const change: ServiceChange = { service };
			const to = label(after);
			const from = label(before);
			if (to) change.to = to;
			if (from && from !== to) change.from = from;
			if (after?.created) change.created = after.created;
			if (after?.releases) change.releases = after.releases;
			return change;
		})
	);
}

interface AgentResult {
	result: 'success' | 'rolled_back' | 'failed';
	stage?: string;
	reason?: string;
	old_digests?: Record<string, string>;
	new_digests?: Record<string, string>;
}

export function parseResultEvent(buffer: string): AgentResult | null {
	const matches = [...buffer.matchAll(/event: result\ndata: (.*)\n/g)];
	if (matches.length === 0) return null;
	try {
		return JSON.parse(matches[matches.length - 1][1]);
	} catch {
		return null;
	}
}

export async function recordUpdateRun(
	serverId: number,
	stackName: string,
	trigger: 'manual' | 'policy',
	buffer: string,
	startedAt: Date
) {
	const parsed = parseResultEvent(buffer);
	const [stackRow] = await db
		.select({ id: stacks.id, feed: stacks.updatesJson })
		.from(stacks)
		.where(and(eq(stacks.serverId, serverId), eq(stacks.name, stackName)));
	// Muss vor der Nachprüfung am Ende laufen: Die überschreibt den Feed, und
	// mit ihm die schon ermittelten Angaben zum neuen Image.
	let changes: ServiceChange[] = [];
	if (stackRow && parsed?.result === 'success' && parsed.new_digests) {
		changes = await collectChanges(stackRow.feed, parsed.old_digests ?? {}, parsed.new_digests).catch(
			(e) => {
				console.warn('[updates] Änderungsinfos nicht ermittelbar:', e);
				return [];
			}
		);
	}
	if (stackRow) {
		await db.insert(updateRuns).values({
			stackId: stackRow.id,
			trigger,
			result: parsed?.result ?? 'failed',
			oldDigestsJson: parsed?.old_digests ? JSON.stringify(parsed.old_digests) : null,
			newDigestsJson: parsed?.new_digests ? JSON.stringify(parsed.new_digests) : null,
			logExcerpt: buffer.slice(-4000),
			changesJson: changes.length ? JSON.stringify(changes) : null,
			startedAt,
			finishedAt: new Date()
		});
		// Aufbewahrung begrenzen: pro Stack die letzten 50 Läufe. Ohne das wächst
		// die Tabelle bei automatischen Updates unbegrenzt (inkl. Log-Auszügen).
		const keep = await db
			.select({ id: updateRuns.id })
			.from(updateRuns)
			.where(eq(updateRuns.stackId, stackRow.id))
			.orderBy(desc(updateRuns.startedAt))
			.limit(50);
		if (keep.length === 50) {
			await db.delete(updateRuns).where(
				and(eq(updateRuns.stackId, stackRow.id), notInArray(updateRuns.id, keep.map((k) => k.id)))
			);
		}
	}

	if (!parsed || parsed.result === 'failed' || parsed.result === 'rolled_back') {
		const kind = parsed?.stage === 'pull' ? 'pull_failed' : 'update_rolled_back';
		const detail = parsed?.reason ?? translator('de')('alert.noResult');
		const messageKey =
			kind === 'pull_failed'
				? 'alert.pullFailed'
				: parsed?.result === 'rolled_back'
					? 'alert.rolledBack'
					: 'alert.updateFailed';
		await engine.updateProblem(serverId, stackName, kind, messageKey, { stack: stackName, reason: detail });
	} else if (parsed.result === 'success') {
		await engine.updateOk(serverId, stackName);
		if (trigger === 'policy') {
			// Nur Services zählen, deren Digest sich tatsächlich geändert hat
			const oldD = parsed.old_digests ?? {};
			const newD = parsed.new_digests ?? {};
			const changed = Object.keys(newD)
				.filter((svc) => oldD[svc] !== newD[svc])
				.sort();
			await engine.updateSucceeded(serverId, stackName, changed);
		}
	}

	// Feed direkt neu prüfen, damit erledigte Updates sofort verschwinden
	try {
		const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
		if (server) {
			const { checkStackUpdates } = await import('./checker');
			await checkStackUpdates(server, stackName);
		}
	} catch {
		/* nächster Scheduler-Lauf korrigiert es */
	}
	return parsed;
}
