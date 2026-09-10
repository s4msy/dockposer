ALTER TABLE `servers` ADD `muted_until` integer;--> statement-breakpoint
ALTER TABLE `servers` ADD `quiet_from` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `quiet_minutes` integer DEFAULT 15 NOT NULL;