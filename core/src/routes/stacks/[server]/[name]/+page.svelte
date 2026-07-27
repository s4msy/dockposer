<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	let { data, form }: { data: PageData; form: ActionData } = $props();

	let output = $state<string[]>([]);
	let busy = $state<string | null>(null);
	let logSource = $state<{ container: string; abort: AbortController } | null>(null);
	let editorContent = $state(data.compose?.content ?? '');
	let outputEl = $state<HTMLElement | null>(null);
	let containers = $state(data.containers);
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

	// SSE-Zeilen aus einem fetch-Stream lesen (POST → kein EventSource möglich)
	async function readSse(res: Response, onLine: (line: string) => void) {
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
				for (const line of part.split('\n')) {
					if (line.startsWith('data: ')) onLine(line.slice(6));
				}
			}
		}
	}

	async function runAction(action: string) {
		if (busy) return;
		busy = action;
		output = [`$ docker compose ${action}`];
		try {
			const res = await fetch(`/api/agent/${data.server.id}/${encodeURIComponent(data.name)}/action/${action}`, {
				method: 'POST'
			});
			if (!res.ok) {
				output = [...output, `Fehler: ${res.status} ${await res.text()}`];
				return;
			}
			await readSse(res, (line) => {
				output = [...output, line];
				outputEl?.scrollTo(0, outputEl.scrollHeight);
			});
		} catch (e) {
			output = [...output, `Verbindung abgebrochen: ${e}`];
		} finally {
			busy = null;
			await invalidateAll();
		}
	}

	async function toggleLogs(containerName: string) {
		if (logSource?.container === containerName) {
			logSource.abort.abort();
			logSource = null;
			return;
		}
		logSource?.abort.abort();
		const abort = new AbortController();
		logSource = { container: containerName, abort };
		output = [`── Logs: ${containerName} ──`];
		try {
			const res = await fetch(
				`/api/agent/${data.server.id}/${encodeURIComponent(data.name)}/logs/${encodeURIComponent(containerName)}?tail=200`,
				{ signal: abort.signal }
			);
			if (!res.ok) {
				output = [...output, `Fehler: ${res.status}`];
				return;
			}
			await readSse(res, (line) => {
				output = [...output, line];
				if (output.length > 2000) output = output.slice(-1500); // Speicher-Deckel
				outputEl?.scrollTo(0, outputEl.scrollHeight);
			});
		} catch {
			/* abort ist der Normalfall */
		}
	}

	function stateDot(state: string): string {
		if (state === 'running') return 'running';
		if (state === 'exited' || state === 'dead') return 'stopped';
		return 'partial';
	}
</script>

<h1>
	{data.name}
	<small style="color: var(--color-text-dim); font-weight: 400;">auf {data.server.name}</small>
</h1>
<p><a href="/">← Übersicht</a></p>

{#if data.agentOffline}
	<div class="alert-error" role="alert">Agent nicht erreichbar — Anzeige ggf. veraltet, Aktionen deaktiviert.</div>
{/if}

<div class="card" style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2);">
	<button disabled={!!busy || data.agentOffline} onclick={() => runAction('up')}>up -d</button>
	<button disabled={!!busy || data.agentOffline} onclick={() => runAction('restart')}>restart</button>
	<button disabled={!!busy || data.agentOffline} onclick={() => runAction('pull')}>pull</button>
	<button
		disabled={!!busy || data.agentOffline}
		style="background: transparent; color: var(--color-crit); border: 1px solid var(--color-crit);"
		onclick={() => confirm(`Stack „${data.name}" wirklich stoppen?`) && runAction('down')}
	>down</button>
</div>

{#if containers.length > 0}
	<div class="card">
		<strong>Services</strong>
		<ul style="list-style: none; padding: 0; margin: var(--space-2) 0 0;">
			{#each containers as c (c.Name)}
				<li style="padding: var(--space-2) 0; border-top: 1px solid var(--color-border); display: flex; align-items: center; gap: var(--space-2);">
					<span class="dot {stateDot(c.State)}"></span>
					<span style="flex: 1;">
						{c.Service}
						<small style="color: var(--color-text-dim); display: block;">{c.Status}{c.Health ? ` · ${c.Health}` : ''}</small>
						{#if stats[c.Name]}
							<small style="color: var(--color-text-dim); display: block;">CPU {stats[c.Name].cpu} · RAM {stats[c.Name].mem}</small>
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
	<div
		class="card"
		bind:this={outputEl}
		style="font-family: ui-monospace, monospace; font-size: 0.8rem; max-height: 40dvh; overflow: auto; white-space: pre-wrap; word-break: break-all;"
	>{#each output as line}{line + '\n'}{/each}</div>
{/if}

{#if data.compose}
	<div class="card">
		<strong>{data.compose.file}</strong>
		{#if data.compose.env_files.length > 0}
			<small style="color: var(--color-text-dim); display: block;">
				.env-Dateien (bleiben auf dem Server): {data.compose.env_files.join(', ')}
			</small>
		{/if}

		{#if form?.saveError}<div class="alert-error" role="alert" style="margin-top: var(--space-2);">{form.saveError}</div>{/if}
		{#if form?.saved}<p role="status" style="color: var(--color-ok);">Gespeichert. „up -d" zum Anwenden.</p>{/if}

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
{/if}
