-- schema.sql
-- D1 SQLite Migration Schema for AzTracker Phase 6.8

DROP TABLE IF EXISTS User_Subscriptions;
DROP TABLE IF EXISTS Global_Products;
DROP TABLE IF EXISTS Users;

-- ============================================================================
-- 1. Identity & Access Directory
-- ============================================================================
CREATE TABLE Users (
    chat_id TEXT PRIMARY KEY,
    role TEXT NOT NULL DEFAULT 'approved', -- Roles: 'approved', 'admin', 'rejected'
    item_limit INTEGER NOT NULL DEFAULT 5,
    approved_by TEXT,
    created_at INTEGER NOT NULL
);

-- ============================================================================
-- 2. The Global Hysteresis & State Engine
-- ============================================================================
CREATE TABLE Global_Products (
    asin TEXT PRIMARY KEY,
    name TEXT,

    -- Live Pricing & Sellers
    new_price REAL,
    new_seller TEXT,
    new_mid TEXT,
    used_price REAL,
    used_seller TEXT,
    used_mid TEXT,
    used_offers TEXT, -- JSON stringified array of alternative used offers
    amazon_price REAL,
    amazon_seller TEXT,
    amazon_mid TEXT,
    amazon_is_buybox INTEGER DEFAULT 0,

    -- Hysteresis Timestamps (Anti-Flap & MIA Tracking)
    seen_amazon_eg_at INTEGER,
    seen_resale_at INTEGER,
    new_missing_since INTEGER,
    used_missing_since INTEGER,
    amazon_missing_since INTEGER,

    -- State Flags & Historical Math
    delisted INTEGER DEFAULT 0,
    is_atl_new INTEGER DEFAULT 0,
    hist_mean REAL,
    hist_stdev REAL,

    -- Broadcast Locks
    last_broadcast_time_ms INTEGER,
    last_broadcast_price REAL,

    -- Engine Sync
    last_updated INTEGER NOT NULL
);

-- ============================================================================
-- 3. The Personal Registry (Junction Table)
-- ============================================================================
CREATE TABLE User_Subscriptions (
    chat_id TEXT NOT NULL,
    asin TEXT NOT NULL,
    target_price REAL,
    is_paused INTEGER DEFAULT 0,
    alert_sent_new INTEGER DEFAULT 0,
    alert_sent_used INTEGER DEFAULT 0,
    added_at INTEGER NOT NULL,
    
    PRIMARY KEY (chat_id, asin),
    FOREIGN KEY (chat_id) REFERENCES Users(chat_id) ON DELETE CASCADE,
    FOREIGN KEY (asin) REFERENCES Global_Products(asin) ON DELETE CASCADE
);

-- ============================================================================
-- 4. Performance Indexes
-- ============================================================================
-- Optimizes the UI /manage list queries
CREATE INDEX idx_subscriptions_chat_id ON User_Subscriptions(chat_id);
-- Optimizes the Cron engine joining users to active products
CREATE INDEX idx_subscriptions_asin ON User_Subscriptions(asin);
-- Optimizes garbage collection / stale product queries
CREATE INDEX idx_products_last_updated ON Global_Products(last_updated);
-- Optimizes Web App CRM Pending/Approved/Banned tab grouping
CREATE INDEX idx_users_role ON Users(role);
-- Optimizes Web App CRM chronological sorting to prevent memory scans
CREATE INDEX idx_users_created_at ON Users(created_at DESC);
-- Optimizes Watch Pool calculations ignoring paused items
CREATE INDEX idx_subscriptions_is_paused ON User_Subscriptions(is_paused);
