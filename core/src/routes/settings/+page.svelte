<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	let { data, form }: { data: PageData; form: ActionData } = $props();

	$effect(() => {
		if (form?.totpDone || form?.totpDisabled) invalidateAll();
	});
</script>

<h1>Einstellungen</h1>

<div class="card">
	<strong>Account</strong>
	<p>Angemeldet als <strong>{data.username}</strong></p>
	<form method="POST" action="/logout"><button>Abmelden</button></form>
</div>

<div class="card">
	<strong>Zwei-Faktor (TOTP)</strong>

	{#if form?.totpError}
		<div class="alert-error" role="alert">{form.totpError}</div>
	{/if}

	{#if data.totpEnabled}
		<p>✓ TOTP ist aktiv.</p>
		<form method="POST" action="?/totpDisable">
			<label for="pw-disable">Zum Deaktivieren Passwort bestätigen</label>
			<input id="pw-disable" name="password" type="password" autocomplete="current-password" required />
			<button>TOTP deaktivieren</button>
		</form>
	{:else if form?.qrDataUrl}
		<p>Mit Authenticator-App scannen, dann Code bestätigen:</p>
		<img src={form.qrDataUrl} alt="TOTP QR-Code" style="border-radius: var(--radius);" />
		<details style="margin: var(--space-2) 0;">
			<summary>Code manuell eingeben</summary>
			<code style="word-break: break-all;">{form.otpauthUrl}</code>
		</details>
		<form method="POST" action="?/totpConfirm">
			<label for="totp-code">Code aus der App</label>
			<input id="totp-code" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="000000" required />
			<button>Bestätigen &amp; aktivieren</button>
		</form>
	{:else}
		<p>Zweiter Faktor für den Login. Dringend empfohlen, bevor Server registriert werden.</p>
		<form method="POST" action="?/totpStart"><button>TOTP einrichten</button></form>
	{/if}
</div>

<div class="card">
	<strong>Server</strong>
	<p><a href="/settings/servers">Server verwalten →</a></p>
</div>
