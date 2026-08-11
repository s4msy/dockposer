<script lang="ts">
	import type { PageData } from './$types';
	import { page } from '$app/state';
	import { translator } from '$lib/i18n';
	let { data }: { data: PageData } = $props();
	const t = $derived(translator(page.data.locale ?? 'en'));

	const stacksFor = $derived((serverId: number) => data.stacks.filter((s) => s.serverId === serverId));
</script>

<h1>Dockposer</h1>

{#if data.servers.length === 0}
	<div class="card">
		<p>{t('overview.noServers')}</p>
		<p><a href="/settings/servers">{t('overview.addFirst')}</a></p>
	</div>
{/if}

<div class="server-grid">
{#each data.servers as server (server.id)}
	<div class="card" style="margin-bottom: 0;">
		<div class="server-head">
			<span class="server-name">{server.name}</span>
			<span class="dot {server.status === 'online' ? 'running' : 'stopped'}" aria-label={server.status}></span>
			<a href="/servers/{server.id}/new-stack" style="text-decoration: none; margin-left: auto;">{t('overview.newStack')}</a>
		</div>
		<ul style="list-style:none; padding:0; margin:var(--space-2) 0 0;">
			{#each stacksFor(server.id) as stack (stack.id)}
				<li style="padding:0; border-top:1px solid var(--color-border);">
					<a href="/stacks/{server.id}/{encodeURIComponent(stack.name)}" style="display:flex; align-items:center; gap:var(--space-2); padding:var(--space-3) 0; text-decoration:none; color:inherit; min-height:44px;">
					<span class="dot {stack.state}"></span>
					{stack.name}
					{#if stack.state === 'partial'}
						<small>{stack.servicesRunning}/{stack.servicesTotal}</small>
					{:else if stack.state === 'unhealthy'}
						<small style="color: var(--color-warn);">unhealthy</small>
					{/if}
					{#if stack.drift}<small style="color:var(--color-warn)">{t('overview.drift')}</small>{/if}
					{#if stack.updatesCount > 0}<small style="color:var(--color-warn); margin-left:auto;">{stack.updatesCount}↑</small>{/if}
					</a>
				</li>
			{/each}
		</ul>

		{#if (data.hiddenPerServer[server.id] ?? 0) > 0}
			<p style="margin: var(--space-2) 0 0; color: var(--color-text-dim); font-size: 0.85rem;">
				{data.hiddenPerServer[server.id] === 1
					? t('overview.hiddenStack', { count: 1 })
					: t('overview.hiddenStacks', { count: data.hiddenPerServer[server.id] })} ·
				<a href="/settings">{t('overview.showAgain')}</a>
			</p>
		{:else if stacksFor(server.id).length === 0 && !data.hideStopped}
			<p style="margin: var(--space-2) 0 0; color: var(--color-text-dim); font-size: 0.85rem;">
				{t('overview.noStacks')}
			</p>
		{/if}

		{#if (data.unmanaged[server.id] ?? []).length > 0}
			{@const list = data.unmanaged[server.id]}
			<details style="margin-top: var(--space-2); border-top: 1px solid var(--color-border); padding-top: var(--space-2);">
				<summary style="color: var(--color-text-dim); cursor: pointer; min-height: 44px; display: flex; align-items: center;">
					<span style="color: var(--color-warn);">⚠</span>&nbsp;{t('overview.unmanaged', { count: list.length, path: server.stacksPath })}
				</summary>
				<ul style="list-style: none; padding: 0; margin: var(--space-2) 0 0;">
					{#each list as c (c.name)}
						<li style="padding: var(--space-2) 0; border-top: 1px solid var(--color-border);">
							<code>{c.name}</code>
							<small style="display: block; color: var(--color-text-dim);">
								{c.image}
								{#if c.kind === 'standalone'}
									· {t('overview.standalone')}
								{:else if c.working_dir}
									· {t('overview.externalStack', { project: c.project ?? '', dir: c.working_dir })}
								{:else}
									· {t('overview.externalStackNoDir', { project: c.project ?? '' })}
								{/if}
							</small>
						</li>
					{/each}
				</ul>
				<small style="display: block; margin-top: var(--space-2); color: var(--color-text-dim);">
					{t('overview.unmanagedHint', { path: server.stacksPath })}
				</small>
			</details>
		{/if}
	</div>
{/each}
</div>
