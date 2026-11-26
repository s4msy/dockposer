<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { translator } from '#lib/i18n/index.ts';
	import CodeEditor from '#lib/components/CodeEditor.svelte';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	const t = $derived(translator(page.data.locale ?? 'en'));

	// Zwei Vorlagen: ein Pod mit erstem Container, oder ein einzelner Container
	// ohne Pod. Dateinamen und Verweise folgen dem Namen, solange die Datei noch
	// nicht angefasst wurde — danach gehört der Text dem Menschen.
	type Kind = 'pod' | 'single';
	let kind = $state<Kind>('pod');
	let name = $state(form?.name ?? '');
	const n = $derived(name.trim() || 'NAME');

	const podText = (x: string) => `[Pod]
PodName=${x}
# Ports gelten für den ganzen Pod:
PublishPort=127.0.0.1:8080:80

[Install]
WantedBy=default.target
`;
	const appText = (x: string) => `[Container]
ContainerName=${x}-app
Image=docker.io/library/nginx:alpine
Pod=${x}.pod
AutoUpdate=registry

[Service]
Restart=always
`;
	const singleText = (x: string) => `[Container]
ContainerName=${x}
Image=docker.io/library/nginx:alpine
PublishPort=127.0.0.1:8080:80
AutoUpdate=registry

[Service]
Restart=always

[Install]
WantedBy=default.target
`;

	type Draft = { file: (x: string) => string; text: (x: string) => string; content: string; touched: boolean };
	let drafts = $state<Draft[]>([]);
	function reset(k: Kind) {
		drafts =
			k === 'pod'
				? [
						{ file: (x) => `${x}.pod`, text: podText, content: podText(n), touched: false },
						{ file: (x) => `${x}-app.container`, text: appText, content: appText(n), touched: false }
					]
				: [{ file: (x) => `${x}.container`, text: singleText, content: singleText(n), touched: false }];
	}
	reset('pod');

	$effect(() => {
		for (const d of drafts) if (!d.touched) d.content = d.text(n);
	});
</script>

<h1>{t('newpod.title')} <small style="color: var(--color-text-dim); font-weight: 400;">{t('stack.onServer', { server: data.server.name })}</small></h1>
<p><a href="/">{t('stack.backToOverview')}</a></p>

{#if form?.error}
	<div class="alert-error" role="alert" style="white-space: pre-wrap; overflow-wrap: anywhere;">{form.error}</div>
{/if}

<form method="POST" class="card" use:enhance={() => async ({ update }) => update({ reset: false })}>
	<label for="name">{t('newpod.nameLabel')}</label>
	<input id="name" name="name" placeholder="freshrss" required autocomplete="off" bind:value={name} />

	<fieldset style="border: none; padding: 0; margin: 0 0 var(--space-3); display: flex; gap: var(--space-4); flex-wrap: wrap;">
		<label style="display: flex; gap: var(--space-2); align-items: center; font-weight: 400;">
			<input type="radio" name="kindChoice" value="pod" checked={kind === 'pod'} onchange={() => { kind = 'pod'; reset('pod'); }} style="width: auto;" />
			{t('newpod.kindPod')}
		</label>
		<label style="display: flex; gap: var(--space-2); align-items: center; font-weight: 400;">
			<input type="radio" name="kindChoice" value="single" checked={kind === 'single'} onchange={() => { kind = 'single'; reset('single'); }} style="width: auto;" />
			{t('newpod.kindSingle')}
		</label>
	</fieldset>

	{#each drafts as d, i}
		<input type="hidden" name="file.{i}.name" value={d.file(n)} />
		<label for="file{i}"><code>{d.file(n)}</code></label>
		<div style="margin-bottom: var(--space-3);">
			<CodeEditor
				id="file{i}"
				name="file.{i}.content"
				bind:value={() => d.content, (v) => { if (v !== d.content) { d.content = v; d.touched = true; } }}
				fileName={d.file(n)}
				rows={kind === 'pod' && i === 0 ? 8 : 10}
			/>
		</div>
	{/each}
	<small style="color: var(--color-text-dim); display: block; margin-bottom: var(--space-3);">{t('newpod.hint', { version: data.server.podmanVersion ?? '' })}</small>

	{#if data.gitReady}
		<label style="display: flex; gap: var(--space-2); align-items: center; font-weight: 400;">
			<input type="checkbox" name="git" checked style="width: auto;" />
			{t('newpod.git')}
		</label>
	{/if}

	<button disabled={!name.trim()}>{t('newpod.create')}</button>
</form>
