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
	</div>
{/each}
