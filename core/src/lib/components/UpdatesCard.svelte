<script lang="ts">
	// Update-Feed mit Prüfen, Ausführen und Policy — gemeinsam für Stacks und Pods.
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { translator } from '#lib/i18n/index.ts';
	import type { UpdateEntry } from '#lib/updates.ts';

	let {
		kind = 'stack',
		updates,
		lastUpdateCheck,
		stopped,
		healthHint = null,
		agentOffline,
		busy,
		onRun,
		policy,
		checkError = null,
		policySaved = false
	}: {
		kind?: 'stack' | 'pod';
		updates: UpdateEntry[];
		lastUpdateCheck: Date | string | null;
		stopped: boolean;
		healthHint?: string | null;
		agentOffline: boolean;
		busy: boolean;
		onRun: () => void;
		policy: string;
		checkError?: string | null;
		policySaved?: boolean;
	} = $props();
	const t = $derived(translator(page.data.locale ?? 'en'));
</script>

<div class="card">
	<strong>{t('stack.updates')}</strong>
	{#if checkError}<div class="alert-error" role="alert">{checkError}</div>{/if}

	{#if updates.length > 0}
		<ul style="list-style: none; padding: 0; margin: var(--space-2) 0;">
			{#each updates as u (u.service)}
				<li style="padding: var(--space-1) 0; display: flex; gap: var(--space-2); align-items: baseline;">
					{#if u.status === 'update'}<span style="color: var(--color-warn); font-weight: 700;">↑</span>
					{:else if u.status === 'current'}<span style="color: var(--color-ok);">✓</span>
					{:else if u.status === 'pinned'}<span style="color: var(--color-text-dim);">🔒</span>
					{:else if u.status === 'noauto'}<span style="color: var(--color-text-dim); font-weight: 700;">↑</span>
					{:else}<span style="color: var(--color-text-dim);">?</span>{/if}
					<span style="flex: 1;">
						{u.service} <small style="color: var(--color-text-dim);">{u.image}</small>
						{#if u.status === 'pinned' || u.image?.includes('@sha256:')}
							<small style="color: var(--color-text-dim);">· {t('stack.pinnedService')}</small>
						{/if}
						{#if u.status === 'update'}
							<small style="display: block; color: var(--color-text-dim);">{u.current.slice(7, 19)} → {u.latest.slice(7, 19)}</small>
							{#if u.newMeta}
								<small style="display: block; color: var(--color-text-dim);">
									{#if u.newMeta.version}{u.newMeta.version}{:else if u.newMeta.revision}{u.newMeta.revision}{/if}
									{#if u.newMeta.created}
										· {t('stack.builtAt', { date: new Date(u.newMeta.created).toLocaleString(page.data.locale ?? 'en') })}
									{/if}
									{#if u.oldMeta?.created}
										<br />{t('stack.runningBuild', {
											date: new Date(u.oldMeta.created).toLocaleString(page.data.locale ?? 'en')
										})}
									{/if}
									{#if u.newMeta.releases}
										<br /><a href={u.newMeta.releases} target="_blank" rel="noopener noreferrer">{t('stack.releaseNotes')}</a>
									{/if}
								</small>
							{/if}
						{:else if u.status === 'pinned' && u.newer}
							<small style="display: block; color: var(--color-text-dim);">
								{t('stack.pinnedNewer')} <span style="white-space: nowrap;">{u.current.slice(7, 19)} → {u.latest.slice(7, 19)}</span>
							</small>
						{:else if u.status === 'noauto'}
							<small style="display: block; color: var(--color-warn);">{t('pod.noAutoUpdate')}</small>
						{:else if u.status === 'unknown'}
							<small style="display: block; color: var(--color-text-dim);">
								{#if u.authRequired && u.host}
									{t('stack.checkImpossibleAuth')}
									<a href="/settings/registries">{t('stack.addCredentials', { host: u.host })}</a>
								{:else if u.host}
									{t('stack.checkImpossibleHost', { host: u.host })}
								{:else}
									{t('stack.checkImpossibleLocal')}
								{/if}
							</small>
						{/if}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
	{#if updates.length > 0 && updates.every((u: { status?: string; image?: string }) => u.status === 'pinned' || u.image?.includes('@sha256:'))}
		<p style="color: var(--color-warn);">{t('stack.allPinned')}</p>
	{/if}
	{#if lastUpdateCheck}
		<small style="color: var(--color-text-dim); display: block; margin-bottom: var(--space-2);">
			{t('stack.lastCheck', { date: new Date(lastUpdateCheck).toLocaleString(page.data.locale ?? 'en') })}
		</small>
	{/if}
	{#if stopped}
		<small style="color: var(--color-text-dim); display: block; margin-bottom: var(--space-2);">
			{t(kind === 'pod' ? 'pod.checkPaused' : 'stack.checkPaused')}
		</small>
	{/if}

	{#if healthHint}
		<small style="color: var(--color-text-dim); display: block; margin-bottom: var(--space-2);">{healthHint}</small>
	{/if}
	<div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2);">
		<form method="POST" action="?/checkUpdates" use:enhance>
			<button style="background: transparent; color: var(--color-primary); border: 1px solid var(--color-primary);" disabled={agentOffline}>{t('stack.checkUpdates')}</button>
		</form>
		<button disabled={!!busy || agentOffline} onclick={onRun}>{t('stack.runUpdate')}</button>
	</div>

	<form method="POST" action="?/setPolicy" use:enhance style="margin-top: var(--space-3); display: flex; gap: var(--space-2); align-items: center;">
		<label for="policy" style="margin: 0; flex: 1;">{t('stack.updatePolicy')}</label>
		<select id="policy" name="policy" value={policy} style="font: inherit; padding: var(--space-2); border-radius: var(--radius); border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text);">
			<option value="manual">{t('stack.policyManual')}</option>
			<option value="auto">{t('stack.policyAuto')}</option>
		</select>
		<button style="width: auto;">OK</button>
	</form>
	{#if policySaved}<small role="status" style="color: var(--color-ok);">{t('stack.policySaved')}</small>{/if}
</div>

