<script lang="ts">
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();

	const stacksFor = $derived((serverId: number) => data.stacks.filter((s) => s.serverId === serverId));
</script>

<h1>Dockposer</h1>

{#if data.servers.length === 0}
	<div class="card">
		<p>Noch keine Server registriert.</p>
		<p><a href="/settings/servers">Ersten Server hinzufügen</a></p>
	</div>
{/if}

{#each data.servers as server (server.id)}
	<div class="card">
		<div class="server-head">
			<span class="server-name">{server.name}</span>
			<span class="dot {server.status === 'online' ? 'running' : 'stopped'}" aria-label={server.status}></span>
			<a href="/servers/{server.id}/new-stack" style="text-decoration: none; margin-left: auto;">+ Stack</a>
		</div>
		<ul style="list-style:none; padding:0; margin:var(--space-2) 0 0;">
			{#each stacksFor(server.id) as stack (stack.id)}
				<li style="padding:0; border-top:1px solid var(--color-border);">
					<a href="/stacks/{server.id}/{encodeURIComponent(stack.name)}" style="display:flex; align-items:center; gap:var(--space-2); padding:var(--space-3) 0; text-decoration:none; color:inherit; min-height:44px;">
					<span class="dot {stack.state}"></span>
					{stack.name}
					{#if stack.state === 'partial'}
						<small>{stack.servicesRunning}/{stack.servicesTotal}</small>
					{/if}
					{#if stack.drift}<small style="color:var(--color-warn)">drift</small>{/if}
					{#if stack.updatesCount > 0}<small style="color:var(--color-warn); margin-left:auto;">{stack.updatesCount}↑</small>{/if}
					</a>
				</li>
			{/each}
		</ul>

		{#if (data.unmanaged[server.id] ?? []).length > 0}
			{@const list = data.unmanaged[server.id]}
			<details style="margin-top: var(--space-2); border-top: 1px solid var(--color-border); padding-top: var(--space-2);">
				<summary style="color: var(--color-text-dim); cursor: pointer; min-height: 44px; display: flex; align-items: center;">
					<span style="color: var(--color-warn);">⚠</span>&nbsp;{list.length} Container außerhalb von {server.stacksPath}
				</summary>
				<ul style="list-style: none; padding: 0; margin: var(--space-2) 0 0;">
					{#each list as c (c.name)}
						<li style="padding: var(--space-2) 0; border-top: 1px solid var(--color-border);">
							<code>{c.name}</code>
							<small style="display: block; color: var(--color-text-dim);">
								{c.image}
								{#if c.kind === 'standalone'}
									· einzeln gestartet (kein Compose)
								{:else if c.working_dir}
									· Stack „{c.project}" aus <code>{c.working_dir}</code>
								{:else}
									· Stack „{c.project}" (Pfad unbekannt)
								{/if}
							</small>
						</li>
					{/each}
				</ul>
				<small style="display: block; margin-top: var(--space-2); color: var(--color-text-dim);">
					Dockposer verwaltet diese nicht. Zum Aufnehmen: compose-Datei nach {server.stacksPath} verschieben
					und dort neu starten — oder per SSH weiterpflegen.
				</small>
			</details>
		{/if}
	</div>
{/each}
