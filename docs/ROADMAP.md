# 🗺️ AzTracker Architecture Roadmap & Tech Debt

This document tracks the technical debt, security fortifications, feature expansion milestones, and intentional architectural boundaries of the AzTracker engine.

## 🚀 Active Architecture: Core Engine Modernization (Phase 6)

- [x] **Phase 6.8: Native D1 Migration & UI Overhaul**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Eliminate legacy Cloudflare KV limits, establish relational data integrity, and build a unified interactive Command Center.
  **The Strategy:** Fully migrated the relational models (`Users`, `User_Subscriptions`, `Global_Products`, `Audit_Logs`, and `Bot_States`) to Cloudflare D1 (SQLite) using a native schema. Converted the legacy text commands into an interactive Telegram Web App CRM Dashboard built with Tailwind CSS. Integrated native Chart.js inline charts directly within the Web App, alongside a lazy history scrubber and security hardening.
  </details>

- [x] **Phase 6.10: Monolith Decomposition & Async Queues**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Break apart the legacy monolithic worker, transition to pure ES6 modules, and secure execution limits using isolated Cloudflare Queues.

  **The Strategy:** Decomposed the 2500+ line worker into a highly modular architecture (`src/core`, `src/routes`, `src/workers`, and `src/api`). Replaced the deprecated PA-API with the modern Creators API. Shifted the intensive Amazon scraping payload off the synchronous cron thread and into an asynchronous `scraper-queue` consumed by `src/workers/queue_worker.js`. Separated outbound Telegram notifications into a `telegram-outbox` queue (bound as `MESSAGE_QUEUE`) to gracefully handle HTTP 429 rate limits without crashing the main engine or violating the Two-Phase Commit boundary.

  **Execution Highlights:**
  - **Modular Architecture:** Split the monolith into `src/core` (i18n, db, auth), `src/routes` (CRM dashboard, telegram webhook), `src/workers` (scraper engine, queue worker), and `src/api` (TypeScript Creators API interface) — each with single-responsibility boundaries.
  - **Creators API Migration:** Replaced the deprecated PA-API with the modern Amazon Creators API (`creatorsapi.amazon/catalog/v1/getItems`), fixing condition parsing to support flattened string enums, subcondition token matching for `is_used_like_offer` parity, and enforcing `amazon.eg` merchant ID parity.
  - **Async Queue Pipeline:** Implemented `scraper-queue` for asynchronous scraping (self-perpetuating chain with delaySeconds:1) and `telegram-outbox` (bound as `MESSAGE_QUEUE`) for rate-limited Telegram dispatch, preventing cron timeouts and HTTP 429 storms.
  - **Two-Phase Commit Outbox:** Extended the 2PC pattern to the queue worker — `alert_sent_new` / `alert_sent_used` flags are only committed to D1 after confirmed Telegram HTTP 200 delivery, preventing phantom alerts on worker crashes. The worker also auto-pauses subscriptions on HTTP 403 (bot blocked).
  - **Python Parity Fixes (Gaps 9.1–9.8):** Closed 8 critical behavioral gaps vs the Python engine: `is_used_like_offer` parsing parity with full subcondition token list, `amazon_price` always tracked (including when Amazon.eg is buybox winner), product-card D1 query expansion with seller/alternatives and `seen_amazon_eg_at`/`seen_resale_at` tracking, 90-day expiry messages with target-price vs general expiry differentiation, used restock + used drop alerts for target-free tracking, and historical Smart Alternatives rendering with Amazon.eg and Amazon Resale links.
  - **CRM v2 Hardening:** Fixed nested backtick syntax errors in template literals, SQL errors during KV restore, broadcast block visibility restricted to root admins, ban/revoke UI mapping, and restore-KV button with full property import from legacy KV.
  - **Legacy Command Deprecation:** Completely removed the `/manage` text command, scrubbed all references from documentation, and consolidated admin control exclusively into the Web App CRM.
  - **Infrastructure Patches:** Fixed Temporal Dead Zone ReferenceError, duplicate constant declarations, `amazon_price` state bleeding, Telegram message ID integer typing, Cache API origin URL validation, and edge cache busting on role modifications.
  </details>

- [x] **Phase 6.11: Professional Masry Localization & RTL Engine**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Localize the Telegram CRM and Bot interface into Professional Masry Egyptian Arabic while preserving technical tracking constants, and implement an organic affiliate marketing strategy for the public broadcast channel.

  **The Strategy:** Deployed an `i18n.js` dictionary engine. Refactored Tailwind CSS in the CRM to use logical properties (`ps-`, `pe-`, `gap`) for native RTL flipping via edge HTML rendering. Decoupled scraper alert logic from string labels by implementing a strict boolean `isUsed` parameter to prevent translation text from breaking conditional routing. Shifted the omnichannel broadcast to a high-urgency organic template without analytical markers to boost affiliate conversion.

  **Execution Highlights:**
  - **i18n Dictionary Engine:** Built `src/core/i18n.js` with a flat key structure `t(key, lang, vars)` supporting `en`/`ar` locales and ~233 keys covering CRM UI, alerts, broadcasts, product labels, access control, navigation, onboarding, and system messages — all in Professional Masry Egyptian Arabic (not Fusha).
  - **Per-User Language Detection:** Extended `getUserRoles()` to return `lang` from the `Users` table, detected from Telegram's `language_code` via `resolveLanguageCode()`. All subscription queries JOIN the Users table for per-user `lang`, enabling per-user localized alerts.
  - **CRM RTL Overhaul:** Added `dir="rtl"` and `lang="ar"` to the CRM `<html>` element dynamically via template literal (`dir="${lang === 'ar' ? 'rtl' : 'ltr'}"`). Uses CSS logical properties (`ps-`, `pe-`, `gap-`) for native RTL flipping in the UI.
  - **Scraper Alert Localization:** Wrapped all user-facing strings in `scraper_engine.js` with `t()` calls — 44 `t()` invocations covering alert headers, button labels, seller tags, historical links, restock/drop messages, the ATL banner, currency labels, and the disclaimer.
  - **String Parsing Trap Fix:** Eliminated fragile `condLabel.includes("(Used")` pattern entirely — replaced with an explicit `isUsed` boolean parameter on `queueAlert()`, preventing Arabic condition labels from breaking merchant ID routing and alert type selection.
  - **Technical Constant Preservation:** Kept ASIN, ATL, ATH, and Amazon Resale as English in the Arabic dictionary — these are tracking constants, not user-facing labels.
  - **Organic Broadcast Template:** Replaced the analytics-heavy public channel message (drop percentages, historical averages, ATL markers) with a clean, high-urgency Egyptian Arabic template: `🚨 لقطة 🚨` header, product name, price in `ج.م`, affiliate CTA link (`الحق العرض من هنا`), bot handle (`@AzTrackerr_bot`), deals link, and `#ad` tag.
  - **Architectural Council Batch 2:** Resolved 3 critical audit findings — string parsing trap, absolute CSS in RTL context, and Fusha-translated technical constants — in a single coordinated fix pass.
  </details>

---

## Phase 7.0: V1→V2 Production Cutover

<details>
<summary><b>View Comprehensive Cutover Checklist</b></summary>

### 🧪 Phase 1: Development Testing (AzTracker Test)

In this phase, we will safely test the new architecture using your `AzTracker Test` bot without touching your live V1 production bot.

- [ ] **Step 1: Start the Automation Script**
  Open your terminal in the `AzTracker` project folder and run:
  ```bash
  node finalize_cutover.js
  ```
- [ ] **Step 2: Select Development Environment**
  When prompted by the script, press **`1`** for Development.
- [ ] **Step 3: Provide the "AzTracker Test" Credentials**
  - **Telegram Token:** Paste the HTTP API Token for your **AzTracker Test** bot.
  - **Admin IDs:** Paste your numeric `TELEGRAM_ROOT_ADMIN_IDS`.
  - **Worker URL:** Paste `aztracker-v2.khalid-ibrahim-dev.workers.dev`.
  - **Amazon Keys:** Paste your `AMAZON_CLIENT_ID`, `AMAZON_CLIENT_SECRET`, `AMAZON_PARTNER_TAG`, and `AMZN_ASSOCIATES_TAG`.
- [ ] **Step 4: Verify the Development Migration**
  The script will automatically register your Test bot with the new V2 worker, export a snapshot of your live data from the `AZTRACKER_DB` KV store, and safely seed it into your `aztracker-test-db`.
- [ ] **Step 5: Smoke Test the Bot**
  Open Telegram, talk to your **AzTracker Test** bot, run `/start`, verify the CRM loads, and ensure product alerts trigger correctly. Your V1 `AzTracker` bot remains completely untouched and online during this.

### 🚀 Phase 2: Final Production Cutover (AzTracker)

- [ ] **Step 1: Start the Automation Script**
  Run the script one final time:
  ```bash
  node finalize_cutover.js
  ```
- [ ] **Step 2: Select Production Environment**
  When prompted by the script, press **`2`** for Production.
- [ ] **Step 3: Provide the Live "AzTracker" Credentials**
  - **Telegram Token:** Paste the HTTP API Token for your live, V1 **AzTracker** bot.
  - **Admin IDs:** Paste your numeric `TELEGRAM_ROOT_ADMIN_IDS` again.
  - **Worker URL:** Paste `aztracker-v2-prod.khalid-ibrahim-dev.workers.dev`.
  - **Amazon Keys:** Paste your `AMAZON_CLIENT_ID`, `AMAZON_CLIENT_SECRET`, `AMAZON_PARTNER_TAG`, and `AMZN_ASSOCIATES_TAG` again.
- [ ] **Step 4: Execute the Final Migration**
  The script will securely inject the secrets into `aztracker-v2-prod`, automatically swap the Webhook to route your live bot traffic to the new V2 infrastructure, pull the absolute latest state from the `AZTRACKER_DB` KV store, and permanently seed it into the `aztracker-prod-db`.

### 🆘 Phase 2.5: The V1 Fail-Safe (Abort Switch)

Because V2 uses the new `D1` database and completely ignores the old `KV` store, **your legacy V1 data is never deleted or corrupted.** This means if anything goes wrong during the Phase 2 production cutover, you can instantly abort and rollback to V1 with zero data loss.

To abort the cutover and instantly revert your live bot back to the old V1 worker (`aztracker-bot`):
1. Locate your old `TELEGRAM_WEBHOOK_SECRET` from your V1 environment.
2. Paste this exact URL into your browser, substituting your tokens:
   ```
   https://api.telegram.org/bot<YOUR_LIVE_BOT_TOKEN>/setWebhook?url=https://aztracker-bot.khalid-ibrahim-dev.workers.dev/webhook&secret_token=<YOUR_OLD_V1_SECRET>
   ```
As soon as you that, Telegram will instantly sever the connection to V2 and start routing all user messages back to your V1 infrastructure.

### ☁️ Phase 3: GCP Backup Bridge Provisioning

- [ ] **Step 1: Test the API Schema**
  Use Postman or `curl` to execute a manual `POST` request to your Cloudflare D1 Export endpoint. Inspect the JSON response and verify whether Cloudflare returned the tracking ID as `result.at_id`, `result.at_bookmark`, or `result.task_id`. Open `gcp_backup_bridge/index.js` and update line 29 to match your specific API response.
- [ ] **Step 2: Google Secret Manager**
  Create three secrets:
  - `GDRIVE_SERVICE_ACCOUNT_JSON`: Your Service Account key.
  - `GDRIVE_FOLDER_ID`: The ID of the Drive folder.
  - `CF_API_TOKEN`: Your Cloudflare API Token.
- [ ] **Step 3: Deploy the Cloud Function**
  Create a 2nd Gen Node.js 20 Cloud Function. Timeout: `900 seconds`. Require Authentication (OIDC). Mount secrets. Upload from `gcp_backup_bridge/`.
- [ ] **Step 4: Configure the Scheduler**
  Create a Cloud Scheduler job running at `0 0 * * *`, HTTP target, OIDC auth header.

</details>

---

## 📋 Backlog & Pending Milestones

- [ ] **Phase 7.1: Documentation Accuracy Audit** — All docs cross-referenced against codebase with 100% accuracy.

---

## 🛑 Intentional Architectural Boundaries
*Features explicitly rejected to preserve the core product vision.*

- **Massive Interactive Setup Pipeline:** Rejected. We intentionally scrapped plans to build a complex, multi-stage provisioning suite (`setup.py`, KV auto-creators, GitHub secret auto-injectors). By consolidating the entire V2 migration into the streamlined `finalize_cutover.js` automation script, we drastically reduced deployment overhead and tooling complexity.
- **Multi-Region Scaling (Amazon.ae / .sa):** Rejected. We intentionally scrapped plans to support multiple geographic Amazon marketplaces. Supporting multiple regions required managing distinct Creators API credentials and complex regional queues. The engine is strictly hardcoded to dominate the Amazon Egypt (Amazon.eg) marketplace.
- **Containerized Deployment (Docker/K8s):** Rejected. We intentionally avoided packaging the engine into a Docker container or Kubernetes cluster. By strictly leveraging Cloudflare Workers, D1, Queues, and KV, we maintain a true "Serverless Edge" architecture.
- **Separate Frontend Framework (React/Next.js):** Rejected. We intentionally avoided a decoupled frontend repository for the CRM dashboard. Generating raw HTML directly from the Cloudflare Worker (`crm_dashboard.js`) maintains our strict zero-build-step, edge-native deployment philosophy.
- **Synchronous CRM History Loading:** Rejected. We intentionally excluded historical KV data from the primary `/api/crm/data` endpoint. Price history is strictly "lazy-loaded" via a dedicated route ONLY when an admin explicitly opens a product drawer, preventing catastrophic KV read exhaustion.
- **Percentage-Based Target Pricing:** Rejected. Modifying the engine and database schema to calculate dynamic percentage drops (e.g., "Alert me at 20% off") introduces severe UX friction by requiring multi-step inputs. The system strictly maintains a "Zero-Friction" fixed-price input philosophy.

---

## 🗄️ Archived V1 History (Python / PA-API Engine)
*The following phases document the original Python engine architecture prior to the V2 ES6 JavaScript & D1 migration. Kept strictly for architectural context.*

<details>
<summary><b>Expand V1 Archive (Phases 1 - 5)</b></summary>

### 🛡️ Phase 1: The Ironclad Foundation (Security & Stability)
- **The Regex URL Parser:** Replaced fragile splits in `price_tracker.py` with robust regex to ensure tracking queries never break the API batch fetch.
- **Zero-Trust Webhook Validation:** Implemented `X-Telegram-Bot-Api-Secret-Token` header verification.
- **State-Overwrite Race Condition (2PC):** Implemented a Unified Atomic Two-Phase Commit (2PC) to sync Telegram delivery locks and backend resets simultaneously.
- **The Bulk-Write Blindspot:** Neutralized Cloudflare KV REST API limits by replacing concurrent `PUT` requests with a native `/bulk` array operation.
- **The "Dead ASIN" Quota Leak:** Stopped wasting Amazon API quotas on completely delisted (404) ASINs by implementing a zero-write timestamp engine.

### ⚡ Phase 2: DevOps & Database Optimization
- **Sharding the Global Blob:** Broke the massive `global_prices` JSON object into individual KV pairs to neutralize Cloudflare's 25MB value limit.
- **Asynchronous Processing:** Refactored engine to use `asyncio.Semaphore()` and `aiohttp` to prevent Layer 7 TCP exhaustion.
- **KV Write Quota Auditing:** Transitioned the jitter lock mechanism to use Cloudflare's in-memory standard caching API instead of KV.

### 📊 Phase 3: The User Experience
- **Anti-Flap Hysteresis Engine:** Built a 2.5-hour static timestamp holding buffer to protect the UI and database from Amazon PA-API payload truncation glitches.
- **Context-Aware Dynamic UI:** Upgraded Telegram notification payloads to natively render specific Merchant checkout buttons (🛒 vs 📦) based on conditions.
- **All-Time Low (ATL) Intelligence:** Injected high-urgency text when a price drops to its lowest recorded state.
- **Global Price Matrix (Root Admin Dashboard):** Evaluated active ASINs applying Omnichannel Z-Score logic ($z \le -1.5$).

### 🔐 Phase 4: Identity Provisioning & Security Governance
- **Strict Region-Lock Enforcement:** Broadened the `isAmazonLink` regex listener to intercept all global Amazon domains, validating against `amazon.eg`.
- **Automated Access Provisioning:** Introduced a `global:join_queue` KV array to eliminate manual ID hand-offs.
- **Forensic Security Audit Log:** Hooked all state-modifying admin callbacks to write atomic, self-expiring keys secured by HMAC.

### 🔁 Phase 5: Scheduler Resilience
- **Colo-Local Circuit Breaker:** Utilized `caches.default` to create an `/_internal/circuit/open` flag to stop hammering a dead API during outages.
</details>

---
