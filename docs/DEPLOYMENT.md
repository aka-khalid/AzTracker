# AzTracker Deployment Guide

> **Branch:** `feature/phase-6.11-localization` (modular `src/` layout)
> **Last verified against codebase:** 2026-06-10

AzTracker runs on Cloudflare Workers with a hybrid D1 (relational) + KV (time-series) database. Background work is driven by Cloudflare Queues and an optional CRON trigger. Disaster Recovery uses a GCP Cloud Function bridge.

---

## 1. Architecture Overview

### 1.1 Worker Entry Point — `src/index.js`

Single default export with three handlers:

| Handler | Trigger | Purpose |
|---|---|---|
| `scheduled` | CRON trigger | Delegates to `workers/cron_trigger.js` |
| `queue` | Queue consumer | Delegates to `workers/queue_worker.js` |
| `fetch` | HTTP request | Routes `POST /webhook` to `routes/telegram_webhook.js`; everything else to `routes/crm_dashboard.js` (`fetchAPI`) |

### 1.2 Source Layout

```
src/
├── index.js                        # Worker entry point (3 handlers)
├── api/
│   └── amazon.ts                   # TypeScript Amazon Creators API types + getAmazonAccessToken() + AmazonEdgeParser class
├── core/
│   ├── amazon.js                   # JS AmazonEdgeParser (runtime version used by workers)
│   ├── db.js                       # getUserRoles(), resolveUserProfile(), logAudit(), cleanupDatabase()
│   ├── i18n.js                     # t(), resolveLanguageCode(), getWelcomeMessage() — 200+ keys, en + ar
│   ├── telegram.js                 # sendTelegramMessage(), editTelegramMessage(), deleteMessage(), answerCallbackQuery()
│   └── utils.js                    # escapeHtml(), formatEGP(), delay(), truncateName(), getCairoTime()
├── routes/
│   ├── crm_dashboard.js            # CRM admin dashboard (HTML + API endpoints)
│   └── telegram_webhook.js         # Telegram bot command handler
└── workers/
    ├── cron_trigger.js             # CRON handler (Bot_States GC + Dynamic Governor)
    ├── queue_worker.js             # Queue consumer (scraper + telegram outbox)
    └── scraper_engine.js           # Core scrape loop (Amazon API → D1 + KV + outbox)
```

### 1.3 Hybrid Database Model

| Store | Binding | Purpose |
|---|---|---|
| **D1** | `DB` | Relational state: users, products, subscriptions, audit logs, bot states, join queue |
| **KV** | `AZTRACKER_DB` | Time-series history (`history:{asin}`, `global:history_all_new`), Amazon access token cache |

D1 handles all relational queries, user management, and alert state flags. KV exclusively stores the high-volume price-history arrays used for charting and statistical calculations (mean, stdev, z-score, ATL).

---

## 2. Environment Configuration — `wrangler.toml`

### 2.1 Worker Names

| Environment | Name |
|---|---|
| Development (default) | `aztracker-v2` |
| Production | `aztracker-v2-prod` |

### 2.2 KV Namespace

| Binding | ID | Shared? |
|---|---|---|
| `AZTRACKER_DB` | `90fcfcb742fe4d7299087c076bd1ba4d` | Yes — same ID in both environments |

### 2.3 D1 Databases

| Environment | Name | ID |
|---|---|---|
| Development | `aztracker-test-db` | `5ba01682-b844-447d-8498-bc0cac846edd` |
| Production | `aztracker-prod-db` | `7998ba93-e8ef-42c5-b37b-580e233a2d6a` |

### 2.4 Queues

Both environments have identical queue configurations:

| Queue Name | Producer Binding | Consumer | max_batch_size | max_retries |
|---|---|---|---|---|
| `telegram-outbox` | `MESSAGE_QUEUE` | Yes | 30 | 3 |
| `scraper-queue` | `SCRAPER_QUEUE` | Yes | 10 | 3 |

### 2.5 CRON Triggers

**Currently EMPTY in both environments:**

```toml
[triggers]
crons = []
# crons = ["* * * * *", "0 0 * * *"]
```

The CRON array is commented out. To enable the Dynamic Governor, uncomment `* * * * *` in both `[triggers]` and `[env.production.triggers]`.

### 2.6 Environment Variables (`[vars]`)

| Variable | Value | Used In |
|---|---|---|
| `GITHUB_OWNER` | `aka-khalid` | `crm_dashboard.js` (GitHub issue tracking) |
| `GITHUB_REPO` | `AzTracker` | `crm_dashboard.js` |
| `DEFAULT_USER_PRODUCT_LIMIT` | `"3"` | `telegram_webhook.js`, `crm_dashboard.js` |
| `GLOBAL_POOL_LIMIT` | `"450"` | Defined but **not directly referenced** in source code (reserved for future use) |

---

## 3. D1 Schema — `schema.sql`

Six tables (note: `Join_Queue` is **missing** from `schema.sql` but is actively used — see Section 3.7):

### 3.1 `Users`
| Column | Type | Notes |
|---|---|---|
| `chat_id` | TEXT PK | Telegram chat ID |
| `first_name` | TEXT | |
| `username` | TEXT | |
| `lang` | TEXT | `'en'` or `'ar'` |
| `role` | TEXT | `'approved'`, `'admin'`, `'rejected'`, `'pending'` |
| `item_limit` | INTEGER | Default 5 |
| `approved_by` | TEXT | |
| `created_at` | INTEGER | Unix ms |

### 3.2 `Global_Products`
| Column | Type | Notes |
|---|---|---|
| `asin` | TEXT PK | |
| `name` | TEXT | English product name |
| `name_ar` | TEXT | Arabic product name |
| `new_price`, `new_seller`, `new_mid` | REAL/TEXT | New condition pricing |
| `used_price`, `used_seller`, `used_mid` | REAL/TEXT | Used/resale pricing |
| `used_offers` | TEXT | JSON array of alternative used offers |
| `amazon_price`, `amazon_seller`, `amazon_mid` | REAL/TEXT | Amazon.eg direct pricing |
| `amazon_is_buybox` | INTEGER | 0/1 |
| `seen_amazon_eg_at`, `seen_resale_at` | INTEGER | Hysteresis timestamps |
| `new_missing_since`, `used_missing_since`, `amazon_missing_since` | INTEGER | Anti-flap timers |
| `delisted` | INTEGER | 0/1 |
| `is_atl_new` | INTEGER | All-Time Low flag |
| `hist_mean`, `hist_stdev` | REAL | Running statistics |
| `last_broadcast_time_ms`, `last_broadcast_price` | INTEGER/REAL | Broadcast throttle |
| `last_updated` | INTEGER | Unix ms |

### 3.3 `User_Subscriptions`
| Column | Type | Notes |
|---|---|---|
| `chat_id` | TEXT | Composite PK |
| `asin` | TEXT | Composite PK |
| `target_price` | REAL | Optional price target |
| `is_paused` | INTEGER | 0/1 |
| `alert_sent_new` | INTEGER | 2PC delivery flag |
| `alert_sent_used` | INTEGER | 2PC delivery flag |
| `added_at` | INTEGER | Unix ms |

### 3.4 `Audit_Logs`
| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER | AUTOINCREMENT PK |
| `timestamp` | INTEGER | Unix ms |
| `actor_id`, `actor_name` | TEXT | |
| `action` | TEXT | |
| `target_id` | TEXT | |
| `details` | TEXT | JSON |

### 3.5 `Bot_States`
| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PK | e.g. `'last_run_time'` |
| `value` | TEXT | |
| `expires_at` | INTEGER | Unix ms (GC target) |

### 3.6 Indexes

- `idx_usersubscriptions_chatid` on `User_Subscriptions(chat_id)`
- `idx_subscriptions_asin` on `User_Subscriptions(asin)`
- `idx_products_last_updated` on `Global_Products(last_updated)`
- `idx_users_role` on `Users(role)`
- `idx_users_created_at` on `Users(created_at DESC)`
- `idx_subscriptions_is_paused` on `User_Subscriptions(is_paused)`
- `idx_audit_timestamp` on `Audit_Logs(timestamp DESC)`
- `idx_audit_actor` on `Audit_Logs(actor_id)`
- `idx_bot_states_expires` on `Bot_States(expires_at)`

### 3.7 Missing Table: `Join_Queue`

The table `Join_Queue` is **referenced in queries** throughout `telegram_webhook.js` and `crm_dashboard.js` but is **NOT defined in `schema.sql`**. It must be created manually before deployment:

```sql
CREATE TABLE IF NOT EXISTS Join_Queue (
    chat_id TEXT PRIMARY KEY,
    first_name TEXT,
    username TEXT,
    requested_at INTEGER NOT NULL,
    admin_messages TEXT
);
```

---

## 4. Secrets

All secrets are injected via `npx wrangler secret put`. None are stored in `wrangler.toml`.

### 4.1 Required Secrets

| Secret | Used In | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `core/telegram.js`, `core/db.js`, `routes/telegram_webhook.js` | Telegram Bot API authentication |
| `TELEGRAM_ROOT_ADMIN_IDS` | `core/db.js`, `routes/telegram_webhook.js`, `routes/crm_dashboard.js` | Root admin access (comma-separated chat IDs). Falls back to `ROOT_ADMIN_ID` then `TELEGRAM_ADMIN_IDS` |
| `TELEGRAM_WEBHOOK_SECRET` | `routes/telegram_webhook.js`, `routes/crm_dashboard.js` | Webhook HMAC verification + CRM audit signature |
| `AMAZON_CLIENT_ID` | `workers/scraper_engine.js`, `routes/telegram_webhook.js`, `routes/crm_dashboard.js` | Amazon Creators API. Falls back to `AMZN_CREATORS_ACCESS_KEY` then `AWS_ACCESS_KEY_ID` |
| `AMAZON_CLIENT_SECRET` | `workers/scraper_engine.js`, `routes/telegram_webhook.js`, `routes/crm_dashboard.js` | Amazon Creators API. Falls back to `AMZN_CREATORS_SECRET_KEY` then `AWS_SECRET_ACCESS_KEY` |
| `AMZN_ASSOCIATES_TAG` | `workers/scraper_engine.js`, `routes/telegram_webhook.js`, `routes/crm_dashboard.js` | Amazon Associates tag for API calls |
| `AMAZON_PARTNER_TAG` | `workers/scraper_engine.js`, `routes/telegram_webhook.js` | Partner tag for affiliate links in alerts and broadcasts |

### 4.2 Optional Secrets

| Secret | Used In | Purpose |
|---|---|---|
| `TELEGRAM_PUBLIC_CHANNEL_ID` | `workers/scraper_engine.js` | Target chat ID for automated deal broadcasts. If unset, broadcast logic is skipped |

---

## 5. Deployment Procedure

### 5.1 Prerequisites

```bash
npm install
```

### 5.2 Provision D1 Databases (first time only)

```bash
npx wrangler d1 create aztracker-test-db
npx wrangler d1 create aztracker-prod-db
```

Update `wrangler.toml` with the returned `database_id` values.

### 5.3 Apply Schema

```bash
# Development (local)
npx wrangler d1 execute aztracker-test-db --local --file=schema.sql

# Production (remote)
npx wrangler d1 execute aztracker-prod-db --env production --remote --file=schema.sql
```

**Also create the missing `Join_Queue` table** (see Section 3.7).

### 5.4 Deploy Worker

```bash
# Development
npx wrangler deploy

# Production
npx wrangler deploy --env production
```

### 5.5 Run Final Cutover — `finalize_cutover.js`

```bash
node finalize_cutover.js
```

Interactive steps:
1. Select environment (1 = dev, 2 = prod)
2. Enter 7 values: bot token, admin IDs, Amazon client ID/secret, partner tag, associates tag, worker URL
3. Generates a random `TELEGRAM_WEBHOOK_SECRET` (16-byte hex)
4. Injects all 7 secrets via `npx wrangler secret put`
5. Registers webhook with Telegram API (`setWebhook`)
6. Runs `scripts/migrate_to_d1.js` to generate `d1_seed.sql` from `kv_export.json`
7. Pushes `d1_seed.sql` to D1 via `npx wrangler d1 execute`

**Note:** Step 6 (`scripts/export_kv.js`) is **commented out** in `finalize_cutover.js` with a warning not to uncomment (STDERR write EOF error). The migration runs from any existing `kv_export.json` file.

---

## 6. GCP Backup Bridge — `gcp_backup_bridge/`

### 6.1 Purpose

Exports the D1 database to SQLite and uploads it to Google Drive. Runs as a GCP Cloud Function (2nd Gen) because Cloudflare Workers have memory constraints that prevent large SQLite exports.

### 6.2 Files

| File | Purpose |
|---|---|
| `index.js` | Cloud Function entry point |
| `package.json` | Dependencies |

### 6.3 Dependencies

- `@google-cloud/functions-framework@^3.3.0`
- `googleapis@^128.0.0`
- `node-fetch@^3.3.2`

### 6.4 Required Environment Variables (GCP Secret Manager)

| Variable | Purpose |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare account ID |
| `CF_D1_DATABASE_ID` | D1 database ID to export |
| `CF_API_TOKEN` | Cloudflare API token with D1 read access |
| `GDRIVE_FOLDER_ID` | Google Drive folder ID for backup files |
| `GDRIVE_SERVICE_ACCOUNT_JSON` | Service Account JSON (parsed as object) |

### 6.5 Function Behavior (`backupD1ToDrive`)

1. POST to Cloudflare D1 export API (`/accounts/{id}/d1/database/{id}/export`) with `output_format: "sqlite"`
2. Poll every 3 seconds until status is `"complete"`
3. Download the signed URL (SQLite stream)
4. Stream-upload to Google Drive as `aztracker_backup_{date}.sqlite`
5. Returns Drive File ID on success

### 6.6 Deployment

Deploy to GCP Cloud Functions (2nd Gen) and configure a Cloud Scheduler job to invoke it on a schedule (e.g., daily). OIDC authentication is handled by Google API Gateway before the function boots.

---

## 7. Queue Architecture — `src/workers/queue_worker.js`

### 7.1 `scraper-queue`

- **Trigger:** Message with `{ offset: N }`
- **Behavior:** Calls `executeScrapeEngine(env, offset)` which processes 10 products at a time
- **Recursion:** If 10 products were returned (meaning more exist), sends `{ offset: offset + 10 }` with `delaySeconds: 1`
- **Error handling:** Retries with `delaySeconds: 30` on failure
- **Kill switch:** Line 6 has a commented-out `return` for development

### 7.2 `telegram-outbox`

- **Trigger:** Message with `{ type, chatId, text, markup, asin }`
- **Behavior:** Calls `sendTelegramMessage()` for each message
- **429 Rate Limit:** Sets `rateLimited = true`, reads `retry_after` from Telegram response, retries all remaining messages with that delay
- **403 Blocked:** Auto-pauses the user's subscriptions (`UPDATE User_Subscriptions SET is_paused = 1`)
- **2PC (Two-Phase Commit):** `alert_sent_new` / `alert_sent_used` flags in D1 are **only updated after successful HTTP 200 delivery** to Telegram. If delivery fails, the alert remains unsent and will be retried.

### 7.3 Queue Diagnostics

**Send a test message to a queue:**

```bash
# Using wrangler (requires local dev or remote connection)
npx wrangler queues send telegram-outbox '{"type":"telegram_alert","chatId":"YOUR_CHAT_ID","text":"Test message"}' --env production

# Using curl (Cloudflare API)
curl -X POST "https://api.cloudflare.com/client/v4/accounts/{account_id}/queues/{queue_id}/messages" \
  -H "Authorization: Bearer {api_token}" \
  -H "Content-Type: application/json" \
  -d '{"body":{"type":"telegram_alert","chatId":"YOUR_CHAT_ID","text":"Test"}}'
```

**Check queue status:**

```bash
npx wrangler queues list
```

---

## 8. CRON Triggers — `src/workers/cron_trigger.js`

### 8.1 Current State

CRON triggers are **disabled** (`crons = []` in both environments). The `* * * * *` and `0 0 * * *` patterns are commented out in `wrangler.toml`.

### 8.2 Dynamic Governor (when `* * * * *` is enabled)

Runs every minute. Two operations:

1. **Bot_States GC:** `DELETE FROM Bot_States WHERE expires_at < now`
2. **Dynamic Governor:**
   - Reads `last_run_time` from `Bot_States`
   - Counts active pool: `SELECT COUNT(DISTINCT asin) FROM User_Subscriptions WHERE is_paused = 0`
   - Calculates batches: `ceil(poolSize / 10)`
   - Calculates max runs per day: `floor(8640 / batches)` (8640 = minutes in 6 days, a safety cap)
   - Calculates interval: `floor(86400000 / maxRuns)` ms
   - If `(now - lastRunMs) >= intervalMs`: updates `last_run_time` and sends `{ offset: 0 }` to `SCRAPER_QUEUE`

This dynamically adjusts scrape frequency based on pool size — larger pools run more frequently.

---

## 9. Migration Scripts — `scripts/`

### 9.1 `export_kv.js` — KV Data Export

**Status: DISABLED** — Commented out in `finalize_cutover.js` with warning: `STDERR: X [ERROR] write EOF - DO NOT UNCOMMENT`

When enabled, it would:
1. List all KV keys via `npx wrangler kv key list`
2. Fetch each value (skipping `audit:*` and `state:*` keys)
3. Write to `kv_export.json`

### 9.2 `migrate_to_d1.js` — KV → D1 Migration

Reads `kv_export.json` and generates `d1_seed.sql` with INSERT statements for:
- **Users:** From `global:approved_users`, `global:admins`, `approved_by:{id}` keys
- **Pending Users:** From `global:join_queue` (role = `'pending'`, limit = 0)
- **Global_Products:** From `user:{id}:products` + `item:{asin}` keys
- **User_Subscriptions:** From `user:{id}:products` entries

Run with:
```bash
node scripts/migrate_to_d1.js
# Then: npx wrangler d1 execute aztracker-prod-db --remote --file=./d1_seed.sql
```

---

## 10. CRM Dashboard — `src/routes/crm_dashboard.js`

HTML-rendered admin dashboard with API endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /crm` | Main dashboard HTML |
| `GET /api/crm/data` | Dashboard data (users, products, stats) |
| `POST /api/crm/action` | Admin actions (approve, reject, ban) |
| `GET /api/crm/audit` | Audit log entries |
| `GET /api/crm/user/:id/products` | User's subscribed products |
| `GET /api/crm/history/:asin` | Price history for charting |
| `GET /audit` | Audit log HTML page |
| `POST /api/test-asin` | Test ASIN lookup |
| `POST /api/migrate-kv` | KV → D1 migration trigger |

Authentication: Telegram Web App `initData` verification using `TELEGRAM_WEBHOOK_SECRET`.

---

## 11. Internationalization — `src/core/i18n.js`

Full i18n dictionary with 200+ keys supporting:
- **English** (`en`)
- **Egyptian Arabic** (`ar`)

Key functions:
- `t(key, lang, params)` — Translate with optional interpolation
- `resolveLanguageCode(code)` — Normalize language codes
- `getWelcomeMessage(lang)` — Localized welcome message

User language is stored in `Users.lang` and resolved per-message in both the Telegram webhook and scraper engine.

---

## 12. Key Runtime Behaviors

### 12.1 Anti-Flap Timers (In-Memory)

The scraper engine uses in-memory anti-flap timers (not persisted to D1):
- **New/Used prices:** 2.5-hour grace period — if a price disappears, the old value is retained for 2.5 hours
- **Amazon.eg price:** 1-hour grace period

### 12.2 Broadcast Logic

When `TELEGRAM_PUBLIC_CHANNEL_ID` is set, the engine evaluates each price drop:
- **Standard deal:** z-score ≤ -1.5 AND drop ≥ 15%
- **ATL deal:** is_atl_new AND z-score ≤ -1.0 AND drop ≥ 10%
- **Throttle:** Max one broadcast per ASIN per 24 hours; must be lower than last broadcast price
- Broadcasts use organic Egyptian Arabic template

### 12.3 90-Day Subscription Expiry

Subscriptions older than 90 days are auto-paused with a notification sent to the user (differentiated message for target-price vs general tracking expiry).

### 12.4 Amazon API Token Caching

The Amazon access token is cached in KV (`amazon_access_token`) with a 55-minute TTL to avoid unnecessary token refreshes.
