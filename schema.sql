-- schema.sql
-- D1 SQLite Migration Schema for AzTracker Phase 6.8
-- Safe to run multiple times (fully idempotent).

-- ============================================================================
-- 1. Identity & Access Directory
-- ============================================================================
CREATE TABLE IF NOT EXISTS Users (
    chat_id TEXT PRIMARY KEY,
    first_name TEXT,
    username TEXT,
    lang TEXT, -- User language preference: 'en' or 'ar'
    role TEXT NOT NULL DEFAULT 'pending', -- Roles: 'approved', 'admin', 'rejected', 'pending'
    item_limit INTEGER NOT NULL DEFAULT 5,
    approved_by TEXT,
    created_at INTEGER NOT NULL
);

-- ============================================================================
-- 2. Join Queue (Pending Access Requests)
-- ============================================================================
CREATE TABLE IF NOT EXISTS Join_Queue (
    chat_id TEXT PRIMARY KEY,
    first_name TEXT,
    username TEXT,
    requested_at INTEGER NOT NULL,
    admin_messages TEXT,
    request_type TEXT NOT NULL DEFAULT 'access' -- 'access' for new join requests, 'unban' for unban appeals
);

-- ============================================================================
-- 3. The Global Hysteresis & State Engine
-- ============================================================================
CREATE TABLE IF NOT EXISTS Global_Products (
    asin TEXT PRIMARY KEY,
    name TEXT,
    name_ar TEXT, -- Arabic product name (fetched from Amazon.eg)

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
-- 4. The Personal Registry (Junction Table)
-- ============================================================================
CREATE TABLE IF NOT EXISTS User_Subscriptions (
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
-- 5. Audit Logging
-- ============================================================================
CREATE TABLE IF NOT EXISTS Audit_Logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    actor_name TEXT,
    action TEXT NOT NULL,
    target_id TEXT,
    details TEXT
);

-- ============================================================================
-- 6. Bot Conversational State (D1 Offload)
-- ============================================================================
CREATE TABLE IF NOT EXISTS Bot_States (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);

-- ============================================================================
-- 7. Dead Letter Queue (Failed Queue Messages)
-- ============================================================================
CREATE TABLE IF NOT EXISTS Failed_Queue_Messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_name TEXT NOT NULL,
    body TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    failed_at INTEGER NOT NULL
);

-- ============================================================================
-- 8. Performance Indexes (all idempotent with IF NOT EXISTS)
-- ============================================================================
-- Optimizes the CRM Web App list queries
CREATE INDEX IF NOT EXISTS idx_usersubscriptions_chatid ON User_Subscriptions (chat_id);
-- Optimizes the Cron engine joining users to active products
CREATE INDEX IF NOT EXISTS idx_subscriptions_asin ON User_Subscriptions(asin);
-- Optimizes garbage collection / stale product queries
CREATE INDEX IF NOT EXISTS idx_products_last_updated ON Global_Products(last_updated);
-- Optimizes Web App CRM Pending/Approved/Banned tab grouping
CREATE INDEX IF NOT EXISTS idx_users_role ON Users(role);
-- Optimizes Web App CRM chronological sorting to prevent memory scans
CREATE INDEX IF NOT EXISTS idx_users_created_at ON Users(created_at DESC);
-- Optimizes Watch Pool calculations ignoring paused items
CREATE INDEX IF NOT EXISTS idx_subscriptions_is_paused ON User_Subscriptions(is_paused);
-- Optimizes audit log chronological queries
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON Audit_Logs(timestamp DESC);
-- Optimizes audit log per-actor filtering
CREATE INDEX IF NOT EXISTS idx_audit_actor ON Audit_Logs(actor_id);
-- Optimizes Bot_States GC queries
CREATE INDEX IF NOT EXISTS idx_bot_states_expires ON Bot_States(expires_at);
-- Optimizes Join_Queue chronological ordering for CRM display
CREATE INDEX IF NOT EXISTS idx_join_queue_requested_at ON Join_Queue(requested_at DESC);
