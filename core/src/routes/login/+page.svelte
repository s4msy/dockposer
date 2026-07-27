<script lang="ts">
	import type { ActionData } from './$types';
	import { enhance } from '$app/forms';
	let { form }: { form: ActionData } = $props();
</script>

<h1>Anmelden</h1>

{#if form?.error}
	<div class="alert-error" role="alert">{form.error}</div>
{/if}

<!-- reset:false — beim TOTP-Schritt bleiben Benutzername und Passwort erhalten -->
<form method="POST" class="card" use:enhance={() => async ({ update }) => update({ reset: false })}>
	<label for="username">Benutzername</label>
	<input id="username" name="username" autocomplete="username" required />

	<label for="password">Passwort</label>
	<input id="password" name="password" type="password" autocomplete="current-password" required />

	{#if form?.needTotp}
		<label for="totp">TOTP-Code</label>
		<!-- svelte-ignore a11y_autofocus — das Feld erscheint gerade erst, Fokus ist hier erwartbar -->
		<input id="totp" name="totp" inputmode="numeric" autocomplete="one-time-code" placeholder="000000" autofocus />
	{/if}

	<button type="submit">Anmelden</button>
</form>
