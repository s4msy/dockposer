<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { invalidateAll as reload } from '$app/navigation';
	import { translator, LOCALE_LABELS, LOCALES } from '$lib/i18n';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	const t = $derived(translator(page.data.locale ?? 'en'));

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

	// Theme sofort anwenden — das <html data-theme> wird sonst erst beim
	// nächsten vollen Seitenladen serverseitig neu gesetzt.
	const THEMES = [
		{ id: 'system', label: 'System', colors: ['#1a1614', '#e07a4a', '#f0e9e2'] },
		{ id: 'dockposer-light', label: 'Dockposer hell', colors: ['#faf6f1', '#b4552d', '#2b2320'] },
		{ id: 'dockposer-dark', label: 'Dockposer dunkel', colors: ['#1a1614', '#e07a4a', '#f0e9e2'] },
		{ id: 'catppuccin-mocha', label: 'Catppuccin Mocha', colors: ['#1e1e2e', '#cba6f7', '#cdd6f4'] },
		{ id: 'catppuccin-latte', label: 'Catppuccin Latte', colors: ['#eff1f5', '#8839ef', '#4c4f69'] },
		{ id: 'nord', label: 'Nord', colors: ['#2e3440', '#88c0d0', '#eceff4'] },
		{ id: 'dracula', label: 'Dracula', colors: ['#282a36', '#bd93f9', '#f8f8f2'] },
		{ id: 'gruvbox-dark', label: 'Gruvbox Dark', colors: ['#282828', '#fe8019', '#ebdbb2'] }
	];
	function applyTheme(id: string) {
		document.documentElement.dataset.theme = id;
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

<h1>{t('settings.title')}</h1>

<div class="card">
	<strong>{t('settings.account')}</strong>
	<p>{t('settings.loggedInAs', { name: data.username })}</p>
	<form method="POST" action="/logout"><button>{t('settings.logout')}</button></form>
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
	<strong>{t('settings.language')}</strong>
	<div style="display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-2);">
		{#each [{ id: 'auto', label: t('settings.languageAuto') }, ...LOCALES.map((l) => ({ id: l, label: LOCALE_LABELS[l] }))] as opt (opt.id)}
			<form method="POST" action="?/setLocale" use:enhance={() => async ({ update }) => {
				await update({ reset: false });
				await reload();
			}} style="width: auto;">
				<input type="hidden" name="locale" value={opt.id} />
				<button
					style="width: auto; background: transparent; color: var(--color-text);
						border: 2px solid {data.localePref === opt.id ? 'var(--color-primary)' : 'var(--color-border)'};
						font-weight: {data.localePref === opt.id ? '700' : '400'};"
				>{opt.label}</button>
			</form>
		{/each}
	</div>
</div>

<div class="card">
	<strong>{t('settings.appearance')}</strong>
	<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--space-2); margin-top: var(--space-2);">
		{#each THEMES as t (t.id)}
			<form method="POST" action="?/setTheme" use:enhance={() => {
				applyTheme(t.id);
				return async ({ update }) => update({ reset: false });
			}}>
				<input type="hidden" name="theme" value={t.id} />
				<button
					style="width: 100%; max-width: none; display: flex; align-items: center; gap: var(--space-2);
						background: transparent; border: 2px solid {data.theme === t.id ? 'var(--color-primary)' : 'var(--color-border)'};
						color: var(--color-text); font-weight: {data.theme === t.id ? '700' : '400'};"
				>
					<span style="display: inline-flex; border-radius: 4px; overflow: hidden; border: 1px solid var(--color-border); flex-shrink: 0;">
						{#each t.colors as c}<span style="width: 12px; height: 18px; background: {c};"></span>{/each}
					</span>
					<span style="font-size: 0.85rem; text-align: left;">{t.label}</span>
				</button>
			</form>
		{/each}
	</div>
</div>

<div class="card">
	<strong>{t('settings.display')}</strong>
	<form method="POST" action="?/toggleHideStopped" use:enhance style="margin-top: var(--space-2);">
		<button
			style="background: transparent; border: 1px solid currentColor; color: {data.hideStoppedStacks
				? 'var(--color-ok)'
				: 'var(--color-text-dim)'};"
		>
			{data.hideStoppedStacks ? t('settings.hideStoppedOn') : t('settings.hideStoppedOff')}
		</button>
	</form>
	<small style="color: var(--color-text-dim); display: block; margin-top: var(--space-2);">
		{t('settings.hideStoppedHint')}
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
	<strong>{t('settings.servers')}</strong>
	<p><a href="/settings/servers">{t('settings.manageServers')} →</a></p>
	<p><a href="/settings/git">{t('settings.gitBackend')} →</a></p>
	<p><a href="/settings/registries">{t('settings.registries')} →</a></p>
</div>
