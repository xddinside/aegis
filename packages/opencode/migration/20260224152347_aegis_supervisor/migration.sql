CREATE TABLE `aegis_event` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`message_id` text,
	`part_id` text,
	`rule_id` text,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_aegis_event_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_aegis_event_rule_id_aegis_rule_id_fk` FOREIGN KEY (`rule_id`) REFERENCES `aegis_rule`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `aegis_rule` (
	`id` text PRIMARY KEY,
	`scope` text NOT NULL,
	`project_id` text,
	`kind` text NOT NULL,
	`statement` text NOT NULL,
	`matcher` text NOT NULL,
	`severity` text NOT NULL,
	`confidence` integer NOT NULL,
	`source` text,
	`active` integer DEFAULT 1 NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_aegis_rule_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `aegis_session` (
	`session_id` text PRIMARY KEY,
	`state` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_aegis_session_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `aegis_event_session_idx` ON `aegis_event` (`session_id`);--> statement-breakpoint
CREATE INDEX `aegis_event_rule_idx` ON `aegis_event` (`rule_id`);--> statement-breakpoint
CREATE INDEX `aegis_event_type_idx` ON `aegis_event` (`type`);--> statement-breakpoint
CREATE INDEX `aegis_rule_scope_idx` ON `aegis_rule` (`scope`);--> statement-breakpoint
CREATE INDEX `aegis_rule_project_idx` ON `aegis_rule` (`project_id`);