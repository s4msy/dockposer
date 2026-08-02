<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { translator } from '$lib/i18n';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	const t = $derived(translator(page.data.locale ?? 'en'));

	let showAdd = $state(false);
	let editHost = $state('');
	let prefill = $state('');

	function startAdd(host = '') {
		prefill = host;
		editHost = '';
		showAdd = true;
	}
	function startEdit(host: string, username: string) {
		prefill = host;
		editHost = username;
		showAdd = true;
	}

	const fmtTime = (d: Date | string) => new Date(d).toLocaleString(page.data.locale ?? 'en');
</script>

<h1>{t('reg.title')}</h1>
<p><a href="/settings">{t('servers.backToSettings')}</a></p>

<div class="card">
	<p style="color: var(--color-text-dim); margin: 0;">
		{t('reg.intro')}
	</p>
</div>

{#if form?.error}<div class="alert-error" role="alert">{form.error}</div>{/if}
{#if form?.saved}<p role="status" style="color: var(--color-ok);">{t('reg.saved', { host: form.saved })}</p>{/if}

{#each data.credentials as cred (cred.id)}
	<div class="card">
		<div class="server-head">
			<span class="server-name">{cred.host}</span>
			{#if form?.tested === cred.id}
				<span class="dot {form.ok ? 'running' : 'stopped'}"></span>
			{:else if cred.lastCheckAt}
				<span class="dot {cred.lastCheckOk ? 'running' : 'stopped'}"></span>
			{:else}
				<span class="dot unknown"></span>
			{/if}
		</div>

		<p style="margin: 0 0 var(--space-2);">
			{t('reg.user', { name: cred.username })}
			{#if cred.note}<small style="display: block; color: var(--color-text-dim);">{cred.note}</small>{/if}
		</p>

		{#if form?.tested === cred.id}
			<p role="status" style="color: {form.ok ? 'var(--color-ok)' : 'var(--color-crit)'};">{form.message}</p>
		{:else if cred.lastCheckAt}
			<small style="display: block; color: {cred.lastCheckOk ? 'var(--color-ok)' : 'var(--color-crit)'}; margin-bottom: var(--space-2);">
				{cred.lastCheckMessage} <span style="color: var(--color-text-dim);">({fmtTime(cred.lastCheckAt)})</span>
			</small>
		{:else}
			<small style="display: block; color: var(--color-text-dim); margin-bottom: var(--space-2);">{t('reg.notTested')}</small>
		{/if}

		<div style="display: flex; gap: var(--space-2);">
			<form method="POST" action="?/test" use:enhance style="flex: 1;">
				<input type="hidden" name="id" value={cred.id} />
				<button style="background: transparent; color: var(--color-primary); border: 1px solid var(--color-primary);">{t('common.test')}</button>
			</form>
			<button
				style="flex: 1; background: transparent; color: var(--color-text-dim); border: 1px solid var(--color-border);"
				onclick={() => startEdit(cred.host, cred.username)}
			>{t('common.edit')}</button>
			<form
				method="POST"
				action="?/remove"
				use:enhance={() => {
					if (!confirm(t('reg.confirmRemove', { host: cred.host }))) return () => {};
					return async ({ update }) => update();
				}}
				style="flex: 1;"
			>
				<input type="hidden" name="id" value={cred.id} />
				<button style="background: transparent; color: var(--color-crit); border: 1px solid var(--color-crit);">{t('common.remove')}</button>
			</form>
		</div>
	</div>
{/each}

{#if data.suggestions.length > 0 && !showAdd}
	<div class="card" style="border-left: 4px solid var(--color-warn);">
		<strong>{t('reg.notPossible')}</strong>
		<ul style="list-style: none; padding: 0; margin: var(--space-2) 0 0;">
			{#each data.suggestions as s (s.host)}
				<li style="display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) 0; border-top: 1px solid var(--color-border);">
					<span style="flex: 1;"><code>{s.host}</code>
						<small style="display: block; color: var(--color-text-dim);">{t('reg.imagesCount', { count: s.count })}</small>
					</span>
					<button style="width: auto;" onclick={() => startAdd(s.host)}>{t('reg.credentials')}</button>
				</li>
			{/each}
		</ul>
	</div>
{/if}

{#if showAdd}
	<form method="POST" action="?/save" class="card" use:enhance={() => async ({ update }) => update({ reset: false })}>
		<label for="host">{t('reg.host')}</label>
		<input id="host" name="host" value={prefill} placeholder="git.example.com" required autocomplete="off" />

		<label for="username">{t('reg.username')}</label>
		<input id="username" name="username" value={editHost} required autocomplete="off" />

		<label for="secret">{editHost ? t('reg.secretKeep') : t('reg.secret')}</label>
		<input id="secret" name="secret" type="password" autocomplete="off" />
		<small style="color: var(--color-text-dim); display: block; margin-bottom: var(--space-3);">
			{t('reg.secretHint')}
		</small>

		<label for="note">{t('reg.note')}</label>
		<input id="note" name="note" placeholder={t('reg.notePlaceholder')} autocomplete="off" />

		<button>{t('common.save')}</button>
		<button
			type="button"
			onclick={() => (showAdd = false)}
			style="background: transparent; color: var(--color-text-dim); border: none; margin-top: var(--space-2);"
		>{t('common.cancel')}</button>
	</form>
{:else}
	<button onclick={() => startAdd()}>{t('reg.add')}</button>
{/if}
