import { db } from '$lib/server/db';
import { servers, stacks } from '$lib/server/db/schema';
import { and, eq, notInArray } from 'drizzle-orm';
import { decrypt } from '$lib/server/crypto';
import { checkHealth, fetchStacks } from './client';

// Zieht Health + Stack-Liste von einem Agent und aktualisiert den DB-Cache.
// Grundsatz: bei Konflikt gewinnt der Agent/das Dateisystem.
export async function syncServer(server: typeof servers.$inferSelect): Promise<void> {
	const token = decrypt(server.agentTokenEnc);
	try {
		await checkHealth(server.baseUrl, token);
		const agentStacks = await fetchStacks(server.baseUrl, token);

		for (const s of agentStacks) {
			await db
				.insert(stacks)
				.values({
					serverId: server.id,
					name: s.name,
					composeHash: s.compose_hash,
					state: s.state,
					servicesRunning: s.services_running,
					servicesTotal: s.services_total,
					servicesUnhealthy: s.services_unhealthy ?? 0,
					drift: s.drift,
					driftServicesJson: JSON.stringify(s.drift_services ?? []),
					lastSyncedAt: new Date()
				})
				.onConflictDoUpdate({
					target: [stacks.serverId, stacks.name],
					set: {
						composeHash: s.compose_hash,
						state: s.state,
						servicesRunning: s.services_running,
						servicesTotal: s.services_total,
						servicesUnhealthy: s.services_unhealthy ?? 0,
						drift: s.drift,
						driftServicesJson: JSON.stringify(s.drift_services ?? []),
						lastSyncedAt: new Date()
					}
				});
		}
		// Verschwundene Stacks aus dem Cache entfernen (Datei gelöscht/verschoben)
		const names = agentStacks.map((s) => s.name);
		await db
			.delete(stacks)
			.where(
				names.length
					? and(eq(stacks.serverId, server.id), notInArray(stacks.name, names))
					: eq(stacks.serverId, server.id)
			);
		await db.update(servers).set({ status: 'online', lastSeenAt: new Date() }).where(eq(servers.id, server.id));
	} catch {
		await db.update(servers).set({ status: 'offline' }).where(eq(servers.id, server.id));
	}
}

export async function syncAll(): Promise<void> {
	const list = await db.select().from(servers);
	await Promise.allSettled(list.map(syncServer));
}
