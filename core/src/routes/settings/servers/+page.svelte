<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { translator } from '$lib/i18n';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	const t = $derived(translator(page.data.locale ?? 'en'));
	let showAdd = $state(false);
	let copied = $state(false);

	$effect(() => {
		if (form?.created) showAdd = false;
	});

	function copyToken(token: string) {
		navigator.clipboard.writeText(token);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

<h1>{t('servers.title')}</h1>
<p><a href="/settings">{t('servers.backToSettings')}</a></p>

{#if form?.error}
	<div class="alert-error" role="alert">{form.error}</div>
{/if}

{#each data.servers as server (server.id)}
	<div class="card">
		<strong>{server.name}</strong>
		<span class="dot {server.status === 'online' ? 'running' : 'stopped'}" aria-label={server.status}></span>
		<p style="color: var(--color-text-dim); margin: var(--space-1) 0;">
			{server.baseUrl} · {server.stacksPath}
			{#if server.lastSeenAt}· {t('servers.lastSeen', { date: new Date(server.lastSeenAt).toLocaleString(page.data.locale ?? 'en') })}{/if}
		</p>

		{#if form?.testResult?.id === server.id}
			<p role="alert" style="color: {form.testResult.ok ? 'var(--color-ok)' : 'var(--color-crit)'};">
				{form.testResult.message}
			</p>
		{/if}

		<form method="POST" action="?/test" use:enhance>
			<input type="hidden" name="id" value={server.id} />
			<button>{t('servers.testConnection')}</button>
		</form>

		<form method="POST" action="?/setSsh" use:enhance style="display: flex; gap: var(--space-2); align-items: flex-end; margin-top: var(--space-2);">
			<input type="hidden" name="id" value={server.id} />
			<div style="flex: 1;">
				<label for="ssh-{server.id}">{t('servers.sshUrlLabel')}</label>
				<input id="ssh-{server.id}" name="sshUrl" placeholder="ssh://user@host" value={server.sshUrl ?? ''} style="margin-bottom: 0;" />
			</div>
			<button style="width: auto;">OK</button>
		</form>
		{#if form?.sshSaved === server.id}<small role="status" style="color: var(--color-ok);">{t('servers.sshSaved')}</small>{/if}

		<form
			method="POST"
			action="?/remove"
			use:enhance={() => {
				if (!confirm(t('servers.confirmRemove', { name: server.name }))) return () => {};
				return async ({ update }) => update();
			}}
			style="margin-top: var(--space-2);"
		>
			<input type="hidden" name="id" value={server.id} />
			<button style="background: transparent; color: var(--color-crit); border: 1px solid var(--color-crit);">{t('common.remove')}</button>
		</form>
	</div>
{/each}

{#if form?.created}
	<div class="card" style="border-color: var(--color-ok);">
		<strong>{t('servers.registered', { name: form.created.name })}</strong>
		{#if form.created.token}
			<p>{t('servers.tokenOnce')}</p>
			<div style="display: flex; gap: var(--space-2); align-items: center;">
				<code style="word-break: break-all; flex: 1; padding: var(--space-2); background: var(--color-bg); border-radius: var(--radius);">{form.created.token}</code>
				<button style="width: auto;" onclick={() => copyToken(form.created.token)}>{copied ? '✓' : t('servers.copy')}</button>
			</div>
			<details style="margin-top: var(--space-2);">
				<summary>{t('servers.installOneliner')}</summary>
				<p style="color: var(--color-text-dim);">{t('servers.rawBaseHint')}</p>
				<code style="word-break: break-all; display: block; padding: var(--space-2); background: var(--color-bg); border-radius: var(--radius); font-size: 0.8rem;">curl -fsSL RAW-BASE/agent/install.sh | sudo sh -s -- --base RAW-BASE --token {form.created.token}</code>
			</details>
		{:else}
			<p>{t('servers.registeredOwnToken')}</p>
		{/if}
	</div>
{:else if showAdd}
	<form method="POST" action="?/add" class="card" use:enhance>
		<label for="name">{t('servers.name')}</label>
		<input id="name" name="name" placeholder="hetzner-1" required />

		<label for="baseUrl">{t('servers.agentUrl')}</label>
		<input id="baseUrl" name="baseUrl" type="url" placeholder="http://agent:8720 (lokal) oder https://agent1.example.com" required />

		<label for="stacksPath">{t('servers.stacksPath')}</label>
		<input id="stacksPath" name="stacksPath" placeholder="~/stacks" />

		<label for="sshUrl">{t('servers.sshUrlLabel')}</label>
		<input id="sshUrl" name="sshUrl" placeholder="ssh://user@host" />

		<label for="token">{t('servers.tokenLabel')}</label>
		<input id="token" name="token" type="password" autocomplete="off" placeholder="optional" />

		<button>{t('servers.register')}</button>
	</form>
{:else}
	<button onclick={() => (showAdd = true)}>{t('servers.add')}</button>
{/if}
