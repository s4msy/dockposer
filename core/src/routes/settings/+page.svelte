<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import { enhance } from '$app/forms';
	let { data, form }: { data: PageData; form: ActionData } = $props();

	$effect(() => {
		if (form?.totpDone || form?.totpDisabled) invalidateAll();
	});

	let pushState = $state<'unknown' | 'unsupported' | 'off' | 'on' | 'busy'>('unknown');
	let pushError = $state('');

	function b64ToUint8(base64: string): Uint8Array {
		const pad = '='.repeat((4 - (base64.length % 4)) % 4);
		const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
		return Uint8Array.from(raw, (c) => c.charCodeAt(0));
	}

	$effect(() => {
		(async () => {
			if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
				pushState = 'unsupported';
				return;
			}
			const reg = await navigator.serviceWorker.ready;
			pushState = (await reg.pushManager.getSubscription()) ? 'on' : 'off';
		})();
	});

	async function enablePush() {
		pushState = 'busy';
		pushError = '';
		try {
			if ((await Notification.requestPermission()) !== 'granted') {
				pushError = 'Benachrichtigungen wurden nicht erlaubt.';
				pushState = 'off';
				return;
			}
			const reg = await navigator.serviceWorker.ready;
			const sub = await reg.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: b64ToUint8(data.vapidPublicKey)
			});
			const res = await fetch('/api/push/subscribe', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(sub.toJSON())
			});
			if (!res.ok) throw new Error(`Server: ${res.status}`);
			pushState = 'on';
			await invalidateAll();
		} catch (e) {
			pushError = `Aktivierung fehlgeschlagen: ${e}`;
			pushState = 'off';
		}
	}

	async function disablePush() {
		pushState = 'busy';
		const reg = await navigator.serviceWorker.ready;
		const sub = await reg.pushManager.getSubscription();
		if (sub) {
			await fetch('/api/push/subscribe', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ endpoint: sub.endpoint })
			});
			await sub.unsubscribe();
		}
		pushState = 'off';
		await invalidateAll();
	}
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
	<strong>Push-Benachrichtigungen</strong>
	<p style="color: var(--color-text-dim);">Alerts direkt aufs Gerät — auch bei geschlossener App. Auf iOS muss die App dafür zum Homescreen hinzugefügt sein.</p>

	{#if pushError}<div class="alert-error" role="alert">{pushError}</div>{/if}

	{#if pushState === 'unsupported'}
		<p>Dieser Browser unterstützt kein Web Push.</p>
	{:else if pushState === 'on'}
		<p>✓ Aktiv auf diesem Gerät{data.webpushCount > 1 ? ` (insgesamt ${data.webpushCount} Geräte)` : ''}.</p>
		<button onclick={disablePush} disabled={pushState === 'busy'} style="background: transparent; color: var(--color-crit); border: 1px solid var(--color-crit);">Auf diesem Gerät deaktivieren</button>
	{:else}
		<button onclick={enablePush} disabled={pushState !== 'off'}>Auf diesem Gerät aktivieren</button>
	{/if}

	<details style="margin-top: var(--space-3);">
		<summary>ntfy-Fallback (optional)</summary>
		{#if form?.ntfyError}<div class="alert-error" role="alert">{form.ntfyError}</div>{/if}
		{#if form?.ntfySaved}<p role="status" style="color: var(--color-ok);">Gespeichert.</p>{/if}
		<form method="POST" action="?/saveNtfy" use:enhance={() => async ({ update }) => update({ reset: false })}>
			<label for="ntfyTopic">Topic-URL (leer = deaktivieren)</label>
			<input id="ntfyTopic" name="ntfyTopic" type="url" placeholder="https://ntfy.sh/mein-geheimes-topic" value={data.ntfyTopic} />
			<button>ntfy speichern</button>
		</form>
	</details>
</div>

<div class="card">
	<strong>Server</strong>
	<p><a href="/settings/servers">Server verwalten →</a></p>
</div>
