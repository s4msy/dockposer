<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { enhance } from '$app/forms';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	let expanded = $state<number | null>(null);
</script>

<h1>Git-Backend</h1>
<p><a href="/settings">← Einstellungen</a></p>

<div class="card">
	<p style="color: var(--color-text-dim); margin: 0;">
		Pro Server ein Repo im Stacks-Ordner. Dockposer deployed nie <em>aus</em> Git — es protokolliert
		<em>nach</em> Git: jede Compose-Änderung wird ein Commit. Aktivieren pro Stack in der Stack-Detailseite.
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
				<strong>git ist auf diesem Server nicht installiert.</strong><br />
				<small style="color: var(--color-text-dim);">Fedora/RHEL: <code>sudo dnf install git</code> · Debian/Ubuntu: <code>sudo apt install git</code></small>
			</p>
		{:else if server.status?.is_repo}
			<p style="margin: 0 0 var(--space-2);">
				✓ Repo aktiv in <code>{server.stacksPath}</code>
				<small style="display: block; color: var(--color-text-dim);">
					Branch {server.status.branch ?? '?'}
					{#if server.status.remote}· Push-Ziel: <code>{server.storedRemote || server.status.remote}</code>{:else}· kein Push-Ziel (nur lokale Commits){/if}
					{#if server.status.last_commit}<br />Letzter Commit: {server.status.last_commit}{/if}
					{#if server.status.dirty_files}<br />{server.status.dirty_files} nicht committete Änderung(en) — z. B. per SSH geändert{/if}
				</small>
			</p>
			{#if server.tracked.length > 0}
				<p style="margin: 0 0 var(--space-2);"><small style="color: var(--color-text-dim);">Tracking aktiv für: {server.tracked.join(', ')}</small></p>
			{:else}
				<p style="margin: 0 0 var(--space-2);"><small style="color: var(--color-warn);">Noch kein Stack mit Git-Tracking — in der Stack-Detailseite aktivieren.</small></p>
			{/if}
		{:else}
			<p style="color: var(--color-text-dim);">Noch kein Repo in <code>{server.stacksPath}</code>.</p>
		{/if}

		{#if form?.setupDone === server.id}
			<p role="status" style="color: var(--color-ok);">
				Eingerichtet.
				{#if form.repo_created}Repo angelegt.{/if}
				{#if form.gitignore_written}.gitignore geschrieben.{:else if form.gitignore_existed}Bestehende .gitignore unangetastet.{/if}
			</p>
		{/if}

		{#if server.status?.git_installed !== false && !server.error}
			{#if expanded === server.id}
				<form method="POST" action="?/setup" use:enhance={() => async ({ update }) => update({ reset: false })}>
					<label for="remote-{server.id}">Push-Ziel (optional, leer = beibehalten)</label>
					<input
						id="remote-{server.id}"
						name="remote"
						placeholder="git@git.example.com:user/stacks-{server.name}.git"
						autocomplete="off"
					/>
					<small style="color: var(--color-text-dim); display: block; margin-bottom: var(--space-3);">
						Zugangsdaten verwaltet Dockposer nicht: Für <code>git@…</code> muss auf dem Server ein
						SSH-Deploy-Key liegen. Bei <code>https://user:token@…</code> wird das Remote verschlüsselt gespeichert.
						Das Repo muss in Forgejo bereits existieren.
					</small>

					<label style="display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2);">
						<input type="checkbox" name="writeGitignore" checked style="width: auto; margin: 0;" />
						Empfohlene <code>.gitignore</code> anlegen (nur Dateien direkt in den Stack-Ordnern, keine Volumes, keine <code>.env</code>)
					</label>
					{#if server.status?.gitignore}
						<label style="display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2);">
							<input type="checkbox" name="overwriteGitignore" style="width: auto; margin: 0;" />
							Bestehende <code>.gitignore</code> überschreiben
						</label>
						<details style="margin-bottom: var(--space-2);">
							<summary><small>Aktuelle .gitignore anzeigen</small></summary>
							<pre style="font-size: 0.75rem; overflow: auto; background: var(--color-bg); padding: var(--space-2); border-radius: var(--radius);">{server.status.gitignore}</pre>
						</details>
					{/if}

					<input type="hidden" name="id" value={server.id} />
					<button>{server.status?.is_repo ? 'Übernehmen' : 'Repo einrichten'}</button>
				</form>
				{#if server.hasStoredRemote}
					<form method="POST" action="?/clearRemote" use:enhance style="margin-top: var(--space-2);">
						<input type="hidden" name="id" value={server.id} />
						<button style="background: transparent; color: var(--color-crit); border: 1px solid var(--color-crit);">Gespeichertes Push-Ziel löschen</button>
					</form>
				{/if}
				<button onclick={() => (expanded = null)} style="background: transparent; color: var(--color-text-dim); border: none; margin-top: var(--space-2);">Schließen</button>
			{:else}
				<button
					onclick={() => (expanded = server.id)}
					style="background: transparent; color: var(--color-primary); border: 1px solid var(--color-primary);"
				>{server.status?.is_repo ? 'Einstellungen' : 'Repo einrichten'}</button>
			{/if}
		{/if}
	</div>
{/each}
