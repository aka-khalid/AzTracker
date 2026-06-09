# 🧪 AzTracker Test Suite & Diagnostic Vectors

This document serves as the living test specification for the current asynchronous architectural phases. 

**Testing Philosophy:** To preserve AzTracker's low-list, minimalist architectural design, we strictly avoid heavy automated End-to-End (E2E) frameworks (like Selenium or Playwright) that would artificially drain Cloudflare KV Read/List allocations. Instead, we utilize **Edge-Diagnostic Test Vectors**—lightweight, authenticated mock payloads temporarily injected into our Cloudflare Queues—and localized diagnostic logs.

---

## 🛑 Phase 5: Scraper Engine & Queue Pagination

These tests validate the Edge-Node's ability to gracefully handle Amazon API fetching and paginate through the database asynchronously without timing out the worker.

| Test ID | Feature Target | Diagnostic Vector / Execution Method | Expected Success Criterion |
| :--- | :--- | :--- | :--- |
| **TC-501** | Queue Pagination (Recurse) | Push a mock payload to `scraper-queue` with `offset: 0` and ensure > 10 items in DB. | `executeScrapeEngine` processes 10 items, returns `true`, and `queue_worker.js` automatically sends a new message to `scraper-queue` with `offset: 10` and a 1-second delay. |
| **TC-502** | Scraper API Outage (Failsafe) | Mock the Amazon Creators API to return 0 items for a batch of >= 5 active ASINs. | `executeScrapeEngine` throws an error ("0 items returned"), causing `queue_worker.js` to call `msg.retry()`, aborting the chain and retrying automatically. |
| **TC-503** | Auth Token Expiration | Mock a missing or expired `amazon_access_token` in KV. | The engine successfully acquires a new token via `getAmazonAccessToken()` and stores it in KV with a 3300s (55-minute) TTL. |
| **TC-504** | Out-of-Stock Failsafe | Mock an ASIN missing from Amazon for > 24 hours (all conditions). | The engine updates D1 setting `delisted = 1`, pauses user subscriptions, and pushes a Telegram alert to the `MESSAGE_QUEUE`. |

---

## ⚙️ Phase 6: Operational Tooling & Setup

These tests validate the environment configuration automation, ensuring frictionless onboarding for new deployments.

| Test ID | Feature Target | Diagnostic Vector / Execution Method | Expected Success Criterion |
| :--- | :--- | :--- | :--- |
| **TC-601** | Secret Generation & GitIgnore | Run `python setup.py --dry-run`. Provide dummy inputs. | Generates secure strings for required secrets. Verifies `.env` and `wrangler.toml` are dynamically appended to `.gitignore`. |
| **TC-602** | Cloudflare Queue Provisioning | Inspect `wrangler.toml` post-setup. | Ensures that `scraper-queue` and `MESSAGE_QUEUE` are correctly defined as producers and consumers in the configuration. |
| **TC-603** | Cloudflare KV Provisioning | Feed a mock Cloudflare REST API response containing `{"result": {"id": "mock_id_123"}}`. | The script correctly parses the ID and performs an in-place regex replacement of `id = "..."` inside `wrangler.toml`. |
| **TC-604** | Worker Secret Injection | Mock the Cloudflare REST API responses for the secrets endpoint. | Verifies the script correctly issues `PUT` requests to the Cloudflare Workers REST API for all required production secrets. |
| **TC-605** | Telegram Webhook & Gate | Trigger the final health probe sequence in `setup.py`. | Telegram responds with "Webhook was set". |

---

## 🌍 Phase 7: Asynchronous Telegram Outbox & Rate Limits

These tests validate the `MESSAGE_QUEUE` outbox and dynamic API rate-limit backoff logic handling within `queue_worker.js`.

| Test ID | Feature Target | Diagnostic Vector / Execution Method | Expected Success Criterion |
| :--- | :--- | :--- | :--- |
| **TC-701** | Asynchronous Payload Queueing | Trigger a mock price drop in `executeScrapeEngine`. | The engine does NOT block for Telegram. It pushes the payload to `MESSAGE_QUEUE` with `type: 'telegram_alert_new'` or `telegram_alert_used`. |
| **TC-702** | Telegram Rate-Limit (429) | Mock the Telegram API to return a `429 Too Many Requests` with `retry_after: 5`. | `queue_worker.js` catches the 429, sets `rateLimited = true`, and calls `msg.retry({ delaySeconds: 5 })` to defer the message. Subsequent messages in the batch are also deferred. |
| **TC-703** | Telegram Blocked Bot (403) | Mock the Telegram API to return a `403 Forbidden` for a specific `chatId`. | `queue_worker.js` catches the 403, executes a D1 update to set `is_paused = 1` for the user, and correctly `ack()`s the message. |
| **TC-704** | Atomic 2PC State Update | Mock a successful 200 OK from Telegram for a `telegram_alert_new` message. | The queue worker issues a D1 update setting `alert_sent_new = 1` ONLY after successful delivery, confirming the 2-Phase Commit mechanism. |
| **TC-705** | Omnichannel Broadcast | Mock an Exceptional Deal (Z-Score <= -1.5) in the batch results. | The engine appends exactly one broadcast payload to the `MESSAGE_QUEUE` targeting `TELEGRAM_PUBLIC_CHANNEL_ID` and stamps `last_broadcast_time_ms` in the database. |

---

## 🛠️ Testing Execution Protocol

**For Queue Diagnostics & Edge-Testing:**
1. Ensure you are on the correct feature branch.
2. To trigger a manual scrape cycle, inject a payload into the scraper queue:
   ```bash
   npx wrangler queues send scraper-queue '{"offset": 0}'
   ```
3. Use `wrangler tail` to monitor the logs. Verify that `queue_worker.js` processes the offset, recursively queues the next offset if `hasMore` is true, and safely catches API errors.
4. For outbox monitoring, observe `wrangler tail` to ensure rate limits (429) are triggering `msg.retry()` rather than crashing the consumer.
5. Check your D1 database to ensure 2PC state locks (`alert_sent_new`, `alert_sent_used`) are only committed after successful Telegram delivery.
