CREATE TABLE `registry_credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`host` text NOT NULL,
	`username` text NOT NULL,
	`secret_enc` text NOT NULL,
	`note` text,
	`last_check_at` integer,
	`last_check_ok` integer,
	`last_check_message` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_credentials_host_unique` ON `registry_credentials` (`host`);