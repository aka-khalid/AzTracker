# 🗺️ AzTracker Architecture Roadmap & Tech Debt

This document tracks the technical debt, security fortifications, feature expansion milestones, and intentional architectural boundaries of the AzTracker engine.

## 🛡️ Phase 1: The Ironclad Foundation (Security & Stability)

- [x] **Zero-Trust Webhook Validation:** Implement `X-Telegram-Bot-Api-Secret-Token` header verification to guarantee only Telegram's official servers can trigger the endpoint.
- [x] **Header-Based Scheduler Auth:** Move the scheduler secret out of the query string and into the `x-scheduler-key` HTTP header.
- [x] **The Regex URL Parser:** Replace fragile splits with robust regex to ensure tracking queries never break the API batch fetch.
- [x] **Unauthenticated Data Proxy Shield (DDoW Vector):** Implemented a cryptographic HMAC-SHA256 token system to prevent unauthorized scrapers from draining the database reads. Illegitimate requests are rejected at the edge with an HTTP 401.
- [x] **Atomic Authorization State Migration:** Deprecated monolithic global authorization arrays in favor of atomic, per-user state keys for isolated administration.
- [x] **Pagination Loading Hang (`answerCallbackQuery`):** Wrapped the entire routing pipeline to ensure the Telegram loading spinner locks the user's UI for the exact millisecond duration of the Cloudflare execution, defeating client-side debounce spam.

## ⚡ Phase 2: DevOps & Database Optimization (Speed & Scaling)

- [x] **Disaster Recovery (GCP Bridge):**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Automate robust SQL database dumps while bypassing Cloudflare Worker memory and timeout limits.
  **The Strategy:** Provisioned a Google Cloud Platform (GCP) Serverless Node.js Cloud Function. It triggers the Cloudflare D1 Export REST API and pipes the `.sqlite` blob stream directly into the Google Drive API. Protected by Google API Gateway (OIDC Auth) and executed securely via Google Cloud Scheduler.
  </details>
- [x] **Cloudflare D1 Migration:** Completed migration from legacy schema and decoupled the database into a fully relational D1 architecture.
- [x] **Resource Quota Controller (Grandfather Clause):** Implemented an environment-driven product limit (`DEFAULT_USER_PRODUCT_LIMIT`) governed by isolated overrides. Includes a soft-downgrade clause preventing destructive sync collisions.
- [x] **Edge Caching Optimization (`caches.default`):** Drastically reduced database read billing during heavy UI navigation by caching authorization fetches using Cloudflare's native `caches.default` API.
- [x] **Dead-User Pruning (403 Handling):** Catch HTTP 403 Forbidden errors when users block the bot, and automatically pause their tracked items to save API quotas.

## 📊 Phase 3: The User Experience (Resilience & Analytics)

- [x] **Anti-Flap Hysteresis Engine:** Built a holding buffer to protect the UI and database from Amazon PA-API payload truncation glitches.
- [x] **Restock & Out-of-Stock Tracking:** Modified engine to declare OOS only after a strict continuous absence, triggering highly accurate `🚨 RESTOCK ALERT` notifications.
- [x] **Chart Analytics UI (ATH, ATL, Avg):** Native browser computation of All-Time High, All-Time Low, and Average Price from historical data arrays to render clean metrics above the canvas without backend overhead.
- [x] **All-Time Low (ATL) Intelligence:** Dynamically inject '🔥 ALL-TIME LOW' high-urgency banners into Telegram payloads when price drops below the previously recorded floor.
- [x] **The "Stale Target" Auto-Pause:** Implemented 90-day target pruning to auto-pause unrealistic queries and prevent API quota waste.
- [x] **Destructive Action Confirmations:** Added stateless edge-routed confirmation gates for critical actions to prevent fat-finger accidents.

## 🔐 Phase 4: Identity Provisioning & Security Governance

- [x] **Strict Region-Lock Enforcement (Dynamic Geofencing):** Broadened regex to intercept all Amazon domains but strictly geofenced execution to the `amazon.eg` allowlist, preventing tracking leaks.
- [x] **Automated Access Provisioning (The Join Queue):** Eliminated manual ID hand-offs with a scalable, queue-based architecture with active admin notification pipelines.
- [x] **Pending Request TTL & Queue Depth Gate:** Auto-expire join requests after 7 days and enforce a hard cap of 25 pending entries to prevent unbounded queue accumulation and staleness.
- [x] **Object-Level IAM Metadata (Creator Tags):** Store admin approver IDs independently to dynamically render "Approved by: [Name]" on CRM User Management cards.
- [x] **Forensic Security Audit Log (Web App SIEM):** Implemented an HMAC-secured `/audit` route, creating logs for all state-modifying actions without introducing read-modify-write TOCTOU vulnerabilities.

## 🏗️ Phase 6: System Architecture & Modernization

- [x] **Monolith Decomposition (Phase 6.10):**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Eliminate the unmaintainable 3,200+ line `worker.js` monolith.
  **The Strategy:** Decomposed the monolith into a modular ES6 architecture. Created a lightweight edge router (`src/index.js`). Extracted domain logic (D1, Telegram, PA-API) into `src/core/`. Moved routing to `src/routes/` and background execution loops (Cron/Queues) to `src/workers/`. This ensures optimal maintainability while preserving zero latency cold starts via Wrangler's `esbuild`.
  </details>

- [x] **Atomic Two-Phase Commit (2PC):**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Eliminate silent D1 database lock-ups during Telegram API timeouts.
  **The Strategy:** The Scraper Engine now strictly delegates `alert_sent` flags to the payload queue (`{ type: 'telegram_alert_new', asin: p.asin }`). The `queue_worker.js` consumer executes the D1 `UPDATE` lock query *only* after a verified `HTTP 200 OK` response from the Telegram servers.
  </details>

---

## 🛑 Intentional Architectural Boundaries
*Features explicitly rejected to preserve the core product vision.*

- **Legacy Architectures:** The system officially rejects Python, Cloudflare KV, Oracle VPS, cron-job.org, and GitHub Actions as architectural components. The stack is strictly Node.js Edge + Cloudflare D1 (SQLite) + GCP.
- **"Target Met" Stagnation Fix:** Rejected. Modifying the engine to continuously send alerts for new all-time lows *after* a target is met violates the strict "Zero-Spam Boolean Lock" philosophy. If a target is met, the system alerts once and locks.
- **Multi-Button Product Dashboard:** Rejected. Stacking redundant Telegram inline buttons for every hidden merchant on the `/manage` dashboard creates extreme UI fatigue. Kept as clean, embedded HTML text links.
- **Real-Time Database Garbage Collection:** Rejected. Real-time garbage collection triggers excessive I/O. Data retention and cleanup are handled through separate lifecycle management strategies.
- **Percentage-Based Target Pricing:** Rejected. Modifying the engine and database schema to calculate dynamic percentage drops (e.g., "Alert me at 20% off") introduces severe UX friction by requiring multi-step inputs. The system strictly maintains a "Zero-Friction" fixed-price input philosophy.
- **Silent Night Mode:** Rejected. Suppressing Telegram notifications during nighttime hours assumes universal user schedules and creates an unnecessary layer of backend timezone management. Users are responsible for managing their own device-level "Do Not Disturb" settings or muting the bot natively in Telegram.
