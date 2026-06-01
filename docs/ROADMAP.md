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

- [x] **Anti-Flap Hysteresis Engine:** Built a 2.5-hour static timestamp holding buffer to protect the UI and database from Amazon PA-API payload truncation glitches.
- [x] **Restock & Out-of-Stock Tracking:** Modified engine to declare OOS only after a strict 2.5-hour continuous absence, triggering highly accurate `🚨 RESTOCK ALERT` notifications.
- [x] **Context-Aware Dynamic UI:** Upgraded Telegram notification payloads to natively render specific Merchant checkout buttons (🛒 vs 📦) based on conditions.
- [x] **Destructive Action Confirmations:** Added stateless edge-routed confirmation gates for Revoke, Demote, Promote, and Clear Target actions to prevent fat-finger accidents.
- [x] **The Invisible Flash Deal UI Bug (`worker.js`)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Prevent isolated Amazon Resale restocks (`[None, Price, None]`) from becoming invisible on the Chart.js UI, and properly label the data to reflect the backend architecture.<br>
  **The Strategy:** Currently, `worker.js` uses a hardcoded `pointRadius` filter that hides data points if there is more than one isolated restock in history. We must replace this with a dynamic callback function that renders a dot if the point is bounded by `null`. Simultaneously, we must rename the dataset label to "Lowest Used Offer" to clarify that the graph plots the market floor, not individual asset tracking.<br>
  **🤖 AI Execution Prompt:** *"In `worker.js`, locate the `Chart.js` configuration inside `renderChartHTML`. I need to make two updates to the Used dataset. First, change its `label` from 'Used (EGP)' to 'Lowest Used Offer (EGP)'. Second, replace the hardcoded `pointRadius` logic with a dynamic function: `pointRadius: function(ctx) { const index = ctx.dataIndex; const data = ctx.dataset.data; if (data[index] === null) return 0; const prev = index > 0 ? data[index - 1] : null; const next = index < data.length - 1 ? data[index + 1] : null; return (prev === null || next === null) ? 4 : 0; }`. Ensure `spanGaps` remains `false`."*
  </details>

- [x] **Chart Analytics UI (ATH, ATL, Avg)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Show All-Time High, All-Time Low, and Average Price inside the Web App.<br>
  **The Strategy:** Do *not* calculate this in Python. Modify the HTML/JS template injected by `worker.js`. Have the client's browser parse the historical JSON array, calculate the metrics natively, and inject them into DOM tiles above the `Chart.js` canvas.<br>
  **🤖 AI Execution Prompt:** *"I am modifying the `/chart` Web App HTML template inside `worker.js`. Write client-side JavaScript to iterate through the injected `historyData` array. Calculate the All-Time High, All-Time Low, and Average for the `n` (New) prices. Provide the CSS and HTML to display these as three clean, modern metric cards above the canvas."*
  </details>

- [x] **All-Time Low (ATL) Intelligence**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Inject high-urgency text when a price drops to its lowest recorded state.<br>
  **The Strategy:** In `price_tracker.py`, immediately after fetching the `history:{asin}` data, calculate `min(history['n'])`. If the `c_new_price` is strictly less than that minimum, append a "🔥 ALL-TIME LOW" banner to the Telegram alert string.<br>
  **🤖 AI Execution Prompt:** *"In `price_tracker.py`, when evaluating a `(New)` price drop, check the historical `n` values from the `history_data` array. If the new price is lower than any previously recorded history point, dynamically inject a '🔥 ALL-TIME LOW' banner at the top of the Telegram alert payload."*
  </details>

- [x] **The "Stale Target" Auto-Pause**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Auto-pause targets that are unrealistic and wasting API bandwidth.<br>
  **The Strategy:** Update `worker.js` to stamp an `added_at` epoch timestamp when a user sets a target. In `price_tracker.py`, check if `unix_now_ms - added_at` exceeds 90 days. If so, toggle `paused: true` and send an informational Telegram message.<br>
  **🤖 AI Execution Prompt:** *"Update `worker.js` to inject an `added_at` timestamp when `/settarget` is used. Then, in `price_tracker.py`, write a pre-evaluation filter: if an item has a target and is older than 90 days, remove it from the active API fetch pool, set `paused: true` in its KV dictionary, and queue a Telegram alert informing the user their stale target was retired."*
  </details>


## 🔐 Phase 4: Identity Provisioning & Security Governance

- [x] **Strict Region-Lock Enforcement (Dynamic Geofencing)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Prevent global ASIN scope leaks where non-EG links trigger false "Already Tracked" flags or implicitly coerce foreign products into the Egyptian database.<br>
  **The Strategy:** Broaden the `isAmazonLink` regex listener to intercept all global Amazon domains. Dynamically parse the domain (`amazon.eg`, `amazon.ae`) via regex, validate it against a `SUPPORTED_REGIONS` whitelist array, and issue a clean "Region Not Supported" error for non-whitelisted domains. Ensure the extracted `productDomain` is primed to be saved into the user's JSON KV dictionary when Phase 5 activates.<br>
  **🤖 AI Execution Prompt:** *"In `worker.js`, broaden the `isAmazonLink` check to capture any `amazon.` or `amzn.` string. Following the URL expansion, extract the domain using regex. If it does not match a `SUPPORTED_REGIONS = ['amazon.eg']` array, return a Telegram error stating the region is unsupported, preventing the ASIN from being parsed."*
  </details>

- [x] **Automated Access Provisioning (The Join Queue)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Eliminate manual ID hand-offs and build a scalable join-request pipeline.<br>
  **The Strategy:** Introduce a `global:join_queue` KV array. Unapproved users hitting `/start` receive a "Request Access" button which pushes their ID to the array. This fires a push notification to Admins. To prevent the "Thundering Herd" race condition, the Admin approval callback must verify the ID is still in the queue, execute the approval, and instantly edit the notification message text to "Request Handled" so other Admins cannot click a stale button.<br>
  **🤖 AI Execution Prompt:** *"Update `worker.js` to handle unauthorized `/start` commands with an inline 'Request Access' button. When clicked, append their ID to a `queue:pending` KV array and send a notification to all Admin IDs. Modify the approval callback so that when an Admin clicks 'Approve', it verifies the ID in the queue, removes it, executes the approval, and edits the original Admin notification message to say '✅ Approved by [Admin Name]'."*
  </details>

- [x] **Pending Request TTL & Queue Depth Gate**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Prevent `queue:pending` from accumulating stale, abandoned join requests indefinitely when admins miss or ignore a notification.<br>
  **The Strategy:** Store join requests as objects `{ id, requested_at }` instead of raw ID strings. When rendering the admin pending list, filter out any entry where `Date.now() - requested_at` exceeds 7 days — no  companion keys, no extra KV reads, zero quota cost. Simultaneously, enforce a max-depth of 25: before appending a new request, check the array length and return a user-facing "Access queue is currently full, please try again in 24 hours" message if the limit is reached, preventing unbounded growth under any load condition.<br>
  **🤖 AI Execution Prompt:** *"In `worker.js`, update the Join Queue logic. When a user clicks 'Request Access', instead of pushing their raw `chat_id` to `queue:pending`, push the object `{ id: chatId, requested_at: Date.now() }`. Before appending, read the current array and (1) filter out entries older than 7 days, (2) check if the filtered length is 25 or more and return a friendly Telegram error if so. Update the admin pending-list renderer to read from `entry.id` instead of the raw string, and display a human-readable relative timestamp (e.g. 'Requested 3 days ago') next to each entry using the `requested_at` field."*
  </details>
  
- [x] **Object-Level IAM Metadata (Creator Tags)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Provide admins with immediate context on who approved a specific user.<br>
  **The Strategy:** Do not alter the `auth:{userId}` string, as this would break the Python engine's auth contract. Instead, introduce a sidecar KV string key `approved_by:{userId}` storing the approver's ID. During the UI loop, fetch this key, run it through the edge-cached `resolveUserProfile` function, and dynamically render "Approved by: [Name]" on the User Management Card.<br>
  **🤖 AI Execution Prompt:** *"When an Admin approves a user in `worker.js`, write their ID to a new key `approved_by:{targetId}`. Update `renderAdminUserProducts` to fetch this key, resolve it to a Telegram name using the existing cached profile function, and inject it into the text of the user's management card. Fallback to 'Legacy Admin' if the key does not exist."*
  </details>

- [x] **Forensic Security Audit Log (Web App SIEM)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Implement a forensic paper trail for granular CRUD actions without causing TOCTOU race conditions or draining Read/List quotas.<br>
  **The Strategy:** Writing to a single `global:audit_log` array creates a Read-Modify-Write TOCTOU vulnerability. Instead, hook all state-modifying admin callbacks to write atomic, self-expiring keys: `audit:{timestamp}:{admin_id}` with a 7-day TTL. To respect the Low-List architecture, we will NOT sweep these in the background. Build a dedicated `/audit` HTML Web App route secured by HMAC token verification. The KV `.list()` operation will *only* be executed when the Root Admin explicitly opens the SIEM dashboard, costing exactly 1 List operation per manual view.<br>
  **🤖 AI Execution Prompt:** *"In `worker.js`, create a helper `logAudit(env, adminId, action, target)`. It must write an atomic key `audit:{Date.now()}:{adminId}` with the JSON payload and a 7-day TTL. Then, create a new Web App route `/audit` and an API route `/api/audit` secured by HMAC signature. The API route executes `env.AZTRACKER_DB.list({ prefix: 'audit:' })`, fetches the keys, and returns the sorted JSON to the Web App to render a color-coded HTML table."*
  </details>

- [x] **Force Price Check Audit Logging**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Capture manual GitHub Actions dispatches in the audit trail to enable correlation between on-demand price checks and unexpected Amazon API quota spikes.<br>
  **The Strategy:** Each manual "Force Price Check" button press dispatches a GitHub Actions run and consumes API quota ahead of the normal schedule. Call the existing `logAudit(env, adminId, action, target)` helper immediately after a successful `triggerWorkflow()` response, with `action: 'FORCE_CHECK'` and `target: 'price_tracker.yml'`. No schema changes required — the existing audit key format and SIEM renderer handle it automatically.<br>
  **🤖 AI Execution Prompt:** *"In `worker.js`, locate the callback handler that calls `triggerWorkflow()` for a manual force price check. Immediately after confirming a successful dispatch response, add a call to `logAudit(env, adminId, 'FORCE_CHECK', 'price_tracker.yml')`. Ensure this only fires on success so failed dispatch attempts are not logged as completed actions."*
  </details>

## 🔁 Phase 5: Scheduler Resilience & Uptime Visibility (Circuit Breaker)

- [x] **GitHub Actions Health Detection in `triggerWorkflow()`**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Make `triggerWorkflow()` return structured status information so the scheduler can detect GitHub API outages.<br>
  **The Strategy:** Refactor `triggerWorkflow()` to return the raw `Response` object. Wrap the fetch in a `try/catch` to handle DNS/Timeout failures and return a synthetic `{ ok: false, status: 0 }` object.<br>
  **🤖 AI Execution Prompt:** *"Refactor the `triggerWorkflow()` function to return the raw `Response` object instead of throwing an error. Wrap the `fetch` call in a `try/catch` block to handle DNS or timeout failures, returning a synthetic `{ ok: false, status: 0 }` object in the catch block."*
  </details>
- [x] **Colo-Local Circuit Breaker (Open / Half-Open / Closed)**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Stop hammering a dead GitHub API during outages, naturally throttling via an Edge-based state machine.<br>
  **The Strategy:** Utilize `caches.default` to create an `/_internal/circuit/open` flag. *Note: Because Cloudflare Cache is local to the specific datacenter, and cron-job.org routes through a consistent regional node, this acts as a perfect, zero-KV-read isolated circuit breaker.* It opens for 15 minutes upon a 5xx failure, probes once at the expiration (Half-Open), and fully closes upon a 2xx success.<br>
  **🤖 AI Execution Prompt:** *"In `worker.js` inside `handleScheduler()`, implement an Edge-based circuit breaker using `caches.default`. If `triggerWorkflow()` returns a 5xx status, write a synthetic cache response to `/_internal/circuit/open` with a 15-minute TTL. While this cache key exists, instantly reject incoming cron pings with HTTP 503. After expiration, allow one single 'Half-Open' probe; if successful (2xx), clear the circuit and resume normal operations."*
  </details>
- [x] **Instant Alert & Auto-Recovery Notifications**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Notify the Root Admin instantly when the system degrades, and confirm when it self-heals.<br>
  **The Strategy:** Introduce an `/_internal/circuit/alerted` cache key with a 2-hour TTL to suppress spam. Fire a Telegram alert on the initial break, and fire a "✅ System Recovered" alert when a successful 2xx response clears the circuit block.<br>
  **🤖 AI Execution Prompt:** *"Extend the circuit breaker logic in `worker.js` to dispatch Telegram notifications to the Root Admins. When the circuit transitions to OPEN, check for an `/_internal/circuit/alerted` cache key. If absent, send a '🚨 GitHub Actions Outage' alert and set the alerted cache key with a 2-hour TTL. When the circuit successfully transitions from HALF-OPEN back to CLOSED, send a '✅ System Recovered' alert and delete the alerted cache key."*
  </details>
- [x] **Scheduler Status Endpoint (`/scheduler/status`)**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Provide a lightweight authenticated endpoint to query the current circuit state.<br>
  **The Strategy:** Guarded by `x-scheduler-key`, this endpoint returns a JSON object containing the circuit status, the alerted flag, and the upcoming trigger slots for the hour, requiring absolutely zero KV reads to execute.<br>
  **🤖 AI Execution Prompt:** *"In `worker.js`, create a new route handler for `/scheduler/status` guarded by the `x-scheduler-key` header. It should return a JSON response containing the current circuit state (CLOSED, OPEN, or HALF-OPEN), the status of the `alerted` cache flag, and the array of calculated hourly trigger slots from `buildHourlySlots()`."*
  </details>

## ⚙️ Phase 6: Operational Tooling (Zero-Friction Deployment)

- [x] **Interactive One-Command Setup Script (`setup.py`)**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Reduce the full deployment process to one terminal command that requests standard credentials and auto-generates cryptographic secrets.<br>
  **The Strategy:** Create `setup.py`. Programmatically generate `.gitignore` first to prevent secret leakage. Auto-generate `CRON_AUTH_KEY` and `TELEGRAM_WEBHOOK_SECRET` as 32-character secure strings. Validate all manual inputs via regex and pass them through to the automated provisioning functions.<br>
  **🤖 AI Execution Prompt:** *"Create a new Python script named `setup.py` in the project root. Programmatically generate a `.gitignore` file (including `.env` and `wrangler.toml`) as the absolute first step. Write functions to securely generate 32-character strings for `CRON_AUTH_KEY` and `TELEGRAM_WEBHOOK_SECRET` using the `secrets` module. Use regex to validate user inputs for Telegram IDs and Cloudflare strings."*
  </details>
- [x] **Cloudflare KV Namespace Auto-Creator**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Automatically provision the `AZTRACKER_DB` KV namespace and inject it into `wrangler.toml`.<br>
  **The Strategy:** `POST` to the Cloudflare API to create the namespace. Parse the `result.id` from the response and use regex to overwrite the `id = "..."` line inside `wrangler.toml` in place.<br>
  **🤖 AI Execution Prompt:** *"In `setup.py`, create a function that executes a POST request to the Cloudflare API's KV namespace creation endpoint. Parse the `result.id` from the JSON response. Read the local `wrangler.toml` file and use regex to perform an in-place replacement of the `id = "..."` line within the `[[kv_namespaces]]` block."*
  </details>
- [x] **GitHub Repository Secrets Auto-Provisioner**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Push all repository secrets to GitHub programmatically using `PyNaCl` encryption.<br>
  **The Strategy:** Fetch the repo's public key from the GitHub API. Encrypt each secret locally using `crypto_box_seal` and push them to the Actions Secrets endpoint.<br>
  **🤖 AI Execution Prompt:** *"In `setup.py`, implement a GitHub Actions Secrets provisioner using `PyNaCl`. First, fetch the repository's public key from the GitHub API. Then, encrypt each required secret locally using `nacl.public.SealedBox` and `crypto_box_seal`, and push the encrypted payloads to the GitHub repository secrets endpoint."*
  </details>
- [x] **Cloudflare Worker Secrets Auto-Injector**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Automate the injection of production secrets into the deployed Cloudflare Worker environment.<br>
  **The Strategy:** Read the worker name from `wrangler.toml`. Poll the GitHub Actions API to ensure the worker deployment pipeline succeeds, then `PUT` the secrets directly into the Cloudflare Worker via their REST API.<br>
  **🤖 AI Execution Prompt:** *"In `setup.py`, write a function that polls the GitHub Actions API to wait for the worker deployment pipeline to complete successfully. Once deployed, execute a sequence of PUT requests to the Cloudflare Workers REST API to inject the production secrets directly into the deployed edge environment."*
  </details>
- [x] **Telegram Webhook Auto-Registrar & Health Gate**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Programmatically wire the Telegram API to the newly deployed Cloudflare Worker and run a full diagnostic probe.<br>
  **The Strategy:** Resolve the `.workers.dev` subdomain dynamically, register the Webhook with Telegram using the generated `secret_token`, and execute a sequence of 4 health probes (Webhook Info, Scheduler Ping, KV Instantiation check, and Actions Status).<br>
  **🤖 AI Execution Prompt:** *"In `setup.py`, write a final diagnostic health gate function. It must dynamically resolve the `.workers.dev` subdomain, register the webhook with the Telegram API using the generated `secret_token`, and sequentially fire 4 HTTP probes: Webhook Info, Scheduler Ping, KV Instantiation check, and Actions Status."*
  </details>
- [x] **Telegram Webhook Auto-Registrar & Health Gate**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Programmatically wire the Telegram API to the newly deployed Cloudflare Worker and run a full diagnostic probe.<br>
  **The Strategy:** Resolve the `.workers.dev` subdomain dynamically, register the Webhook with Telegram using the generated `secret_token`, and execute a sequence of 4 health probes (Webhook Info, Scheduler Ping, KV Instantiation check, and Actions Status).<br>
  **🤖 AI Execution Prompt:** *"In `setup.py`, write a final diagnostic health gate function. It must dynamically resolve the `.workers.dev` subdomain, register the webhook with the Telegram API using the generated `secret_token`, and sequentially fire 4 HTTP probes: Webhook Info, Scheduler Ping, KV Instantiation check, and Actions Status."*
  </details>
  
## 🏗️ Phase 6.5: The Great Migration (Oracle Cloud Architecture Pivot)

**The Goal:** Transition the AzTracker engine from Cloudflare's serverless edge to a persistent Oracle Cloud Always-Free ARM instance. This replaces strict KV quotas with infinite local database writes and establishes a predictable, zero-latency execution environment.

### (a) Infrastructure & Ingress (The Foundation)
* **Docker Compose:** The entire stack will be containerized via `docker-compose.yml` to guarantee zero-friction deployments and automatic recovery upon VM reboots.
* **Caddy / Traefik Reverse Proxy:** Replacing Cloudflare's automatic SSL edge. A lightweight reverse proxy container will sit in front of the application, automatically provisioning and renewing Let's Encrypt SSL certificates (a strict requirement for Telegram Webhooks).
* **Network Security Gate:** The Oracle Virtual Cloud Network (VCN) Security Lists must be explicitly locked down to expose only ports `80` and `443`.

### (b) The Database Layer (Redis)
* **1:1 Schema Translation:** Transition from Cloudflare KV REST calls to the `redis-py` async client. The namespace schema (`user:{id}:products`, `global:stats`) remains completely unchanged.
* **AOF Persistence:** The Redis container will be configured with `appendonly yes` and `appendfsync everysec`. This guarantees that the in-memory speed does not compromise data integrity if the Oracle VM halts.
* **Local Backups:** A local bash script will snapshot the Redis `dump.rdb` file every 4 hours, replacing the GitHub Actions backup pipeline.

### (c) Application Refactoring (FastAPI)
* **The Unified Container:** `worker.js` is deprecated. The Telegram webhook router, Authorization gates, and Chart.js HTML rendering will be completely rewritten into a Python **FastAPI** application (`api.py`).
* **The Background Engine:** The `price_tracker.py` engine will no longer run as an isolated script triggered by GitHub Actions. It will be refactored as an `asyncio.create_task()` background loop running alongside the FastAPI worker, utilizing an adaptive `asyncio.sleep()` for pacing.
* **Profile Cache Continuity:** The FastAPI routing layer must implement a native memory cache (e.g., `cachetools` or standard dictionaries) to mirror Cloudflare's `caches.default`. This guarantees that Telegram profiles and user names remain fully rendered in the administration UI, rather than degrading into raw, unreadable User IDs.

### (d) The Migration Execution (Zero-Downtime Pipeline)
1. **Provisioning:** Deploy the Oracle ARM VM, install Docker, and spin up the Caddy/Redis/FastAPI containers.
2. **State Export:** Write a temporary extraction script to paginate through Cloudflare KV and download the entire production database to a single `export.json` file.
3. **State Import:** Write an ingestion script on the Oracle VM to parse `export.json` and inject all keys/values natively into the Redis container.
4. **The Cutover:** Update the Telegram Webhook via the `setWebhook` API to point from the `*.workers.dev` URL to the new Oracle domain name.
5. **The Decommission:** Once execution logs confirm the FastAPI server is intercepting Telegram updates and the async engine is pacing correctly, delete the Cloudflare Worker and KV Namespace.

### (e) The Oracle "Always-Free" Reclaim Shield
* **The Heartbeat Service:** Oracle routinely terminates inactive VMs. A background task will be added to the FastAPI engine to perform a burst of CPU-intensive matrix calculations (or database vacuuming) for 60 seconds every 12 hours. This artificially elevates the CPU and memory footprint just enough to bypass Oracle's "idle instance" reclamation algorithms.

## 🌍 Phase 7: Platform Expansion (Growth)

- [ ] **Multi-Marketplace Support (Amazon.ae / .sa)**
  <details>
  <summary><b>View Execution Brief</b></summary>
  
  **The Goal:** Scale the bot beyond Egypt using the foundation built in Phase 4.<br>
  **The Strategy:** Leverage the `productDomain` extraction implemented in the Phase 4 Geofence update. Inject `region: productDomain` into the `user:{chat_id}:products` KV array when a product is added. Move the `AMZN_ASSOCIATES_TAG` and `Country` hardcodes out of the global scope in Python. Dynamically group `fetch_batch` execution queues by region in `price_tracker.py` rather than pooling all ASINs universally together to prevent endpoint collisions.<br>
  **🤖 AI Execution Prompt:** *"AzTracker needs to support multiple Amazon regions based on the `productDomain` field in the user's KV profile. Walk me through the architecture of storing regional preferences (EG, AE, SA), and how to dynamically group `fetch_batch` execution queues by region in Python rather than pooling all ASINs together."*
  </details>

- [ ] **Adaptive Inter-Batch Backoff**
  <details>
  <summary><b>View Execution Brief</b></summary>

  **The Goal:** Replace the fixed 3-second sleep between Amazon API batch 
  requests with a dynamic wait that responds to actual rate-limit signals, reducing idle time under normal load while remaining resilient under quota pressure.<br>
  **The Strategy:** The current `await asyncio.sleep(3)` between batches is a conservative fixed guard. As Phase 7 grows the active ASIN pool across multiple regions, this compounds: 45 batches at the 450-item ceiling already produce 132 seconds of idle per run. Replace the fixed sleep with an adaptive strategy inside `fetch_batch()`: on a successful response, sleep 1 second; on a 429 response, parse `Retry-After` from the response headers and sleep that duration; on a second consecutive 429, abort the run and notify admins. This preserves rate-limit safety while cutting idle time by ~66% under normal operating conditions.<br>
  **🤖 AI Execution Prompt:** *"In `price_tracker.py`, replace the fixed `await asyncio.sleep(3)` between batch iterations in `async_main()` with an adaptive wait. Refactor `fetch_batch()` to return a status alongside its results — success, rate_limited with a retry_after value, or error. In the batch loop, sleep 1 second on success; on rate_limited, sleep the returned `retry_after` duration (minimum 5 seconds); on a second consecutive rate_limited response, break the loop, queue an admin notification via `notify_admins_of_error()`, and return whatever partial results were already collected."*
  </details>

---

## 🛑 Intentional Architectural Boundaries
*Features explicitly rejected to preserve the core product vision.*

- **"Target Met" Stagnation Fix:** Rejected. Modifying the engine to continuously send alerts for new all-time lows *after* a target is met violates the strict "Zero-Spam Boolean Lock" philosophy. If a target is met, the system alerts once and locks.
- **Multi-Button Product Dashboard:** Rejected. Stacking redundant Telegram inline buttons for every hidden merchant on the `/manage` dashboard creates extreme UI fatigue. Kept as clean, embedded HTML text links.
- **Real-Time Database Garbage Collection:** Rejected. Implementing a paginated `.list()` sweep inside the per-minute Python engine exhausts Cloudflare's 1,000/day REST API free tier limits within hours. Hivemind sizing has been securely offloaded to the 4-hour GitHub Actions backup cron, and real-time GC is indefinitely suspended.
- **Percentage-Based Target Pricing:** Rejected. Modifying the engine and database schema to calculate dynamic percentage drops (e.g., "Alert me at 20% off") introduces severe UX friction by requiring multi-step inputs, and bloats the Delta-Logger with anchor-price state management. The system strictly maintains a "Zero-Friction" fixed-price input philosophy.
- **Silent Night Mode:** Rejected. Suppressing Telegram notifications during nighttime hours assumes universal user schedules and creates an unnecessary layer of backend timezone management. Users are responsible for managing their own device-level "Do Not Disturb" settings or muting the bot natively in Telegram.
