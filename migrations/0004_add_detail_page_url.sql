-- Migration 0004: Add detail_page_url to Global_Products
-- Stores the canonical affiliate URL from the Amazon Creators API
-- so that stored product data can use the full URL (with tag, marketplace, language)
-- instead of manually constructing it.

ALTER TABLE Global_Products ADD COLUMN detail_page_url TEXT;
