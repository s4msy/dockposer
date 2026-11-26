<script lang="ts">
	import type { PageData } from './$types';
	import { refreshAll } from '$app/navigation';
	import { page } from '$app/state';
	import { translator } from '#lib/i18n/index.ts';
	let { data }: { data: PageData } = $props();
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
	<small style="color: var(--color-text-dim);">{t('pod.phaseHint', { version: data.server.podmanVersion ?? '' })}</small>
</div>

<style>
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
