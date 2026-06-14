-- Migration to add last_active tracking for dormancy sweeps

-- Add the new column
ALTER TABLE Users ADD COLUMN last_active INTEGER DEFAULT 0;

-- Backfill existing users: Set their last_active to their created_at date so they don't get swept immediately if they recently joined
UPDATE Users SET last_active = created_at WHERE last_active = 0 OR last_active IS NULL;
