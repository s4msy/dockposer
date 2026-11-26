<script lang="ts">
	// Update-Historie aus dem Audit-Log — gemeinsam für Stacks und Pods.
	import { page } from '$app/state';
	import { translator } from '#lib/i18n/index.ts';
	import type { HistoryRun } from '#lib/updates.ts';

	let { history }: { history: HistoryRun[] } = $props();
	const t = $derived(translator(page.data.locale ?? 'en'));
</script>

<details class="card">
	<summary style="cursor: pointer; min-height: 44px; display: flex; align-items: center;">
		<strong>{t('stack.history')}</strong>
		{#if history.length > 0}
			<small style="color: var(--color-text-dim); margin-left: var(--space-2);">({history.length})</small>
		{/if}
	</summary>

	{#if history.length === 0}
		<p style="color: var(--color-text-dim);">{t('stack.historyEmpty')}</p>
	{:else}
		<ul style="list-style: none; padding: 0; margin: var(--space-2) 0 0;">
			{#each history as run (run.id)}
				<li style="padding: var(--space-2) 0; border-top: 1px solid var(--color-border);">
					<div style="display: flex; align-items: baseline; gap: var(--space-2);">
						<span class="dot {run.result === 'success' ? 'running' : run.result === 'rolled_back' ? 'partial' : 'stopped'}"></span>
						<span style="flex: 1;">
							{run.result === 'success'
								? t('stack.resultSuccess')
								: run.result === 'rolled_back'
									? t('stack.resultRolledBack')
									: t('stack.resultFailed')}
							<small style="color: var(--color-text-dim);">
								· {run.trigger === 'policy' ? t('stack.triggerPolicy') : t('stack.triggerManual')}
							</small>
							<small style="display: block; color: var(--color-text-dim);">
								{new Date(run.startedAt).toLocaleString(page.data.locale ?? 'en')}
								{#if run.finishedAt}
									· {t('stack.historyDuration', {
										seconds: Math.max(0, Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000))
									})}
								{/if}
							</small>
							{#if run.changes.length > 0}
								<!-- Eine Zeile je geändertem Dienst, mit Version und Link zu den
								     Release Notes. Auch bei automatischen Updates nachlesbar, die
								     im Feed nie als „verfügbar" auftauchen. -->
								{#each run.changes as c (c.service)}
									<small style="display: block; color: var(--color-text-dim);">
										<strong style="color: var(--color-text); font-weight: 600;">{c.service}</strong>
										{#if c.from && c.to}{c.from} → {c.to}{:else if c.to}→ {c.to}{/if}
										{#if c.created}· {t('stack.builtAt', { date: new Date(c.created).toLocaleDateString(page.data.locale ?? 'en') })}{/if}
										{#if c.releases}
											· <a href={c.releases} target="_blank" rel="noopener noreferrer">{t('stack.releaseNotesShort')}</a>
										{/if}
									</small>
								{/each}
							{:else}
								<small style="display: block; color: var(--color-text-dim);">
									{run.changed.length > 0
										? t('stack.historyChanged', { services: run.changed.join(', ') })
										: t('stack.historyNoChange')}
								</small>
							{/if}
						</span>
					</div>
					{#if run.logExcerpt}
						<details style="margin-top: var(--space-1);">
							<summary><small>{t('stack.historyLog')}</small></summary>
							<div class="term" style="max-height: 30dvh; margin-top: var(--space-2);">{run.logExcerpt}</div>
						</details>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</details>

