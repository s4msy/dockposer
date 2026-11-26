DROP INDEX `stacks_name_idx`;--> statement-breakpoint
ALTER TABLE `stacks` ADD `kind` text DEFAULT 'stack' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `stacks_name_idx` ON `stacks` (`server_id`,`kind`,`name`);--> statement-breakpoint
ALTER TABLE `servers` ADD `docker_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `servers` ADD `pods_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `servers` ADD `podman_version` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `pods_problem` text;