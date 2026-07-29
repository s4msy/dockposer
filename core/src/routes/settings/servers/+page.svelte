<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { enhance } from '$app/forms';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	let showAdd = $state(false);
</script>

<h1>Server</h1>
<p><a href="/settings">← Einstellungen</a></p>

{#if form?.error}
	<div class="alert-error" role="alert">{form.error}</div>
{/if}

{#if form?.created}
	<div class="card" style="border-color: var(--color-ok);">
		<strong>„{form.created.name}" registriert.</strong>
		{#if form.created.token}
			<p>Agent-Token — <strong>wird nur einmal angezeigt</strong>, gehört in die Agent-Config auf dem Server:</p>
			<code style="word-break: break-all; display: block; padding: var(--space-2); background: var(--color-bg); border-radius: var(--radius);">{form.created.token}</code>
		{:else}
			<p>Mit deinem vorgegebenen Token registriert. Jetzt „Verbindung testen".</p>
		{/if}
	</div>
{/if}

{#each data.servers as server (server.id)}
	<div class="card">
		<strong>{server.name}</strong>
		<span class="dot {server.status === 'online' ? 'running' : 'stopped'}" aria-label={server.status}></span>
		<p style="color: var(--color-text-dim); margin: var(--space-1) 0;">
			{server.baseUrl} · {server.stacksPath}
			{#if server.lastSeenAt}· zuletzt gesehen: {new Date(server.lastSeenAt).toLocaleString('de-DE')}{/if}
		</p>

		{#if form?.testResult?.id === server.id}
			<p role="alert" style="color: {form.testResult.ok ? 'var(--color-ok)' : 'var(--color-crit)'};">
				{form.testResult.message}
			</p>
		{/if}

		<form method="POST" action="?/test" use:enhance>
			<input type="hidden" name="id" value={server.id} />
			<button>Verbindung testen</button>
		</form>

		<form method="POST" action="?/setSsh" use:enhance style="display: flex; gap: var(--space-2); align-items: flex-end; margin-top: var(--space-2);">
			<input type="hidden" name="id" value={server.id} />
			<div style="flex: 1;">
				<label for="ssh-{server.id}">SSH-URL</label>
				<input id="ssh-{server.id}" name="sshUrl" placeholder="ssh://user@host" value={server.sshUrl ?? ''} style="margin-bottom: 0;" />
			</div>
			<button style="width: auto;">OK</button>
		</form>
		{#if form?.sshSaved === server.id}<small role="status" style="color: var(--color-ok);">SSH-URL gespeichert.</small>{/if}

		<form
			method="POST"
			action="?/remove"
			use:enhance={() => {
				if (!confirm(`Server „${server.name}" wirklich entfernen?`)) return () => {};
				return async ({ update }) => update();
			}}
			style="margin-top: var(--space-2);"
		>
			<input type="hidden" name="id" value={server.id} />
			<button style="background: transparent; color: var(--color-crit); border: 1px solid var(--color-crit);">Entfernen</button>
		</form>
	</div>
{/each}

{#if showAdd}
	<form method="POST" action="?/add" class="card" use:enhance>
		<label for="name">Name</label>
		<input id="name" name="name" placeholder="hetzner-1" required />

		<label for="baseUrl">Agent-URL (hinter deinem Proxy)</label>
		<input id="baseUrl" name="baseUrl" type="url" placeholder="http://agent:8720 (lokal) oder https://agent1.example.com" required />

		<label for="stacksPath">Stacks-Pfad auf dem Server</label>
		<input id="stacksPath" name="stacksPath" placeholder="~/stacks" />

		<label for="sshUrl">SSH-URL (optional, für den „Terminal öffnen"-Button)</label>
		<input id="sshUrl" name="sshUrl" placeholder="ssh://user@host" />

		<label for="token">Token (leer lassen = generieren; für den lokalen Agent: LOCAL_AGENT_TOKEN aus der .env)</label>
		<input id="token" name="token" type="password" autocomplete="off" placeholder="optional" />

		<button>Registrieren</button>
	</form>
{:else}
	<button onclick={() => (showAdd = true)}>Server hinzufügen</button>
{/if}
