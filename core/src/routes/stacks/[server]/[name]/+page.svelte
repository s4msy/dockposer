<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { translator } from '$lib/i18n';
	import CodeEditor from '$lib/components/CodeEditor.svelte';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	const t = $derived(translator(page.data.locale ?? 'en'));

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
	const driftServices = $derived.by(() => {
		try {
			return JSON.parse(data.stack?.driftServicesJson ?? '[]') as string[];
		} catch {
			return [];
		}
	});
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
							pushLine(changed > 0 ? `── Ergebnis: Erfolg, ${changed} Service(s) aktualisiert ──` : '── ' + t('stack.updates') + ': ' + t('stack.policySaved') + ' ──', 'ok');
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
	<small style="color: var(--color-text-dim); font-weight: 400;">{t('stack.onServer', { server: data.server.name })}</small>
</h1>
<p style="display: flex; gap: var(--space-3);">
	<a href="/">{t('stack.backToOverview')}</a>
	{#if data.server.sshUrl}
		<a href={data.server.sshUrl} style="margin-left: auto;">{t('stack.openTerminal')}</a>
		<button
			style="width: auto; min-height: 0; padding: 0 var(--space-2); background: transparent; color: var(--color-primary); border: 1px solid var(--color-primary); font-size: 0.8rem;"
			title={t('stack.copySshHint')}
			onclick={() => {
				// ssh://user@host:2222 → „ssh -p 2222 user@host"
				const rest = data.server.sshUrl!.slice(6);
				const m = rest.match(/^(.*?)(?::(\d{1,5}))?$/);
				const cmd = m?.[2] ? `ssh -p ${m[2]} ${m[1]}` : `ssh ${rest}`;
				navigator.clipboard.writeText(cmd);
				sshCopied = true;
				setTimeout(() => (sshCopied = false), 2000);
			}}
		>{sshCopied ? '✓ ' + t('stack.copied') : '⧉'}</button>
	{/if}
</p>

{#if data.agentOffline}
	<div class="alert-error" role="alert">{t('stack.agentOffline')}</div>
{/if}

{#if data.stack?.drift}
	<div class="card" style="border-left: 4px solid var(--color-warn);" role="status">
		<strong>{t('stack.driftTitle')}</strong>
		{#if driftServices.length > 0}
			<p style="margin: var(--space-1) 0 0;">{t('stack.driftServices', { services: driftServices.join(', ') })}</p>
		{/if}
		<p style="margin: var(--space-1) 0 0; color: var(--color-text-dim);">{t('stack.driftHint')}</p>

		<form method="POST" action="?/driftDetails" use:enhance style="margin-top: var(--space-2);">
			<button style="width: auto; min-height: 36px; padding: var(--space-1) var(--space-3); background: transparent; color: var(--color-primary); border: 1px solid var(--color-primary);">
				{t('stack.driftWhy')}
			</button>
		</form>

		{#if form?.driftError}<div class="alert-error" role="alert" style="margin-top: var(--space-2);">{form.driftError}</div>{/if}

		{#if form?.driftDebug}
			{@const d = form.driftDebug}
			<div style="margin-top: var(--space-3); font-size: 0.85rem;">
				<strong>{t('stack.driftDiag')}</strong>
				<dl style="display: grid; grid-template-columns: auto 1fr; gap: var(--space-1) var(--space-3); margin: var(--space-2) 0;">
					<dt style="color: var(--color-text-dim);">{t('stack.driftAgentVersion')}</dt><dd style="margin: 0;"><code>{d.agent_version}</code></dd>
					<dt style="color: var(--color-text-dim);">{t('stack.driftFilesNewer')}</dt>
					<dd style="margin: 0; color: {d.files_newer ? 'var(--color-warn)' : 'var(--color-ok)'};">
						{d.files_newer ? t('stack.driftYes') : t('stack.driftNo')}
					</dd>
					<dt style="color: var(--color-text-dim);">{t('stack.driftNewestFile')}</dt>
					<dd style="margin: 0;">{d.newest_file_mtime ? new Date(d.newest_file_mtime).toLocaleString(page.data.locale ?? 'en') : '—'}</dd>
					<dt style="color: var(--color-text-dim);">{t('stack.driftOldestContainer')}</dt>
					<dd style="margin: 0;">{d.oldest_container ? new Date(d.oldest_container).toLocaleString(page.data.locale ?? 'en') : '—'}</dd>
					{#if d.compose_verdict}
						<dt style="color: var(--color-text-dim);">{t('stack.driftComposeVerdict')}</dt>
						<dd style="margin: 0;">{d.compose_verdict}</dd>
					{/if}
					<dt style="color: var(--color-text-dim);">{t('stack.driftReason')}</dt><dd style="margin: 0;">{d.reason}</dd>
				</dl>

				<table style="width: 100%; border-collapse: collapse; font-family: ui-monospace, monospace; font-size: 0.75rem;">
					<thead>
						<tr style="text-align: left; color: var(--color-text-dim);">
							<th style="padding: var(--space-1) 0;">Service</th>
							<th>{t('stack.driftExpected')}</th>
							<th>{t('stack.driftActual')}</th>
						</tr>
					</thead>
					<tbody>
						{#each Object.keys({ ...d.expected_hashes, ...d.actual_hashes }).sort() as svc (svc)}
							{@const exp = d.expected_hashes[svc] ?? ''}
							{@const act = d.actual_hashes[svc] ?? ''}
							<tr style="border-top: 1px solid var(--color-border); color: {exp && act && exp !== act ? 'var(--color-warn)' : 'inherit'};">
								<td style="padding: var(--space-1) 0;">{svc}</td>
								<td>{exp ? exp.slice(0, 12) : '—'}</td>
								<td>{act ? act.slice(0, 12) : '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
{/if}

{#if data.compose?.pinned}
	<div class="card" style="border-left: 4px solid var(--color-warn);" role="alert">
		<strong>{t('stack.pinnedTitle')}</strong>
		<p style="margin: var(--space-1) 0 0; color: var(--color-text-dim);">
			{t('stack.pinnedHint', { file: '.dockposer-rollback.yaml' })}
		</p>

		{#if form?.pinError}<div class="alert-error" role="alert">{form.pinError}</div>{/if}
		{#if form?.pinRemoved !== undefined}
			<p role="status" style="color: var(--color-ok);">
				{form.pinRemoved ? t('stack.pinRemoved') : t('stack.pinNone')}
			</p>
		{/if}
		<form method="POST" action="?/removePin" use:enhance style="margin-top: var(--space-2);">
			<button style="width: auto; min-height: 36px; padding: var(--space-1) var(--space-3); background: transparent; color: var(--color-primary); border: 1px solid var(--color-primary);">
				{t('stack.pinRemove')}
			</button>
		</form>
	</div>
{/if}

<div class="card" style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--space-2);">
	<button disabled={!!busy || data.agentOffline} onclick={() => runAction('up')}>up -d</button>
	<button disabled={!!busy || data.agentOffline} onclick={() => runAction('restart')}>restart</button>
	<button
		disabled={!!busy || data.agentOffline}
		style="background: transparent; color: var(--color-crit); border: 1px solid var(--color-crit);"
		onclick={() => confirm(t('stack.confirmDown', { name: data.name })) && runAction('down')}
	>down</button>
</div>

<div class="card">
	<strong>{t('stack.updates')}</strong>
	{#if form?.checkError}<div class="alert-error" role="alert">{form.checkError}</div>{/if}

	{#if data.updates.length > 0}
		<ul style="list-style: none; padding: 0; margin: var(--space-2) 0;">
			{#each data.updates as u (u.service)}
				<li style="padding: var(--space-1) 0; display: flex; gap: var(--space-2); align-items: baseline;">
					{#if u.status === 'update'}<span style="color: var(--color-warn); font-weight: 700;">↑</span>
					{:else if u.status === 'current'}<span style="color: var(--color-ok);">✓</span>
					{:else if u.status === 'pinned'}<span style="color: var(--color-text-dim);">🔒</span>
					{:else}<span style="color: var(--color-text-dim);">?</span>{/if}
					<span style="flex: 1;">
						{u.service} <small style="color: var(--color-text-dim);">{u.image}</small>
						{#if u.status === 'pinned' || u.image?.includes('@sha256:')}
							<small style="color: var(--color-text-dim);">· {t('stack.pinnedService')}</small>
						{/if}
						{#if u.status === 'update'}
							<small style="display: block; color: var(--color-text-dim);">{u.current.slice(7, 19)} → {u.latest.slice(7, 19)}</small>
						{:else if u.status === 'pinned' && u.newer}
							<small style="display: block; color: var(--color-text-dim);">
								{t('stack.pinnedNewer')} <span style="white-space: nowrap;">{u.current.slice(7, 19)} → {u.latest.slice(7, 19)}</span>
							</small>
						{:else if u.status === 'unknown'}
							<small style="display: block; color: var(--color-text-dim);">
								{#if u.authRequired && u.host}
									{t('stack.checkImpossibleAuth')}
									<a href="/settings/registries">{t('stack.addCredentials', { host: u.host })}</a>
								{:else if u.host}
									{t('stack.checkImpossibleHost', { host: u.host })}
								{:else}
									{t('stack.checkImpossibleLocal')}
								{/if}
							</small>
						{/if}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
	{#if data.updates.length > 0 && data.updates.every((u: { status?: string; image?: string }) => u.status === 'pinned' || u.image?.includes('@sha256:'))}
		<p style="color: var(--color-warn);">{t('stack.allPinned')}</p>
	{/if}
	{#if data.lastUpdateCheck}
		<small style="color: var(--color-text-dim); display: block; margin-bottom: var(--space-2);">
			{t('stack.lastCheck', { date: new Date(data.lastUpdateCheck).toLocaleString(page.data.locale ?? 'en') })}
		</small>
	{/if}

	<div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2);">
		<form method="POST" action="?/checkUpdates" use:enhance>
			<button style="background: transparent; color: var(--color-primary); border: 1px solid var(--color-primary);" disabled={data.agentOffline}>{t('stack.checkUpdates')}</button>
		</form>
		<button disabled={!!busy || data.agentOffline} onclick={() => runAction('update')}>{t('stack.runUpdate')}</button>
	</div>

	<form method="POST" action="?/setPolicy" use:enhance style="margin-top: var(--space-3); display: flex; gap: var(--space-2); align-items: center;">
		<label for="policy" style="margin: 0; flex: 1;">{t('stack.updatePolicy')}</label>
		<select id="policy" name="policy" value={data.updatePolicy} style="font: inherit; padding: var(--space-2); border-radius: var(--radius); border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text);">
			<option value="manual">{t('stack.policyManual')}</option>
			<option value="auto">{t('stack.policyAuto')}</option>
		</select>
		<button style="width: auto;">OK</button>
	</form>
	{#if form?.policySaved}<small role="status" style="color: var(--color-ok);">{t('stack.policySaved')}</small>{/if}
</div>

<details class="card">
	<summary style="cursor: pointer; min-height: 44px; display: flex; align-items: center;">
		<strong>{t('stack.history')}</strong>
		{#if data.history.length > 0}
			<small style="color: var(--color-text-dim); margin-left: var(--space-2);">({data.history.length})</small>
		{/if}
	</summary>

	{#if data.history.length === 0}
		<p style="color: var(--color-text-dim);">{t('stack.historyEmpty')}</p>
	{:else}
		<ul style="list-style: none; padding: 0; margin: var(--space-2) 0 0;">
			{#each data.history as run (run.id)}
				<li style="padding: var(--space-2) 0; border-top: 1px solid var(--color-border);">
					<div style="display: flex; align-items: baseline; gap: var(--space-2);">
						<span class="dot {run.result === 'success' ? 'running' : run.result === 'rolled_back' ? 'partial' : 'stopped'}"></span>
						<span style="flex: 1;">
							{run.result === 'success'
								? t('stack.resultSuccess')
								: run.result === 'rolled_back'
									? t('stack.resultRolledBack')
									: t('stack.resultFailed')}
							<small style="color: var(--color-text-dim);">
								· {run.trigger === 'policy' ? t('stack.triggerPolicy') : t('stack.triggerManual')}
							</small>
							<small style="display: block; color: var(--color-text-dim);">
								{new Date(run.startedAt).toLocaleString(page.data.locale ?? 'en')}
								{#if run.finishedAt}
									· {t('stack.historyDuration', {
										seconds: Math.max(0, Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000))
									})}
								{/if}
							</small>
							<small style="display: block; color: var(--color-text-dim);">
								{run.changed.length > 0
									? t('stack.historyChanged', { services: run.changed.join(', ') })
									: t('stack.historyNoChange')}
							</small>
						</span>
					</div>
					{#if run.logExcerpt}
						<details style="margin-top: var(--space-1);">
							<summary><small>{t('stack.historyLog')}</small></summary>
							<div class="term" style="max-height: 30dvh; margin-top: var(--space-2);">{run.logExcerpt}</div>
						</details>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</details>

{#if containers.length > 0}
	<div class="card">
		<strong>{t('stack.services')}</strong>
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
						{logSource?.container === c.Name ? t('stack.stopLogs') : t('stack.logs')}
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
				{t('stack.envFilesFound', { files: data.compose.env_files.join(', ') })}
			</small>
		{/if}

		<form method="POST" action="?/toggleGit" use:enhance style="margin: var(--space-2) 0; display: flex; align-items: center; gap: var(--space-2);">
			<button style="width: auto; min-height: 36px; padding: var(--space-1) var(--space-3); background: transparent; color: {data.gitTracking ? 'var(--color-ok)' : 'var(--color-text-dim)'}; border: 1px solid currentColor;">
				{data.gitTracking ? t('stack.gitOn') : t('stack.gitOff')}
			</button>
			<small style="color: var(--color-text-dim);">
				{t('stack.gitHint', { link: '' })}
				<a href="/settings/git">{t('stack.gitSetUp')}</a>
			</small>
		</form>

		{#if form?.saveError}<div class="alert-error" role="alert" style="margin-top: var(--space-2);">{form.saveError}</div>{/if}
		{#if form?.saved}
			<p role="status" style="color: var(--color-ok);">
				{t('stack.composeSaved', { committed: form.committed ? t('stack.andCommitted') : '' })}
				{#if form.gitError}<span style="color: var(--color-warn);"> {t('stack.gitNote', { msg: form.gitError })}</span>{/if}
			</p>
		{/if}

		<form method="POST" action="?/saveCompose" use:enhance={() => async ({ update }) => update({ reset: false })}>
			<CodeEditor
				name="content"
				bind:value={editorContent}
				fileName={data.compose.file}
				rows={18}
			/>
			<button style="margin-top: var(--space-2);" disabled={data.agentOffline}>{t('stack.saveCompose')}</button>
		</form>
	</div>

	<details class="card" bind:open={envOpen}>
		<summary style="cursor: pointer; min-height: 44px; display: flex; align-items: center;">
			<strong>{t('stack.configFiles')}</strong>
		</summary>

		{#if data.editableFiles.length === 0}
			<p style="color: var(--color-text-dim);">
				{t('stack.noEditableFiles')}
				{#if data.allowedPatterns.length > 0}
					{t('stack.allowedOnServer', { list: data.allowedPatterns.join(', ') })}
				{/if}
				<br />{t('stack.editableHint', { var: 'DOCKPOSER_EDITABLE_FILES' })}
			</p>
		{:else}
			<p style="color: var(--color-text-dim); font-size: 0.85rem;">
				{t('stack.allowed', { list: data.allowedPatterns.join(', '), var: 'DOCKPOSER_EDITABLE_FILES' })}
				<strong>{t('stack.neverCommitted')}</strong>
			</p>

			{#if form?.fileError}<div class="alert-error" role="alert">{form.fileError}</div>{/if}
			{#if form?.fileSaved}
				<p role="status" style="color: var(--color-ok);">
					{t('stack.fileSaved', { file: form.fileName })}
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
					<label for="fileContent"><code>{form.fileName}</code>{#if !form.fileExists} — {t('stack.fileNotYet')}{/if}</label>
					<CodeEditor
						id="fileContent"
						name="fileContent"
						value={form.fileContent ?? ''}
						fileName={form.fileName}
						rows={12}
					/>
					<button style="margin-top: var(--space-2);" disabled={data.agentOffline}>{t('common.save')}</button>
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
		>{t('stack.deleteOpen')}</button>
	{:else}
		<strong style="color: var(--color-crit);">{t('stack.deleteTitle')}</strong>
		{#if !stackStopped}
			<p style="color: var(--color-text-dim);">{t('stack.deleteOnlyStopped')}</p>
		{:else}
			<p style="color: var(--color-text-dim);">
				{t('stack.deleteHint', { name: data.name })}
			</p>
			{#if form?.deleteError}<div class="alert-error" role="alert">{form.deleteError}</div>{/if}
			<form method="POST" action="?/deleteStack" use:enhance>
				<label for="confirmName">{t('stack.deleteConfirmLabel', { name: data.name })}</label>
				<input id="confirmName" name="confirmName" bind:value={confirmName} autocomplete="off" placeholder={data.name} />
				<button
					disabled={confirmName !== data.name}
					style="background: var(--color-crit);"
				>{t('stack.deleteConfirmBtn')}</button>
			</form>
		{/if}
		<button onclick={() => (showDanger = false)} style="background: transparent; color: var(--color-text-dim); border: none; margin-top: var(--space-2);">{t('common.cancel')}</button>
	{/if}
</div>
