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
  
  **The Goal:** Stop the Telegram inline button from spinning endlessly when a user clicks any passive or background-processing button.<br>
  **The Strategy:** Instead of patching individual buttons like `"ignore"`, we implemented a global interceptor. We added a `ctx.waitUntil()` fetch call to Telegram's `answerCallbackQuery` endpoint at the absolute top of the `handleCallback` pipeline. This instantly kills the loading spinner for all UI interactions without blocking the edge worker's main execution thread.
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


## ⚡ Phase 2: DevOps & Database Optimization (Speed & Scaling)

- [x] **Sharding the Global Blob:** Broke the massive `global_prices` JSON object into individual KV pairs to neutralize Cloudflare's 25MB value limit.
- [x] **Asynchronous Processing & Bounded Concurrency:** Refactored engine to use `asyncio.Semaphore()` and `aiohttp` to prevent Layer 7 TCP exhaustion.
- [x] **Automated KV Backups:** Decoupled from the primary execution tracker into a dedicated native GitHub Actions cron (`backup_db.yml`) running every 4 hours to drastically reduce Cloudflare `List` API quota consumption.
- [x] **KV Write Quota Auditing:** Transitioned the jitter lock mechanism to use Cloudflare's in-memory standard caching API instead of KV, freeing up quota.
- [x] **Time-Based Write Amplification Shield:** Replaced volatile iteration counters with static UNIX timestamps for the Anti-Flap engine. Reduced Lazy Refresh metadata TTLs to 6 hours, and implemented a strict 30-minute heartbeat throttle on the global dashboard stats, reducing daily KV overhead writes to near-zero.
- [x] **KV Pagination Blindspot:** Implemented `cursor` while-loops for multi-tenant KV fetches to safely bypass Cloudflare's 1,000-key response truncation limit.
- [ ] **KV Read Optimization in Webhook (`caches.default`)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Drastically reduce Cloudflare KV Read billing during heavy UI navigation.<br>
  **The Strategy:** Wrap the `getUserRoles()` fetch inside `worker.js` with Cloudflare's native `caches.default` API using a 60-second TTL.<br>
  **🤖 AI Execution Prompt:** *"In `worker.js`, I need to cache the `getUserRoles` KV fetches. Please rewrite the authorization function to check `caches.default.match()` using a synthetic Request object before falling back to `env.AZTRACKER_DB.get()`. If falling back, `caches.default.put()` the result with a 60-second Cache-Control header."*
  </details>
- [ ] **Dead-User Pruning (403 Handling)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Prevent the Amazon API from wasting quota on tracking items for users who have blocked the Telegram bot.<br>
  **The Strategy:** When `async_send_telegram()` in `price_tracker.py` receives an HTTP 403 Forbidden, append that user ID to a "dead_users" set. During the KV sync phase, toggle all their items to `paused: true`.<br>
  **🤖 AI Execution Prompt:** *"In `price_tracker.py`, update `async_send_telegram` to return a specific '403' flag if the user blocked the bot. If this flag is caught in the delivery loop, add the chat_id to a `dead_users` set. During the final Two-Phase Commit, inject logic to iterate over `dead_users` and set `paused = True` for all their active items."*
  </details>
- [ ] **Orphaned Data Leak (Garbage Collection)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Prune "zombie" `price:{asin}` shards from the database when no user is tracking them anymore, and fix the `hivemind_size` dashboard metric.<br>
  **The Strategy:** Fetch the total keys from the `prefix=price:` query using a cursor loop. Compare this against the active `unique_asins` set and issue `DELETE` commands for orphaned ASINs. Simultaneously, use the true length of this fetched key array to accurately update the `hivemind_size` metric in `global:stats`, resolving the dashboard metric illusion.<br>
  **🤖 AI Execution Prompt:** *"In `price_tracker.py`, after we fetch `unique_asins` from all users, we need to compare it to the full list of `price:*` keys in KV. Write a paginated cursor loop to fetch all price keys. Build a garbage collection block that identifies orphaned ASINs and adds bounded `DELETE` requests to purge them. Finally, use the total count of those fetched keys to correctly define the `hivemind_size` variable before the `global:stats` payload is pushed."*
  </details>
  

## 📊 Phase 3: The User Experience (Resilience & Analytics)

- [x] **Anti-Flap Hysteresis Engine:** Built a 16-run holding buffer to protect the UI and database from Amazon PA-API payload truncation glitches.
- [x] **Restock & Out-of-Stock Tracking:** Modified engine to declare OOS only after 16 misses, triggering highly accurate `🚨 RESTOCK ALERT` notifications.
- [x] **Context-Aware Dynamic UI:** Upgraded Telegram notification payloads to natively render specific Merchant checkout buttons (🛒 vs 📦) based on conditions.
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

## 🛑 Intentional Architectural Boundaries
*Features explicitly rejected to preserve the core product vision.*

- **"Target Met" Stagnation Fix:** Rejected. Modifying the engine to continuously send alerts for new all-time lows *after* a target is met violates the strict "Zero-Spam Boolean Lock" philosophy. If a target is met, the system alerts once and locks.
- **Multi-Button Product Dashboard:** Rejected. Stacking redundant Telegram inline buttons for every hidden merchant on the `/manage` dashboard creates extreme UI fatigue. Kept as clean, embedded HTML text links.

## 🌍 Phase 4: Platform Expansion (Growth)

- [ ] **Multi-Marketplace Support (Amazon.ae / .sa)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Scale the bot beyond Egypt.<br>
  **The Strategy:** Move the `AMZN_ASSOCIATES_TAG` and `Country.EG` hardcodes into the `user:{chat_id}` KV object. Initialize the `AmazonCreatorsApi` dynamically per batch based on the user's regional preferences.<br>
  **🤖 AI Execution Prompt:** *"AzTracker needs to support multiple Amazon regions. Walk me through the architecture of storing regional preferences (EG, AE, SA) inside the user's KV profile, and how to dynamically group `fetch_batch` execution queues by region rather than pooling all ASINs together."*
  </details>
