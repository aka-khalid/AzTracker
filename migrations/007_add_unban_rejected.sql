-- Migration 007: Add unban_rejected column to Users table
-- Phase 6.11 — Ban/Unban State Machine Redesign
--
-- Adds the unban_rejected flag that serves as the single source of truth
-- for permanent ban status. Previously this was tracked only in Bot_States
-- which was fragile and didn't survive state cleanup.
--
-- Safe to run multiple times (fully idempotent).

-- Add the column (no-op if it already exists in SQLite)
ALTER TABLE Users ADD COLUMN unban_rejected INTEGER DEFAULT 0;

-- Index for fast lookups of permanently banned users
CREATE INDEX IF NOT EXISTS idx_users_unban_rejected ON Users(unban_rejected);

-- Migrate existing Bot_Users flags into the new column
-- (handles any users who were permanently banned under the old system)
UPDATE Users SET unban_rejected = 1 WHERE chat_id IN (
    SELECT REPLACE(key, 'unban_rejected:', '')
    FROM Bot_States
    WHERE key LIKE 'unban_rejected:%'
);

-- Optional: clean up the now-redundant Bot_States entries
-- (the application now reads from Users.unban_rejected instead)
DELETE FROM Bot_States WHERE key LIKE 'unban_rejected:%';
