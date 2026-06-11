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
| `AZTRACKER_DB` | _your KV namespace ID_ | Yes — same ID in both environments |

> **Note:** Create the KV namespace with `npx wrangler kv:namespace create AZTRACKER_DB` and paste the returned ID into `wrangler.toml`. Never commit actual namespace IDs to version control.

### 2.3 D1 Databases

| Environment | Name | ID |
|---|---|---|
| Development | `aztracker-test-db` | _your D1 database ID_ |
| Production | `aztracker-prod-db` | _your D1 database ID_ |

> **Note:** Create databases with `npx wrangler d1 create <name>` and paste the returned `database_id` into `wrangler.toml`. Never commit actual database IDs to version control.

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
| `GITHUB_OWNER` | _your GitHub username_ | `crm_dashboard.js` (GitHub issue tracking) |
| `GITHUB_REPO` | _your repo name_ | `crm_dashboard.js` |
| `DEFAULT_USER_PRODUCT_LIMIT` | `"3"` | `telegram_webhook.js`, `crm_dashboard.js` |

---

## 3. D1 Schema — `schema.sql`

Seven tables:

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

### 3.7 `Join_Queue`

Stores pending user access requests. Defined in `schema.sql` (Section 2 of the schema).

| Column | Type | Notes |
|---|---|---|
| `chat_id` | TEXT PK | Telegram chat ID |
| `first_name` | TEXT | User's first name |
| `username` | TEXT | Telegram username |
| `requested_at` | INTEGER | Unix ms |
| `admin_messages` | TEXT | JSON array of admin messages |

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

Command-line flags:
- `--env prod` — target production (default: dev)
- `--db <name>` — D1 database name (default: `aztracker-test-db` for dev, `aztracker-prod-db` for prod)
- `--skip-migration` — skip KV → D1 data migration
- `--skip-secrets` — skip secret injection
- `--skip-webhook` — skip Telegram webhook registration
- `--dry-run` — print actions without making changes

Steps performed:
1. Checks prerequisites (Node.js, wrangler, auth, schema.sql, migration script)
2. Prompts for required values (bot token, admin IDs, Amazon credentials, worker URL) — or reads from environment variables
3. Generates a random `TELEGRAM_WEBHOOK_SECRET` (16-byte hex)
4. Injects all 7 secrets via `npx wrangler secret put`
5. Registers webhook with Telegram API (`setWebhook`)
6. Runs `scripts/migrate_to_d1.js` to generate `d1_seed.sql` from `kv_export.json`
7. Pushes `d1_seed.sql` to D1 via `npx wrangler d1 execute`

**Note:** `scripts/export_kv.js` is **commented out** in `finalize_cutover.js` with a warning not to uncomment (STDERR write EOF error). The migration runs from any existing `kv_export.json` file.

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

### 9.3 `seed_d1.js` — Apply D1 SQL Seed via Cloudflare REST API

Applies a SQL seed file to a D1 database via the Cloudflare REST API (no wrangler CLI required). Handles statement splitting, progress reporting, and per-statement error recovery.

**Options:**

| Flag | Default | Purpose |
|---|---|---|
| `--file <path>` | `./d1_seed.sql` | Path to SQL seed file |
| `--account-id <id>` | `CF_ACCOUNT_ID` env | Cloudflare account ID |
| `--db-id <id>` | `D1_DATABASE_ID` env | D1 database ID |
| `--api-token <token>` | `CF_API_TOKEN` env | Cloudflare API token (D1: Read & Write) |

**Usage:**
```bash
# Apply default d1_seed.sql (reads credentials from env):
node scripts/seed_d1.js

# Custom file + explicit credentials:
node scripts/seed_d1.js --file ./d1_seed.sql --db-id abc123 --api-token YOUR_TOKEN
```

**Behavior:**
1. Reads the seed file and splits into individual SQL statements (delimited by `;`)
2. Executes each statement sequentially via `POST /client/v4/accounts/{id}/d1/database/{id}/query`
3. Reports progress every 10 statements
4. On error: logs the failed SQL and continues (does not abort)
5. Exits with code 1 if any statements failed

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

---

## 13. Fresh Deployment Checklist

Use this checklist for a first-time deployment from scratch:

- [ ] Install Node.js 18+ and wrangler (`npm install -g wrangler`)
- [ ] Run `npx wrangler login` (opens browser for OAuth)
- [ ] Clone repo and run `npm install`
- [ ] Create KV namespace: `npx wrangler kv:namespace create AZTRACKER_DB`
- [ ] Create D1 database: `npx wrangler d1 create aztracker-test-db`
- [ ] Update `wrangler.toml` with the returned IDs
- [ ] Apply schema: `npx wrangler d1 execute aztracker-test-db --local --file=./schema.sql`
- [ ] Inject all secrets via `npx wrangler secret put` (see Section 4)
- [ ] Deploy: `npx wrangler deploy`
- [ ] Register Telegram webhook (see Section 6.5 or use `finalize_cutover.js`)
- [ ] Test with `/start` in Telegram
- [ ] Verify CRM dashboard at worker URL

---

## 14. Troubleshooting

### "wrangler: command not found"

```bash
npm install -g wrangler
```

### "Not authenticated" Error

```bash
npx wrangler login
```

### "Database not found" Error

Verify the `database_id` in `wrangler.toml`. List databases:

```bash
npx wrangler d1 list
```

### "Table already exists" Error

The schema uses `CREATE TABLE IF NOT EXISTS` — safe to re-run.

### "KV namespace not found"

Verify the `id` in `wrangler.toml` under `[[kv_namespaces]]`. List namespaces:

```bash
npx wrangler kv:namespace list
```

### "Webhook not working"

1. Check that the bot token is correct
2. Check that the worker URL is accessible
3. Verify the webhook secret matches between Telegram and your worker
4. Check worker logs: `npx wrangler tail`

### "Secrets not loading"

Secrets are injected at deploy time. If you added secrets after deploying, re-deploy:

```bash
npx wrangler deploy
```

### "D1 foreign key errors"

The seed file wraps inserts with `PRAGMA foreign_keys = OFF` / `ON`. If applying manually, add these pragmas.

### Migration: "No kv_export.json found"

Run with `--export-kv` to fetch from Cloudflare API:

```bash
node scripts/migrate_to_d1.js --export-kv --api-token YOUR_API_TOKEN
```

### Migration: "SQL syntax error in seed"

The seed uses `INSERT OR IGNORE` which requires SQLite 3.24+. D1 supports this. Run with `--dry-run` to inspect the generated SQL.

---

## 15. Environment Variable Reference

### Worker Runtime Secrets (set via `wrangler secret put`)

| Secret | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot authentication |
| `TELEGRAM_ROOT_ADMIN_IDS` | Yes | Root admin access (comma-separated) |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | Webhook HMAC verification |
| `AMAZON_CLIENT_ID` | Yes | Amazon Creators API |
| `AMAZON_CLIENT_SECRET` | Yes | Amazon Creators API |
| `AMZN_ASSOCIATES_TAG` | Yes | Amazon Associates tag |
| `AMAZON_PARTNER_TAG` | Yes | Amazon partner tag |
| `TELEGRAM_PUBLIC_CHANNEL_ID` | No | Broadcast channel for deals |

### For `finalize_cutover.js`

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token from @BotFather |
| `TELEGRAM_ROOT_ADMIN_IDS` | Yes | Comma-separated admin chat IDs |
| `AMAZON_CLIENT_ID` | Yes | Amazon Creators API client ID |
| `AMAZON_CLIENT_SECRET` | Yes | Amazon Creators API client secret |
| `AMAZON_PARTNER_TAG` | Yes | Amazon partner tag for affiliate links |
| `AMZN_ASSOCIATES_TAG` | Yes | Amazon Associates tag |
| `WORKER_URL` | Yes | Full worker URL (without https://) |
| `CF_ACCOUNT_ID` | For migration | Cloudflare account ID |
| `CF_API_TOKEN` | For migration | Cloudflare API token |
| `CF_KV_NAMESPACE_ID` | For migration | KV namespace ID |

### For `migrate_to_d1.js`

| Variable | Required | Description |
|---|---|---|
| `CF_ACCOUNT_ID` | For --export-kv | Cloudflare account ID |
| `CF_API_TOKEN` | For --export-kv | Cloudflare API token (KV Read) |
| `CF_KV_NAMESPACE_ID` | For --export-kv | KV namespace to export |

### For `seed_d1.js`

| Variable | Required | Description |
|---|---|---|
| `CF_ACCOUNT_ID` | Yes | Cloudflare account ID |
| `D1_DATABASE_ID` | Yes | D1 database ID |
| `CF_API_TOKEN` | Yes | Cloudflare API token (D1 Read & Write) |
