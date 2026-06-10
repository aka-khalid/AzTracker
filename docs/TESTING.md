# AzTracker Test Suite & Diagnostic Vectors

This document serves as the living test specification for the current asynchronous ES6 architectural phases.

**Testing Philosophy:** To preserve AzTracker's low-list, minimalist architectural design, we strictly avoid heavy automated End-to-End (E2E) frameworks (like Selenium or Playwright) that would artificially drain Cloudflare KV and D1 Read/List allocations. Instead, we utilize **Edge-Diagnostic Test Vectors** -- lightweight, authenticated mock payloads temporarily injected into our Cloudflare Queues -- and localized diagnostic logs.

---

## Phase 5: Scraper Engine & Queue Pagination

These tests validate the Edge-Node's ability to gracefully handle Amazon API fetching and paginate through the D1 database asynchronously without timing out the worker.

| Test ID | Feature Target | Diagnostic Vector / Execution Method | Expected Success Criterion |
| :--- | :--- | :--- | :--- |
| **TC-501** | Queue Pagination (Recurse) | Push a mock payload to `scraper-queue` with `offset: 0` and ensure > 10 items in DB. | `src/workers/scraper_engine.js` processes 10 items, returns `true` (i.e. `staleProducts.length === 10`), and `src/workers/queue_worker.js` automatically sends a new message to `scraper-queue` with `offset: 10` and a **1-second** delay. |
| **TC-502** | Scraper API Outage (Failsafe) | Mock the Amazon Creators API to return 0 items for a batch of **>= 5** active ASINs. | `scraper_engine.js` throws an Error (`"0 items returned from Amazon"`) at the failsafe check (line 109-112), causing `queue_worker.js` to call `msg.retry({ delaySeconds: 30 })`, aborting the chain and retrying automatically. **Note:** The failsafe only triggers when `staleProducts.length >= 5`; batches smaller than 5 are allowed to return 0 items without throwing. |
| **TC-503** | Auth Token Expiration | Mock a missing or expired `amazon_access_token` in KV. | The engine successfully acquires a new token via `getAmazonAccessToken()` and stores it in KV with a **3300s (55-minute)** TTL using `expirationTtl`. If token acquisition fails entirely, the engine returns `false` (abort chain without throwing). |
| **TC-504** | Out-of-Stock Failsafe | N/A -- this behavior was **removed** in a later phase. Products are no longer auto-delisted or paused when absent from a scrape batch. Anti-flap timers (2.5h for new/used, 1h for amazon) are in-memory only and do not persist to D1. | Verify that missing ASINs in the API response do NOT trigger any D1 update or subscription pause. The `delisted` column and the 24h-missing check have been removed from `scraper_engine.js`. |

---

## Phase 6: Operational Tooling & Setup

These tests validate the environment configuration automation, ensuring frictionless onboarding for new deployments.

| Test ID | Feature Target | Diagnostic Vector / Execution Method | Expected Success Criterion |
| :--- | :--- | :--- | :--- |
| **TC-601** | Cutover Initialization | Run `node finalize_cutover.js` and select Development [1]. | Prompts process successfully without crashing and generates a **32-character hex** (16-byte) cryptographically secure webhook token via `crypto.randomBytes(16).toString('hex')`. |
| **TC-602** | Worker Secret Injection | Verify Cloudflare secret injection via `npx wrangler secret put`. | The script correctly issues sequential `wrangler secret put` commands for `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ROOT_ADMIN_IDS`, `TELEGRAM_WEBHOOK_SECRET`, `AMAZON_CLIENT_ID`, `AMAZON_CLIENT_SECRET`, `AMAZON_PARTNER_TAG`, and `AMZN_ASSOCIATES_TAG`. |
| **TC-603** | Telegram Webhook | Trigger the webhook registration step in `finalize_cutover.js`. | Telegram API responds with `ok: true` confirming the webhook was set with the `secret_token` query parameter appended to the URL. |
| **TC-604** | D1 Migration | Run `node scripts/migrate_to_d1.js` followed by `npx wrangler d1 execute aztracker-test-db --local --file=./d1_seed.sql`. | The script reads `kv_export.json` and generates `d1_seed.sql` with `INSERT OR IGNORE` for Users and User_Subscriptions, and `INSERT OR REPLACE` for Global_Products. Verify the SQL is syntactically valid by running with `--local` first. |
| **TC-605** | D1 Idempotency | Re-run the same `d1_seed.sql` against the same database. | No duplicate rows appear. `INSERT OR IGNORE` prevents duplicate Users and Subscriptions; `INSERT OR REPLACE` updates Global_Products in place. |

---

## Phase 7: Asynchronous Telegram Outbox & Rate Limits

These tests validate the `telegram-outbox` and dynamic API rate-limit backoff logic handling within `src/workers/queue_worker.js`.

| Test ID | Feature Target | Diagnostic Vector / Execution Method | Expected Success Criterion |
| :--- | :--- | :--- | :--- |
| **TC-701** | Asynchronous Payload Queueing | Trigger a mock price drop in `executeScrapeEngine`. | The engine does NOT block for Telegram. It pushes payloads to the `telegram-outbox` via `env.MESSAGE_QUEUE.sendBatch()`. Alert payloads use types `telegram_alert`, `telegram_alert_new`, or `telegram_alert_used`. Broadcast payloads use type `telegram_alert` targeted at `env.TELEGRAM_PUBLIC_CHANNEL_ID`. |
| **TC-702** | Telegram Rate-Limit (429) | Mock the Telegram API to return a `429 Too Many Requests` with `retry_after: 5`. | `queue_worker.js` catches the 429, sets `rateLimited = true`, reads `res.parameters?.retry_after` (default 5), and calls `msg.retry({ delaySeconds: retryDelay })`. All subsequent messages in the batch are deferred with the same delay. |
| **TC-703** | Telegram Blocked Bot (403) | Mock the Telegram API to return a `403 Forbidden` for a specific `chatId`. | `queue_worker.js` catches the 403, executes a D1 update `UPDATE User_Subscriptions SET is_paused = 1 WHERE chat_id = ?`, and calls `msg.ack()` (does not retry). |
| **TC-704** | Atomic 2PC State Update | Mock a successful 200 OK from Telegram for a `telegram_alert_new` message with a valid `asin`. | The queue worker issues a D1 update `UPDATE User_Subscriptions SET alert_sent_new = 1 WHERE chat_id = ? AND asin = ?` ONLY after successful delivery, confirming the 2-Phase Commit mechanism. For `telegram_alert_used`, the `alert_sent_used` column is updated analogously. For plain `telegram_alert` type, no 2PC update occurs. |
| **TC-705** | Omnichannel Broadcast | Mock an Exceptional Deal (Z-Score <= -1.5 AND drop >= 15%, OR All-Time Low with Z-Score <= -1.0 AND drop >= 10%) in the batch results. | The engine pushes exactly one broadcast payload to `env.MESSAGE_QUEUE` targeting `env.TELEGRAM_PUBLIC_CHANNEL_ID` with `type: 'telegram_alert'`. The broadcast uses **Arabic product name** (`name_ar`) when available, falling back to English `name`. The D1 is updated with `last_broadcast_time_ms` and `last_broadcast_price` for the ASIN. |

---

## Phase 8: i18n Localization (Phase 6.10)

These tests validate the bilingual localization engine and per-user language rendering throughout the bot.

| Test ID | Feature Target | Diagnostic Vector / Execution Method | Expected Success Criterion |
| :--- | :--- | :--- | :--- |
| **TC-801** | Translation Lookup (English) | Call `t('access.denied_head', 'en')` from `src/core/i18n.js`. | Returns `"⛔ <b>Access Denied</b>"`. |
| **TC-802** | Translation Lookup (Arabic) | Call `t('access.denied_head', 'ar')` from `src/core/i18n.js`. | Returns `"⛔ <b>ممنوع الدخول</b>"`. |
| **TC-803** | Placeholder Substitution | Call `t('link.limit_reached_body', 'ar', { used: 5, limit: 3 })`. | Returns Arabic string with `{used}` replaced by `5` and `{limit}` replaced by `3`: `"عندك 5 منتجات محفوظة، بس حدك الحالي 3."` |
| **TC-804** | Missing Key Fallback | Call `t('nonexistent.key', 'ar')`. | Returns the key string `"nonexistent.key"` and logs a console warning. |
| **TC-805** | Missing Language Fallback | Call `t('access.denied_head', 'fr')` (unsupported language). | Falls back to English: `"⛔ <b>Access Denied</b>"`. |
| **TC-806** | Language Code Resolution | Call `resolveLanguageCode('ar-EG')` and `resolveLanguageCode('en-US')`. | Returns `'ar'` for any code starting with `'ar'`, and `'en'` for everything else (including `null`/`undefined`). |
| **TC-807** | Toggle Language (Callback) | Send `callback_query` with `data: "toggle_lang"` from `src/routes/telegram_webhook.js`. | The handler flips `lang`: `'en'` becomes `'ar'` and vice versa. The DB is updated via `UPDATE Users SET lang = ? WHERE chat_id = ?`, the edge cache is busted, and the main menu is re-rendered in the new language. |
| **TC-808** | OS Language Detection on /start | Send `/start` with `message.from.language_code = 'ar'` and the user's `lang` IS NULL in DB. | The webhook handler sets `lang` from OS detection on first interaction only (`WHERE chat_id = ? AND lang IS NULL`). On subsequent `/start` calls, the existing DB lang is preserved. |
| **TC-809** | Welcome Message Rendering | Call `getWelcomeMessage('ar', 3)`. | Returns a multi-line Arabic welcome message with all 5 steps, pro-tip, and `{limit}` interpolated as `3`. |
| **TC-810** | Product List Name Resolution | View product list with `lang = 'ar'` for a product that has `name_ar` set in D1. | `src/routes/telegram_webhook.js` renders the Arabic name via `resolveProductName(p, lang)` (line 736). If `name_ar` is NULL, falls back to English `name`. |
| **TC-811** | Alert Message Localization | Trigger a price drop alert for a user with `lang = 'ar'`. | `src/workers/scraper_engine.js` uses `t('alert.price_drop_head', lang)` and `t('chrome.currency_egp', lang)` etc. All user-facing strings in the alert are in Arabic, including `"ج.م"` for currency. |
| **TC-812** | CRM Dashboard RTL Rendering | Navigate to `/crm?lang=ar`. | `renderCrmHTML('ar')` generates HTML with `dir="rtl"` and `lang="ar"` on the `<html>` tag. All CRM labels use Arabic i18n keys (e.g., `"الناس"` for Users, `"ملخص سريع"` for System Overview). |
| **TC-813** | CRM Dashboard LTR (English) | Navigate to `/crm` or `/crm?lang=en`. | `renderCrmHTML('en')` generates HTML with `dir="ltr"` and `lang="en"`. |

---

## Phase 8: Creators API Integration (Phase 6.10)

These tests validate the Amazon Creators API token management, batch fetching, and Arabic name extraction.

| Test ID | Feature Target | Diagnostic Vector / Execution Method | Expected Success Criterion |
| :--- | :--- | :--- | :--- |
| **TC-820** | Token Acquisition | Call `getAmazonAccessToken(clientId, clientSecret)` with valid staging credentials. | POSTs to `https://api.amazon.com/auth/o2/token` with `grant_type: 'client_credentials'` and `scope: 'creatorsapi::default'`. Returns an `access_token` string. |
| **TC-821** | Token Caching in KV | After successful token acquisition, check `env.AZTRACKER_DB`. | Token is stored under key `'amazon_access_token'` with `expirationTtl: 3300`. Subsequent calls within the TTL window skip the HTTP request. |
| **TC-822** | Batch Item Fetching | Call `parser.getItems(['B094HJ4JSH'])` (single ASIN). | POSTs to `https://creatorsapi.amazon/catalog/v1/getItems` with `itemIds`, `itemIdType: 'ASIN'`, and the 5 standard resources. Returns a parsed item object with `asin`, `name`, `newPrice`, `usedPrice`, `amazonPrice`, seller info, and buy box flag. |
| **TC-823** | Batch Size Limit | Call `parser.getItems([...11 ASINs])`. | Throws an Error: `"Batch size exceeds 10 ASINs limit."`. |
| **TC-824** | Arabic Title Fetch (API) | Call `parser.getItemsWithArabic([asin])`. | POSTs with `languagesOfPreference: ['ar_AE']`. Returns a `Map<asin, arabicTitle>` where titles contain Arabic characters (verified via `containsArabic()`). |
| **TC-825** | Arabic Title Fallback (Scraping) | Mock the Creators API to return no Arabic titles, triggering `scrapeArabicTitle(asin)`. | Fetches `https://www.amazon.eg/dp/{asin}` with `Accept-Language: ar,ar-EG;q=0.9`, parses the HTML for `id="productTitle"`, and returns the title only if it contains Arabic characters. |
| **TC-826** | Condition Parsing (New) | Parse an API response listing with `Condition.Value = "New"`. | `parseItem()` categorizes under `parsed.newPrice` / `parsed.newSeller` / `parsed.newMid`. |
| **TC-827** | Condition Parsing (Used) | Parse an API response listing with `Condition.Value = "Used"` and `SubCondition.Value = "Like New"`. | `parseItem()` categorizes under `parsed.usedPrice` / `parsed.usedSeller` / `parsed.usedMid` via the `usedTokens`/`subTokens` matching logic. |
| **TC-828** | Condition Parsing (Amazon Resale) | Parse a listing where seller name contains "resale" or merchant ID matches `A2N2MP47XAP1MK`. | Categorized as used price regardless of condition label. |
| **TC-829** | containsArabic Helper | Call `containsArabic('منتج تجريبي')` and `containsArabic('Test Product')`. | Returns `true` for Arabic text (matches Unicode range `؀-ۿ` and extensions), `false` for Latin-only text. Returns `false` for `null`/`undefined`/empty string. |

---

## Phase 8: CRM Dashboard (Phase 6.10)

These tests validate the Telegram Web App-based CRM dashboard.

| Test ID | Feature Target | Diagnostic Vector / Execution Method | Expected Success Criterion |
| :--- | :--- | :--- | :--- |
| **TC-840** | CRM HTML Rendering | Send `GET /crm` to the worker. | Returns `renderCrmHTML('en')` with status 200 and `Content-Type: text/html;charset=UTF-8`. The HTML includes the Telegram Web App script, Tailwind CSS, Chart.js, and the i18n-rendered UI. |
| **TC-841** | CRM Auth Flow (Valid) | Send `GET /api/crm/data` with a valid `Authorization: Bearer <initData>` header. | `verifyInitData()` validates the HMAC-SHA256 signature from Telegram. `getUserRoles()` checks admin status. Returns JSON with `systemStats`, `users[]`, `joinQueue[]`, and `auth.isRootAdmin`. |
| **TC-842** | CRM Auth Flow (Invalid) | Send `GET /api/crm/data` with an invalid or missing Authorization header. | Returns HTTP 401 Unauthorized. |
| **TC-843** | CRM Auth Flow (Expired initData) | Craft an `initData` payload where `auth_date` is > 86400 seconds old. | `verifyInitData()` detects expired `auth_date` and returns `null`. Returns HTTP 401. |
| **TC-844** | Action: Approve User | Send `POST /api/crm/action` with `{ action: "approve", targetId: "<chat_id>" }`. | Upserts the user with `role = 'approved'`, removes from `Join_Queue`, sends a Telegram approval notification, busts the edge cache, and writes an `APPROVE_USER` audit log entry. |
| **TC-845** | Action: Reject User | Send `POST /api/crm/action` with `{ action: "reject", targetId: "<chat_id>" }`. | Removes from `Join_Queue`, sends a rejection Telegram notification, writes a `REJECT_USER` audit log entry. |
| **TC-846** | Action: Revoke User | Send `POST /api/crm/action` with `{ action: "revoke", targetId: "<chat_id>" }` as an admin. | Sets all user's subscriptions to `is_paused = 1`, updates user `role` to `'rejected'`, sends a revocation notification, writes a `REVOKE_USER` audit log entry. |
| **TC-847** | Action: Unban User | Send `POST /api/crm/action` with `{ action: "unban", targetId: "<chat_id>" }`. | Sets subscriptions to `is_paused = 0`, updates user `role` to `'approved'`, sends a restoration notification, writes an `UNBAN_USER` audit log entry. |
| **TC-848** | Action: Promote to Admin | Send `POST /api/crm/action` with `{ action: "promote", targetId: "<chat_id>" }` as **root admin** only. | Updates user `role` to `'admin'`, sends a promotion notification, busts caches for both admin and target user. Returns 403 if caller is not root admin. |
| **TC-849** | Action: Demote Admin | Send `POST /api/crm/action` with `{ action: "demote", targetId: "<chat_id>" }` as root admin. | Updates user `role` to `'approved'`, sends a demotion notification. Returns 403 if caller is not root admin. Returns 400 if attempting to demote self. |
| **TC-850** | Action: Set Limit | Send `POST /api/crm/action` with `{ action: "set_limit", targetId: "<id>", data: { limit: 10 } }`. | Updates `Users.item_limit` to 10, sends a limit update notification to the user, writes a `SET_TARGET` audit log entry. Returns 400 for invalid limit values. |
| **TC-851** | Action: Restore KV | Send `POST /api/crm/action` with `{ action: "restore_kv", targetId: "global" }` as root admin only. | Triggers an async process that reads user:<id>:products from KV, migrates products to D1 `Global_Products` (using `INSERT OR REPLACE`) and `User_Subscriptions`, migrates history, and sends a completion/failure Telegram message to the admin. Returns 202 with `{ status: "queued" }`. |
| **TC-852** | Action: Force Scrape | Send `POST /api/crm/action` with `{ action: "force_scrape" }`. | Sends `{ offset: 0 }` to `env.SCRAPER_QUEUE`, which starts the recursive chain. Polls `Global_Products.last_updated` for up to 2 minutes to confirm completion. Returns 202 with `{ status: "queued" }`. |
| **TC-853** | Action: Broadcast | Send `POST /api/crm/action` with `{ action: "broadcast", data: { message: "Test" } }` as root admin only. | Iterates all approved/admin users and sends each a Telegram message with the broadcast. Writes a `GLOBAL_BROADCAST` audit log entry. Returns 403 if caller is not root admin. |
| **TC-854** | Action: Direct Message | Send `POST /api/crm/action` with `{ action: "direct_message", targetId: "<id>", data: { message: "Hello" } }`. | Sends a formatted message to the target user and writes a `DIRECT_MESSAGE` audit log entry. |
| **TC-855** | User List Pagination (CRM) | Send `GET /api/crm/data` with > 20 approved users. | Returns the full user list in `users[]` array. The client-side JavaScript renders pagination with a search filter (`filterUsers()`). No server-side pagination -- the entire dataset is returned with `Cache-Control: s-maxage=60`. |
| **TC-856** | User Product Drawer | Send `GET /api/crm/user/<chat_id>` with a valid admin auth header. | Returns JSON array of user's subscriptions including `asin`, `target_price`, `is_paused`, `name`, `amazon_price`, `new_price`, `used_price`, `last_updated`, and seller info. |
| **TC-857** | Product Level Actions | Send `POST /api/crm/action` with `{ action: "pause_product", targetId: "<id>", data: { asin: "B094HJ4JSH" } }`. | Sets `User_Subscriptions.is_paused = 1` for the specific user+ASIN pair. `resume_product` sets it to 0. `delete_product` removes the subscription row entirely. `set_target` updates `target_price` and resets `alert_sent_new`/`alert_sent_used` to 0. |
| **TC-858** | Security Audit Log | Send `GET /api/crm/audit` with valid admin auth. | Returns up to 50 most recent `Audit_Logs` entries as JSON with `ts`, `adminId`, `adminHandle`, `action`, `target`, `targetHandle`, and `details`. |
| **TC-859** | SIEM Audit Page | Navigate to `/audit?exp=<timestamp>&sig=<hmac>` as a root admin. | `renderAuditHTML()` generates a standalone page with `dir="rtl"` or `dir="ltr"` based on `lang` param, loads audit logs via the `/api/audit` endpoint, and renders cards with timestamp, admin, action, target, and details. |

---

## Phase 9: Bilingual Product Names (Phase 6.11)

These tests validate the Arabic product name enrichment pipeline and bilingual broadcast rendering.

| Test ID | Feature Target | Diagnostic Vector / Execution Method | Expected Success Criterion |
| :--- | :--- | :--- | :--- |
| **TC-870** | Arabic Name Enrichment (Scraper) | During a scrape cycle, mock `getItemsWithArabic()` to return `{ 'B094HJ4JSH': 'منتج تجريبي' }`. | `scraper_engine.js` sets `item.name_ar` for matched ASINs. The value is persisted to D1 via `UPDATE Global_Products SET name_ar = COALESCE(?, name_ar)`. |
| **TC-871** | Arabic Name Scraping Fallback | Mock `getItemsWithArabic()` to return empty, triggering `scrapeArabicTitle(asin)`. | The scraper fetches `https://www.amazon.eg/dp/<asin>`, parses the `#productTitle` HTML element, and stores the Arabic title (only if `containsArabic()` returns `true`). A 200ms delay is applied between scrape requests. |
| **TC-872** | Arabic Name Non-Blocking Failure | Mock both `getItemsWithArabic()` and `scrapeArabicTitle()` to throw errors. | Errors are caught and logged via `console.warn`. Scrape cycle continues without Arabic names. No user-facing impact. |
| **TC-873** | Broadcast Uses Arabic Name | Trigger an exceptional deal broadcast for a product with `name_ar` set. | The broadcast message (line 539 of `scraper_engine.js`) uses `bestDeal.name_ar` (falling back to `bestDeal.name` if Arabic is absent). The rendered message shows the Arabic product name in the HTML. |
| **TC-874** | DM Alerts Use Per-User Language | Trigger a price drop for a user with `lang = 'ar'`. | `resolveProductName(liveItem, 'ar')` returns the Arabic name from `item.name_ar`. The alert message is fully in Arabic, including labels, currency (`ج.م`), and button text (`t('alert.btn_open_new', 'ar')` etc.). |
| **TC-875** | DM Alerts Fallback to English | Trigger a price drop for a user with `lang = 'ar'` but where `item.name_ar` is NULL. | `resolveProductName(liveItem, 'ar')` falls back to `item.name`. Alert labels remain in Arabic, but the product name is in English. |
| **TC-876** | Webhook Arabic Name on Link Submit | Submit an Amazon link via the bot with an Arabic-titled product. | `src/routes/telegram_webhook.js` fetches Arabic name via `getItemsWithArabic()` and `scrapeArabicTitle()` fallback. The `name_ar` is stored in `Global_Products` via `ON CONFLICT(asin) DO UPDATE SET name_ar = COALESCE(excluded.name_ar, name_ar)`. |
| **TC-877** | Arabic Name Persistence Without Price Change | Run a scrape where no price changed but Arabic name enrichment found new names. | `scraper_engine.js` (line 472-477) executes `UPDATE Global_Products SET last_updated = ?, name_ar = COALESCE(?, name_ar) WHERE asin = ?` even when `dbNeedsUpdate` is false. This ensures Arabic names are always persisted. |

---

## Phase 9: Scraper Queue Worker Deep-Dive (Phase 6.11)

These tests validate the complete queue_worker.js message format, 2PC handling, and scraper pagination.

| Test ID | Feature Target | Diagnostic Vector / Execution Method | Expected Success Criterion |
| :--- | :--- | :--- | :--- |
| **TC-890** | Scraper Queue Message Format | Send to `scraper-queue`: `{ offset: 0 }`. | `queue_worker.js` reads `msg.body.offset` (defaulting to 0), passes it to `executeScrapeEngine(env, offset)`, and uses the `hasMore` boolean return value to decide whether to recurse. |
| **TC-891** | Telegram Outbox Message Format | A `telegram_alert_new` message in `telegram-outbox` must include `chatId`, `text`, `type`, `asin`, and `markup`. | `queue_worker.js` reads `payload.chatId`, `payload.text`, and `payload.markup` and passes them to `sendTelegramMessage(env, payload.chatId, payload.text, payload.markup)`. The 2PC D1 query uses `payload.chatId` and `payload.asin`. |
| **TC-892** | 2PC for `telegram_alert_new` | Mock Telegram to return `{ ok: true }` for a `telegram_alert_new` message with `asin: 'B094HJ4JSH'`. | D1 executes `UPDATE User_Subscriptions SET alert_sent_new = 1 WHERE chat_id = ? AND asin = ?`. |
| **TC-893** | 2PC for `telegram_alert_used` | Mock Telegram to return `{ ok: true }` for a `telegram_alert_used` message with `asin: 'B094HJ4JSH'`. | D1 executes `UPDATE User_Subscriptions SET alert_sent_used = 1 WHERE chat_id = ? AND asin = ?`. |
| **TC-894** | No 2PC for plain `telegram_alert` | Mock Telegram to return `{ ok: true }` for a `telegram_alert` message. | No 2PC D1 update occurs. Only `msg.ack()` is called. |
| **TC-895** | DelaySeconds Syntax for msg.retry | Trigger a 429 with `retry_after: 5`. | `queue_worker.js` calls `msg.retry({ delaySeconds: 5 })` -- the `delaySeconds` key is the correct syntax for Cloudflare Queues batch-level retry. |
| **TC-896** | Recursive Scraper-Queue Pagination (Multi-Batch) | Seed 25 products in `Global_Products`. Run scraper-queue. | First call: offset=0, processes 10, returns `true`, enqueues offset=10 with 1s delay. Second call: offset=10, processes 10, returns `true`, enqueues offset=20 with 1s delay. Third call: offset=20, processes 5, returns `false` (5 !== 10), chain stops. |
| **TC-897** | Scraper Error Retry | Mock `executeScrapeEngine` to throw an error. | `queue_worker.js` catches the error and calls `msg.retry({ delaySeconds: 30 })`. The message is NOT acked. |
| **TC-898** | Generic Queue Error | Push a malformed message to `telegram-outbox` that causes `sendTelegramMessage` to throw. | `queue_worker.js` catches the error and calls `msg.retry()` (no delay -- uses default). |
| **TC-899** | Rate Limit Cascade | Mock the first message in a batch to return 429. | `rateLimited` is set to `true`. All subsequent messages in the same batch are deferred via `msg.retry({ delaySeconds: retryDelay })` without being processed. |

---

## Testing Execution Protocol

**For Queue Diagnostics & Edge-Testing:**

1. Ensure you are on the correct feature branch (`feature/phase-6.11-localization` or the relevant phase branch).
2. To trigger a manual scrape cycle via the CLI, inject a payload into the scraper queue:
   ```bash
   npx wrangler queues send scraper-queue --message '{"offset": 0}'
   ```
   **Note:** The `npx wrangler queues send` command takes the queue name as a positional argument and `--message` (or `-m`) for the body. The exact syntax may vary by Wrangler version; check `npx wrangler queues --help` for your installed version.
3. Use `npx wrangler tail` to monitor the logs. Verify that `src/workers/queue_worker.js` processes the offset, recursively queues the next offset if `hasMore` is true, and safely catches API errors.
4. For outbox monitoring, observe `npx wrangler tail` to ensure rate limits (429) are triggering `msg.retry()` rather than crashing the consumer.
5. Check your D1 database to ensure 2PC state locks (`alert_sent_new`, `alert_sent_used`) are only committed after successful Telegram delivery:
   ```bash
   npx wrangler d1 execute aztracker-test-db --local --command "SELECT chat_id, asin, alert_sent_new, alert_sent_used FROM User_Subscriptions LIMIT 10;"
   ```
6. For production D1 queries, add `--remote`:
   ```bash
   npx wrangler d1 execute aztracker-prod-db --remote --command "SELECT COUNT(*) FROM Users;"
   ```
7. To test the CRM dashboard locally, run `npx wrangler dev` and navigate to `http://localhost:8787/crm?lang=ar` for the Arabic RTL view or `http://localhost:8787/crm` for the English LTR view.
8. To test i18n translations directly, use the Wrangler REPL or add temporary console.log statements in `src/core/i18n.js` and observe the output in `npx wrangler tail`.
