-- Migration: adds the columns the Activity Logs feature needs to an
-- already-deployed database. Safe to run once against a DB created from
-- the original schema.sql (id, handover_id, action, staff_name,
-- created_at). If you're setting up a brand-new database, you don't need
-- this file — schema.sql already includes these columns.
--
-- Run with:
--   wrangler d1 execute villaggio-handover-db --file=./migrations/002_activity_logs_details.sql --remote

ALTER TABLE activity_logs ADD COLUMN handover_date TEXT DEFAULT '';
ALTER TABLE activity_logs ADD COLUMN previous_value TEXT;
ALTER TABLE activity_logs ADD COLUMN new_value TEXT;

-- Backfill handover_date for any rows logged before this migration, so
-- older entries still show a handover date in the Activity Logs screen.
UPDATE activity_logs
SET handover_date = (
  SELECT reference_date FROM handovers WHERE handovers.id = activity_logs.handover_id
)
WHERE handover_date = '' OR handover_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs(created_at);
