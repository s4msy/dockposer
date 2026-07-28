import type { Handle, ServerInit } from '@sveltejs/kit';
import { building } from '$app/environment';
import { validateSession } from '$lib/server/auth';

export const init: ServerInit = async () => {
	if (building) return;
	// HMR-/Doppelstart-Schutz im Dev-Modus
	const g = globalThis as typeof globalThis & { __dockposerAlertsStarted?: boolean };
	if (g.__dockposerAlertsStarted) return;
	g.__dockposerAlertsStarted = true;
	const { startAlertSystem } = await import('$lib/server/alerts/listener');
	startAlertSystem().catch((e) => console.error('[alerts] Start fehlgeschlagen:', e));
};

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = await validateSession(event.cookies);
	return resolve(event);
};
