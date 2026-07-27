<script lang="ts">
	import type { ActionData } from './$types';
	let { form }: { form: ActionData } = $props();
	let username = $state(form?.username ?? '');
</script>

<h1>Anmelden</h1>

{#if form?.error}
	<div class="alert-error" role="alert">{form.error}</div>
{/if}

<form method="POST" class="card">
	<label for="username">Benutzername</label>
	<input id="username" name="username" autocomplete="username" required bind:value={username} />

	<label for="password">Passwort</label>
	<input id="password" name="password" type="password" autocomplete="current-password" required />

	{#if form?.needTotp}
		<label for="totp">TOTP-Code</label>
		<input id="totp" name="totp" inputmode="numeric" autocomplete="one-time-code" placeholder="000000" />
	{/if}

	<button type="submit">Anmelden</button>
</form>
