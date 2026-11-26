import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { db } from '#lib/server/db/index.ts';
import { servers, stacks } from '#lib/server/db/schema.ts';
import { and, eq } from 'drizzle-orm';
import { requireUser } from '#lib/server/guards.ts';
import { decrypt } from '#lib/server/crypto.ts';
import { fetchPodPs, type AgentContainer } from '#lib/server/agents/client.ts';

// Pod = Quadlet-Ordner im Podman-Pfad des Servers. Phase 1: Status, Steuerung,
// Logs. Bearbeiten (Phase 2) und Updates über `podman auto-update` (Phase 3)
// folgen — bis dahin werden die Dateien per SSH gepflegt.
export const load: PageServerLoad = async ({ locals, params }) => {
	requireUser(locals);
	const [server] = await db.select().from(servers).where(eq(servers.id, Number(params.server)));
	if (!server) error(404, 'Server nicht gefunden');
	const [pod] = await db
		.select()
		.from(stacks)
		.where(and(eq(stacks.serverId, server.id), eq(stacks.name, params.name), eq(stacks.kind, 'pod')));
	if (!pod) error(404, 'Pod nicht gefunden');

	let containers: AgentContainer[] = [];
	let agentOffline = false;
	try {
		containers = await fetchPodPs(server.baseUrl, decrypt(server.agentTokenEnc), params.name);
	} catch {
		agentOffline = true;
	}

	return {
		server: { id: server.id, name: server.name, sshUrl: server.sshUrl, podmanVersion: server.podmanVersion },
		name: params.name,
		state: pod.state,
		containers,
		agentOffline
	};
};
