// Alert-Engine: Herzstück von M2. Nimmt normalisierte Docker-Events entgegen,
// matcht sie gegen Regeln, dedupliziert und schreibt Alerts in die DB.
// Alles In-Memory-Zustandshaltung — bei Neustart des Core fangen Zähler bei
// null an, was für Crash-Loops (Minuten-Fenster) verschmerzbar ist.
import { db } from '$lib/server/db';
import { alertRules, alerts, servers, stacks, alertType } from '$lib/server/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { translator, type MessageKey } from '$lib/i18n';
import { isQuiet } from './quiet';

type AlertType = (typeof alertType)[number];
type Severity = 'info' | 'warning' | 'critical';

export interface DockerEvent {
	Action: string;
	Actor: { Attributes: Record<string, string> };
	time: number;
}

// Exit-Codes, die kein Alarm sind: 0 = sauber beendet, 143 = SIGTERM (compose down)
const CLEAN_EXITS = new Set([0, 143]);
const RESOLVE_STABLE_MS = 60_000; // Container läuft 60s → Exit-Alerts gelten als behoben

interface Thresholds {
	restarts: number;
	window_min: number;
	free_percent: number;
}

class AlertEngine {
	private dieTimes = new Map<string, number[]>();
	private suppressedProjects = new Map<string, number>();
	private resolveTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private rulesCache: { type: AlertType; enabled: boolean; thresholds: Partial<Thresholds> }[] = [];
	private rulesLoadedAt = 0;

	// ── Regeln (globale Defaults, Scope-Kaskade folgt später) ──
	async ensureDefaultRules() {
		// Additiv: fehlende Regel-Typen nachziehen (neue Releases bringen neue Typen mit)
		const defaults: { type: AlertType; thresholdJson?: string }[] = [
			{ type: 'crash_loop', thresholdJson: JSON.stringify({ restarts: 3, window_min: 5 }) },
			{ type: 'container_exit' },
			{ type: 'unhealthy' },
			{ type: 'oom_kill' },
			{ type: 'agent_offline' },
			{ type: 'disk_space', thresholdJson: JSON.stringify({ free_percent: 10 }) },
			{ type: 'pull_failed' },
			{ type: 'update_rolled_back' },
			{ type: 'update_success' },
			{ type: 'update_available' }
		];
		for (const def of defaults) {
			const [existing] = await db.select({ id: alertRules.id }).from(alertRules)
				.where(and(eq(alertRules.type, def.type), eq(alertRules.scope, 'global'))).limit(1);
			if (!existing) await db.insert(alertRules).values(def);
		}
	}

	// Bekannte Stack-Namen je Server, kurz gecacht. Ohne diesen Filter meldet
	// die Pipeline jeden Container des Hosts — auch CI-Job-Container oder Reste
	// anderer Tools, die Dockposer weder verwaltet noch beeinflussen kann.
	private stackNames = new Map<number, { names: Set<string>; loadedAt: number }>();

	private async managedProjects(serverId: number): Promise<Set<string>> {
		const cached = this.stackNames.get(serverId);
		if (cached && Date.now() - cached.loadedAt < 60_000) return cached.names;
		const rows = await db.select({ name: stacks.name }).from(stacks).where(eq(stacks.serverId, serverId));
		// Compose normalisiert Ordnernamen zu Projektnamen: klein, nur [a-z0-9_-]
		const names = new Set(rows.map((r) => r.name.toLowerCase().replace(/[^a-z0-9_-]/g, '')));
		this.stackNames.set(serverId, { names, loadedAt: Date.now() });
		return names;
	}

	/**
	 * Gehört der Container zu einem Stack, den Dockposer kennt?
	 *
	 * Ohne Compose-Projekt-Label ist er per `docker run` oder von einem anderen
	 * Werkzeug gestartet — nicht unsere Zuständigkeit. Ein unbekanntes Projekt
	 * kommt von Stacks außerhalb des Stacks-Ordners.
	 *
	 * Ausnahme: Solange für einen Server noch gar keine Stacks synchronisiert
	 * sind, wird nicht gefiltert — sonst bliebe es nach einem Neustart des Cores
	 * still, bis jemand die Übersicht öffnet.
	 */
	private async isManaged(serverId: number, project: string | undefined): Promise<boolean> {
		if (!project) return false;
		const known = await this.managedProjects(serverId);
		if (known.size === 0) return true;
		return known.has(project.toLowerCase());
	}

	private async rule(type: AlertType) {
		if (Date.now() - this.rulesLoadedAt > 30_000) {
			const rows = await db.select().from(alertRules).where(eq(alertRules.scope, 'global'));
			this.rulesCache = rows.map((r) => ({
				type: r.type,
				enabled: r.enabled,
				thresholds: r.thresholdJson ? JSON.parse(r.thresholdJson) : {}
			}));
			this.rulesLoadedAt = Date.now();
		}
		return this.rulesCache.find((r) => r.type === type);
	}

	/** Nach einem Sync aufrufen, damit neu angelegte Stacks sofort überwacht werden. */
	invalidateStackCache(serverId?: number) {
		if (serverId === undefined) this.stackNames.clear();
		else this.stackNames.delete(serverId);
	}

	// ── Suppression: eigene Aktionen (down/restart/up über Dockposer) lösen keine Alerts aus ──
	suppress(serverId: number, project: string, ms = 120_000) {
		this.suppressedProjects.set(`${serverId}:${project}`, Date.now() + ms);
	}

	private isSuppressed(serverId: number, project: string | undefined): boolean {
		if (!project) return false;
		const until = this.suppressedProjects.get(`${serverId}:${project}`);
		return !!until && Date.now() < until;
	}

	// ── Event-Verarbeitung ──
	async handleEvent(serverId: number, evt: DockerEvent) {
		const attrs = evt.Actor?.Attributes ?? {};
		const container = attrs['name'] ?? 'unbekannt';
		const project = attrs['com.docker.compose.project'];
		const key = `${serverId}:${container}`;
		const action = evt.Action.startsWith('health_status') ? 'health_status' : evt.Action;

		// Nur Container aus verwalteten Stacks bewerten
		if (!(await this.isManaged(serverId, project))) return;

		switch (action) {
			case 'die': {
				const exitCode = Number(attrs['exitCode'] ?? '0');
				// laufender Stabilitäts-Timer ist hinfällig — Container ist wieder gestorben
				const timer = this.resolveTimers.get(key);
				if (timer) {
					clearTimeout(timer);
					this.resolveTimers.delete(key);
				}
				if (this.isSuppressed(serverId, project) || CLEAN_EXITS.has(exitCode)) return;

				const crashRule = await this.rule('crash_loop');
				const windowMs = (crashRule?.thresholds.window_min ?? 5) * 60_000;
				const needed = crashRule?.thresholds.restarts ?? 3;
				const times = (this.dieTimes.get(key) ?? []).filter((t) => Date.now() - t < windowMs);
				times.push(Date.now());
				this.dieTimes.set(key, times);

				if (crashRule?.enabled && times.length >= needed) {
					await this.fire('crash_loop', 'critical', serverId, project, container, 'alert.crashLoop', {
						container, count: times.length, minutes: Math.round(windowMs / 60_000), code: exitCode
					});
				} else if ((await this.rule('container_exit'))?.enabled) {
					await this.fire('container_exit', 'warning', serverId, project, container,
						'alert.containerExit', { container, code: exitCode });
				}
				return;
			}
			case 'oom': {
				if ((await this.rule('oom_kill'))?.enabled) {
					await this.fire('oom_kill', 'critical', serverId, project, container,
						'alert.oomKill', { container });
				}
				return;
			}
			case 'health_status': {
				const healthy = evt.Action.includes('healthy') && !evt.Action.includes('unhealthy');
				if (healthy) {
					await this.resolve(serverId, container, ['unhealthy']);
				} else if ((await this.rule('unhealthy'))?.enabled && !this.isSuppressed(serverId, project)) {
					await this.fire('unhealthy', 'warning', serverId, project, container,
						'alert.unhealthy', { container });
				}
				return;
			}
			case 'start': {
				// 60s stabil → Exit-/Crash-Alerts auto-resolven
				const timer = this.resolveTimers.get(key);
				if (timer) clearTimeout(timer);
				this.resolveTimers.set(key, setTimeout(() => {
					this.resolveTimers.delete(key);
					this.resolve(serverId, container, ['container_exit', 'crash_loop']).catch(() => {});
				}, RESOLVE_STABLE_MS));
				return;
			}
		}
	}

	// ── Updates: Ergebnis-Alerts (Container-Feld trägt hier den Stack-Namen) ──
	async updateProblem(
		serverId: number,
		stackName: string,
		kind: 'pull_failed' | 'update_rolled_back',
		messageKey: MessageKey,
		params: Record<string, string | number>
	) {
		if ((await this.rule(kind))?.enabled) {
			await this.fire(kind, kind === 'pull_failed' ? 'warning' : 'critical', serverId,
				undefined, stackName, messageKey, params);
		}
	}

	async updateOk(serverId: number, stackName: string) {
		await this.resolve(serverId, stackName, ['pull_failed', 'update_rolled_back']);
	}

	/**
	 * Erfolgreich abgeschlossenes Update melden — bewusst nur für Läufe der
	 * Update-Policy. Manuelle Updates sieht man ja live in der Konsole; die
	 * automatischen laufen unbeobachtet und sind genau die, von denen man
	 * erfahren will. Ohne tatsächlich getauschte Images bleibt es still.
	 */
	async updateSucceeded(serverId: number, stackName: string, changedServices: string[]) {
		if (changedServices.length < 1) return;
		if (!(await this.rule('update_success'))?.enabled) return;
		// Bei vielen Services die Meldung nicht ausufern lassen — Push-Nachrichten
		// werden auf dem Sperrbildschirm ohnehin abgeschnitten.
		const MAX_NAMED = 4;
		const services =
			changedServices.length <= MAX_NAMED
				? changedServices.join(', ')
				: `${changedServices.slice(0, MAX_NAMED).join(', ')} +${changedServices.length - MAX_NAMED}`;
		await this.fire('update_success', 'info', serverId, undefined, stackName,
			'alert.updateSuccess', { stack: stackName, services }, true);
	}

	// ── Verfügbare Updates (Stacks auf Policy 'manual') ──
	/**
	 * Meldet einmal pro tatsächlich neuer Version, nicht pro Prüflauf. Der
	 * Digest-Schlüssel steckt in den Alert-Parametern: Bleibt er gleich, war die
	 * Meldung schon draußen — sonst käme alle 6 Stunden dieselbe Nachricht.
	 * Erscheint eine noch neuere Version, wird der offene Alert ersetzt.
	 */
	async updateAvailable(
		serverId: number,
		stackName: string,
		services: string[],
		digestKey: string
	) {
		if (!services.length) return;
		if (!(await this.rule('update_available'))?.enabled) return;
		const [open] = await db
			.select({ id: alerts.id, params: alerts.messageParamsJson })
			.from(alerts)
			.where(
				and(
					eq(alerts.ruleType, 'update_available'),
					eq(alerts.serverId, serverId),
					eq(alerts.containerName, stackName),
					isNull(alerts.resolvedAt)
				)
			)
			.limit(1);
		if (open) {
			let previous = '';
			try {
				previous = (JSON.parse(open.params ?? '{}') as { key?: string }).key ?? '';
			} catch {
				/* Altbestand ohne Schlüssel → wie „unbekannt" behandeln */
			}
			if (previous === digestKey) return;
			await db.update(alerts).set({ resolvedAt: new Date() }).where(eq(alerts.id, open.id));
		}
		const MAX_NAMED = 4;
		const list =
			services.length <= MAX_NAMED
				? services.join(', ')
				: `${services.slice(0, MAX_NAMED).join(', ')} +${services.length - MAX_NAMED}`;
		await this.fire(
			'update_available',
			'info',
			serverId,
			stackName.toLowerCase().replace(/[^a-z0-9_-]/g, ''),
			stackName,
			'alert.updateAvailable',
			{ stack: stackName, services: list, key: digestKey }
		);
	}

	/** Update eingespielt oder Image zurückgezogen → offene Meldung schließen. */
	async updateNoLongerPending(serverId: number, stackName: string) {
		await this.resolve(serverId, stackName, ['update_available']);
	}

	// ── Server-Ebene: Agent offline / Disk ──
	/** Rückgabe: true, wenn tatsächlich alarmiert wurde (nicht in Ruhezeit). */
	async agentOffline(serverId: number, serverName: string): Promise<boolean> {
		if (!(await this.rule('agent_offline'))?.enabled) return false;
		return this.fire('agent_offline', 'critical', serverId, undefined, undefined,
			'alert.agentOffline', { server: serverName });
	}

	async agentOnline(serverId: number) {
		await this.resolveByType(serverId, 'agent_offline');
	}

	async checkDisk(serverId: number, serverName: string, freeBytes: number, totalBytes: number) {
		const rule = await this.rule('disk_space');
		if (!rule?.enabled || !totalBytes) return;
		const freePercent = (freeBytes / totalBytes) * 100;
		const threshold = rule.thresholds.free_percent ?? 10;
		if (freePercent < threshold) {
			await this.fire('disk_space', 'warning', serverId, undefined, undefined,
				'alert.diskSpace', { server: serverName, percent: freePercent.toFixed(1) });
		} else if (freePercent > threshold + 2) {
			await this.resolveByType(serverId, 'disk_space'); // Hysterese gegen Flattern
		}
	}

	// ── DB-Schreiber mit Deduplizierung ──
	private async fire(type: AlertType, severity: Severity, serverId: number,
		project: string | undefined, container: string | undefined,
		messageKey: MessageKey, params: Record<string, string | number> = {},
		// transient: sofort als erledigt ablegen. Für reine Erfolgsmeldungen —
		// sie sollen pushen und im Verlauf stehen, aber weder den Badge-Zähler
		// hochtreiben noch (per Dedup) die nächste gleichartige Meldung blockieren.
		transient = false): Promise<boolean> {
		// Deutsch als gespeicherter Fallback; die Anzeige übersetzt über den Schlüssel.
		const message = translator('de')(messageKey, params);
		// Ruhephase: Der Vorgang wird protokolliert (sonst fehlt er im Verlauf),
		// aber sofort als erledigt abgelegt und nicht zugestellt. Der Aufrufer
		// erfährt über den Rückgabewert, dass nichts rausgegangen ist — die
		// Offline-Erkennung nutzt das, um es nach dem Fenster erneut zu versuchen.
		const quiet = await this.isQuietFor(serverId);
		const conditions = [
			eq(alerts.ruleType, type),
			eq(alerts.serverId, serverId),
			isNull(alerts.resolvedAt),
			...(container ? [eq(alerts.containerName, container)] : [])
		];
		const [open] = await db.select({ id: alerts.id }).from(alerts).where(and(...conditions)).limit(1);
		if (open) return false; // kein Re-Alert solange unresolved

		// Crash-Loop ersetzt einen offenen container_exit desselben Containers
		if (type === 'crash_loop' && container) {
			await db.update(alerts).set({ resolvedAt: new Date() }).where(and(
				eq(alerts.ruleType, 'container_exit'),
				eq(alerts.serverId, serverId),
				eq(alerts.containerName, container),
				isNull(alerts.resolvedAt)
			));
		}

		let stackId: number | undefined;
		if (project) {
			const rows = await db.select({ id: stacks.id, name: stacks.name }).from(stacks).where(eq(stacks.serverId, serverId));
			stackId = rows.find((s) => s.name.toLowerCase().replace(/[^a-z0-9_-]/g, '') === project)?.id;
		}
		await db.insert(alerts).values({
			ruleType: type, serverId, stackId, containerName: container, severity,
			message, messageKey, messageParamsJson: JSON.stringify(params),
			...(transient || quiet ? { resolvedAt: new Date() } : {})
		});
		if (quiet) {
			console.log(`[alerts] In Ruhezeit unterdrückt: ${type} (Server ${serverId})`);
			return false;
		}
		notifyDispatchers({ type, severity, serverId, container, message, messageKey, params });
		return true;
	}

	/** Ruhephase des Servers — Stummschaltung auf Zeit oder tägliches Fenster. */
	private async isQuietFor(serverId: number): Promise<boolean> {
		const [row] = await db
			.select({
				mutedUntil: servers.mutedUntil,
				quietFrom: servers.quietFrom,
				quietMinutes: servers.quietMinutes
			})
			.from(servers)
			.where(eq(servers.id, serverId))
			.limit(1);
		return row ? isQuiet(row) : false;
	}

	private static readonly RESOLVED_COLUMNS = {
		ruleType: alerts.ruleType,
		severity: alerts.severity,
		containerName: alerts.containerName,
		serverId: alerts.serverId,
		stackId: alerts.stackId
	};

	private async resolve(serverId: number, container: string, types: AlertType[]) {
		const resolved = [];
		for (const type of types) {
			resolved.push(
				...(await db.update(alerts).set({ resolvedAt: new Date() }).where(and(
					eq(alerts.ruleType, type),
					eq(alerts.serverId, serverId),
					eq(alerts.containerName, container),
					isNull(alerts.resolvedAt)
				)).returning(AlertEngine.RESOLVED_COLUMNS))
			);
		}
		await this.announceRecovery(resolved);
	}

	private async resolveByType(serverId: number, type: AlertType) {
		const resolved = await db.update(alerts).set({ resolvedAt: new Date() }).where(and(
			eq(alerts.ruleType, type),
			eq(alerts.serverId, serverId),
			isNull(alerts.resolvedAt)
		)).returning(AlertEngine.RESOLVED_COLUMNS);
		await this.announceRecovery(resolved);
	}

	/**
	 * Entwarnung. Wer über eine Störung benachrichtigt, schuldet auch die
	 * Nachricht, dass sie vorbei ist — sonst bleibt der Nutzer mit einer
	 * kritischen Meldung im Kopf zurück und muss selbst nachsehen.
	 * Ausgelassen wird sie bei Info-Meldungen (da gab es keine Sorge) und
	 * während einer Ruhephase.
	 */
	private async announceRecovery(
		rows: {
			ruleType: AlertType;
			severity: Severity;
			containerName: string | null;
			serverId: number;
			stackId: number | null;
		}[]
	) {
		const seen = new Set<string>();
		const names = new Map<number, string>();
		for (const row of rows) {
			if (row.severity === 'info') continue;
			const key: MessageKey = row.containerName
				? 'alert.recoveredContainer'
				: row.ruleType === 'disk_space'
					? 'alert.recoveredDisk'
					: 'alert.recoveredServer';
			const dedup = `${row.serverId}:${row.containerName ?? ''}:${key}`;
			if (seen.has(dedup)) continue; // container_exit + crash_loop → eine Entwarnung
			seen.add(dedup);
			const quiet = await this.isQuietFor(row.serverId);
			if (!names.has(row.serverId)) {
				const [srv] = await db
					.select({ name: servers.name })
					.from(servers)
					.where(eq(servers.id, row.serverId))
					.limit(1);
				names.set(row.serverId, srv?.name ?? `#${row.serverId}`);
			}
			const params: Record<string, string | number> = row.containerName
				? { container: row.containerName }
				: { server: names.get(row.serverId)! };
			const message = translator('de')(key, params);
			// Eigener Eintrag im Verlauf, sofort als erledigt abgelegt. Vorher gab
			// es die Entwarnung nur als Push — wer die Nachricht wegwischte oder sie
			// verpasste, fand im Alert-Center nur die Störung, nie ihr Ende.
			// Auch in Ruhezeiten protokolliert, nur dann nicht zugestellt.
			const now = new Date();
			await db.insert(alerts).values({
				ruleType: row.ruleType,
				serverId: row.serverId,
				stackId: row.stackId,
				containerName: row.containerName,
				severity: 'info',
				message,
				messageKey: key,
				messageParamsJson: JSON.stringify(params),
				firedAt: now,
				resolvedAt: now
			});
			if (quiet) continue;
			notifyDispatchers({
				type: row.ruleType,
				severity: 'info',
				serverId: row.serverId,
				container: row.containerName ?? undefined,
				message,
				messageKey: key,
				params
			});
		}
	}
}

// ── Dispatcher-Hook: Web Push u. Ä. docken hier an (nächster Patch) ──
export interface FiredAlert {
	type: AlertType;
	severity: Severity;
	serverId: number;
	container?: string;
	message: string;
	messageKey: MessageKey;
	params: Record<string, string | number>;
}
type Dispatcher = (alert: FiredAlert) => void;
const dispatchers: Dispatcher[] = [];
export function onAlert(fn: Dispatcher) {
	dispatchers.push(fn);
}
function notifyDispatchers(alert: FiredAlert) {
	for (const fn of dispatchers) {
		try {
			fn(alert);
		} catch (e) {
			console.error('[alerts] Dispatcher-Fehler:', e);
		}
	}
}

export const engine = new AlertEngine();
