<script lang="ts">
	import type { ActionData } from './$types';
	let { form }: { form: ActionData } = $props();
</script>

<h1>Ersteinrichtung</h1>
<p>Willkommen bei Dockposer. Lege den Admin-Account an.</p>

{#if form?.error}
	<div class="alert-error" role="alert">{form.error}</div>
{/if}

<form method="POST" class="card">
	<label for="username">Benutzername</label>
	<input id="username" name="username" autocomplete="username" required />

	<label for="password">Passwort (min. 12 Zeichen)</label>
	<input id="password" name="password" type="password" autocomplete="new-password" required minlength="12" />

	<button type="submit">Account anlegen</button>
</form>
