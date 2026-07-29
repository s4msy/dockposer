// Event-Listener: abonniert die /v1/events-Streams aller Agents dauerhaft.
// Reconnect mit Backoff, Offline-Erkennung nach 3 Fehlversuchen, Disk-Poll 60s.
// Läuft als Singleton im Core-Prozess (Start über hooks.server.ts init).
import { db } from '$lib/server/db';
import { servers } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { decrypt } from '$lib/server/crypto';
import { agentStream, checkHealth } from '$lib/server/agents/client';
import { engine, type DockerEvent } from './engine';

const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;
const OFFLINE_AFTER_FAILS = 3;
const DISK_POLL_MS = 60_000;
const SERVER_REFRESH_MS = 30_000;

const activeLoops = new Map<number, AbortController>();

async function listenLoop(serverId: number) {
	let fails = 0;
	let backoff = RECONNECT_MIN_MS;
	const abort = new AbortController();
	activeLoops.set(serverId, abort);

	while (!abort.signal.aborted) {
		const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
		if (!server) break; // Server gelöscht → Loop beenden

		try {
			const res = await agentStream(server.baseUrl, decrypt(server.agentTokenEnc), '/v1/events', 'GET');
			// Verbunden: Status pflegen, ggf. Offline-Alert auflösen
			fails = 0;
			backoff = RECONNECT_MIN_MS;
			await db.update(servers).set({ status: 'online', lastSeenAt: new Date() }).where(eq(servers.id, serverId));
			await engine.agentOnline(serverId);
			console.log(`[alerts] Event-Stream verbunden: ${server.name}`);

			const reader = res.body!.getReader();
			const decoder = new TextDecoder();
			let buf = '';
			for (;;) {
				const { done, value } = await reader.read();
				if (done || abort.signal.aborted) break;
				buf += decoder.decode(value, { stream: true });
				const parts = buf.split('\n\n');
				buf = parts.pop() ?? '';
				for (const part of parts) {
					for (const line of part.split('\n')) {
						if (!line.startsWith('data: ')) continue;
						try {
							const evt = JSON.parse(line.slice(6)) as DockerEvent;
							await engine.handleEvent(serverId, evt);
						} catch {
							/* keine JSON-Zeile — ignorieren */
						}
					}
				}
			}
		} catch {
			fails++;
			if (fails === OFFLINE_AFTER_FAILS) {
				await db.update(servers).set({ status: 'offline' }).where(eq(servers.id, serverId));
				await engine.agentOffline(serverId, server.name);
				console.warn(`[alerts] Agent offline: ${server.name}`);
			}
		}
		if (abort.signal.aborted) break;
		await new Promise((r) => setTimeout(r, backoff));
		backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
	}
	activeLoops.delete(serverId);
}

async function diskPollLoop() {
	for (;;) {
		await new Promise((r) => setTimeout(r, DISK_POLL_MS));
		const all = await db.select().from(servers);
		for (const server of all) {
			try {
				const health = await checkHealth(server.baseUrl, decrypt(server.agentTokenEnc));
				const disk = health.disk as { free_bytes: number; total_bytes?: number };
				await engine.checkDisk(server.id, server.name, disk.free_bytes, disk.total_bytes ?? 0);
			} catch {
				/* offline behandelt der Event-Loop */
			}
		}
	}
}

// Neue/gelöschte Server erkennen, ohne Neustart des Core
async function serverRefreshLoop() {
	for (;;) {
		await new Promise((r) => setTimeout(r, SERVER_REFRESH_MS));
		const all = await db.select({ id: servers.id }).from(servers);
		const ids = new Set(all.map((s) => s.id));
		for (const { id } of all) {
			if (!activeLoops.has(id)) listenLoop(id).catch((e) => console.error('[alerts] Loop-Fehler:', e));
		}
		for (const [id, abort] of activeLoops) {
			if (!ids.has(id)) abort.abort();
		}
	}
}

export async function startAlertSystem() {
	await engine.ensureDefaultRules();
	const { initPushDispatcher } = await import('$lib/server/push/dispatch');
	initPushDispatcher();
	const all = await db.select({ id: servers.id }).from(servers);
	for (const { id } of all) {
		listenLoop(id).catch((e) => console.error('[alerts] Loop-Fehler:', e));
	}
	diskPollLoop().catch((e) => console.error('[alerts] Disk-Poll-Fehler:', e));
	serverRefreshLoop().catch((e) => console.error('[alerts] Refresh-Fehler:', e));
	console.log(`[alerts] Alert-System gestartet (${all.length} Server)`);
}
