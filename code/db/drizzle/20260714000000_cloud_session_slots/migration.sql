-- Add per-org slot indexes so cloud session quota claims are enforced by SQLite uniqueness.
-- Existing rows are preserved and assigned stable slot numbers per org.

CREATE TABLE `cloud_session_new` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`slot_index` integer NOT NULL,
	`browser_use_session_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `cloud_session_new` (`id`, `org_id`, `slot_index`, `browser_use_session_id`, `created_at`)
SELECT
	`id`,
	`org_id`,
	ROW_NUMBER() OVER (PARTITION BY `org_id` ORDER BY `created_at`, `id`) AS `slot_index`,
	`browser_use_session_id`,
	`created_at`
FROM `cloud_session`;
--> statement-breakpoint
DROP TABLE `cloud_session`;
--> statement-breakpoint
ALTER TABLE `cloud_session_new` RENAME TO `cloud_session`;
--> statement-breakpoint
CREATE INDEX `cloud_session_org_id_idx` ON `cloud_session` (`org_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `cloud_session_org_id_slot_index_unique` ON `cloud_session` (`org_id`, `slot_index`);
