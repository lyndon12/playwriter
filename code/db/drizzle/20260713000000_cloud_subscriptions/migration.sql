-- Forward migration: simplify cloud session model and add subscriptions.
-- Old cloud_browser/cloud_session tables replaced with a simpler cloud_session
-- that maps org → Browser Use session ID directly.

-- Drop old tables (order matters: child first, then parent)
DROP TABLE IF EXISTS `cloud_session`;
--> statement-breakpoint
DROP TABLE IF EXISTS `cloud_browser`;
--> statement-breakpoint
DROP INDEX IF EXISTS `cloud_session_cloud_browser_id_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `cloud_browser_org_id_idx`;
--> statement-breakpoint

-- New subscription table for Stripe billing
CREATE TABLE `subscription` (
	`subscription_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text,
	`price_id` text,
	`product_id` text,
	`status` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`plan_name` text,
	`current_period_start` integer,
	`current_period_end` integer,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `subscription_org_id_idx` ON `subscription` (`org_id`);
--> statement-breakpoint

-- New simplified cloud_session table (org → BU session mapping)
CREATE TABLE `cloud_session` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`browser_use_session_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `cloud_session_org_id_idx` ON `cloud_session` (`org_id`);
