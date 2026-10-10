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

{#if data.open.length > 1}
	<form
		method="POST"
		action="?/resolveAll"
		use:enhance={() => {
			if (!confirm(t('alerts.confirmResolveAll', { count: data.open.length }))) return () => {};
			return async ({ update }) => update();
		}}
		style="margin-bottom: var(--space-3);"
	>
		<button style="background: transparent; color: var(--color-text-dim); border: 1px solid var(--color-border);">
			{t('alerts.resolveAll')} ({data.open.length})
		</button>
	</form>
{/if}

{#if data.open.length === 0}
	<div class="card"><p>{t('alerts.none')} 🎉</p></div>
{/if}

{#each data.open as alert (alert.id)}
	<div class="card" style="border-left: 4px solid {sevColor[alert.severity]};">
		<div style="display: flex; align-items: baseline; gap: var(--space-2);">
			<!-- min-width: 0 — ohne das schrumpfen Flex-Kinder nicht unter ihre
			     Mindestbreite und lange Meldungen erzeugen horizontalen Überlauf -->
			<strong style="flex: 1; min-width: 0;">{alert.message}</strong>
		</div>
		<small style="color: var(--color-text-dim); display: block; margin: var(--space-1) 0 var(--space-2);">
			{data.serverNames[alert.serverId] ?? `Server ${alert.serverId}`} · {fmtTime(alert.firedAt)}
			{#if alert.acknowledgedAt}· {t('alerts.acked')}{/if}
		</small>
		{#if alert.ruleType === 'disk_space'}
			<!-- Die häufigste Ursache sind alte Images aus unseren eigenen Updates —
			     hier steht der Weg dorthin, statt dass man ihn suchen muss. -->
			<p style="margin: 0 0 var(--space-2);">
				<a href="/settings/servers">{t('alerts.diskCleanup')}</a>
			</p>
		{/if}
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
		{@const recovery = alert.messageKey?.startsWith('alert.recovered')}
		<div class="card" style="opacity: {recovery ? 0.9 : 0.7};{recovery ? ' border-left: 3px solid var(--color-ok);' : ''}">
			{#if recovery}<span style="color: var(--color-ok);" aria-hidden="true">✓ </span>{/if}{alert.message}
			<small style="color: var(--color-text-dim); display: block;">
				{data.serverNames[alert.serverId] ?? ''} ·
				{#if recovery}
					{fmtTime(alert.firedAt)}
				{:else}
					{fmtTime(alert.firedAt)} → {alert.resolvedAt ? fmtTime(alert.resolvedAt) : ''}
				{/if}
			</small>
		</div>
	{/each}
{/if}
