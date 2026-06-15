-- ============================================================================
-- Migration: Add mute_join_queue for Admin Opt-out
-- Description: Adds a new column to Users table allowing admins to opt out
--              of the Telegram join queue notifications. Default is 0 (receive).
-- ============================================================================

ALTER TABLE Users ADD COLUMN mute_join_queue INTEGER DEFAULT 0;
