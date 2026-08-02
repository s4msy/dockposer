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
	const { startUpdateSystem } = await import('$lib/server/updates/scheduler');
	startUpdateSystem();
};

// Farben je Theme fürs <meta name="theme-color"> (Statusleiste der PWA)
const META_COLORS: Record<string, string> = {
	'dockposer-light': '#faf6f1',
	'dockposer-dark': '#1a1614',
	'catppuccin-mocha': '#1e1e2e',
	'catppuccin-latte': '#eff1f5',
	nord: '#2e3440',
	dracula: '#282a36',
	'gruvbox-dark': '#282828',
	system: '#1a1614'
};

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = await validateSession(event.cookies);
	const theme = event.locals.user?.theme ?? 'system';
	// Theme serverseitig ins HTML schreiben — sonst blitzt beim Laden die
	// Standardpalette auf, bevor die Einstellung greift.
	return resolve(event, {
		transformPageChunk: ({ html }) =>
			html
				.replace('%dockposer.theme%', theme)
				.replace('%dockposer.metatheme%', META_COLORS[theme] ?? '#1a1614')
	});
};
