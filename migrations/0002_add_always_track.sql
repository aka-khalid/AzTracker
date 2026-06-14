-- Migration: Add always_track column to Global_Products
-- Description: Enables admins to flag orphaned products for global deal hunting even when there are 0 active user subscriptions.

ALTER TABLE Global_Products ADD COLUMN always_track INTEGER DEFAULT 0;
