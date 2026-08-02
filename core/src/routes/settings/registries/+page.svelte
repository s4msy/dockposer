<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { enhance } from '$app/forms';
	let { data, form }: { data: PageData; form: ActionData } = $props();

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

	const fmtTime = (d: Date | string) => new Date(d).toLocaleString('de-DE');
</script>

<h1>Private Registries</h1>
<p><a href="/settings">← Einstellungen</a></p>

<div class="card">
	<p style="color: var(--color-text-dim); margin: 0;">
		Zugangsdaten für Registries, die ohne Anmeldung keinen Digest liefern. Ohne Eintrag zeigt der
		Update-Feed für solche Images „Check nicht möglich“ — Updates lassen sich trotzdem manuell ausführen.
	</p>
</div>

{#if form?.error}<div class="alert-error" role="alert">{form.error}</div>{/if}
{#if form?.saved}<p role="status" style="color: var(--color-ok);">Zugangsdaten für <code>{form.saved}</code> gespeichert. Jetzt testen.</p>{/if}

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
			Benutzer: <code>{cred.username}</code>
			{#if cred.note}<small style="display: block; color: var(--color-text-dim);">{cred.note}</small>{/if}
		</p>

		{#if form?.tested === cred.id}
			<p role="status" style="color: {form.ok ? 'var(--color-ok)' : 'var(--color-crit)'};">{form.message}</p>
		{:else if cred.lastCheckAt}
			<small style="display: block; color: {cred.lastCheckOk ? 'var(--color-ok)' : 'var(--color-crit)'}; margin-bottom: var(--space-2);">
				{cred.lastCheckMessage} <span style="color: var(--color-text-dim);">({fmtTime(cred.lastCheckAt)})</span>
			</small>
		{:else}
			<small style="display: block; color: var(--color-text-dim); margin-bottom: var(--space-2);">Noch nicht getestet.</small>
		{/if}

		<div style="display: flex; gap: var(--space-2);">
			<form method="POST" action="?/test" use:enhance style="flex: 1;">
				<input type="hidden" name="id" value={cred.id} />
				<button style="background: transparent; color: var(--color-primary); border: 1px solid var(--color-primary);">Testen</button>
			</form>
			<button
				style="flex: 1; background: transparent; color: var(--color-text-dim); border: 1px solid var(--color-border);"
				onclick={() => startEdit(cred.host, cred.username)}
			>Bearbeiten</button>
			<form
				method="POST"
				action="?/remove"
				use:enhance={() => {
					if (!confirm(`Zugangsdaten für „${cred.host}" entfernen?`)) return () => {};
					return async ({ update }) => update();
				}}
				style="flex: 1;"
			>
				<input type="hidden" name="id" value={cred.id} />
				<button style="background: transparent; color: var(--color-crit); border: 1px solid var(--color-crit);">Entfernen</button>
			</form>
		</div>
	</div>
{/each}

{#if data.suggestions.length > 0 && !showAdd}
	<div class="card" style="border-left: 4px solid var(--color-warn);">
		<strong>Ohne Zugangsdaten nicht prüfbar</strong>
		<ul style="list-style: none; padding: 0; margin: var(--space-2) 0 0;">
			{#each data.suggestions as s (s.host)}
				<li style="display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) 0; border-top: 1px solid var(--color-border);">
					<span style="flex: 1;"><code>{s.host}</code>
						<small style="display: block; color: var(--color-text-dim);">{s.count} Image(s)</small>
					</span>
					<button style="width: auto;" onclick={() => startAdd(s.host)}>Zugangsdaten</button>
				</li>
			{/each}
		</ul>
	</div>
{/if}

{#if showAdd}
	<form method="POST" action="?/save" class="card" use:enhance={() => async ({ update }) => update({ reset: false })}>
		<label for="host">Registry-Host</label>
		<input id="host" name="host" value={prefill} placeholder="git.example.com" required autocomplete="off" />

		<label for="username">Benutzername</label>
		<input id="username" name="username" value={editHost} required autocomplete="off" />

		<label for="secret">Token oder Passwort{#if editHost} (leer lassen = beibehalten){/if}</label>
		<input id="secret" name="secret" type="password" autocomplete="off" />
		<small style="color: var(--color-text-dim); display: block; margin-bottom: var(--space-3);">
			Ein Access-Token mit Lese-Recht genügt — bei Forgejo/Gitea unter Einstellungen → Anwendungen,
			Bereich „Paket“ mit Leserechten. Wird verschlüsselt gespeichert und nur für Digest-Abfragen verwendet.
		</small>

		<label for="note">Notiz (optional)</label>
		<input id="note" name="note" placeholder="z. B. Read-only-Token, gültig bis …" autocomplete="off" />

		<button>Speichern</button>
		<button
			type="button"
			onclick={() => (showAdd = false)}
			style="background: transparent; color: var(--color-text-dim); border: none; margin-top: var(--space-2);"
		>Abbrechen</button>
	</form>
{:else}
	<button onclick={() => startAdd()}>Registry hinzufügen</button>
{/if}
