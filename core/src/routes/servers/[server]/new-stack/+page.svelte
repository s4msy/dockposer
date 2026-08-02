<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { translator } from '$lib/i18n';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	const t = $derived(translator(page.data.locale ?? 'en'));

	const template = `services:
  app:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:80"
`;
	let content = $state(form?.content ?? template);
</script>

<h1>{t('newstack.title')} <small style="color: var(--color-text-dim); font-weight: 400;">{t('stack.onServer', { server: data.server.name })}</small></h1>
<p><a href="/">{t('stack.backToOverview')}</a></p>

{#if form?.error}
	<div class="alert-error" role="alert">{form.error}</div>
{/if}

<form method="POST" class="card" use:enhance={() => async ({ update }) => update({ reset: false })}>
	<label for="name">{t('newstack.nameLabel')}</label>
	<input id="name" name="name" placeholder="mein-stack" required value={form?.name ?? ''} />

	<label for="content">compose.yaml</label>
	<textarea
		id="content"
		name="content"
		bind:value={content}
		rows="14"
		spellcheck="false"
		style="width: 100%; font-family: ui-monospace, monospace; font-size: 0.85rem; border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-bg); color: var(--color-text); padding: var(--space-3); margin-bottom: var(--space-3);"
	></textarea>

	<button>{t('newstack.create')}</button>
</form>
