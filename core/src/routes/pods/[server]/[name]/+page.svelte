<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { refreshAll } from '$app/navigation';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { translator } from '#lib/i18n/index.ts';
	import CodeEditor from '#lib/components/CodeEditor.svelte';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	const t = $derived(translator(page.data.locale ?? 'en'));

	// Pods laufen über systemd. Die Seite folgt der Stack-Seite, damit sich beide
	// gleich bedienen; Abfragen tragen ?kind=pod, der Core leitet sie an die
	// Pod-Routen des Agents weiter.
	const api = $derived(`/api/agent/${data.server.id}/${encodeURIComponent(data.name)}`);

	let output = $state<{ text: string; cls: string }[]>([]);
	let outputEl = $state<HTMLElement | null>(null);
	let busy = $state<string | null>(null);
	let logSource = $state<{ container: string; abort: AbortController } | null>(null);
	let containers = $state(data.containers);
	let stats = $state<Record<string, { cpu: string; mem: string }>>({});

	function classify(line: string): string {
		if (line.startsWith('$ ') || line.startsWith('──')) return 'cmd';
		if (/— ok$|✓/.test(line)) return 'ok';
		if (/error|failed|fehlgeschlagen|denied/i.test(line)) return 'err';
		return '';
	}
	const pushLine = (text: string, cls?: string) => {
		output = [...output, { text, cls: cls ?? classify(text) }];
		if (output.length > 2000) output = output.slice(-1500);
		outputEl?.scrollTo(0, outputEl.scrollHeight);
	};

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

	async function runAction(action: 'start' | 'stop' | 'restart') {
		if (busy) return;
		busy = action;
		output = [];
		pushLine(`$ systemctl --user ${action} …`, 'cmd');
		try {
			const res = await fetch(`${api}/action/${action}?kind=pod`, { method: 'POST' });
			if (!res.ok) {
				pushLine(`Fehler: ${res.status} ${await res.text()}`, 'err');
				return;
			}
			await readSse(res, (event, line) => {
				if (event === 'exit') pushLine(line === '0' ? '— fertig —' : `— beendet mit Exit ${line} —`, line === '0' ? 'dim' : 'err');
				else pushLine(line);
			});
		} catch (e) {
			pushLine(`Verbindung abgebrochen: ${e}`, 'err');
		} finally {
			busy = null;
			await refreshAll();
		}
	}

	async function toggleLogs(containerName: string) {
		if (logSource?.container === containerName) {
			logSource.abort.abort();
			logSource = null;
			output = [];
			return;
		}
		logSource?.abort.abort();
		const abort = new AbortController();
		logSource = { container: containerName, abort };
		output = [];
		pushLine(`── Logs: ${containerName} ──`, 'cmd');
		try {
			const res = await fetch(`${api}/logs/${encodeURIComponent(containerName)}?tail=200&kind=pod`, {
				signal: abort.signal
			});
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

	// Live-Werte wie auf der Stack-Seite: nur bei sichtbarem, bedientem Tab
	const POLL_MS = 5_000;
	const MAX_BACKOFF_MS = 60_000;
	const IDLE_MS = 10 * 60_000;
	let livePaused = $state(false);
	const live = { resume: () => {} };

	$effect(() => {
		containers = data.containers;
		if (data.agentOffline) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let delay = POLL_MS;
		let lastActivity = Date.now();
		const schedule = (ms: number) => {
			clearTimeout(timer);
			if (!stopped) timer = setTimeout(tick, ms);
		};
		const tick = async () => {
			if (stopped || document.hidden) return;
			if (Date.now() - lastActivity > IDLE_MS) {
				livePaused = true;
				return;
			}
			try {
				const res = await fetch(`${api}/status?kind=pod`);
				if (stopped) return;
				if (!res.ok) throw new Error(String(res.status));
				const body = await res.json();
				containers = body.containers;
				const map: Record<string, { cpu: string; mem: string }> = {};
				for (const st of body.stats) map[st.Name] = { cpu: st.CPUPerc, mem: st.MemUsage };
				stats = map;
				delay = POLL_MS;
			} catch {
				delay = Math.min(delay * 2, MAX_BACKOFF_MS);
			}
			schedule(delay);
		};
		live.resume = () => {
			lastActivity = Date.now();
			if (livePaused) {
				livePaused = false;
				delay = POLL_MS;
				schedule(0);
			}
		};
		const onVisibility = () => {
			if (document.hidden) clearTimeout(timer);
			else {
				live.resume();
				if (!livePaused) schedule(0);
			}
		};
		const onActivity = () => {
			lastActivity = Date.now();
		};
		document.addEventListener('visibilitychange', onVisibility);
		const activityEvents = ['pointerdown', 'keydown', 'scroll', 'focus'] as const;
		for (const ev of activityEvents) window.addEventListener(ev, onActivity, { passive: true });
		tick();
		return () => {
			stopped = true;
			clearTimeout(timer);
			document.removeEventListener('visibilitychange', onVisibility);
			for (const ev of activityEvents) window.removeEventListener(ev, onActivity);
		};
	});

	function fmtSize(raw: string): string {
		return raw.replace(/(\d+(?:\.\d+)?)\s*([KMGT]i?B|[kMGT]B|B)/g, (_, num, unit) => {
			const n = parseFloat(num);
			const rounded = n >= 100 ? Math.round(n).toString() : n.toFixed(n >= 10 ? 1 : 2);
			return rounded.replace(/\.?0+$/, '').replace('.', ',') + ' ' + unit;
		});
	}
	function fmtCpu(raw: string): string {
		const n = parseFloat(raw);
		if (Number.isNaN(n)) return raw;
		return n.toFixed(n >= 10 ? 0 : 1).replace('.', ',') + ' %';
	}
	function stateDot(state: string, health?: string): string {
		if (health === 'unhealthy') return 'unhealthy';
		if (state === 'running') return 'running';
		if (state === 'exited' || state === 'dead' || state === 'stopped') return 'stopped';
		return 'partial';
	}
	// Podman (wie Docker) hängt den Health-Zustand an den Status-Text — er wird
	// daneben farbig angezeigt und soll nicht doppelt dastehen.
	const statusText = (s: string) => s.replace(/\s*\((healthy|unhealthy|starting|health: starting)\)/, '');

	// ── Quadlet-Dateien ───────────────────────────────────────────────────
	// Eine Datei ist ausgewählt; der Editor hält ihren Entwurf. Nach dem
	// Speichern lädt die Seite neu und der Editor übernimmt den Serverstand —
	// außer der Agent hat abgelehnt, dann bleibt das Getippte stehen.
	let selected = $state<string | null>(null);
	let editorContent = $state('');
	let newFile = $state('');
	let showNew = $state(false);
	let showDanger = $state(false);
	let confirmName = $state('');
	const current = $derived(data.files.find((f) => f.name === selected) ?? null);
	const podFileName = $derived(data.files.find((f) => f.name.endsWith('.pod'))?.name ?? '');
	const isNew = $derived(selected !== null && !current);
	const podStopped = $derived(!data.containers.some((c) => c.State === 'running' || c.State === 'restarting'));
	const NEW_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.(container|network|volume|image|build|env)$/;

	function template(name: string): string {
		const base = name.replace(/\.[^.]+$/, '');
		if (name.endsWith('.container'))
			return `[Container]\nContainerName=${base}\nImage=docker.io/library/IMAGE:TAG\n${podFileName ? `Pod=${podFileName}\n` : ''}AutoUpdate=registry\n`;
		if (name.endsWith('.volume')) return `[Volume]\n`;
		if (name.endsWith('.network')) return `[Network]\n`;
		if (name.endsWith('.image')) return `[Image]\nImage=docker.io/library/IMAGE:TAG\n`;
		if (name.endsWith('.build')) return `[Build]\nImageTag=localhost/${base}\nSetWorkingDirectory=unit\n`;
		if (name.endsWith('.env')) return `# Einbinden mit EnvironmentFile=%h/.config/containers/systemd/…/${name}\n`;
		return '';
	}

	function select(name: string) {
		selected = name;
		const f = data.files.find((x) => x.name === name);
		editorContent = f?.content ?? (f ? '' : template(name));
	}

	// Auswahl beim ersten Laden und Abgleich nach jedem Neuladen. Läuft nur,
	// wenn Serverstand (data.files) oder Formularantwort sich ändern — nicht
	// beim Klick auf einen Reiter (untrack), sonst würde Getipptes überschrieben.
	$effect(() => {
		const files = data.files;
		const f0 = form;
		untrack(() => {
			const failedHere = f0 && 'saveError' in f0 && f0.fileName === selected;
			if (failedHere) {
				if ('content' in f0 && typeof f0.content === 'string') editorContent = f0.content;
				return;
			}
			if (f0 && 'secretLoaded' in f0 && f0.fileName === selected) {
				editorContent = f0.content ?? '';
				return;
			}
			const f = files.find((x) => x.name === selected);
			if (!f) {
				// gelöscht, neu angelegt oder erster Aufruf
				const first = files.find((x) => !x.secret) ?? files[0];
				if (first) select(first.name);
				return;
			}
			if (f.content !== null) editorContent = f.content;
		});
	});

	function addFile() {
		const name = newFile.trim();
		if (!NEW_FILE_RE.test(name) || data.files.some((f) => f.name === name)) return;
		select(name);
		showNew = false;
		newFile = '';
	}

	const secretLocked = $derived(
		current?.secret && current.content === null && !(form && 'secretLoaded' in form && form.fileName === selected)
	);
</script>

<h1>
	{data.name}
	<small class="badge">Pod</small>
	<small style="color: var(--color-text-dim); font-weight: 400;">{t('stack.onServer', { server: data.server.name })}</small>
</h1>
<p style="display: flex; gap: var(--space-3);">
	<a href="/">{t('stack.backToOverview')}</a>
	{#if data.server.sshUrl}
		<a href={data.server.sshUrl} style="margin-left: auto;">{t('stack.openTerminal')}</a>
	{/if}
</p>

{#if data.agentOffline}
	<div class="alert-error" role="alert">{t('pod.agentOffline')}</div>
{/if}

<div class="card" style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--space-2);">
	<button disabled={!!busy || data.agentOffline} onclick={() => runAction('start')}>start</button>
	<button disabled={!!busy || data.agentOffline} onclick={() => runAction('restart')}>restart</button>
	<button
		disabled={!!busy || data.agentOffline}
		style="background: transparent; color: var(--color-crit); border: 1px solid var(--color-crit);"
		onclick={() => confirm(t('pod.confirmStop', { name: data.name })) && runAction('stop')}
	>stop</button>
</div>

{#if output.length > 0}
	<div class="term" bind:this={outputEl}>{#each output as line}<span class="term-line {line.cls}">{line.text + '\n'}</span>{/each}</div>
{/if}

<div class="card">
	<strong>{t('stack.services')}</strong>
	{#if livePaused}
		<button
			onclick={() => live.resume()}
			style="display: block; width: 100%; margin-top: var(--space-2); background: transparent; color: var(--color-text-dim); border: 1px dashed var(--color-border);"
		>
			{t('stack.livePaused')}
		</button>
	{/if}
	{#if containers.length === 0}
		<p style="color: var(--color-text-dim);">{t('pod.noContainers')}</p>
	{:else}
		<ul style="list-style: none; padding: 0; margin: var(--space-2) 0 0;">
			{#each containers as c (c.Name)}
				<li style="padding: var(--space-2) 0; border-top: 1px solid var(--color-border); display: flex; align-items: center; gap: var(--space-2);">
					<span class="dot {stateDot(c.State, c.Health)}"></span>
					<span style="flex: 1;">
						{c.Service}
						<small style="color: var(--color-text-dim); display: block;">
							{statusText(c.Status)}{#if c.Health}
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
						{logSource?.container === c.Name ? t('stack.stopLogs') : t('stack.logs')}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<div class="card">
	<strong>{t('pod.files')}</strong>
	{#if data.path}<small style="color: var(--color-text-dim); display: block; overflow-wrap: anywhere;"><code>{data.path}</code></small>{/if}

	{#if data.filesError}
		<div class="alert-error" role="alert" style="margin-top: var(--space-2);">{t('pod.filesUnavailable', { msg: data.filesError })}</div>
	{:else if !data.agentOffline}
		<form method="POST" action="?/toggleGit" use:enhance style="margin: var(--space-2) 0; display: flex; align-items: center; gap: var(--space-2);">
			<button style="width: auto; flex-shrink: 0; white-space: nowrap; min-height: 36px; padding: var(--space-1) var(--space-3); background: transparent; color: {data.gitTracking ? 'var(--color-ok)' : 'var(--color-text-dim)'}; border: 1px solid currentColor;">
				{data.gitTracking ? t('stack.gitOn') : t('stack.gitOff')}
			</button>
			<small style="color: var(--color-text-dim);">
				{t('pod.gitHint')}
				<a href="/settings/git">{t('stack.gitSetUp')}</a>
			</small>
		</form>

		<div style="display: flex; flex-wrap: wrap; gap: var(--space-2); margin: var(--space-2) 0 var(--space-3);">
			{#each data.files as f (f.name)}
				<button
					class="file-tab"
					class:active={selected === f.name}
					onclick={() => select(f.name)}
				>{f.name}{#if f.secret}&nbsp;🔒{/if}</button>
			{/each}
			{#if isNew && selected}
				<button class="file-tab active">{selected} <small>({t('pod.newFileBadge')})</small></button>
			{/if}
			<button class="file-tab" style="border-style: dashed;" onclick={() => (showNew = !showNew)}>+ {t('pod.addFile')}</button>
		</div>

		{#if showNew}
			<div style="display: flex; gap: var(--space-2); margin-bottom: var(--space-3); align-items: center;">
				<input
					bind:value={newFile}
					placeholder="redis.container"
					autocomplete="off"
					onkeydown={(e) => e.key === 'Enter' && addFile()}
					style="flex: 1;"
				/>
				<button
					style="width: auto;"
					disabled={!NEW_FILE_RE.test(newFile.trim()) || data.files.some((f) => f.name === newFile.trim())}
					onclick={addFile}
				>{t('common.add')}</button>
			</div>
			<small style="color: var(--color-text-dim); display: block; margin-top: calc(-1 * var(--space-2)); margin-bottom: var(--space-3);">{t('pod.addFileHint')}</small>
		{/if}

		{#if form && 'saveError' in form && form.saveError && form.fileName === selected}
			<div class="alert-error" role="alert" style="white-space: pre-wrap; overflow-wrap: anywhere;">{form.saveError}</div>
		{/if}
		{#if form && ('saved' in form || 'fileDeleted' in form)}
			<div role="status" style="margin-bottom: var(--space-2);">
				<p style="color: var(--color-ok); margin: 0;">
					{#if 'fileDeleted' in form}{t('pod.fileDeleted', { file: form.fileDeleted ?? '' })}{:else}{t('pod.fileSaved', { file: form.fileName ?? '', committed: 'committed' in form && form.committed ? t('stack.andCommitted') : '' })}{/if}
					{#if form.restartNeeded}{t('pod.restartToApply')}{/if}
				</p>
				{#if form.restartNeeded}
					<button style="width: auto; margin-top: var(--space-1);" disabled={!!busy} onclick={() => runAction('restart')}>restart</button>
				{/if}
				{#if 'reloadError' in form && form.reloadError}<p style="color: var(--color-warn); margin: var(--space-1) 0 0;">{form.reloadError}</p>{/if}
				{#if form.gitError}<p style="color: var(--color-warn); margin: var(--space-1) 0 0;">{t('stack.gitNote', { msg: form.gitError })}</p>{/if}
				{#if form.warnings && form.warnings.length > 0}
					<details style="margin-top: var(--space-1);">
						<summary style="cursor: pointer; color: var(--color-warn);">{t('pod.warnings', { n: form.warnings.length })}</summary>
						<ul style="margin: var(--space-1) 0 0; padding-left: var(--space-4); color: var(--color-text-dim); font-size: 0.85rem;">
							{#each form.warnings as w}<li style="overflow-wrap: anywhere;">{w}</li>{/each}
						</ul>
					</details>
				{/if}
			</div>
		{/if}

		{#if selected}
			{#if secretLocked}
				<form method="POST" action="?/loadFile" use:enhance={() => async ({ update }) => update({ reset: false })}>
					<input type="hidden" name="fileName" value={selected} />
					<p style="color: var(--color-text-dim);">{t('pod.secretHidden')}</p>
					<button style="width: auto;">{t('pod.showSecret')}</button>
				</form>
			{:else}
				<form method="POST" action="?/saveFile" use:enhance={() => async ({ update }) => update({ reset: false })}>
					<input type="hidden" name="fileName" value={selected} />
					<CodeEditor name="content" bind:value={editorContent} fileName={selected} rows={14} />
					<div style="display: flex; gap: var(--space-2); margin-top: var(--space-2);">
						<button disabled={data.agentOffline} style="flex: 1;">{isNew ? t('pod.createFile') : t('common.save')}</button>
					</div>
				</form>
				{#if !isNew}
					<form
						method="POST"
						action="?/deleteFile"
						use:enhance={({ cancel }) => {
							if (!confirm(t('pod.confirmDeleteFile', { file: selected ?? '' }))) cancel();
							return async ({ update }) => update({ reset: false });
						}}
						style="margin-top: var(--space-2);"
					>
						<input type="hidden" name="fileName" value={selected} />
						<button style="width: auto; background: transparent; color: var(--color-crit); border: 1px solid var(--color-crit); min-height: 36px; padding: var(--space-1) var(--space-3);">{t('pod.deleteFile')}</button>
					</form>
				{:else}
					<button
						style="width: auto; margin-top: var(--space-2); background: transparent; color: var(--color-text-dim); border: none;"
						onclick={() => { const first = data.files[0]; if (first) select(first.name); }}
					>{t('common.cancel')}</button>
				{/if}
			{/if}
		{/if}
		<small style="color: var(--color-text-dim); display: block; margin-top: var(--space-3);">{t('pod.editHint', { version: data.server.podmanVersion ?? '' })}</small>
	{/if}
</div>

<div class="card" style="margin-top: var(--space-6); border-color: var(--color-border);">
	{#if !showDanger}
		<button
			onclick={() => (showDanger = true)}
			style="background: transparent; color: var(--color-text-dim); border: 1px dashed var(--color-border);"
		>{t('pod.deleteOpen')}</button>
	{:else}
		<strong style="color: var(--color-crit);">{t('pod.deleteTitle')}</strong>
		{#if !podStopped}
			<p style="color: var(--color-text-dim);">{t('pod.deleteOnlyStopped')}</p>
		{:else}
			<p style="color: var(--color-text-dim);">{t('pod.deleteHint', { name: data.name })}</p>
			{#if form && 'deleteError' in form && form.deleteError}<div class="alert-error" role="alert">{form.deleteError}</div>{/if}
			<form method="POST" action="?/deletePod" use:enhance>
				<label for="confirmName">{t('stack.deleteConfirmLabel', { name: data.name })}</label>
				<input id="confirmName" name="confirmName" bind:value={confirmName} autocomplete="off" placeholder={data.name} />
				<button disabled={confirmName !== data.name} style="background: var(--color-crit);">{t('stack.deleteConfirmBtn')}</button>
			</form>
		{/if}
		<button onclick={() => (showDanger = false)} style="background: transparent; color: var(--color-text-dim); border: none; margin-top: var(--space-2);">{t('common.cancel')}</button>
	{/if}
</div>

<style>
	.file-tab {
		width: auto;
		min-height: 36px;
		padding: var(--space-1) var(--space-3);
		background: transparent;
		color: var(--color-primary);
		border: 1px solid var(--color-primary);
	}
	.file-tab.active {
		background: var(--color-primary);
		color: var(--color-primary-text);
	}
	.badge {
		font-size: 0.75rem;
		font-weight: 400;
		padding: 0 var(--space-1);
		border: 1px solid var(--color-border);
		border-radius: 4px;
		color: var(--color-text-dim);
		vertical-align: middle;
	}
</style>
