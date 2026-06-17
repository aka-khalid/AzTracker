# AzTracker Test Suite & Diagnostic Vectors

> **Architecture:** Phase 6.16 Modular ES6 + Native Dialogs & Toasts
> **Focus:** Asynchronous Queue Architecture, Rate Limiting & UI Components

This document serves as the living test specification for the current asynchronous architectural phases. 

**Testing Philosophy:** To preserve AzTracker's low-latency, minimalist architectural design, we strictly avoid heavy automated End-to-End (E2E) frameworks that would artificially drain Cloudflare KV and D1 Read/List allocations. Instead, we utilize **Edge-Diagnostic Test Vectors**—lightweight, authenticated mock payloads temporarily injected into our Cloudflare Queues.

---

## 1. Async Queue Architecture (Core Engine)

AzTracker relies entirely on a decoupled async queue architecture to orchestrate Amazon scraping and Telegram deliveries.

### 1.1 Scraper Queue Pagination
Validates the Edge-Node's ability to iterate through the D1 database asynchronously without hitting worker timeout limits.

| Test ID | Feature Target | Diagnostic Vector / Execution Method | Expected Success Criterion |
| :--- | :--- | :--- | :--- |
| **TC-101** | Recursive Pagination | Push mock payload to `scraper-queue` with `offset: 0` | `scraper_engine.js` processes exactly 10 items. Returns `hasMore=true`. `queue_worker.js` automatically enqueues a new message with `offset: 10` and `delaySeconds: 1`. |
| **TC-102** | Scraper API Outage | Mock the Creators API to return 0 items for a batch | Failsafe aborts the chain (throws Error). `queue_worker.js` catches it and runs `msg.retry({ delaySeconds: 30 })`. |
| **TC-103** | Pagination Termination | Push `scraper-queue` message for the final batch (e.g. 5 items left) | Engine processes 5 items. Returns `hasMore=false`. The chain successfully stops without enqueuing another offset. |

---

## 2. Telegram Outbox & Rate Limits

Alerts are fully asynchronous. `telegram-outbox` isolates the scraping logic from Telegram API latency and limits.

| Test ID | Feature Target | Diagnostic Vector / Execution Method | Expected Success Criterion |
| :--- | :--- | :--- | :--- |
| **TC-201** | Asynchronous Queueing | Trigger a price drop in the Scraper Engine. | Engine does NOT block. It pushes payload `{type: 'telegram_alert_new'}` to `MESSAGE_QUEUE`. |
| **TC-202** | Telegram 429 Backoff | Mock Telegram API returning `429 Too Many Requests` | `queue_worker.js` sets `rateLimited = true`, reads `retry_after`, and calls `msg.retry({ delaySeconds: retry_after })` for the batch. |
| **TC-203** | 403 Blocked Bot Pause | Mock Telegram API returning `403 Forbidden` | `queue_worker.js` auto-pauses user via `UPDATE User_Subscriptions SET is_paused = 1` and calls `msg.ack()`. |
| **TC-204** | Atomic 2PC Commitment | Mock a 200 OK delivery for `telegram_alert_new` | Queue worker executes `UPDATE User_Subscriptions SET alert_sent_new = 1` ONLY after a successful HTTP 200. This Two-Phase Commit ensures zero duplicate alerts. |

> [!NOTE]
> **DLQ & Retry Limits:** The `queue_worker.js` contains a manual fallback to write to a Dead Letter Queue (DLQ) in D1 if `msg.attempts >= 5`. However, Cloudflare Queues natively enforce `max_retries` before discarding a message. By default, `wrangler.toml` caps `max_retries = 3` (4 total attempts), meaning the DLQ logic is natively unreachable. To test the DLQ, you must temporarily set `max_retries = 5` in `wrangler.toml`.

---

## 3. Localization & CRM Integration (Phase 6.11)

Tests for the bilingual localization engine and ES6 route structures.

| Test ID | Feature Target | Diagnostic Vector / Execution Method | Expected Success Criterion |
| :--- | :--- | :--- | :--- |
| **TC-301** | Bilingual Alert Payload | Trigger a price drop for a user with `lang = 'masry'` | Alert payload pushed to `telegram-outbox` is completely rendered in Arabic, including currency symbols (ج.م) and button text. |
| **TC-302** | Dashboard Routing | Send `GET /crm?lang=masry` to worker | Worker routes request to `crm_dashboard.js` and renders full HTML with `dir="rtl"` and `lang="masry"`. |
| **TC-303** | CRM Action Endpoint | Send `POST /api/crm/action` with action `force_scrape` | Validates HMAC signature, sends `{ offset: 0 }` to `SCRAPER_QUEUE`, starts recursive async chain, and returns 202 queued. |

---

## 4. Native Confirm Dialogs & Toast Notifications (Phase 6.16)

Tests for the custom in-UI confirm dialogs and toast notifications that replace native Telegram popups.

| Test ID | Feature Target | Diagnostic Vector / Execution Method | Expected Success Criterion |
| :--- | :--- | :--- | :--- |
| **TC-401** | Confirm Dialog Rendering | Trigger `triggerSync()` from CRM via `POST /api/crm/action` with `action: 'sync'` | Custom `showConfirmDialog()` modal appears with localized confirm/cancel buttons. No `tg.showConfirm()` call is made. |
| **TC-402** | Confirm Dialog Stacking Guard | Trigger two rapid confirm-dialog actions (e.g. sync then scrape) | Second dialog is blocked; only one modal exists in the DOM at a time. |
| **TC-403** | Confirm Dialog Keyboard — Enter | Open confirm dialog and press Enter key | Dialog confirms the action (equivalent to clicking the confirm button). |
| **TC-404** | Confirm Dialog Keyboard — Escape | Open confirm dialog and press Escape key | Dialog dismisses without triggering the action. |
| **TC-405** | Confirm Dialog RTL Button Order | Open confirm dialog in Masry (`lang=masry`) mode | Cancel button appears on the left, confirm on the right (mirrored from LTR). |
| **TC-406** | Green Success Toast | Trigger a successful target price update via `POST /api/user/update-target` | Green toast (`bg-green-500/90`) appears and auto-dismisses. No `tg.showPopup()` call is made. |
| **TC-407** | User Dashboard Confirm Dialog | Trigger `deleteProduct()` from User Dashboard | Custom `showConfirmDialog()` modal appears with `dashboard.confirm_btn_confirm` and `dashboard.cancel` labels. |
| **TC-408** | Image Fallback Placeholder | Load a CRM/product drawer view with a broken image URL | Broken image is replaced with transparent 1x1 GIF placeholder; no `display:none` or broken-image icon appears. |
| **TC-409** | i18n Search Placeholder | Load CRM dashboard and inspect search input | Search input uses `crm.search_users_placeholder` key (not generic `crm.search_placeholder`). |
| **TC-410** | i18n Subscribers Drawer Title | Open Product Subscribers Drawer for any ASIN | Drawer title reads "Subscribers for {ASIN}" in English or "اللي مشتركين في {ASIN}" in Masry, using the `crm.subscribers_for` template key. |
| **TC-411** | Locale Dictionary Integrity | Inspect `src/core/i18n.js` dictionary | No `ar` (Fusha) keys exist; only `en` and `masry` locales are defined. |

---

## Testing Execution Protocol

**For Queue Diagnostics & Edge-Testing:**

1. Use wrangler to inject a payload directly into the scraper queue:
   ```bash
   npx wrangler queues send scraper-queue --message '{"offset": 0}'
   ```
2. Monitor background operations asynchronously:
   ```bash
   npx wrangler tail
   ```
3. Verify that `queue_worker.js` safely loops the offsets and correctly executes Two-Phase Commits in the database.
4. Check D1 state manually:
   ```bash
   npx wrangler d1 execute aztracker-test-db --local --command "SELECT chat_id, asin, alert_sent_new FROM User_Subscriptions;"
   ```
