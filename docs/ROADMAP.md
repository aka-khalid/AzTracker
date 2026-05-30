# 🗺️ AzTracker Architecture Roadmap & Tech Debt

This document tracks the technical debt, security fortifications, feature expansion milestones, and intentional architectural boundaries of the AzTracker engine.

## 🛡️ Phase 1: The Ironclad Foundation (Security & Stability)

- [x] **The Regex URL Parser:** Replace fragile splits in `price_tracker.py` with robust regex to ensure tracking queries never break the API batch fetch.
- [x] **Zero-Trust Webhook Validation:** Implement `X-Telegram-Bot-Api-Secret-Token` header verification to guarantee only Telegram's official servers can trigger the endpoint.
- [x] **Header-Based Scheduler Auth:** Move the scheduler secret out of the query string and into the `x-scheduler-key` HTTP header.
- [x] **State-Overwrite Race Condition (2PC):** Implemented a Unified Atomic Two-Phase Commit (2PC) to sync Telegram delivery locks and backend resets simultaneously.
- [x] **Double-Ping UI Spam Resolution:** Unified `target_alert` assignments across New and Used evaluation blocks to allow seamless message piggybacking.
- [x] **Pagination Loading Hang (`answerCallbackQuery`)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Stop the Telegram inline button from spinning endlessly without creating a "UX Dead Zone" where premature resolution triggers ghost clicks.<br>
  **The Strategy:** Wrapped the entire `handleCallback` routing pipeline in a `try/finally` block. The `ctx.waitUntil(fetch(...answerCallbackQuery))` interceptor is executed in the `finally` stage. This guarantees the Telegram loading spinner locks the user's UI for the exact millisecond duration of the Cloudflare execution, naturally defeating client-side debounce spam while satisfying Telegram's API callback requirements.
  </details>
- [x] **The Partial 2PC Failure (Infinite Spam Loop Trap)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Prevent infinite target-alert spam loops caused by script timeouts breaking the Two-Phase Commit.<br>
  **The Strategy:** Executed alongside the Bulk-Write patch. We completely removed the scattered `asyncio.gather` database pushes. The engine now executes the Telegram delivery loop *first*, collects the locks, and serializes everything (history, prices, users, locks, and stats) into a single, strictly atomic payload executed as the absolute last step of the engine.
  </details>

- [x] **The Bulk-Write Blindspot (Control Plane Rescue)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Neutralize Cloudflare KV REST API limits by replacing concurrent `PUT` requests with a native `/bulk` array operation.<br>
  **The Strategy:** We eliminated the massive `asyncio.gather` block that was firing dozens of concurrent `PUT` requests and triggering 429 Rate Limits. Replaced it with a single `bulk_payload` JSON array routed through a new `async_put_kv_bulk` helper, compressing 100+ API calls down to exactly 1.
  </details>

- [x] **The "Dead ASIN" Quota Leak (MIA Hysteresis)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Stop wasting Amazon API quotas on completely delisted (404) ASINs without triggering false-positive mass deletions during PA-API outages.<br>
  **The Strategy:** We implemented a zero-write timestamp engine. Instead of iterating a counter, the engine stamps a `mia_since_ms` epoch when an ASIN vanishes, costing 0 writes while it waits. We also built a "Zero-Return Outage" failsafe: if the PA-API returns 0 items, the engine aborts MIA logic entirely. After a true 24-hour omission, the item is flagged `delisted`, paused globally, and a final Telegram warning is dispatched.
  </details>

- [x] **Unauthenticated Data Proxy Shield (DDoW Vector)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Prevent unauthorized scrapers from draining the 100,000/day Cloudflare KV Read quota via the public `/api/history/:asin` endpoint.<br>
  **The Strategy:** Implemented a cryptographic HMAC-SHA256 token system utilizing the WebCrypto API. The Worker generates a 2-hour TTL token signed by the `TELEGRAM_WEBHOOK_SECRET` upon rendering the UI, which the client-side JS passes back. Illegitimate or expired requests are rejected at the edge with an HTTP 401, resulting in 0 database reads.
  </details>

- [x] **2PC TOCTOU User Data Protection**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Eliminate the 40-second Time-Of-Check to Time-Of-Use race condition during the Two-Phase Commit pipeline in the Python engine.<br>
  **The Strategy:** Replaced the sequential `bounded_get_kv()` loop with concurrent `asyncio.gather()` execution. The fetch phase was compressed from `O(N)` down to `O(1)`, shrinking the vulnerability window to milliseconds and ensuring user state modifications in Telegram are not silently overwritten.
  </details>

- [x] **Atomic Authorization State Migration**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Resolve edge cache poisoning and read-modify-write race conditions when multiple admins execute approval commands simultaneously.<br>
  **The Strategy:** Deprecated the monolithic `global:approved_users` arrays in favor of isolated `auth:{chat_id}` keys. Built a transparent backward-compatibility wrapper in `worker.js` that lazily migrates legacy array users to their atomic keys upon their next bot interaction.
  </details>

## ⚡ Phase 2: DevOps & Database Optimization (Speed & Scaling)

- [x] **Sharding the Global Blob:** Broke the massive `global_prices` JSON object into individual KV pairs to neutralize Cloudflare's 25MB value limit.
- [x] **Asynchronous Processing & Bounded Concurrency:** Refactored engine to use `asyncio.Semaphore()` and `aiohttp` to prevent Layer 7 TCP exhaustion.
- [x] **Automated KV Backups:** Decoupled from the primary execution tracker into a dedicated native GitHub Actions cron (`backup_db.yml`) running every 4 hours to drastically reduce Cloudflare `List` API quota consumption.
- [x] **KV Write Quota Auditing:** Transitioned the jitter lock mechanism to use Cloudflare's in-memory standard caching API instead of KV, freeing up quota.
- [x] **Time-Based Write Amplification Shield:** Replaced volatile iteration counters with static UNIX timestamps for the Anti-Flap engine. Reduced Lazy Refresh metadata TTLs to 6 hours, and implemented a strict 30-minute heartbeat throttle on the global dashboard stats, reducing daily KV overhead writes to near-zero.
- [x] **KV Pagination Blindspot:** Implemented `cursor` while-loops for multi-tenant KV fetches to safely bypass Cloudflare's 1,000-key response truncation limit.
- [x] **Resource Quota Controller (Grandfather Clause):** Implemented an environment-driven product limit (`DEFAULT_USER_PRODUCT_LIMIT`) governed by isolated `limit:{chat_id}` overrides. Includes a soft-downgrade clause preventing destructive sync collisions if an admin lowers a user's quota below their current item count.
- [x] **KV Read Optimization in Webhook (`caches.default`)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Drastically reduce Cloudflare KV Read billing during heavy UI navigation.<br>
  **The Strategy:** Wrap the `getUserRoles()` fetch inside `worker.js` with Cloudflare's native `caches.default` API using a 60-second TTL.<br>
  **🤖 AI Execution Prompt:** *"In `worker.js`, I need to cache the `getUserRoles` KV fetches. Please rewrite the authorization function to check `caches.default.match()` using a synthetic Request object before falling back to `env.AZTRACKER_DB.get()`. If falling back, `caches.default.put()` the result with a 60-second Cache-Control header."*
  </details>
- [x] **Dead-User Pruning (403 Handling)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Prevent the Amazon API from wasting quota on tracking items for users who have blocked the Telegram bot.<br>
  **The Strategy:** When `async_send_telegram()` in `price_tracker.py` receives an HTTP 403 Forbidden, append that user ID to a "dead_users" set. During the KV sync phase, toggle all their items to `paused: true`.<br>
  **🤖 AI Execution Prompt:** *"In `price_tracker.py`, update `async_send_telegram` to return a specific '403' flag if the user blocked the bot. If this flag is caught in the delivery loop, add the chat_id to a `dead_users` set. During the final Two-Phase Commit, inject logic to iterate over `dead_users` and set `paused = True` for all their active items."*
  </details>
  

## 📊 Phase 3: The User Experience (Resilience & Analytics)

- [x] **Anti-Flap Hysteresis Engine:** Built a 16-run holding buffer to protect the UI and database from Amazon PA-API payload truncation glitches.
- [x] **Restock & Out-of-Stock Tracking:** Modified engine to declare OOS only after 16 misses, triggering highly accurate `🚨 RESTOCK ALERT` notifications.
- [x] **Context-Aware Dynamic UI:** Upgraded Telegram notification payloads to natively render specific Merchant checkout buttons (🛒 vs 📦) based on conditions.
- [x] **Destructive Action Confirmations:** Added stateless edge-routed confirmation gates for Revoke, Demote, Promote, and Clear Target actions to prevent fat-finger accidents.
- [ ] **The Invisible Flash Deal UI Bug (`worker.js`)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Prevent isolated Amazon Resale restocks (`[None, Price, None]`) from becoming invisible on the Chart.js UI, and properly label the data to reflect the backend architecture.<br>
  **The Strategy:** Currently, `worker.js` uses a hardcoded `pointRadius` filter that hides data points if there is more than one isolated restock in history. We must replace this with a dynamic callback function that renders a dot if the point is bounded by `null`. Simultaneously, we must rename the dataset label to "Lowest Used Offer" to clarify that the graph plots the market floor, not individual asset tracking.<br>
  **🤖 AI Execution Prompt:** *"In `worker.js`, locate the `Chart.js` configuration inside `renderChartHTML`. I need to make two updates to the Used dataset. First, change its `label` from 'Used (EGP)' to 'Lowest Used Offer (EGP)'. Second, replace the hardcoded `pointRadius` logic with a dynamic function: `pointRadius: function(ctx) { const index = ctx.dataIndex; const data = ctx.dataset.data; if (data[index] === null) return 0; const prev = index > 0 ? data[index - 1] : null; const next = index < data.length - 1 ? data[index + 1] : null; return (prev === null || next === null) ? 4 : 0; }`. Ensure `spanGaps` remains `false`."*
  </details>
- [ ] **Chart Analytics UI (ATH, ATL, Avg)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Show All-Time High, All-Time Low, and Average Price inside the Web App.<br>
  **The Strategy:** Do *not* calculate this in Python. Modify the HTML/JS template injected by `worker.js`. Have the client's browser parse the historical JSON array, calculate the metrics natively, and inject them into DOM tiles above the `Chart.js` canvas.<br>
  **🤖 AI Execution Prompt:** *"I am modifying the `/chart` Web App HTML template inside `worker.js`. Write client-side JavaScript to iterate through the injected `historyData` array. Calculate the All-Time High, All-Time Low, and Average for the `n` (New) prices. Provide the CSS and HTML to display these as three clean, modern metric cards above the canvas."*
  </details>
- [ ] **All-Time Low (ATL) Intelligence**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Inject high-urgency text when a price drops to its lowest recorded state.<br>
  **The Strategy:** In `price_tracker.py`, immediately after fetching the `history:{asin}` data, calculate `min(history['n'])`. If the `c_new_price` is strictly less than that minimum, append a "🔥 ALL-TIME LOW" banner to the Telegram alert string.<br>
  **🤖 AI Execution Prompt:** *"In `price_tracker.py`, when evaluating a `(New)` price drop, check the historical `n` values from the `history_data` array. If the new price is lower than any previously recorded history point, dynamically inject a '🔥 ALL-TIME LOW' banner at the top of the Telegram alert payload."*
  </details>
- [ ] **The "Stale Target" Auto-Pause**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Auto-pause targets that are unrealistic and wasting API bandwidth.<br>
  **The Strategy:** Update `worker.js` to stamp an `added_at` epoch timestamp when a user sets a target. In `price_tracker.py`, check if `unix_now_ms - added_at` exceeds 90 days. If so, toggle `paused: true` and send an informational Telegram message.<br>
  **🤖 AI Execution Prompt:** *"Update `worker.js` to inject an `added_at` timestamp when `/settarget` is used. Then, in `price_tracker.py`, write a pre-evaluation filter: if an item has a target and is older than 90 days, remove it from the active API fetch pool, set `paused: true` in its KV dictionary, and queue a Telegram alert informing the user their stale target was retired."*
  </details>
- [ ] **Silent Night Mode**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Prevent Telegram from buzzing users' phones at 3:00 AM for non-critical alerts.<br>
  **The Strategy:** In `price_tracker.py`, check the `cairo_tz` current hour. If it is between 23 (11 PM) and 7 (7 AM), append `"disable_notification": True` to the JSON payload in `async_send_telegram`, *unless* it's a Target Met alert.<br>
  **🤖 AI Execution Prompt:** *"In `price_tracker.py`, extract the current hour from the `cairo_tz` datetime object. If the hour is >= 23 or <= 7, modify the `async_send_telegram` payload to include `"disable_notification": True`. However, if `is_target` is True, bypass this and always push the notification audibly."*
  </details>

## 🔐 Phase 4: Identity Provisioning & Security Governance

- [ ] **Strict Region-Lock Enforcement (Dynamic Geofencing)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Prevent global ASIN scope leaks where non-EG links (e.g., `.ae`) trigger false "Already Tracked" flags or implicitly coerce foreign products into the Egyptian database.<br>
  **The Strategy:** Broaden the `isAmazonLink` regex listener to intercept all global Amazon domains. Dynamically parse the domain (`amazon.eg`, `amazon.ae`) via regex, validate it against a `SUPPORTED_REGIONS` whitelist array, and issue a clean "Region Not Supported" error for non-whitelisted domains.<br>
  **Future-Proofing:** Ensure the extracted `productDomain` is primed to be saved into the user's JSON KV dictionary when Phase 5 activates.
  </details>
- [ ] **Automated Access Provisioning (The Join Queue)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Eliminate manual ID hand-offs and build a scalable join-request pipeline.<br>
  **The Strategy:** Introduce a new JSON array key: `queue:pending`. Unapproved users clicking `/start` will push their ID to this array via a "Request Access" button. This fires a highly stateful push notification to Admins. If Admin A clicks Approve, the callback instantly updates the original message for all admins to prevent redundant clicks. Introduce a `🔔 Pending Requests` dynamic button in the Admin Dashboard.
  </details>
- [ ] **Object-Level IAM Metadata (Creator Tags)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Provide standard admins with immediate context on who approved a specific user.<br>
  **The Strategy:** Introduce a sidecar KV string key `approved_by:{userId}` storing the approver's ID to avoid breaking the Python engine's existing `auth:{id}` contract. During the UI loop, run this ID through the edge-cached `resolveUserProfile` function to dynamically render "Approved by: [Name]" on the User Management Card.
  </details>
- [ ] **Forensic Security Audit Log (Web App SIEM)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Implement a forensic paper trail for granular CRUD actions without draining Read/List quotas or cluttering Telegram UI.<br>
  **The Strategy:** Introduce `global:audit_log` as a rolling JSON array hard-capped at 50 events. Hook all state-modifying admin callbacks (Revoke, Limit Change, Delete) to push lightweight events here. Build a dedicated `/audit` HTML Web App route secured by HMAC token verification (verifying both expiration and Root Admin authorization) to render a color-coded HTML table.
  </details>

## 🌍 Phase 5: Platform Expansion (Growth)

- [ ] **Multi-Marketplace Support (Amazon.ae / .sa)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Scale the bot beyond Egypt using the foundation built in Phase 4.<br>
  **The Strategy:** Leverage the `productDomain` extraction implemented in the Phase 4 Geofence update. Inject `region: productDomain` into the `user:{chat_id}` KV object when a product is added. Move the `AMZN_ASSOCIATES_TAG` and `Country` hardcodes out of the global scope. Dynamically group `fetch_batch` execution queues by region in `price_tracker.py` rather than pooling all ASINs universally together.<br>
  **🤖 AI Execution Prompt:** *"AzTracker needs to support multiple Amazon regions based on the `productDomain` field in the user's KV profile. Walk me through the architecture of storing regional preferences (EG, AE, SA), and how to dynamically group `fetch_batch` execution queues by region rather than pooling all ASINs together."*
  </details>

## 🛑 Intentional Architectural Boundaries
*Features explicitly rejected to preserve the core product vision.*

- **"Target Met" Stagnation Fix:** Rejected. Modifying the engine to continuously send alerts for new all-time lows *after* a target is met violates the strict "Zero-Spam Boolean Lock" philosophy. If a target is met, the system alerts once and locks.
- **Multi-Button Product Dashboard:** Rejected. Stacking redundant Telegram inline buttons for every hidden merchant on the `/manage` dashboard creates extreme UI fatigue. Kept as clean, embedded HTML text links.
- **Real-Time Database Garbage Collection:** Rejected. Implementing a paginated `.list()` sweep inside the per-minute Python engine exhausts Cloudflare's 1,000/day REST API free tier limits within hours. Hivemind sizing has been securely offloaded to the 4-hour GitHub Actions backup cron, and real-time GC is indefinitely suspended.
