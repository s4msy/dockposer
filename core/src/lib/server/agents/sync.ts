import { db } from '#lib/server/db/index.ts';
import { servers, stacks } from '#lib/server/db/schema.ts';
import { and, eq, notInArray } from 'drizzle-orm';
import { decrypt } from '#lib/server/crypto.ts';
import { checkHealth, fetchStacks, fetchPods, type AgentStack } from './client';
import { engine } from '#lib/server/alerts/engine.ts';

// Zieht Health + Stack-Liste von einem Agent und aktualisiert den DB-Cache.
// Grundsatz: bei Konflikt gewinnt der Agent/das Dateisystem.
export async function syncServer(server: typeof servers.$inferSelect): Promise<void> {
	const token = decrypt(server.agentTokenEnc);
	try {
		const health = await checkHealth(server.baseUrl, token);
		// Ein leerer docker_version-String heißt: reiner Podman-Host. Ältere
		// Agents kennen keine Pods und melden immer Docker.
		const dockerEnabled = health.docker_version !== '';
		const pods = health.pods;
		await db
			.update(servers)
			.set({
				dockerEnabled,
				podsEnabled: !!pods?.enabled,
				podmanVersion: pods?.podman_version || null,
				podsProblem: pods?.problem || null
			})
			.where(eq(servers.id, server.id));

		const lists: { kind: 'stack' | 'pod'; items: AgentStack[] }[] = [
			{ kind: 'stack', items: dockerEnabled ? await fetchStacks(server.baseUrl, token) : [] },
			{ kind: 'pod', items: pods?.enabled ? await fetchPods(server.baseUrl, token) : [] }
		];

		for (const { kind, items } of lists) {
			for (const s of items) {
				const values = {
					composeHash: s.compose_hash,
					state: s.state,
					servicesRunning: s.services_running,
					servicesTotal: s.services_total,
					servicesUnhealthy: s.services_unhealthy ?? 0,
					drift: s.drift,
					driftServicesJson: JSON.stringify(s.drift_services ?? []),
					lastSyncedAt: new Date()
				};
				await db
					.insert(stacks)
					.values({ serverId: server.id, name: s.name, kind, ...values })
					.onConflictDoUpdate({ target: [stacks.serverId, stacks.kind, stacks.name], set: values });
			}
			// Verschwundene Einträge dieser Art entfernen (Ordner gelöscht/verschoben)
			const names = items.map((s) => s.name);
			await db
				.delete(stacks)
				.where(
					names.length
						? and(eq(stacks.serverId, server.id), eq(stacks.kind, kind), notInArray(stacks.name, names))
						: and(eq(stacks.serverId, server.id), eq(stacks.kind, kind))
				);
		}
		// Alert-Engine über den neuen Stand informieren (Filter für verwaltete Container)
		engine.invalidateStackCache(server.id);

		await db.update(servers).set({ status: 'online', lastSeenAt: new Date() }).where(eq(servers.id, server.id));
	} catch {
		await db.update(servers).set({ status: 'offline' }).where(eq(servers.id, server.id));
	}
}

export async function syncAll(): Promise<void> {
	const list = await db.select().from(servers);
	await Promise.allSettled(list.map(syncServer));
}
