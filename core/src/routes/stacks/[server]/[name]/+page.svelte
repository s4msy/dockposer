<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	let { data, form }: { data: PageData; form: ActionData } = $props();

	let output = $state<{ text: string; cls: string }[]>([]);

	function classify(line: string): string {
		if (line.startsWith('$ ') || line.startsWith('──')) return 'cmd';
		if (/✓|erfolgreich|Pulled|Started|Healthy/i.test(line)) return 'ok';
		if (/error|failed|fehlgeschlagen|Rollback|unhealthy|Instabil|denied/i.test(line)) return 'err';
		if (/warn/i.test(line)) return 'warn';
		if (line.startsWith('  …') || line.startsWith('…') || line.startsWith('  ')) return 'dim';
		return '';
	}
	const pushLine = (text: string, cls?: string) => {
		output = [...output, { text, cls: cls ?? classify(text) }];
		if (output.length > 2000) output = output.slice(-1500);
		outputEl?.scrollTo(0, outputEl.scrollHeight);
	};
	let busy = $state<string | null>(null);
	let logSource = $state<{ container: string; abort: AbortController } | null>(null);
	let editorContent = $state(data.compose?.content ?? '');
	let outputEl = $state<HTMLElement | null>(null);
	let containers = $state(data.containers);
	let sshCopied = $state(false);
	let showDanger = $state(false);
	let envOpen = $state(false);
	let confirmName = $state('');
	const stackStopped = $derived(
		containers.length === 0 || !containers.some((c) => c.State === 'running' || c.State === 'restarting')
	);
	let stats = $state<Record<string, { cpu: string; mem: string }>>({});

	// Live-Polling: ps + stats alle 5s, solange die Seite offen ist
	$effect(() => {
		containers = data.containers;
		if (data.agentOffline) return;
		let stopped = false;
		const tick = async () => {
			try {
				const res = await fetch(`/api/agent/${data.server.id}/${encodeURIComponent(data.name)}/status`);
				if (!res.ok || stopped) return;
				const body = await res.json();
				containers = body.containers;
				const map: Record<string, { cpu: string; mem: string }> = {};
				for (const st of body.stats) map[st.Name] = { cpu: st.CPUPerc, mem: st.MemUsage };
				stats = map;
			} catch {
				/* nächster Tick versucht es erneut */
			}
		};
		tick();
		const iv = setInterval(tick, 5000);
		return () => {
			stopped = true;
			clearInterval(iv);
		};
	});

	$effect(() => {
		if (data.compose && !busy) editorContent = data.compose.content;
	});

	// SSE aus einem fetch-Stream lesen (POST → kein EventSource möglich).
	// Liefert pro Block Event-Name (default 'message') + Datenzeile.
	async function readSse(res: Response, onEvent: (event: string, data: string) => void) {
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let buf = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const parts = buf.split('\n\n');
			buf = parts.pop() ?? '';
			for (const part of parts) {
				let event = 'message';
				for (const line of part.split('\n')) {
					if (line.startsWith('event: ')) event = line.slice(7).trim();
					else if (line.startsWith('data: ')) onEvent(event, line.slice(6));
				}
			}
		}
	}

	async function runAction(action: string) {
		if (busy) return;
		busy = action;
		output = [];
		pushLine(`$ docker compose ${action}`, 'cmd');
		try {
			const res = await fetch(`/api/agent/${data.server.id}/${encodeURIComponent(data.name)}/action/${action}`, {
				method: 'POST'
			});
			if (!res.ok) {
				pushLine(`Fehler: ${res.status} ${await res.text()}`, 'err');
				return;
			}
			await readSse(res, (event, line) => {
				if (event === 'result') {
					try {
						const r = JSON.parse(line);
						if (r.result === 'success') {
							const changed = Object.entries(r.new_digests ?? {}).filter(
								([svc, d]) => (r.old_digests ?? {})[svc] !== d
							).length;
							pushLine(changed > 0 ? `── Ergebnis: Erfolg, ${changed} Service(s) aktualisiert ──` : '── Ergebnis: bereits aktuell, keine Änderung ──', 'ok');
						} else if (r.result === 'rolled_back') {
							pushLine(`── Ergebnis: Rollback aktiv (${r.reason ?? ''}) ──`, 'err');
						} else {
							pushLine(`── Ergebnis: fehlgeschlagen (${r.reason ?? r.stage ?? ''}) ──`, 'err');
						}
					} catch {
						pushLine(line);
					}
				} else if (event === 'exit') {
					pushLine(line === '0' ? '— fertig —' : `— beendet mit Exit ${line} —`, line === '0' ? 'dim' : 'err');
				} else {
					pushLine(line);
				}
			});
		} catch (e) {
			pushLine(`Verbindung abgebrochen: ${e}`, 'err');
		} finally {
			busy = null;
			await invalidateAll();
		}
	}

	async function toggleLogs(containerName: string) {
		if (logSource?.container === containerName) {
			logSource.abort.abort();
			logSource = null;
			output = []; // Stoppen klappt die Konsole wieder zu
			return;
		}
		logSource?.abort.abort();
		const abort = new AbortController();
		logSource = { container: containerName, abort };
		output = [];
		pushLine(`── Logs: ${containerName} ──`, 'cmd');
		try {
			const res = await fetch(
				`/api/agent/${data.server.id}/${encodeURIComponent(data.name)}/logs/${encodeURIComponent(containerName)}?tail=200`,
				{ signal: abort.signal }
			);
			if (!res.ok) {
				pushLine(`Fehler: ${res.status}`, 'err');
				return;
			}
			await readSse(res, (event, line) => {
				if (event === 'exit') pushLine('— Log-Stream beendet —', 'dim');
				else pushLine(line, '');
			});
		} catch {
			/* abort ist der Normalfall */
		}
	}

	// Dockers "2.801MiB / 1.828GiB" → "2,8 MiB / 1,83 GiB" (deutsche Lesart, max. 2 Nachkommastellen)
	function fmtSize(raw: string): string {
		return raw.replace(/(\d+(?:\.\d+)?)\s*([KMGT]i?B|B)/g, (_, num, unit) => {
			const n = parseFloat(num);
			const rounded = n >= 100 ? Math.round(n).toString() : n.toFixed(n >= 10 ? 1 : 2);
			return rounded.replace(/\.?0+$/, '').replace('.', ',') + '\u00a0' + unit;
		});
	}

	function fmtCpu(raw: string): string {
		const n = parseFloat(raw);
		if (Number.isNaN(n)) return raw;
		return n.toFixed(n >= 10 ? 0 : 1).replace('.', ',') + '\u00a0%';
	}

	function stateDot(state: string, health?: string): string {
		if (health === 'unhealthy') return 'unhealthy'; // läuft, aber Healthcheck schlägt an
		if (state === 'running') return 'running';
		if (state === 'exited' || state === 'dead') return 'stopped';
		return 'partial';
	}
</script>

<h1>
	{data.name}
	<small style="color: var(--color-text-dim); font-weight: 400;">auf {data.server.name}</small>
</h1>
<p style="display: flex; gap: var(--space-3);">
	<a href="/">← Übersicht</a>
	{#if data.server.sshUrl}
		<a href={data.server.sshUrl} style="margin-left: auto;">Terminal öffnen ↗</a>
		<button
			style="width: auto; min-height: 0; padding: 0 var(--space-2); background: transparent; color: var(--color-primary); border: 1px solid var(--color-primary); font-size: 0.8rem;"
			title="SSH-Kommando kopieren (falls der Browser den User aus dem Link entfernt)"
			onclick={() => {
				// ssh://user@host:2222 → „ssh -p 2222 user@host"
				const rest = data.server.sshUrl!.slice(6);
				const m = rest.match(/^(.*?)(?::(\d{1,5}))?$/);
				const cmd = m?.[2] ? `ssh -p ${m[2]} ${m[1]}` : `ssh ${rest}`;
				navigator.clipboard.writeText(cmd);
				sshCopied = true;
				setTimeout(() => (sshCopied = false), 2000);
			}}
		>{sshCopied ? '✓ kopiert' : '⧉'}</button>
	{/if}
</p>

{#if data.agentOffline}
	<div class="alert-error" role="alert">Agent nicht erreichbar — Anzeige ggf. veraltet, Aktionen deaktiviert.</div>
{/if}

{#if data.compose?.pinned}
	<div class="card" style="border-left: 4px solid var(--color-warn);" role="alert">
		<strong>Stack läuft auf gepinnter alter Version</strong>
		<p style="margin: var(--space-1) 0 0; color: var(--color-text-dim);">
			Ein Update ist fehlgeschlagen, <code>.dockposer-rollback.yaml</code> pinnt die alten Images.
			Aufräumen: compose.yaml aktualisieren, Pin-Datei per SSH löschen, „up -d" — oder erneut ein Update versuchen.
		</p>
	</div>
{/if}

<div class="card" style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--space-2);">
	<button disabled={!!busy || data.agentOffline} onclick={() => runAction('up')}>up -d</button>
	<button disabled={!!busy || data.agentOffline} onclick={() => runAction('restart')}>restart</button>
	<button
		disabled={!!busy || data.agentOffline}
		style="background: transparent; color: var(--color-crit); border: 1px solid var(--color-crit);"
		onclick={() => confirm(`Stack „${data.name}" wirklich stoppen?`) && runAction('down')}
	>down</button>
</div>

<div class="card">
	<strong>Updates</strong>
	{#if form?.checkError}<div class="alert-error" role="alert">{form.checkError}</div>{/if}

	{#if data.updates.length > 0}
		<ul style="list-style: none; padding: 0; margin: var(--space-2) 0;">
			{#each data.updates as u (u.service)}
				<li style="padding: var(--space-1) 0; display: flex; gap: var(--space-2); align-items: baseline;">
					{#if u.status === 'update'}<span style="color: var(--color-warn); font-weight: 700;">↑</span>
					{:else if u.status === 'current'}<span style="color: var(--color-ok);">✓</span>
					{:else}<span style="color: var(--color-text-dim);">?</span>{/if}
					<span style="flex: 1;">
						{u.service} <small style="color: var(--color-text-dim);">{u.image}</small>
						{#if u.status === 'update'}
							<small style="display: block; color: var(--color-text-dim);">{u.current.slice(7, 19)} → {u.latest.slice(7, 19)}</small>
						{:else if u.status === 'unknown'}
							<small style="display: block; color: var(--color-text-dim);">
								{#if u.authRequired && u.host}
									Check nicht möglich — <a href="/settings/registries">Zugangsdaten für {u.host} hinterlegen</a>
								{:else if u.host}
									Check nicht möglich (Registry {u.host} liefert keinen Digest)
								{:else}
									Check nicht möglich (lokal gebaut, kein Registry-Image)
								{/if}
							</small>
						{/if}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
	{#if data.lastUpdateCheck}
		<small style="color: var(--color-text-dim); display: block; margin-bottom: var(--space-2);">
			Letzter Check: {new Date(data.lastUpdateCheck).toLocaleString('de-DE')}
		</small>
	{/if}

	<div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2);">
		<form method="POST" action="?/checkUpdates" use:enhance>
			<button style="background: transparent; color: var(--color-primary); border: 1px solid var(--color-primary);" disabled={data.agentOffline}>Nach Updates suchen</button>
		</form>
		<button disabled={!!busy || data.agentOffline} onclick={() => runAction('update')}>Update (Auto-Rollback)</button>
	</div>

	<form method="POST" action="?/setPolicy" use:enhance style="margin-top: var(--space-3); display: flex; gap: var(--space-2); align-items: center;">
		<label for="policy" style="margin: 0; flex: 1;">Update-Policy</label>
		<select id="policy" name="policy" value={data.updatePolicy} style="font: inherit; padding: var(--space-2); border-radius: var(--radius); border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text);">
			<option value="manual">manuell</option>
			<option value="auto">automatisch</option>
		</select>
		<button style="width: auto;">OK</button>
	</form>
	{#if form?.policySaved}<small role="status" style="color: var(--color-ok);">Policy gespeichert.</small>{/if}
</div>

{#if containers.length > 0}
	<div class="card">
		<strong>Services</strong>
		<ul style="list-style: none; padding: 0; margin: var(--space-2) 0 0;">
			{#each containers as c (c.Name)}
				<li style="padding: var(--space-2) 0; border-top: 1px solid var(--color-border); display: flex; align-items: center; gap: var(--space-2);">
					<span class="dot {stateDot(c.State, c.Health)}"></span>
					<span style="flex: 1;">
						{c.Service}
						<small style="color: var(--color-text-dim); display: block;">
							{c.Status}{#if c.Health}
								· <span style="color: {c.Health === 'unhealthy' ? 'var(--color-crit)' : c.Health === 'healthy' ? 'var(--color-ok)' : 'var(--color-warn)'}; font-weight: 700;">{c.Health}</span>
							{/if}
						</small>
						{#if stats[c.Name]}
							<small style="color: var(--color-text-dim); display: block;">CPU {fmtCpu(stats[c.Name].cpu)} · RAM {fmtSize(stats[c.Name].mem)}</small>
						{/if}
					</span>
					<button
						style="width: auto; min-height: 36px; padding: var(--space-1) var(--space-3); background: transparent; color: var(--color-primary); border: 1px solid var(--color-primary);"
						onclick={() => toggleLogs(c.Name)}
					>
						{logSource?.container === c.Name ? 'Stopp' : 'Logs'}
					</button>
				</li>
			{/each}
		</ul>
	</div>
{/if}

{#if output.length > 0}
	<div class="term" bind:this={outputEl}>{#each output as line}<span class="term-line {line.cls}">{line.text + '\n'}</span>{/each}</div>
{/if}

{#if data.compose}
	<div class="card">
		<strong>{data.compose.file}</strong>
		{#if data.compose.env_files.length > 0}
			<small style="color: var(--color-text-dim); display: block;">
				.env-Dateien (bleiben auf dem Server): {data.compose.env_files.join(', ')}
			</small>
		{/if}

		<form method="POST" action="?/toggleGit" use:enhance style="margin: var(--space-2) 0; display: flex; align-items: center; gap: var(--space-2);">
			<button style="width: auto; min-height: 36px; padding: var(--space-1) var(--space-3); background: transparent; color: {data.gitTracking ? 'var(--color-ok)' : 'var(--color-text-dim)'}; border: 1px solid currentColor;">
				{data.gitTracking ? '✓ Git-Tracking an' : 'Git-Tracking aus'}
			</button>
			<small style="color: var(--color-text-dim);">Jede Änderung wird als Commit im Stacks-Repo protokolliert (<a href="/settings/git">einrichten</a>). Volumes und <code>.env</code> bleiben ausgeschlossen.</small>
		</form>

		{#if form?.saveError}<div class="alert-error" role="alert" style="margin-top: var(--space-2);">{form.saveError}</div>{/if}
		{#if form?.saved}
			<p role="status" style="color: var(--color-ok);">
				Gespeichert{form.committed ? ' & committed' : ''}. „up -d" zum Anwenden.
				{#if form.gitError}<span style="color: var(--color-warn);"> Git-Hinweis: {form.gitError}</span>{/if}
			</p>
		{/if}

		<form method="POST" action="?/saveCompose" use:enhance={() => async ({ update }) => update({ reset: false })}>
			<textarea
				name="content"
				bind:value={editorContent}
				rows="18"
				spellcheck="false"
				style="width: 100%; font-family: ui-monospace, monospace; font-size: 0.85rem; border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-bg); color: var(--color-text); padding: var(--space-3);"
			></textarea>
			<button style="margin-top: var(--space-2);" disabled={data.agentOffline}>Speichern (wird validiert)</button>
		</form>
	</div>

	<details class="card" bind:open={envOpen}>
		<summary style="cursor: pointer; min-height: 44px; display: flex; align-items: center;">
			<strong>Konfigurationsdateien</strong>
		</summary>

		{#if data.editableFiles.length === 0}
			<p style="color: var(--color-text-dim);">
				Keine bearbeitbaren Dateien gefunden.
				{#if data.allowedPatterns.length > 0}
					Zugelassen auf diesem Server: <code>{data.allowedPatterns.join(', ')}</code>.
				{/if}
				<br />Die Liste bestimmt <code>DOCKPOSER_EDITABLE_FILES</code> in der Agent-Konfiguration
				(z. B. <code>.env,Caddyfile</code>) — Compose lädt automatisch nur <code>.env</code>.
			</p>
		{:else}
			<p style="color: var(--color-text-dim); font-size: 0.85rem;">
				Zugelassen: <code>{data.allowedPatterns.join(', ')}</code> (Agent-Einstellung
				<code>DOCKPOSER_EDITABLE_FILES</code>). <strong>Nichts davon wird nach Git committet.</strong>
			</p>

			{#if form?.fileError}<div class="alert-error" role="alert">{form.fileError}</div>{/if}
			{#if form?.fileSaved}
				<p role="status" style="color: var(--color-ok);">
					<code>{form.fileName}</code> gespeichert. Neustart des Stacks übernimmt die Änderung.
				</p>
			{/if}

			<div style="display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-3);">
				{#each data.editableFiles as f (f.name)}
					<form method="POST" action="?/loadFile" use:enhance style="width: auto;">
						<input type="hidden" name="fileName" value={f.name} />
						<button
							style="width: auto; min-height: 36px; padding: var(--space-1) var(--space-3);
								background: {form?.fileName === f.name && form?.fileLoaded ? 'var(--color-primary)' : 'transparent'};
								color: {form?.fileName === f.name && form?.fileLoaded ? 'var(--color-primary-text)' : 'var(--color-primary)'};
								border: 1px solid var(--color-primary);"
							disabled={data.agentOffline}
						>{f.name}{#if f.secrets}&nbsp;🔒{/if}</button>
					</form>
				{/each}
			</div>

			{#if form?.fileLoaded}
				<form method="POST" action="?/saveFile" use:enhance={() => async ({ update }) => update({ reset: false })}>
					<input type="hidden" name="fileName" value={form.fileName} />
					<label for="fileContent"><code>{form.fileName}</code>{#if !form.fileExists} — noch nicht vorhanden, Speichern legt sie an{/if}</label>
					<textarea
						id="fileContent"
						name="fileContent"
						value={form.fileContent ?? ''}
						rows="12"
						spellcheck="false"
						autocomplete="off"
						style="width: 100%; font-family: ui-monospace, monospace; font-size: 0.85rem; border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-bg); color: var(--color-text); padding: var(--space-3);"
					></textarea>
					<button style="margin-top: var(--space-2);" disabled={data.agentOffline}>Speichern</button>
				</form>
			{/if}
		{/if}
	</details>
{/if}

<div class="card" style="margin-top: var(--space-6); border-color: var(--color-border);">
	{#if !showDanger}
		<button
			onclick={() => (showDanger = true)}
			style="background: transparent; color: var(--color-text-dim); border: 1px dashed var(--color-border);"
		>Stack löschen …</button>
	{:else}
		<strong style="color: var(--color-crit);">Stack löschen</strong>
		{#if !stackStopped}
			<p style="color: var(--color-text-dim);">Nur möglich, wenn der Stack gestoppt ist. Erst „down" ausführen.</p>
		{:else}
			<p style="color: var(--color-text-dim);">
				Entfernt den Ordner <code>{data.name}</code> auf dem Server. <strong>Volumes bleiben erhalten</strong> (per SSH aufräumen, falls gewünscht).
			</p>
			{#if form?.deleteError}<div class="alert-error" role="alert">{form.deleteError}</div>{/if}
			<form method="POST" action="?/deleteStack" use:enhance>
				<label for="confirmName">Zur Bestätigung „{data.name}" eingeben</label>
				<input id="confirmName" name="confirmName" bind:value={confirmName} autocomplete="off" placeholder={data.name} />
				<button
					disabled={confirmName !== data.name}
					style="background: var(--color-crit);"
				>Unwiderruflich löschen</button>
			</form>
		{/if}
		<button onclick={() => (showDanger = false)} style="background: transparent; color: var(--color-text-dim); border: none; margin-top: var(--space-2);">Abbrechen</button>
	{/if}
</div>
