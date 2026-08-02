<script lang="ts">
	import type { ActionData } from './$types';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { translator } from '$lib/i18n';
	let { form }: { form: ActionData } = $props();
	const t = $derived(translator(page.data.locale ?? 'en'));
	let passkeyError = $state('');
	let passkeyBusy = $state(false);

	async function loginWithPasskey() {
		passkeyBusy = true;
		passkeyError = '';
		try {
			const { startAuthentication } = await import('@simplewebauthn/browser');
			const { challengeId, options } = await (await fetch('/api/webauthn/auth')).json();
			const response = await startAuthentication({ optionsJSON: options });
			const res = await fetch('/api/webauthn/auth', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ challengeId, response })
			});
			if (!res.ok) throw new Error(await res.text());
			await goto('/', { invalidateAll: true });
		} catch (e) {
			// Abbruch durch den User ist kein Fehler
			if (!String(e).includes('NotAllowedError')) passkeyError = t('login.passkeyFailed', { error: String(e) });
		} finally {
			passkeyBusy = false;
		}
	}
</script>

<h1>{t('login.title')}</h1>

{#if form?.error}
	<div class="alert-error" role="alert">{form.error}</div>
{/if}

<!-- reset:false — beim TOTP-Schritt bleiben Benutzername und Passwort erhalten -->
<form method="POST" class="card" use:enhance={() => async ({ update }) => update({ reset: false })}>
	<label for="username">{t('login.username')}</label>
	<input id="username" name="username" autocomplete="username" required />

	<label for="password">{t('login.password')}</label>
	<input id="password" name="password" type="password" autocomplete="current-password" required />

	{#if form?.needTotp}
		<label for="totp">{t('login.totp')}</label>
		<!-- svelte-ignore a11y_autofocus — das Feld erscheint gerade erst, Fokus ist hier erwartbar -->
		<input id="totp" name="totp" inputmode="numeric" autocomplete="one-time-code" placeholder="000000" autofocus />
	{/if}

	<button type="submit">{t('login.submit')}</button>
</form>

{#if passkeyError}<div class="alert-error" role="alert">{passkeyError}</div>{/if}
<button onclick={loginWithPasskey} disabled={passkeyBusy} style="background: transparent; color: var(--color-primary); border: 1px solid var(--color-primary);">
	🔑 {t('login.passkey')}
</button>
