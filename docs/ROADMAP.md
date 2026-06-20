# 🗺️ AzTracker Architecture Roadmap & Tech Debt

This document tracks the technical debt, security fortifications, feature expansion milestones, and intentional architectural boundaries of the AzTracker engine.

## 🚀 Active Architecture: Core Engine Modernization (Phase 6)

- [x] **Phase 6.17: True Dynamic Governor, AIMD Probing & Edge Hardening**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Eliminate rigid Cloudflare-bound limits, prevent sustained Amazon 429 blackouts through intelligent self-throttling, protect user endpoints from DDoS abuse, and optimize legacy codebase remnants.

  **The Strategy:** Deployed a True Dynamic Dual-Governor inside `cron_trigger.js` that balances Cloudflare Queue capacity against the Amazon daily API quota. Integrated a TCP AIMD (Additive Increase, Multiplicative Decrease) probing algorithm to auto-tune API limits. Added a deep-sleep `exhausted` hibernation state upon confirmed quota depletion. Secured all API routes with strict IP-based Rate Limiting, simplified broadcasting logic, and finalized the eradication of dead product URL mapping code.

  **Execution Highlights:**
  - **Dual-Governor Throttle:** Replaced static calculation with `Math.min(cloudflareLimit, amazonLimit)` to perfectly space batched executions across the strictest bottleneck.
  - **AIMD Night Probes:** Configured the bot to run a daily probe at Midnight UTC. In safe territory, it scales aggressively (+50% Slow Start); near the threshold (`ssthresh`), it crawls gently (+5% Congestion Avoidance). *Crucially, to prevent untested exponential growth, this probe only triggers if Amazon is actively bottlenecking the engine.*
  - **Hibernation State:** Decoupled 429 quota exhaustion from generic 503 circuit-breaker trips. A proven 429 triggers a 10% penalty slap and sends the scraper engine into a `cooldownMs` deep sleep exactly until the next Midnight UTC.
  - **50% API Cost Reduction:** Shifted Arabic title enrichment to a strictly `name_ar` missing database filter, preventing wasteful requests for static titles and instantly halving API consumption per cycle.
  - **IP-Based Rate Limiting:** Implemented CF-edge IP extraction (`cf-connecting-ip`) across all `user_dashboard` endpoints and wildcard routers to thwart malicious scanning and rapid-fire API abuse.
  - **CRM Animation Polish:** Injected smooth CSS transitions into the CRM dashboard to auto-hide cards dynamically when admins toggle the `always_track` Keep-Alive switch.
  - **Broadcast Simplification:** Scrapped the bloated analytical broadcast header in favor of a punchy, affiliate-optimized two-tier system (`🔥 الحق 🔥` vs `⚡ عرض ⚡`). Added promo channel buttons natively to private target-hit alerts.
  </details>

- [x] **Phase 6.14: Statistical Engine Overhaul & Global Abandoned Tracking**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Upgrade the statistical engine to eliminate false positives on highly volatile items and introduce Time-Weighted calculus, while granting admins the ability to hijack orphaned products for global tracking without blowing up API limits.

  **The Strategy:** Refactored the standard deviation calculation in `scraper_engine.js` from discrete arrays to Time-Weighted Integrals (`durationSec * decayWeight`). Implemented a 7-day low-lifespan failsafe for new products. Converted the CRM's legacy Paused Products UI into an "Abandoned Products Hub" that displays orphaned items. Stripped the per-user pause button and replaced it with a dynamic global "Keep Alive" (`always_track`) toggle to hijack products.

  **Execution Highlights:**
  - **Time-Weighted Math:** Calculated the integral area of price durations to natively suppress anomalous fast-flapping prices, ensuring the Z-score correctly evaluates stable deals.
  - **Low-Lifespan Failsafe:** Introduced a 168-hour failsafe that bypasses the Z-Score logic entirely for items lacking statistical mass, evaluating them purely on dynamic Hot Deals percentage thresholds.
  - **API-Safe Global Pool:** Modified the Cloudflare Queue governor in `cron_trigger.js` to accurately aggregate active user subscriptions and `always_track` global items, automatically stretching the polling interval to safely absorb up to 500 orphaned items within the 8,640 PA-API daily limit.
  - **Abandoned Products Hub:** Gutted the useless per-user pause UX in the CRM. Renamed the drawer to "Abandoned Products" (`منتجات مهجورة`), returning aggregated items that have 0 active users.
  - **Keep Alive UX:** Replaced the legacy admin pause button on all user product cards with a dynamic `Keep Alive` toggle switch, enabling instantaneous omnichannel hijacking of user-discovered items.
  - **Interactive Chart Intervals:** Upgraded the CRM and User Dashboards with fully localized dynamic price history chart controls (1W, 1M, 3M, 6M, ALL) that slice KV array timelines in memory without triggering duplicate fetch requests. The chart leverages a **Proportional Chronological Linear X-Axis** to accurately anchor intervals and depict time proportionally, avoiding categorical distortion. Additionally, out-of-stock periods elegantly degrade metrics (ATH/ATL/AVG) to dashes instead of abruptly shifting the layout.
  </details>

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
  - **Organic Broadcast Template:** Replaced the analytics-heavy public channel message (drop percentages, historical averages, ATL markers) with a clean, high-urgency Egyptian Arabic template: two-tier dynamic headers (`🔥 الحق 🔥` for wow deals ≥ 2× threshold, `⚡ عرض ⚡` for everything else), product name, price in `ج.م`, affiliate CTA link (`الحق العرض من هنا`), bot handle (`@AzTrackerr_bot`), deals link, and `#ad` tag.
  - **Fallback Web Scraper:** While the engine primarily uses the Creators API, it maintains a fallback HTTP scraper (`scrapeArabicTitle`) for extracting native Arabic text directly from `www.amazon.eg` product pages if the API fails to return the localized title.
  - **Architectural Council Batch 2:** Resolved 3 critical audit findings — string parsing trap, absolute CSS in RTL context, and Fusha-translated technical constants — in a single coordinated fix pass.
  </details>

- [x] **Phase 6.13: Legacy Interface Deprecation & Web App Exclusivity**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Eliminate the deprecated text-based product management interfaces and permanently shift all users to the Web App Deals Dashboard to reduce UI noise.

  **The Strategy:** Aggressively pruned the massive legacy rendering functions (`renderProductList`, `renderProductView`) from `telegram_webhook.js`. Caught all legacy inline button callbacks (`list_products_`, `view_`, `settarget_`, `remove_`, etc.) and seamlessly routed them to the `/start` handler as a safe fallback for users clicking old messages. Scrubbed `i18n.js` of over 100 lines of orphaned translation keys (`list.*`, `delete.*`, `target.*`), while strictly preserving `product.*` keys actively used by the Scraper Engine.
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

  **The Strategy:** Overhauled the CRM UI rendering engine to fetch and display native Amazon product images (`image_url`) directly from the D1 database across all CRM views. Introduced a new user-facing "Hot Deals" (`🔥 عروض نار`) tab in the Web App that leverages the new `drop_percentage` deal detection metric to surface massive global price drops to all users. Simultaneously replaced insecure `adminId` URL-parameter API fetching with a robust `fetchAPI` wrapper that cryptographically validates the Telegram `initData` header. For DevOps, introduced a seamless GitHub Actions CI/CD workflow to safely mirror production databases to the development environment. Added an unhandled exception interceptor (Generic 500 / Error 1101) to the Cloudflare Worker to protect worker URLs from leaking. Perfected the Arabic visual scaling by dynamically applying the Cairo font and 115% scaling to equalize cross-lingual footprints, alongside detailed UI enhancements like subscript User IDs.

  **Execution Highlights:**
  - **Hot Deals Discovery Tab:** Added a dedicated `/api/user/hot_deals` endpoint and UI tab in the User Dashboard. This tab queries the `Global_Products` table for items with a massive `drop_percentage` (calculated algorithmically based on ATH/ATL), allowing standard users to effortlessly discover and track globally detected deals with a single click.
  - **Inflation-Resistant Deal Detection (EMA):** Replaced standard historical averages with a **Time-Weighted Average (EMA)** algorithm using a 30-day exponential decay half-life, ensuring the baseline gracefully ignores pre-inflation prices.
  - **Dynamic Tiered Price Buckets:** Upgraded both the Omnichannel broadcast and Hot Deals tab to evaluate percentage drops against a dynamic matrix based on absolute price (e.g., cheap items require a 15% drop, premium electronics only require a 3% drop), perfectly mapping to human psychological pricing without hardcoded limits.
  - **Omnichannel Direct-Tracking Deep-Links:** Injected a `?start=track_{asin}` deep-link into all broadcast messages, allowing users to tap a "🎯 Track Deal" button in the public channel and instantly subscribe to the product inside the bot with zero friction.
  - **CRM Visual Upgrade:** Injected native database-driven product images into the User Products, Top Charts, Graveyard, and Admin CRM layouts. Implemented a robust `<img onerror="...">` fallback mechanism that gracefully degrades to the Amazon URL path if the cached image fails to load.
  - **Secure API Wrapper (`fetchAPI`):** Completely removed URL-based `adminId` parameter injection in the CRM frontend. Replaced all direct `fetch` calls with an interceptor that automatically attaches the Telegram Web App `initData` string as an `Authorization` header.
  - **Backend Cryptographic Authentication:** Updated the `GET /api/crm/*` and `POST /api/crm/*` backend endpoints to extract and validate the Telegram `initData` header securely via SubtleCrypto. This guarantees zero-trust Root Admin verification for sensitive actions like global broadcasts and cache deletion.
  - **Automated D1 Environment Synchronization:** Engineered a comprehensive `.github/workflows/sync-prod-to-dev.yml` pipeline that triggers Wrangler to execute a remote D1 export of `aztracker-prod-db`.
  - **Safe SQL Transformation:** The sync workflow leverages `sed` to intelligently parse the exported SQL dump and replace destructive `INSERT INTO` commands with `INSERT OR REPLACE INTO`, ensuring smooth, collision-free dev imports without dropping existing tables or violating constraints.
  - **Seamless KV Mirroring:** Hand-crafted a Node.js `sync-kv.js` script inside the CI/CD pipeline to query all keys from the Production KV Namespace and automatically bulk-write them into the Development KV Namespace using the Cloudflare REST API.
  - **Principle of Least Privilege:** Enforced a strict permission matrix for the GitHub Actions Cloudflare API Token, binding it explicitly to three explicit permissions (`D1 Edit`, `Workers KV Storage Edit`, `Worker Scripts Edit`) instead of granting overarching Global API Key access.
  </details>

- [x] **Phase 6.14: Persistent Menu & Edge Navigation Resilience**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Unify the Telegram native Persistent Menu with the Web App experience, eliminate browser history traps, and ensure seamless synchronization between Telegram caching and the D1 Database.

  **The Strategy:** Deployed a native `setup_bot_commands.js` script to configure the Telegram Persistent Menu (commands like `/lang` and `/help`) to replace the deprecated inline keyboard. Rewrote the Web App frontend navigation layer to bypass `window.history.back()` traps using absolute URL replacements and explicit `tg.BackButton` bindings. Implemented a seamless state-sync interceptor that forces Web Apps to reload if their URL language parameter mismatches the `X-User-Lang` database header, making D1 the absolute source of truth.

  **Execution Highlights:**
  - **Database as Source of Truth:** Stripped out `localStorage` and OS-level `tg.initDataUnsafe.language_code` fallbacks in the frontend. All Web App language state is now strictly synced to the `Users` D1 table, preventing desynchronization across devices.
  - **Navigation Loop Resolution:** Replaced all `window.location.search` mutations with `window.location.replace()` in the API interceptors, preventing the iOS/Android Telegram WebKit from stacking duplicate history states and trapping the user in infinite back-button loops.
  - **Graceful Blocking (HTTP 403):** Replaced the aggressive permanent-ban logic for users who block the bot. The queue worker now gracefully sets `is_paused = 1` for their subscriptions, preserving their history and allowing instant reactivation if they unblock the bot.
  - **Secure Loading Overlay:** Injected a full-screen CSS loader overlay (`id="init-loader"`) across both the CRM and User Dashboards. This completely obscures the HTML skeleton until cryptographic API validation succeeds, preventing layout flashing for unauthorized users.
  - **Cross-Browser Hardening:** Fixed severe iOS WebKit clipping bugs on both the Access Denied and Loading screens by replacing modern `inset: 0` rules with explicit viewport dimensions, and moved the black Access Denied background directly to the `<body>` tag to bypass Android WebApp container clipping.
  </details>

- [x] **Phase 6.16: Native Confirm Dialogs, Toast Notifications & i18n Hardening**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Replace the native Telegram `tg.showConfirm()` and `tg.showPopup()` calls with custom in-UI modal dialogs and toast notifications for a consistent cross-platform experience, while hardening i18n coverage and image fallback resilience.

  **The Strategy:** Implemented a custom `showConfirmDialog()` modal with stacking guard, RTL-aware button placement, and keyboard support (Enter/Escape) in both the CRM and User Dashboards. Added a green success toast style (`bg-green-500/90`). Replaced brittle `this.style.display='none'` image error handling with a transparent 1x1 GIF placeholder to prevent layout shift. Added missing i18n keys for search placeholders and confirm/cancel buttons. Removed all `ar` (Fusha) dictionary entries, keeping only `en` and `masry` locales.

  **Execution Highlights:**
  - **Custom Confirm Dialog (`showConfirmDialog`):** Replaced `tg.showConfirm()` across 4 CRM actions (`triggerSync`, `triggerGlobalScrape`, `sendBroadcast`, `confirmRevoke`) and 2 User Dashboard actions (`updateTarget`, `deleteProduct`). The modal features a stacking guard (prevents duplicate dialogs), RTL-aware button placement (cancel on the right in LTR, on the left in RTL), and keyboard support (Enter to confirm, Escape to dismiss).
  - **Toast Notifications (`showToast`):** Added green success toast style (`bg-green-500/90`) to both CRM and User Dashboards, replacing `tg.showPopup()` for target price updates and clears.
  - **Image Fallback Hardening:** Replaced `this.style.display='none'` on image error with a transparent 1x1 GIF data URI placeholder (`data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7`), preventing broken-image icons and layout shift.
  - **i18n Key Additions:** Added `crm.search_users_placeholder` (distinct from generic search placeholder), `dashboard.confirm_btn_confirm`, `dashboard.confirm_btn_cancel`, and `crm.subscribers_for` (with `{asin}` template variable) for the localized "Subscribers for" drawer title.
  - **Locale Cleanup:** Removed all `ar` (Modern Standard Arabic) dictionary entries from `i18n.js` — the project now strictly supports `en` (English) and `masry` (Egyptian Arabic), eliminating ~3 redundant Fusha entries.
  - **Search Placeholder:** Updated CRM search input to use the more specific `crm.search_users_placeholder` key instead of the generic `crm.search_placeholder`.
  - **Auth Bypass (Debug):** Commented out HMAC auth check on `/api/test-asin` endpoint for development testing.
  </details>

- [x] **Phase 6.15: Product Variations CRM Broadcasting**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Enable admins to broadcast any specific child variation of a product directly from the CRM without incurring additional Amazon API calls, ensuring high accuracy for targeted affiliate marketing.

  **The Strategy:** Upgraded the `scrapeProduct` core to securely fetch and cache child variations (`isVariation`) with their exact prices, names, ASINs, and images. Refactored the CRM UI to present a lazy-loaded list of these variations before generating the broadcast template.

  **Execution Highlights:**
  - **Variations Data Caching:** The `live-price` endpoint now parses all child variations natively (excluding OOS items) and returns them to the frontend, avoiding secondary, costly Amazon API fetch calls.
  - **Interactive Broadcast Options:** Replaced the immediate template generation with an interactive UI picker in both the "Deals" and "Per-Product Modal" broadcast flows. Admins can selectively broadcast the parent product or any in-stock child variation.
  - **Zero-Cost Template Generation:** Created a local `/api/crm/generate-text` backend endpoint that constructs the organic broadcast template (with exact variation affiliate links and inline buttons) purely from the frontend-cached variation payload.
  - **RTL Layout Hardening:** Overhauled the broadcast template formatting with strict Unicode RLE (Right-to-Left Embedding) and PDF markers. This tricks Telegram's internal text-direction engine into rendering English-heavy lines natively in Arabic right-to-left layout without visual glitches.
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
- **Anti-Flap Hysteresis Engine:** Built a 1-hour static timestamp holding buffer to protect the UI and database from Amazon PA-API payload truncation glitches.
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
