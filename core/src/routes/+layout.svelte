<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { translator } from '$lib/i18n';
	let { children } = $props();
	const t = $derived(translator(page.data.locale ?? 'en'));
	const showNav = $derived(!['/login', '/setup'].includes(page.url.pathname));

	$effect(() => {
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW-Registrierung:', e));
		}
	});

	// App-Icon-Badge: Anzahl offener Alerts (Badging API — wo verfügbar)
	$effect(() => {
		const n = page.data.openAlerts ?? 0;
		if ('setAppBadge' in navigator) {
			if (n > 0) navigator.setAppBadge(n).catch(() => {});
			else navigator.clearAppBadge?.().catch(() => {});
		}
	});
</script>

<main class={page.url.pathname === '/' ? 'wide' : ''}>
	{@render children()}
</main>

{#if showNav}
	<nav>
		<a href="/" aria-current={page.url.pathname === '/' ? 'page' : undefined}>{t('nav.overview')}</a>
		<a href="/alerts" aria-current={page.url.pathname.startsWith('/alerts') ? 'page' : undefined}>
			<span style="overflow: hidden; text-overflow: ellipsis;">{t('nav.alerts')}</span>
			{#if page.data.openAlerts > 0}<span class="badge">{page.data.openAlerts}</span>{/if}
		</a>
		<a href="/settings" aria-current={page.url.pathname.startsWith('/settings') ? 'page' : undefined}>{t('nav.settings')}</a>
	</nav>
{/if}

<style>
	nav {
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		z-index: 10;
		display: flex;
		background: var(--color-surface);
		border-top: 1px solid var(--color-border);
		/* Seitliche Safe-Area für Notch/abgerundete Ecken im Querformat */
		padding: 0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
	}
	/*
	 * Feste Drittel statt space-around: Vorher wuchsen die Einträge mit ihrem
	 * Textinhalt, und sobald das Alert-Badge dazukam, lief die Zeile über den
	 * Bildschirmrand — der letzte Eintrag ("Einstellungen") war dann nicht mehr
	 * erreichbar. Mit flex: 1 bekommt jeder Eintrag garantiert seinen Platz.
	 */
	nav a {
		flex: 1 1 0;
		min-width: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		text-decoration: none;
		color: var(--color-text-dim);
		padding: var(--space-3) var(--space-1);
		min-height: 44px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	nav a[aria-current='page'] {
		color: var(--color-primary);
		font-weight: 700;
	}
	.badge {
		flex-shrink: 0; /* darf nicht zusammengedrückt werden */
		background: var(--color-crit);
		color: #fff;
		border-radius: 999px;
		font-size: 0.7rem;
		font-weight: 700;
		padding: 1px 7px;
	}
	/* Sehr schmale Geräte: lieber kleinere Schrift als abgeschnittene Wörter */
	@media (max-width: 360px) {
		nav a {
			font-size: 0.85rem;
		}
	}
	/* Auf breiten Schirmen die Einträge mittig bündeln statt über 2000px ziehen */
	@media (min-width: 720px) {
		nav {
			justify-content: center;
		}
		nav a {
			flex: 0 0 200px;
		}
	}
</style>
