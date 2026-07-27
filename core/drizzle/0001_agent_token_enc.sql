DELETE FROM `stacks`;--> statement-breakpoint
DROP TABLE `servers`;--> statement-breakpoint
CREATE TABLE `servers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`agent_token_enc` text NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`stacks_path` text DEFAULT '~/stacks' NOT NULL,
	`ssh_url` text,
	`last_seen_at` integer,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `servers_name_unique` ON `servers` (`name`);--> statement-breakpoint
DROP INDEX IF EXISTS `stacks_name_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `stacks_name_idx` ON `stacks` (`server_id`,`name`);
