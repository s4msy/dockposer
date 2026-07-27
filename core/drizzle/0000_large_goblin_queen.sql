CREATE TABLE `alert_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text DEFAULT 'global' NOT NULL,
	`server_id` integer,
	`stack_id` integer,
	`type` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`threshold_json` text,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule_type` text NOT NULL,
	`server_id` integer NOT NULL,
	`stack_id` integer,
	`container_name` text,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`fired_at` integer NOT NULL,
	`resolved_at` integer,
	`acknowledged_at` integer,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `alerts_open_idx` ON `alerts` (`resolved_at`,`fired_at`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`transport` text DEFAULT 'webpush' NOT NULL,
	`endpoint` text,
	`keys_p256dh` text,
	`keys_auth` text,
	`ntfy_topic` text,
	`created_at` integer NOT NULL,
	`last_success_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `servers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`agent_token_hash` text NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`stacks_path` text DEFAULT '~/stacks' NOT NULL,
	`ssh_url` text,
	`last_seen_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `servers_name_unique` ON `servers` (`name`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`user_agent` text,
	`ip` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `stacks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` integer NOT NULL,
	`name` text NOT NULL,
	`compose_hash` text,
	`state` text DEFAULT 'unknown' NOT NULL,
	`services_running` integer DEFAULT 0 NOT NULL,
	`services_total` integer DEFAULT 0 NOT NULL,
	`drift` integer DEFAULT false NOT NULL,
	`update_policy` text DEFAULT 'manual' NOT NULL,
	`git_tracking` integer DEFAULT false NOT NULL,
	`last_synced_at` integer,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stacks_server_idx` ON `stacks` (`server_id`);--> statement-breakpoint
CREATE INDEX `stacks_name_idx` ON `stacks` (`server_id`,`name`);--> statement-breakpoint
CREATE TABLE `update_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stack_id` integer NOT NULL,
	`trigger` text NOT NULL,
	`old_digests_json` text,
	`new_digests_json` text,
	`result` text,
	`log_excerpt` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`totp_secret` text,
	`totp_enabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `webauthn_credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`device_name` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webauthn_credentials_credential_id_unique` ON `webauthn_credentials` (`credential_id`);