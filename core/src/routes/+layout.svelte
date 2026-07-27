<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	let { children } = $props();
	const showNav = $derived(!['/login', '/setup'].includes(page.url.pathname));
</script>

<main>
	{@render children()}
</main>

{#if showNav}
	<nav>
		<a href="/" aria-current={page.url.pathname === '/' ? 'page' : undefined}>Übersicht</a>
		<a href="/settings" aria-current={page.url.pathname.startsWith('/settings') ? 'page' : undefined}>Einstellungen</a>
	</nav>
{/if}

<style>
	nav {
		position: sticky;
		bottom: 0;
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
</style>
