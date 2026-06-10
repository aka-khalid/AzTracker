<div align="center">

<img src="assets/logo.png" alt="AzTracker Logo" width="200">

### The Serverless Amazon.eg Price Engine

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![ES6 JavaScript](https://img.shields.io/badge/ES6-JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Cloudflare D1](https://img.shields.io/badge/Cloudflare-D1-0051C3?style=for-the-badge&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)
[![Cloudflare KV](https://img.shields.io/badge/Cloudflare-KV-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/kv/)
[![Telegram API](https://img.shields.io/badge/Telegram-ChatOps-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white)](https://core.telegram.org/bots)

> A highly scalable, multi-tenant price tracking architecture built purely on Cloudflare Workers, D1 SQL, and Queues. It features an interactive ChatOps UI, dual-hysteresis anti-flap protection, and dynamic queue-based scheduling.

🔗 **Try the Bot:** [@AzTrackerr_bot](https://t.me/AzTrackerr_bot)

📢 **Live Demo (Public Deals Channel):** [@AzTrackerr](https://t.me/AzTrackerr)

<img src="assets/StatsGraphDemo.jpg" alt="AzTracker Analytics Graph" width="400">
</div>

---

## 🚀 Key Engineering Achievements

### 🗄️ Hybrid Database Architecture (D1 + KV)
AzTracker strictly separates relational state from time-series telemetry. **Cloudflare D1 (SQLite)** handles all user tracking, subscriptions, concurrency locks, audit logs, and the Hysteresis Engine via the `DB` binding. **Cloudflare KV** (bound as `AZTRACKER_DB`) serves as a NoSQL document store for massive time-series arrays (`history:{asin}`), the Omnichannel Global Matrix (`global:history_all_new`), and cached Amazon access tokens — dropping database read-exhaustion to near zero.

### 🛡️ Edge-Rendered CRM & SIEM Auditing
The **👑 Admin Panel** button within the `/start` menu opens an edge-rendered, Tailwind-styled Command Center Web App served directly from the Worker. Authentication uses Telegram Web App `initData` verified via HMAC-SHA256 against `TELEGRAM_BOT_TOKEN`. The `/audit` route serves a forensic SIEM ledger page, secured via HMAC-SHA256 signature tokens verified against `TELEGRAM_WEBHOOK_SECRET`. The `/api/crm/audit` endpoint returns the 50 most recent audit log entries from D1.

### ⚛️ Decoupled Async Message Delivery
Telegram alerts are decoupled from the main scraper engine using Cloudflare Queues (`telegram-outbox`, bound as `MESSAGE_QUEUE`). The queue worker updates D1 `alert_sent_new` / `alert_sent_used` flags **only** on a successful HTTP 200 Telegram delivery — creating a Two-Phase Commit (2PC) that prevents duplicate alerts. Failed deliveries trigger automatic retry with exponential backoff, and Telegram 429 rate-limit responses are handled with `retry_after` respect.

### 📦 Smart Alternatives & Hidden Warehouse Deals
The engine parses complex condition sub-schemas from the Amazon Creators API (New, Used, Refurbished, Renewed, Collectible, and sub-conditions like Like New, Very Good, Good, Acceptable, Open Box) to unearth hidden "Amazon Resale" (Warehouse) deals. The `buildSmartAlternatives()` function renders contextual checkout buttons for Amazon.eg and Amazon Resale alternatives directly in alert messages and the product view UI.

### 📉 Distributed Scraping with Dynamic Governor Logic
The scraper engine processes products in batches of 10 via Cloudflare Queues (`scraper-queue`, bound as `SCRAPER_QUEUE`). A dynamic Governor in the cron trigger calculates optimal batch sizes and distribution intervals based on the total active subscription pool: `batches = ceil(poolSize / 10)`, `maxRuns = floor(8640 / batches)`, `intervalMs = floor(86400000 / maxRuns)`. Each batch recursively enqueues the next with a 1-second linear delay, creating a self-perpetuating chain reaction.

---

## 🛠️ Architecture Pipeline

```mermaid
graph TD;
    User([📱 User Drops Amazon Link]) --> Webhook[⚡ Telegram Webhook Route];
    Webhook --> D1[(☁️ CF D1: Users, Subs, Audit)];
    Webhook --> KV[(☁️ CF KV: Price History, Tokens)];
    Cron[⏱️ CF Cron Trigger] --> Governor[⚡ Dynamic Governor];
    Governor -- "Dispatches offset:0" --> SQ[📦 CF Queue: scraper-queue];
    SQ --> Engine[⚙️ Scraper Engine Worker];
    Engine -- "Batched Creators API Call" --> CreatorsAPI[🛒 Amazon Creators API];
    CreatorsAPI -- "Live Prices + Arabic Names" --> Engine;
    Engine -- "Anti-Flap + Price Deltas" --> KV;
    Engine -- "Updates Global State" --> D1;
    Engine -- "Pushes Alerts + Broadcasts" --> TQ[📦 CF Queue: telegram-outbox];
    TQ --> QW[⚙️ Queue Worker];
    QW -- "2PC: Update D1 on 200 OK" --> D1;
    QW -- "sendMessage" --> TG[📲 Telegram API];
```

---

## ✨ System Features

* 👥 **Automated Join Queue:** Built-in ChatOps approval pipeline with a strict depth limit of 25 (`QUEUE_MAX_DEPTH`). Users request access via an inline button; admins approve or reject with full audit logging. Duplicate clicks are safely deduplicated.
* 🌍 **Dynamic Geofencing:** Automatically parses incoming links and hard-rejects non-supported regions. The database is securely locked to `amazon.eg` — only links resolving to `amazon.eg` are accepted.
* 🎯 **Strict Boolean Target Locks:** Users set specific budget targets. The engine uses `alert_sent_new` and `alert_sent_used` boolean flags to alert exactly once per condition type when the target price is met or beaten. Targets auto-reset when price rises above target.
* 📦 **Deduplicated Batch Processing:** The scraper uses `SELECT DISTINCT` across all active subscriptions — 10 users tracking the same ASIN triggers only 1 API request. Results are fan-out to all matching subscribers in-memory.
* 🔄 **Anti-Flap Hysteresis:** In-memory timers (2.5h for new/used, 1h for Amazon.eg) prevent phantom price oscillations from triggering false alerts when the API temporarily returns null for a listing.
* 🌐 **Bilingual UI (EN/AR):** Full i18n localization engine with Professional Masry Egyptian Arabic. Every user-facing string — menus, alerts, CRM dashboard — is rendered in the user's preferred language, detected from Telegram OS settings on first interaction.
* 📊 **Price History Charts:** The CRM dashboard renders interactive price history charts (Chart.js) using KV-stored time-series data, with ATH/ATL/Avg metrics.
* 📢 **Public Deal Broadcasting:** The best deal of each scrape cycle (determined by z-score and drop percentage) is broadcast to a public Telegram channel in organic Egyptian Arabic.

---

## ⚙️ Routing Logic & Architecture

The application is structured entirely using ES6 Modules within the `src/` directory, exporting fetch, queue, and scheduled handlers through [`src/index.js`](src/index.js).

### 🚏 Core Routes (`src/routes/`)

| File | Route | Description |
|------|-------|-------------|
| [`telegram_webhook.js`](src/routes/telegram_webhook.js) | `POST /webhook`, `POST /webhook/*` | Primary Telegram Bot interface. Handles messages (link parsing, ASIN extraction, product registration, target setting) and callbacks (join queue, admin actions, product management, language toggle). Secured via `X-Telegram-Bot-Api-Secret-Token` header. |
| [`crm_dashboard.js`](src/routes/crm_dashboard.js) | `GET /crm` | Serves the edge-rendered Admin Command Center Web App (Tailwind CSS, Chart.js, Telegram Web App). |
| [`crm_dashboard.js`](src/routes/crm_dashboard.js) | `GET /api/crm/data` | Returns system stats, user directory, and join queue. Cached at edge (60s). Auth via Telegram `initData`. |
| [`crm_dashboard.js`](src/routes/crm_dashboard.js) | `GET /api/crm/user/:id` | Returns a specific user's tracked products with live pricing. Auth via Telegram `initData`. |
| [`crm_dashboard.js`](src/routes/crm_dashboard.js) | `POST /api/crm/action` | Administrative mutations: approve, reject, revoke, unban, promote, demote, set_limit, delete_product, pause_product, resume_product, set_target, direct_message, broadcast, restore_kv, force_scrape. Auth via Telegram `initData`. |
| [`crm_dashboard.js`](src/routes/crm_dashboard.js) | `GET /api/crm/history/:asin` | Returns KV-stored price history for chart rendering. Auth via Telegram `initData`. |
| [`crm_dashboard.js`](src/routes/crm_dashboard.js) | `GET /audit` | Serves the SIEM audit ledger HTML page. Secured via HMAC-SHA256 signature (`TELEGRAM_WEBHOOK_SECRET`). |
| [`crm_dashboard.js`](src/routes/crm_dashboard.js) | `GET /api/audit` | Returns the 50 most recent audit log entries from D1. Secured via HMAC-SHA256 signature. |
| [`crm_dashboard.js`](src/routes/crm_dashboard.js) | `GET /api/test-asin` | Debug endpoint: fetches live ASIN data from Creators API with Arabic name resolution. |
| [`crm_dashboard.js`](src/routes/crm_dashboard.js) | `GET /api/migrate-kv` | One-time migration endpoint: imports legacy KV user/product data into D1. Root admin only. |

### 🔧 Core Modules (`src/core/`)

| File | Description |
|------|-------------|
| [`amazon.js`](src/amazon.js) | Amazon Creators API client. OAuth2 token management, `getItems()` (batch ASIN lookup, max 10), `getItemsWithArabic()` (Arabic title via `languagesOfPreference: ar_AE`), `scrapeArabicTitle()` (fallback HTML scrape), and `parseItem()` (condition sub-schema parsing for New/Used/Resale/Amazon.eg). |
| [`db.js`](src/core/db.js) | Database helpers: `getUserRoles()` (role resolution with edge caching), `resolveUserProfile()` (Telegram getChat with caching), `logAudit()` (writes to `Audit_Logs` table), `cleanupDatabase()` (Bot_States GC). |
| [`telegram.js`](src/core/telegram.js) | Telegram API wrappers: `sendTelegramMessage()`, `editTelegramMessage()`, `deleteMessage()`, `answerCallbackQuery()`. |
| [`i18n.js`](src/core/i18n.js) | Localization engine with 200+ keys supporting EN and Professional Masry Egyptian Arabic. Flat key structure: `t('category.key', lang, {vars})`. Includes `resolveLanguageCode()` and `getWelcomeMessage()`. |
| [`utils.js`](src/core/utils.js) | Shared utilities: `escapeHtml()`, `formatEGP()`, `truncateName()`, `getCairoTime()`, `delay()`. |

### 🔄 Background Jobs (`src/workers/`)

| File | Trigger | Description |
|------|---------|-------------|
| [`cron_trigger.js`](src/workers/cron_trigger.js) | Cloudflare Cron (currently disabled) | Performs D1 garbage collection on expired `Bot_States`. Calculates dynamic scraping interval based on active pool size. Dispatches the first batch to `scraper-queue` when the interval has elapsed. |
| [`scraper_engine.js`](src/workers/scraper_engine.js) | `scraper-queue` messages | Core Creators API consumer. Fetches 10 products per batch, resolves Arabic names, applies anti-flap hysteresis, evaluates price changes against target locks, pushes history to KV, updates D1, and enqueues alerts to `telegram-outbox`. Broadcasts the best deal to the public channel. |
| [`queue_worker.js`](src/workers/queue_worker.js) | Both queues | Consumer for `scraper-queue` (triggers `executeScrapeEngine`) and `telegram-outbox` (delivers via Telegram API). Implements 2PC: D1 alert flags updated only on successful delivery. Handles 429 rate limits, 403 blocked users (auto-pause), and automatic retries. |

### 📦 API Module (`src/api/`)

| File | Description |
|------|-------------|
| [`amazon.ts`](src/api/amazon.ts) | TypeScript mirror of `src/core/amazon.js` with typed interfaces (`AmazonItem`). Contains identical `AmazonEdgeParser` class and `getAmazonAccessToken()` function. |

---

## 🔑 Environment Variables & Secrets

### Plaintext Variables (set in `wrangler.toml` `[vars]`)

| Variable | Description |
|----------|-------------|
| `DEFAULT_USER_PRODUCT_LIMIT` | Global limit on concurrent tracks per user (default: `"3"`). |
| `GLOBAL_POOL_LIMIT` | Maximum active products in the global pool (default: `"450"`). |
| `GITHUB_OWNER` | GitHub owner for the project (default: `"aka-khalid"`). |
| `GITHUB_REPO` | GitHub repository name (default: `"AzTracker"`). |

### Secrets (must be injected via `wrangler secret put`)

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token. Used for all Telegram API calls and Web App initData verification. |
| `TELEGRAM_WEBHOOK_SECRET` | Secret token to validate incoming Telegram webhook requests (`X-Telegram-Bot-Api-Secret-Token` header). Also used for HMAC-SHA256 audit route signatures. |
| `TELEGRAM_ROOT_ADMIN_IDS` | Comma-separated list of root-level Telegram user IDs. Root admins cannot be revoked/demoted and have access to KV restoration and broadcasting. |
| `AMAZON_CLIENT_ID` | Amazon Creators API Credential ID. Also read from `AMZN_CREATORS_ACCESS_KEY` or `AWS_ACCESS_KEY_ID` as fallback. |
| `AMAZON_CLIENT_SECRET` | Amazon Creators API Secret. Also read from `AMZN_CREATORS_SECRET_KEY` or `AWS_SECRET_ACCESS_KEY` as fallback. |
| `AMAZON_PARTNER_TAG` | Amazon Associates Tracking ID for product URLs (used in affiliate link generation). |
| `AMZN_ASSOCIATES_TAG` | Amazon Associates Tracking ID for the Creators API payload (`partnerTag` field). |
| `TELEGRAM_PUBLIC_CHANNEL_ID` | Target channel ID for automated deal broadcasting (e.g., `@AzTrackerr`). |

### Cloudflare Bindings (configured in `wrangler.toml`)

| Binding | Type | Name |
|---------|------|------|
| `DB` | D1 Database | `aztracker-test-db` (dev) / `aztracker-prod-db` (prod) |
| `AZTRACKER_DB` | KV Namespace | `90fcfcb742fe4d7299087c076bd1ba4d` |
| `MESSAGE_QUEUE` | Queue Producer | `telegram-outbox` |
| `SCRAPER_QUEUE` | Queue Producer | `scraper-queue` |

---

## 👨‍💻 Architect & Acknowledgements

Engineered and maintained by **Khalid Ibrahim**, built upon core cloud infrastructure and system architecture principles.

Special thanks to **[Abdelrahman Elkhayat](https://www.facebook.com/bodaa.elkhayat)** for generously providing the Amazon Creators API credentials that power the core tracking engine.
