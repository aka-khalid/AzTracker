# 🗺️ AzTracker Architecture Roadmap & Tech Debt

This document tracks the technical debt, security fortifications, feature expansion milestones, and intentional architectural boundaries of the AzTracker engine.

## 🛡️ Phase 1: The Ironclad Foundation (Security & Stability)
*These are the silent threats. Prioritize these to ensure the system is completely tamper-proof and crash-proof.*

- [x] **The Regex URL Parser:** Replace fragile splits in `price_tracker.py` with robust regex to ensure tracking queries never break the API batch fetch.
- [x] **Zero-Trust Webhook Validation:** Implement `X-Telegram-Bot-Api-Secret-Token` header verification to guarantee only Telegram's official servers can trigger the endpoint.
- [x] **Header-Based Scheduler Auth:** Move the scheduler secret out of the query string and into the `x-scheduler-key` HTTP header.
- [x] **State-Overwrite Race Condition (2PC):** Fixed the data loss vulnerability where the 2-minute API processing window overwrites active user mutations. Implemented a Unified Atomic Two-Phase Commit (2PC) to sync Telegram delivery locks and backend resets simultaneously.
- [x] **Double-Ping UI Spam Resolution:** Unified `target_alert` assignments across New and Used evaluation blocks to allow seamless message piggybacking, preventing users from receiving two separate alerts for the same item in the same second.
- [ ] **Pagination Loading Hang (`answerCallbackQuery`):** Fix the passive `📄 X/Y` pagination buttons in `worker.js`. We must explicitly call Telegram's `answerCallbackQuery` endpoint to resolve the client-side loading spinner.

## ⚡ Phase 2: DevOps & Database Optimization (Speed & Scaling)
*Focuses on bypassing hardware and network limits to make the engine run faster while future-proofing Cloudflare KV limits.*

- [x] **Sharding the Global Blob:** Broke the massive `global_prices` JSON object into individual KV pairs to neutralize Cloudflare's 25MB value limit.
- [x] **Asynchronous Processing:** Refactored the engine to use `asyncio` and `aiohttp`. Firing KV updates simultaneously drastically reduces runtime.
- [x] **KV Write Quota Auditing:** Transitioned the jitter lock mechanism to use Cloudflare's in-memory standard caching API instead of KV, freeing up quota.
- [x] **Lazy Refresh Metadata:** Implemented a 24-hour TTL on metadata writes (`seen_amazon_eg_at`) to drastically reduce minute-by-minute write amplification on the database.
- [ ] **KV Read Optimization in Webhook:** Wrap `getUserRoles()` fetches inside the Cloudflare `caches.default` API (60-second TTL) to slash KV Read operations during heavy UI navigation.
- [ ] **Dead-User Pruning (403 Handling):** Catch Telegram `403 Forbidden` errors in the async notification engine. Automatically toggle a `paused: true` state for users who block the bot to prevent wasted API calls.
- [ ] **KV Pagination Blindspot:** Update `price_tracker.py` to handle Cloudflare's 1,000-key limit on the `/keys` endpoint via a `cursor` loop.
- [ ] **Orphaned Data Leak (Garbage Collection):** Build a tracking mechanism to prune "zombie" `price:{asin}` shards that remain in the database after the last user stops tracking the product.

## 📊 Phase 3: The User Experience (Resilience & Analytics)
*Improving what the user actually sees and feels.*

- [x] **Anti-Flap Hysteresis Engine:** Built a 16-run holding buffer to protect the UI and database from Amazon PA-API payload truncation glitches.
- [x] **Restock & Out-of-Stock (OOS) Tracking:** Modified the Python engine to officially declare OOS only after 16 consecutive API misses, triggering highly accurate `🚨 RESTOCK ALERT` notifications when an unavailable item returns.
- [x] **Context-Aware Dynamic UI:** Upgraded Telegram notification payloads to natively render specific Merchant checkout buttons (🛒 vs 📦) based on the specific condition of the trigger.
- [ ] **Chart Analytics UI:** Update the edge-rendered Web App to calculate and display the All-Time High, All-Time Low, and Average Price above the Chart.js graph.
- [ ] **Fetch Failure States:** Build a UI fallback so if an item perma-errors during the API fetch, the dashboard shows a "⚠️ Fetch Failed" state instead of silent stagnation.
- [ ] **All-Time Low (ATL) Intelligence:** Enhance the notification engine to evaluate new price drops against the `history:{asin}` array. Inject a high-urgency "🔥 ALL-TIME LOW" banner into the Telegram alert.
- [ ] **The "Stale Target" Auto-Pause:** Introduce a 90-day tracking lifespan to auto-pause items that haven't hit their aggressive targets.
- [ ] **Silent Night Mode:** Utilize Telegram's `disable_notification=True` parameter in the engine. If the server time is between 11 PM and 7 AM Cairo time, push non-target alerts silently.

## 🛑 Intentional Architectural Boundaries
*Features explicitly rejected to preserve the core product vision.*

- **"Target Met" Stagnation Fix:** Rejected. Modifying the engine to continuously send alerts for new all-time lows *after* a target is met violates the strict "Zero-Spam Boolean Lock" philosophy. If a target is met, the system alerts once and shuts up.
- **Multi-Button Product Dashboard:** Rejected. Stacking redundant Telegram inline buttons for every hidden merchant on the `/manage` dashboard creates extreme UI fatigue. Kept as clean, embedded HTML <a> text links.

## 🌍 Phase 4: Platform Expansion (Growth)
*Scaling the surface area of the platform.*

- [ ] **Multi-Marketplace Support:** Parameterize the Amazon Creators API initialization to support `Amazon.sa` and `Amazon.ae`.
- [ ] **Group Chat / Inline Mode:** Modify the Telegram payload parsers so the bot can be dropped into group chats, allowing multiple people to query live prices natively.
