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

- [ ] **Sharding the Global Blob:** Break the massive `global_prices` JSON object into individual KV pairs keyed as `price:{asin}`. This neutralizes Cloudflare's 25MB value limit.
- [ ] **Asynchronous Processing:** Refactor the sequential `requests.get()` and `requests.put()` loops in the Python engine to use `asyncio` and `aiohttp`. Firing KV updates simultaneously will drastically reduce GitHub Actions runtime.
- [ ] **GitHub Actions `pip` Cache:** Add the `actions/cache` step to `price_tracker.yml` to cache Python dependencies, saving ~30 seconds of compute time per run.
- [ ] **DRY RBAC Refactor:** Extract the duplicate Admin/Root Admin validation logic in `worker.js` into a single `getUserRoles(chatId, env)` helper function.
- [ ] **Automated KV Backups:** Add a pre-execution step in `price_tracker.yml` to download the `global_prices` and `history` JSON objects from Cloudflare KV and save them as GitHub artifacts. This ensures disaster recovery is possible if a script error corrupts the serverless database.

## 📊 Phase 3: The User Experience (Resilience & Analytics)
*Improving what the user actually sees and feels.*

- [ ] **Fetch Failure States:** Build a UI fallback so if an item vanishes from Amazon or errors out during the API fetch, the user's dashboard shows a "⚠️ Fetch Failed" state instead of silent stagnation.
- [ ] **Chart Analytics UI:** Update the edge-rendered Web App to calculate and display the All-Time High, All-Time Low, and Average Price above the Chart.js graph.
- [ ] **Upward Trend Alerts:** Add a feature toggle allowing users to be warned if a tracked item's price goes *up* (creating urgency to buy before it climbs higher).
- [ ] **URL Shortening (amzn.to Integration):** Implement programmatic link shortening by integrating the Bitly API into the Cloudflare Worker. Passing tagged Amazon URLs through Bitly automatically generates the official `amzn.to` branded short links. This will declutter Telegram push notifications and maintain a minimalist chat interface.
- [ ] **The "Kill Switch" (Opt-Out Command):** Implement a `/stop` command and a "Delete My Account" button in the `worker.js` user settings. This will automatically execute a safe purge of their `user:{chat_id}:products` and `ui:{chat_id}` keys, allowing users to permanently erase their data from the serverless database.

## 🌍 Phase 4: Platform Expansion (Growth)
*Scaling the surface area of the platform.*

- [ ] **Multi-Marketplace Support:** Parameterize the Amazon Creators API initialization to support `Amazon.sa` and `Amazon.ae`, opening the tracker to the broader Middle East market.
- [ ] **Group Chat / Inline Mode:** Modify the Telegram payload parsers so the bot can be dropped into group chats, allowing multiple people to query live prices natively in a shared chat.
