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
			{t('nav.alerts')}
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
		justify-content: space-around;
		background: var(--color-surface);
		border-top: 1px solid var(--color-border);
		padding: var(--space-2) 0 calc(var(--space-2) + env(safe-area-inset-bottom));
	}
	nav a {
		text-decoration: none;
		color: var(--color-text-dim);
		padding: var(--space-2) var(--space-4);
		min-height: 44px;
		display: flex;
		align-items: center;
	}
	nav a[aria-current='page'] {
		color: var(--color-primary);
		font-weight: 700;
	}
	.badge {
		background: var(--color-crit);
		color: #fff;
		border-radius: 999px;
		font-size: 0.7rem;
		font-weight: 700;
		padding: 1px 7px;
		margin-left: 4px;
	}
</style>
