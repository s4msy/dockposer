import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ── Enums (SQLite: text mit Typisierung) ────────────────────────────────
export const serverStatus = ['online', 'offline', 'degraded'] as const;
export const stackState = ['running', 'partial', 'unhealthy', 'stopped', 'unknown'] as const;
export const updatePolicy = ['manual', 'auto', 'auto_patch'] as const;
export const alertScope = ['global', 'server', 'stack'] as const;
export const alertType = [
	'container_exit',
	'crash_loop',
	'unhealthy',
	'oom_kill',
	'pull_failed',
	'update_rolled_back',
	'disk_space',
	'agent_offline',
	'update_success'
] as const;
export const alertSeverity = ['info', 'warning', 'critical'] as const;
export const pushTransport = ['webpush', 'ntfy'] as const;
export const updateTrigger = ['manual', 'policy'] as const;
export const updateResult = ['success', 'rolled_back', 'failed'] as const;

// ── Auth ────────────────────────────────────────────────────────────────
export const users = sqliteTable('users', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	username: text('username').notNull().unique(),
	passwordHash: text('password_hash').notNull(),
	totpSecret: text('totp_secret'), // AES-256-GCM-verschlüsselt (Key aus ENV)
	totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
	hideStoppedStacks: integer('hide_stopped_stacks', { mode: 'boolean' }).notNull().default(false),
	theme: text('theme').notNull().default('system'),
	locale: text('locale').notNull().default('auto'), // 'auto' | 'de' | 'en'
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export const webauthnCredentials = sqliteTable('webauthn_credentials', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	credentialId: text('credential_id').notNull().unique(),
	publicKey: text('public_key').notNull(),
	counter: integer('counter').notNull().default(0),
	transports: text('transports'), // JSON-Array
	deviceName: text('device_name'),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date()),
	lastUsedAt: integer('last_used_at', { mode: 'timestamp' })
});

export const sessions = sqliteTable(
	'sessions',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		tokenHash: text('token_hash').notNull().unique(),
		expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date()),
		userAgent: text('user_agent'),
		ip: text('ip')
	},
	(t) => [index('sessions_user_idx').on(t.userId)]
);

// ── Infrastruktur ───────────────────────────────────────────────────────
export const servers = sqliteTable('servers', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull().unique(),
	baseUrl: text('base_url').notNull(), // https://agent1.example.com — TLS macht der Proxy
	agentTokenEnc: text('agent_token_enc').notNull(), // AES-256-GCM — Core braucht das Token im Klartext für Agent-Calls
	status: text('status', { enum: serverStatus }).notNull().default('offline'),
	stacksPath: text('stacks_path').notNull().default('~/stacks'),
	sshUrl: text('ssh_url'), // ssh://user@host für den "Terminal öffnen"-Button (M4)
	gitRemoteEnc: text('git_remote_enc'), // Push-Ziel des Stacks-Repos, AES-verschlüsselt (kann Token enthalten)
	lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

// Cache/Metadaten — Quelle bleibt das Dateisystem! Bei Konflikt gewinnt der Agent.
export const stacks = sqliteTable(
	'stacks',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		serverId: integer('server_id')
			.notNull()
			.references(() => servers.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		composeHash: text('compose_hash'),
		state: text('state', { enum: stackState }).notNull().default('unknown'),
		servicesRunning: integer('services_running').notNull().default(0), // für die „3/4"-Anzeige
		servicesTotal: integer('services_total').notNull().default(0),
		servicesUnhealthy: integer('services_unhealthy').notNull().default(0),
		drift: integer('drift', { mode: 'boolean' }).notNull().default(false),
		driftServicesJson: text('drift_services_json'), // welche Services abweichen
		updatePolicy: text('update_policy', { enum: updatePolicy }).notNull().default('manual'),
		gitTracking: integer('git_tracking', { mode: 'boolean' }).notNull().default(false),
		lastSyncedAt: integer('last_synced_at', { mode: 'timestamp' }),
		updatesJson: text('updates_json'), // Cache des letzten Registry-Checks: [{service,image,current,latest,status}]
		lastUpdateCheck: integer('last_update_check', { mode: 'timestamp' })
	},
	(t) => [index('stacks_server_idx').on(t.serverId), uniqueIndex('stacks_name_idx').on(t.serverId, t.name)]
);

// ── Alerts ──────────────────────────────────────────────────────────────
export const alertRules = sqliteTable('alert_rules', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	scope: text('scope', { enum: alertScope }).notNull().default('global'),
	serverId: integer('server_id').references(() => servers.id, { onDelete: 'cascade' }),
	stackId: integer('stack_id').references(() => stacks.id, { onDelete: 'cascade' }),
	type: text('type', { enum: alertType }).notNull(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	thresholdJson: text('threshold_json') // z. B. {"restarts":3,"window_min":5}
});

export const alerts = sqliteTable(
	'alerts',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		ruleType: text('rule_type', { enum: alertType }).notNull(),
		serverId: integer('server_id')
			.notNull()
			.references(() => servers.id, { onDelete: 'cascade' }),
		stackId: integer('stack_id').references(() => stacks.id, { onDelete: 'set null' }),
		containerName: text('container_name'),
		severity: text('severity', { enum: alertSeverity }).notNull(),
		message: text('message').notNull(), // gerenderter Text (Fallback / Altbestand)
		messageKey: text('message_key'), // i18n-Schlüssel, erst zur Anzeige übersetzt
		messageParamsJson: text('message_params_json'),
		firedAt: integer('fired_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date()),
		resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
		acknowledgedAt: integer('acknowledged_at', { mode: 'timestamp' })
	},
	(t) => [index('alerts_open_idx').on(t.resolvedAt, t.firedAt)]
);

export const pushSubscriptions = sqliteTable('push_subscriptions', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	transport: text('transport', { enum: pushTransport }).notNull().default('webpush'),
	endpoint: text('endpoint'),
	keysP256dh: text('keys_p256dh'),
	keysAuth: text('keys_auth'),
	ntfyTopic: text('ntfy_topic'),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date()),
	lastSuccessAt: integer('last_success_at', { mode: 'timestamp' })
});

// ── Updates (Audit) ─────────────────────────────────────────────────────
export const updateRuns = sqliteTable('update_runs', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	stackId: integer('stack_id')
		.notNull()
		.references(() => stacks.id, { onDelete: 'cascade' }),
	trigger: text('trigger', { enum: updateTrigger }).notNull(),
	oldDigestsJson: text('old_digests_json'),
	newDigestsJson: text('new_digests_json'),
	result: text('result', { enum: updateResult }),
	logExcerpt: text('log_excerpt'),
	startedAt: integer('started_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date()),
	finishedAt: integer('finished_at', { mode: 'timestamp' })
});


// ── Registry-Zugangsdaten (M5) ──────────────────────────────────────────
// Pro Registry-Host ein Eintrag — realistisch hat man eine private Registry,
// nicht zwanzig. Das Secret liegt AES-verschlüsselt (wie die Agent-Tokens).
export const registryCredentials = sqliteTable('registry_credentials', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	host: text('host').notNull().unique(), // z. B. git.example.com (ohne Schema)
	username: text('username').notNull(),
	secretEnc: text('secret_enc').notNull(), // Token/Passwort, AES-256-GCM
	note: text('note'),
	lastCheckAt: integer('last_check_at', { mode: 'timestamp' }),
	lastCheckOk: integer('last_check_ok', { mode: 'boolean' }),
	lastCheckMessage: text('last_check_message'),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});
