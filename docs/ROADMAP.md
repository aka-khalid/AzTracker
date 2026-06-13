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

  **The Strategy:** Decomposed the 2500+ line worker into a highly modular architecture (`src/core`, `src/routes`, and `src/workers`). Replaced the deprecated PA-API with the modern Creators API. Shifted the intensive Amazon scraping payload off the synchronous cron thread and into an asynchronous `scraper-queue` consumed by `src/workers/queue_worker.js`. Separated outbound Telegram notifications into a `telegram-outbox` queue (bound as `MESSAGE_QUEUE`) to gracefully handle HTTP 429 rate limits without crashing the main engine or violating the Two-Phase Commit boundary.

  **Execution Highlights:**
  - **Modular Architecture:** Split the monolith into `src/core` (i18n, db, auth, amazon API logic), `src/routes` (CRM dashboard, telegram webhook), and `src/workers` (scraper engine, queue worker) — each with single-responsibility boundaries.
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
  - **i18n Dictionary Engine:** Built `src/core/i18n.js` with a flat key structure `t(key, lang, vars)` supporting `en`/`masry` locales and ~233 keys covering CRM UI, alerts, broadcasts, product labels, access control, navigation, onboarding, and system messages — all in Professional Masry Egyptian Arabic (not Fusha).
  - **Per-User Language Detection:** Extended `getUserRoles()` to return `lang` from the `Users` table, detected from Telegram's `language_code` via `resolveLanguageCode()`. All subscription queries JOIN the Users table for per-user `lang`, enabling per-user localized alerts.
  - **CRM RTL Overhaul:** Added `dir="rtl"` and `lang="masry"` to the CRM `<html>` element dynamically via template literal (`dir="${lang === 'masry' ? 'rtl' : 'ltr'}"`). Uses CSS logical properties (`ps-`, `pe-`, `gap-`) for native RTL flipping in the UI.
  - **Scraper Alert Localization:** Wrapped all user-facing strings in `scraper_engine.js` with `t()` calls — 44 `t()` invocations covering alert headers, button labels, seller tags, historical links, restock/drop messages, the ATL banner, currency labels, and the disclaimer.
  - **String Parsing Trap Fix:** Eliminated fragile `condLabel.includes("(Used")` pattern entirely — replaced with an explicit `isUsed` boolean parameter on `queueAlert()`, preventing Arabic condition labels from breaking merchant ID routing and alert type selection.
  - **Technical Constant Preservation:** Kept ASIN, ATL, ATH, and Amazon Resale as English in the Arabic dictionary — these are tracking constants, not user-facing labels.
  - **Organic Broadcast Template:** Replaced the analytics-heavy public channel message (drop percentages, historical averages, ATL markers) with a clean, high-urgency Egyptian Arabic template: `🚨 لقطة 🚨` header, product name, price in `ج.م`, affiliate CTA link (`الحق العرض من هنا`), bot handle (`@AzTrackerr_bot`), deals link, and `#ad` tag.
  - **Fallback Web Scraper:** While the engine primarily uses the Creators API, it maintains a fallback HTTP scraper (`scrapeArabicTitle`) for extracting native Arabic text directly from `www.amazon.eg` product pages if the API fails to return the localized title.
  - **Architectural Council Batch 2:** Resolved 3 critical audit findings — string parsing trap, absolute CSS in RTL context, and Fusha-translated technical constants — in a single coordinated fix pass.
  </details>

- [x] **Phase 6.12: Telegram Web App & Resilient Fallback Scraping**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Replace the limited inline keyboard menu with a rich, interactive Telegram Web App UI for user product management, and enforce strict language-based name enrichment.

  **The Strategy:** Fully deprecated the inline message-based user menu in favor of an edge-rendered HTML dashboard served natively from the Cloudflare Worker via `src/routes/user_dashboard.js`. Enforced strong cryptographic security using `crypto.subtle` for HMAC-SHA256 Telegram `initData` validation. Significantly upgraded the scraper engine's fallback logic to fetch English (`en_AE`) and Arabic (`ar_AE`) titles manually over HTTP if the Amazon Creators API fails or returns cross-pollinated languages.

  **Execution Highlights:**
  - **Telegram Web App CRM:** Built a fully responsive HTML/CSS/JS dashboard tracking UI with zero frontend frameworks. Users can pause, delete, and set target prices via a synchronized slider and input field.
  - **Secure Edge Validation:** Implemented native HMAC verification for API requests (`/api/user/*`) using Cloudflare's SubtleCrypto API to cryptographically guarantee Web App requests originate from authenticated Telegram users.
  - **Dynamic Affiliate Injection:** Injected the Amazon Associates `partnerTag` dynamically into the target URL buttons (New, Resale, Amazon.eg) within the Web App right before opening the browser.
  - **Explicit HTTP Language Scraping:** Bypassed Amazon's IP-based geolocation by explicitly appending `?language=en_AE` and `?language=ar_AE` to the fallback HTTP scraper URLs. 
  - **Arabic Cross-Pollination Fix:** Added intelligent detection for cases where the Creators API incorrectly returns an Arabic name in the English field. The scraper engine now detects Arabic characters (`/[\u0600-\u06FF]/`), forcefully shunts the text to the `name_ar` database column, and triggers the English fallback scraper to ensure English localization isn't corrupted.
  - **Synchronous Webhook Scraping:** Upgraded the `telegram_webhook.js` link processor to immediately trigger synchronous HTTP extraction for both Arabic and English names (bypassing the queue) if they can't be extracted from the URL structure directly.
  </details>

- [x] **Phase 6.13: Visual CRM Overhaul, Deal Discovery & Database Synchronization**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Upgrade the Admin CRM Web App with rich product visuals, introduce a global "Hot Deals" discovery tab for users, secure API integrations, and completely automate the Production-to-Development Database synchronization pipeline.

  **The Strategy:** Overhauled the CRM UI rendering engine to fetch and display native Amazon product images (`image_url`) directly from the D1 database across all CRM views. Introduced a new user-facing "Hot Deals" (`🔥 لقطات`) tab in the Web App that leverages the new `drop_percentage` deal detection metric to surface massive global price drops to all users. Simultaneously replaced insecure `adminId` URL-parameter API fetching with a robust `fetchAPI` wrapper that cryptographically validates the Telegram `initData` header. For DevOps, introduced a seamless GitHub Actions CI/CD workflow to safely mirror production databases to the development environment.

  **Execution Highlights:**
  - **Hot Deals Discovery Tab:** Added a dedicated `/api/user/hot_deals` endpoint and UI tab in the User Dashboard. This tab queries the `Global_Products` table for items with a massive `drop_percentage` (calculated algorithmically based on ATH/ATL), allowing standard users to effortlessly discover and track globally detected deals with a single click.
  - **CRM Visual Upgrade:** Injected native database-driven product images into the User Products, Top Charts, Graveyard, and Admin CRM layouts. Implemented a robust `<img onerror="...">` fallback mechanism that gracefully degrades to the Amazon URL path if the cached image fails to load.
  - **Secure API Wrapper (`fetchAPI`):** Completely removed URL-based `adminId` parameter injection in the CRM frontend. Replaced all direct `fetch` calls with an interceptor that automatically attaches the Telegram Web App `initData` string as an `Authorization` header.
  - **Backend Cryptographic Authentication:** Updated the `GET /api/crm/*` and `POST /api/crm/*` backend endpoints to extract and validate the Telegram `initData` header securely via SubtleCrypto. This guarantees zero-trust Root Admin verification for sensitive actions like global broadcasts and cache deletion.
  - **Automated D1 Environment Synchronization:** Engineered a comprehensive `.github/workflows/sync-prod-to-dev.yml` pipeline that triggers Wrangler to execute a remote D1 export of `aztracker-prod-db`.
  - **Safe SQL Transformation:** The sync workflow leverages `sed` to intelligently parse the exported SQL dump and replace destructive `INSERT INTO` commands with `INSERT OR REPLACE INTO`, ensuring smooth, collision-free dev imports without dropping existing tables or violating constraints.
  - **Seamless KV Mirroring:** Hand-crafted a Node.js `sync-kv.js` script inside the CI/CD pipeline to query all keys from the Production KV Namespace and automatically bulk-write them into the Development KV Namespace using the Cloudflare REST API.
  - **Principle of Least Privilege:** Enforced a strict permission matrix for the GitHub Actions Cloudflare API Token, binding it explicitly to three explicit permissions (`D1 Edit`, `Workers KV Storage Edit`, `Worker Scripts Edit`) instead of granting overarching Global API Key access.
  </details>

---

## 🔮 Phase 7: Continuous Improvement & R&D

- [ ] **Phase 7.1: Multi-Region Support Exploration**
  - Research acquiring Amazon Creators API credentials for additional marketplaces (`amazon.sa`, `amazon.ae`).
  - Explore multi-tenant queuing or sharded deployments to handle separate regions.
  - Currently blocked by the lack of verified partner credentials for regions outside Egypt.

---

## 🛑 Intentional Architectural Boundaries
*Features explicitly rejected to preserve the core product vision.*

- **Massive Interactive Setup Pipeline:** Rejected. We intentionally scrapped plans to build a complex, multi-stage provisioning suite (`setup.py`, KV auto-creators, GitHub secret auto-injectors). By consolidating the entire V2 architecture to standard Wrangler D1/Queue commands, we drastically reduced deployment overhead and tooling complexity.

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
