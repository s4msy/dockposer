<script lang="ts">
	import type { PageData } from './$types';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { translator } from '$lib/i18n';
	let { data }: { data: PageData } = $props();
	const t = $derived(translator(page.data.locale ?? 'en'));

	const sevColor: Record<string, string> = {
		critical: 'var(--color-crit)',
		warning: 'var(--color-warn)',
		info: 'var(--color-text-dim)'
	};
	const fmtTime = (d: Date | string) =>
		new Date(d).toLocaleString(page.data.locale ?? 'en', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
</script>

<h1>{t('alerts.title')}</h1>

{#if data.open.length === 0}
	<div class="card"><p>{t('alerts.none')} 🎉</p></div>
{/if}

{#each data.open as alert (alert.id)}
	<div class="card" style="border-left: 4px solid {sevColor[alert.severity]};">
		<div style="display: flex; align-items: baseline; gap: var(--space-2);">
			<strong style="flex: 1;">{alert.message}</strong>
		</div>
		<small style="color: var(--color-text-dim); display: block; margin: var(--space-1) 0 var(--space-2);">
			{data.serverNames[alert.serverId] ?? `Server ${alert.serverId}`} · {fmtTime(alert.firedAt)}
			{#if alert.acknowledgedAt}· {t('alerts.acked')}{/if}
		</small>
		<div style="display: flex; gap: var(--space-2);">
			{#if !alert.acknowledgedAt}
				<form method="POST" action="?/ack" use:enhance style="flex: 1;">
					<input type="hidden" name="id" value={alert.id} />
					<button style="background: transparent; color: var(--color-primary); border: 1px solid var(--color-primary);">{t('alerts.ack')}</button>
				</form>
			{/if}
			<form method="POST" action="?/resolve" use:enhance style="flex: 1;">
				<input type="hidden" name="id" value={alert.id} />
				<button>{t('alerts.resolve')}</button>
			</form>
		</div>
	</div>
{/each}

{#if data.resolved.length > 0}
	<h1 style="font-size: 1.1rem;">{t('alerts.recentlyResolved')}</h1>
	{#each data.resolved as alert (alert.id)}
		<div class="card" style="opacity: 0.7;">
			{alert.message}
			<small style="color: var(--color-text-dim); display: block;">
				{data.serverNames[alert.serverId] ?? ''} · {fmtTime(alert.firedAt)} → {alert.resolvedAt ? fmtTime(alert.resolvedAt) : ''}
			</small>
		</div>
	{/each}
{/if}
