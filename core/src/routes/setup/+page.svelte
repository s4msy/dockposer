<script lang="ts">
	import type { ActionData } from './$types';
	import { page } from '$app/state';
	import { translator } from '$lib/i18n';
	let { form }: { form: ActionData } = $props();
	const t = $derived(translator(page.data.locale ?? 'en'));
</script>

<h1>{t('setup.title')}</h1>
<p>{t('setup.intro')}</p>

{#if form?.error}
	<div class="alert-error" role="alert">{form.error}</div>
{/if}

<form method="POST" class="card">
	<label for="username">{t('login.username')}</label>
	<input id="username" name="username" autocomplete="username" required />

	<label for="password">{t('setup.passwordLabel')}</label>
	<input id="password" name="password" type="password" autocomplete="new-password" required minlength="12" />

	<button type="submit">{t('setup.create')}</button>
</form>
