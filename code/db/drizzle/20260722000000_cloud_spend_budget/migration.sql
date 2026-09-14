-- Add separate browser/VM spend tracking alongside existing proxy spend.
-- Add per-org creation rate limit timestamp.
-- Add per-session browser cost baseline.

-- org: add browser spend columns (proxy columns already exist)
ALTER TABLE org ADD COLUMN browser_spend_cents INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE org ADD COLUMN browser_budget_cents INTEGER NOT NULL DEFAULT 500;
--> statement-breakpoint
-- Unify period start: rename proxy_spend_period_start to spend_period_start
-- (covers both proxy and browser spend resets)
ALTER TABLE org ADD COLUMN spend_period_start INTEGER;
--> statement-breakpoint
UPDATE org SET spend_period_start = proxy_spend_period_start;
--> statement-breakpoint
ALTER TABLE org ADD COLUMN last_cloud_create_at INTEGER;
--> statement-breakpoint
-- cloud_session: add browser cost baseline (proxy baseline already exists)
ALTER TABLE cloud_session ADD COLUMN last_browser_cost_cents INTEGER NOT NULL DEFAULT 0;
