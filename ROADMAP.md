# 🗺️ AzTracker Architecture Roadmap & Tech Debt

This document tracks the technical debt, security fortifications, and feature expansion milestones planned for future iterations of the AzTracker engine.

## 🛡️ Phase 1: The Ironclad Foundation (Security & Stability)
*These are the silent threats. Prioritize these to ensure the system is completely tamper-proof and crash-proof.*

- [x] **The Regex URL Parser:** Replace the fragile `.split("/")[-1]` in `price_tracker.py` with the robust regex used in `worker.js` to ensure Amazon tracking queries (e.g., `?ref=...`) never break the API batch fetch.
- [x] **Zero-Trust Webhook Validation:** Implement `X-Telegram-Bot-Api-Secret-Token` header verification in `worker.js` to guarantee that only Telegram's official servers can trigger the POST endpoint.
- [x] **Header-Based Scheduler Auth:** Move the `SCHEDULER_SECRET` out of the query string and into the `x-scheduler-key` HTTP header in both cron-job.org and the `worker.js` routing logic.
- [x] **Supply Chain Security:** Update `requirements.txt` to pin the custom Amazon PA-API library to a specific commit hash rather than the floating `main` branch.
- [x] **Clean the Python Syntax:** Fix the misleading indentation around the global prices fetch block in `price_tracker.py` to prevent future maintenance confusion.

## ⚡ Phase 2: DevOps & Database Optimization (Speed & Scaling)
*Focuses on bypassing hardware and network limits to make the engine run faster while future-proofing Cloudflare KV limits.*

- [x] **Sharding the Global Blob:** Break the massive `global_prices` JSON object into individual KV pairs keyed as `price:{asin}`. This neutralizes Cloudflare's 25MB value limit.
- [x] **Asynchronous Processing:** Refactor the sequential `requests.get()` and `requests.put()` loops in the Python engine to use `asyncio` and `aiohttp`. Firing KV updates simultaneously will drastically reduce GitHub Actions runtime.
- [x] **GitHub Actions `pip` Cache:** Add the `actions/cache` step to `price_tracker.yml` to cache Python dependencies, saving ~30 seconds of compute time per run.
- [x] **DRY RBAC Refactor:** Extract the duplicate Admin/Root Admin validation logic in `worker.js` into a single `getUserRoles(chatId, env)` helper function.
- [x] **Automated KV Backups:** Add a pre-execution step in `price_tracker.yml` to download the `global_prices` and `history` JSON objects from Cloudflare KV and save them as GitHub artifacts. This ensures disaster recovery is possible if a script error corrupts the serverless database.
- [x] **KV Write Quota Auditing:** Refactor the `schedule` and `runlock` key generations in `worker.js`. Currently, the scheduler consumes ~216 writes per day just checking in. Transition the lock mechanism to use Cloudflare's in-memory standard caching API instead of KV to free up database quota for actual product price updates.
- [x] **Unify Timestamp Architecture:** Refactor the `last_updated` field in `global_prices` to use Unix epoch integers (`int(time.time() * 1000)`) instead of `pytz` formatted strings. Update `worker.js` `renderProductView` to ingest the epoch timestamp natively, ensuring backward compatibility with legacy string formats during the transition.
- [ ] **KV Read Optimization in Webhook:** Wrap the `global:admins` and `global:approved_users` fetches inside `getUserRoles()` using the Cloudflare `caches.default` API (60-second TTL) to drastically slash KV Read operations during heavy UI navigation.
- [ ] **Dead-User Pruning (403 Handling):** Catch Telegram `403 Forbidden` errors in the async notification engine. Automatically toggle a `paused: true` state for users who block the bot to prevent wasted Amazon API calls and KV reads.

## 📊 Phase 3: The User Experience (Resilience & Analytics)
*Improving what the user actually sees and feels.*

- [ ] **Fetch Failure States:** Build a UI fallback so if an item vanishes from Amazon or errors out during the API fetch, the user's dashboard shows a "⚠️ Fetch Failed" state instead of silent stagnation.
- [ ] **Chart Analytics UI:** Update the edge-rendered Web App to calculate and display the All-Time High, All-Time Low, and Average Price above the Chart.js graph.
- [ ] **Upward Trend Alerts:** Add a feature toggle allowing users to be warned if a tracked item's price goes *up* (creating urgency to buy before it climbs higher).
- [ ] **The "Kill Switch" (Opt-Out Command):** Implement a `/stop` command and a "Delete My Account" button in the `worker.js` user settings. This will automatically execute a safe purge of their `user:{chat_id}:products` and `ui:{chat_id}` keys, allowing users to permanently erase their data from the serverless database.
- [ ] **All-Time Low (ATL) Intelligence:** Enhance the `price_tracker.py` notification engine to evaluate new price drops against the `history:{asin}` array. If a drop matches or beats the historical minimum, inject a high-urgency "🔥 ALL-TIME LOW" banner into the Telegram alert.
- [ ] **Glanceable History Metrics:** Update `worker.js` to compute All-Time High (ATH), All-Time Low (ATL), and Average Price on the fly, injecting these quick stats directly into the Telegram product card for immediate context.
- [ ] **Restock & Out-of-Stock (OOS) Tracking:** Modify the Python engine to log "OOS" states in the `global_prices` database. Implement a routing block to trigger specific "🚨 RESTOCK ALERT" notifications when an unavailable item returns to the Amazon catalog.
- [ ] **Interactive Web App Target Setting:** Expand the `/chart/` Web App HTML to include an input UI for setting target prices. Build a `POST /api/set-target` endpoint in `worker.js` so users can update their database parameters natively within the graph interface, completely bypassing the Telegram chat flow.
- [ ] **Silent Night Mode:** Utilize Telegram's `disable_notification=True` parameter in the engine. If the server time is between 11 PM and 7 AM Cairo time, push alerts silently to avoid disturbing sleeping users.
- [ ] **The "Stale Target" Auto-Pause:** Introduce a 90-day tracking lifespan. If an item hasn't hit its aggressive target in 90 days, auto-pause it to save resources and notify the user to re-evaluate their price goal.

## 🌍 Phase 4: Platform Expansion (Growth)
*Scaling the surface area of the platform.*

- [ ] **Multi-Marketplace Support:** Parameterize the Amazon Creators API initialization to support `Amazon.sa` and `Amazon.ae`, opening the tracker to the broader Middle East market.
- [ ] **Group Chat / Inline Mode:** Modify the Telegram payload parsers so the bot can be dropped into group chats, allowing multiple people to query live prices natively in a shared chat.
