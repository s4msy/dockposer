<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import { enhance } from '$app/forms';
	let { data, form }: { data: PageData; form: ActionData } = $props();

	$effect(() => {
		if (form?.totpDone || form?.totpDisabled || form?.displaySaved) invalidateAll();
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

	let passkeyError = $state('');
	let passkeyBusy = $state(false);

	// Install-Prompt (Chromium): beforeinstallprompt abfangen, Button anbieten
	let installEvent = $state<Event & { prompt: () => Promise<void> } | null>(null);
	$effect(() => {
		const handler = (e: Event) => {
			e.preventDefault();
			installEvent = e as Event & { prompt: () => Promise<void> };
		};
		window.addEventListener('beforeinstallprompt', handler);
		return () => window.removeEventListener('beforeinstallprompt', handler);
	});
	async function installApp() {
		await installEvent?.prompt();
		installEvent = null;
	}

	async function addPasskey() {
		passkeyBusy = true;
		passkeyError = '';
		try {
			const { startRegistration } = await import('@simplewebauthn/browser');
			const { challengeId, options } = await (await fetch('/api/webauthn/register')).json();
			const response = await startRegistration({ optionsJSON: options });
			const deviceName = prompt('Name für dieses Gerät (z. B. „Pixel 9"):') ?? '';
			const res = await fetch('/api/webauthn/register', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ challengeId, response, deviceName })
			});
			if (!res.ok) throw new Error(await res.text());
			await invalidateAll();
		} catch (e) {
			if (!String(e).includes('NotAllowedError')) passkeyError = `Passkey-Anlage fehlgeschlagen: ${e}`;
		} finally {
			passkeyBusy = false;
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

{#if installEvent}
	<div class="card">
		<strong>Als App installieren</strong>
		<p style="color: var(--color-text-dim);">Dockposer zum Homescreen/Desktop hinzufügen — für Push und Badge-Anzeige.</p>
		<button onclick={installApp}>Installieren</button>
	</div>
{/if}

<div class="card">
	<strong>Anzeige</strong>
	<form method="POST" action="?/toggleHideStopped" use:enhance style="margin-top: var(--space-2);">
		<button
			style="background: transparent; border: 1px solid currentColor; color: {data.hideStoppedStacks
				? 'var(--color-ok)'
				: 'var(--color-text-dim)'};"
		>
			{data.hideStoppedStacks ? '✓ Gestoppte Stacks ausgeblendet' : 'Gestoppte Stacks einblenden'}
		</button>
	</form>
	<small style="color: var(--color-text-dim); display: block; margin-top: var(--space-2);">
		Blendet Stacks aus, von denen aktuell kein Container läuft — der Ordner bleibt unangetastet.
		Die Übersicht zeigt weiterhin an, wie viele ausgeblendet sind.
	</small>
</div>

<div class="card">
	<strong>Passkeys</strong>
	<p style="color: var(--color-text-dim);">Anmeldung per Fingerabdruck/Face — ersetzt Passwort und TOTP-Code.</p>
	{#if passkeyError}<div class="alert-error" role="alert">{passkeyError}</div>{/if}

	{#if data.passkeys.length > 0}
		<ul style="list-style: none; padding: 0; margin: 0 0 var(--space-2);">
			{#each data.passkeys as pk (pk.id)}
				<li style="display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) 0; border-top: 1px solid var(--color-border);">
					<span style="flex: 1;">
						{pk.deviceName}
						<small style="color: var(--color-text-dim); display: block;">
							angelegt {new Date(pk.createdAt).toLocaleDateString('de-DE')}{pk.lastUsedAt ? ` · zuletzt ${new Date(pk.lastUsedAt).toLocaleDateString('de-DE')}` : ''}
						</small>
					</span>
					<form method="POST" action="?/removePasskey" use:enhance>
						<input type="hidden" name="id" value={pk.id} />
						<button style="width: auto; min-height: 36px; padding: var(--space-1) var(--space-3); background: transparent; color: var(--color-crit); border: 1px solid var(--color-crit);">Entfernen</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
	<button onclick={addPasskey} disabled={passkeyBusy}>Passkey hinzufügen</button>
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
	<p><a href="/settings/git">Git-Backend →</a></p>
</div>
