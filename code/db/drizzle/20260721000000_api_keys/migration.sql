-- API Keys table for @better-auth/api-key plugin.
-- Stores hashed API keys for programmatic cloud browser access (CI, VPS, headless).
-- enableSessionForAPIKeys makes getSession() resolve x-api-key headers into
-- sessions transparently, so no changes needed in cloud-api.ts routes.

CREATE TABLE `apikey` (
  `id` text PRIMARY KEY NOT NULL,
  `config_id` text NOT NULL DEFAULT 'default',
  `name` text,
  `start` text,
  `prefix` text,
  `key` text NOT NULL,
  `reference_id` text NOT NULL,
  `refill_interval` integer,
  `refill_amount` integer,
  `last_refill_at` integer,
  `enabled` integer DEFAULT true,
  `rate_limit_enabled` integer,
  `rate_limit_time_window` integer,
  `rate_limit_max` integer,
  `request_count` integer,
  `remaining` integer,
  `last_request` integer,
  `expires_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `permissions` text,
  `metadata` text
);

CREATE INDEX `apikey_reference_id_idx` ON `apikey` (`reference_id`);
CREATE INDEX `apikey_config_id_idx` ON `apikey` (`config_id`);
CREATE INDEX `apikey_key_idx` ON `apikey` (`key`);
