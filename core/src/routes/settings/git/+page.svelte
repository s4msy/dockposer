<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { translator } from '$lib/i18n';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	const t = $derived(translator(page.data.locale ?? 'en'));
	let expanded = $state<number | null>(null);
</script>

<h1>{t('git.title')}</h1>
<p><a href="/settings">{t('servers.backToSettings')}</a></p>

<div class="card">
	<p style="color: var(--color-text-dim); margin: 0;">
		{t('git.intro')}
	</p>
</div>

{#if form?.error}<div class="alert-error" role="alert">{form.error}</div>{/if}

{#each data.servers as server (server.id)}
	<div class="card">
		<div class="server-head">
			<span class="server-name">{server.name}</span>
			{#if server.status?.is_repo}
				<span class="dot running" aria-label="Repo vorhanden"></span>
			{:else if server.status?.git_installed === false}
				<span class="dot stopped" aria-label="git fehlt"></span>
			{:else}
				<span class="dot unknown" aria-label="kein Repo"></span>
			{/if}
		</div>

		{#if server.error}
			<p style="color: var(--color-crit);">{server.error}</p>
		{:else if server.status?.git_installed === false}
			<p style="color: var(--color-crit);">
				<strong>{t('git.notInstalled')}</strong><br />
				<small style="color: var(--color-text-dim);">{t('git.installHint')}</small>
			</p>
		{:else if server.status?.is_repo}
			<p style="margin: 0 0 var(--space-2);">
				✓ {t('git.repoActive', { path: server.stacksPath })}
				<small style="display: block; color: var(--color-text-dim);">
					{t('git.branch', { branch: server.status.branch ?? '?' })}
					{#if server.status.remote}· {t('git.pushTarget', { remote: server.storedRemote || server.status.remote })}{:else}· {t('git.noPushTarget')}{/if}
					{#if server.status.last_commit}<br />{t('git.lastCommit', { commit: server.status.last_commit })}{/if}
					{#if server.status.dirty_files}<br />{t('git.dirty', { count: server.status.dirty_files })}{/if}
				</small>
			</p>
			{#if server.tracked.length > 0}
				<p style="margin: 0 0 var(--space-2);"><small style="color: var(--color-text-dim);">{t('git.trackingFor', { stacks: server.tracked.join(', ') })}</small></p>
			{:else}
				<p style="margin: 0 0 var(--space-2);"><small style="color: var(--color-warn);">{t('git.noTracking')}</small></p>
			{/if}
		{:else}
			<p style="color: var(--color-text-dim);">{t('git.noRepo', { path: server.stacksPath })}</p>
		{/if}

		{#if form?.setupDone === server.id}
			<p role="status" style="color: var(--color-ok);">
				{t('git.setUpDone')}
				{#if form.repo_created}{t('git.repoCreated')}{/if}
				{#if form.gitignore_written}{t('git.gitignoreWritten')}{:else if form.gitignore_existed}{t('git.gitignoreKept')}{/if}
			</p>
		{/if}

		{#if server.status?.git_installed !== false && !server.error}
			{#if expanded === server.id}
				<form method="POST" action="?/setup" use:enhance={() => async ({ update }) => update({ reset: false })}>
					<label for="remote-{server.id}">{t('git.remoteLabel')}</label>
					<input
						id="remote-{server.id}"
						name="remote"
						placeholder="git@git.example.com:user/stacks-{server.name}.git"
						autocomplete="off"
					/>
					<small style="color: var(--color-text-dim); display: block; margin-bottom: var(--space-3);">
						{t('git.remoteHint')}
					</small>

					<label style="display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2);">
						<input type="checkbox" name="writeGitignore" checked style="width: auto; margin: 0;" />
						{t('git.writeGitignore')}
					</label>
					{#if server.status?.gitignore}
						<label style="display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2);">
							<input type="checkbox" name="overwriteGitignore" style="width: auto; margin: 0;" />
							{t('git.overwriteGitignore')}
						</label>
						<details style="margin-bottom: var(--space-2);">
							<summary><small>{t('git.showGitignore')}</small></summary>
							<pre style="font-size: 0.75rem; overflow: auto; background: var(--color-bg); padding: var(--space-2); border-radius: var(--radius);">{server.status.gitignore}</pre>
						</details>
					{/if}

					<input type="hidden" name="id" value={server.id} />
					<button>{server.status?.is_repo ? t('git.apply') : t('git.setUpRepo')}</button>
				</form>
				{#if server.hasStoredRemote}
					<form method="POST" action="?/clearRemote" use:enhance style="margin-top: var(--space-2);">
						<input type="hidden" name="id" value={server.id} />
						<button style="background: transparent; color: var(--color-crit); border: 1px solid var(--color-crit);">{t('git.clearRemote')}</button>
					</form>
				{/if}
				<button onclick={() => (expanded = null)} style="background: transparent; color: var(--color-text-dim); border: none; margin-top: var(--space-2);">{t('common.close')}</button>
			{:else}
				<button
					onclick={() => (expanded = server.id)}
					style="background: transparent; color: var(--color-primary); border: 1px solid var(--color-primary);"
				>{server.status?.is_repo ? t('git.settings') : t('git.setUpRepo')}</button>
			{/if}
		{/if}
	</div>
{/each}
