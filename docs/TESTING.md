# 🧪 AzTracker Test Suite & Diagnostic Vectors

This document serves as the living test specification for the upcoming architectural phases (Phases 5, 6, and 7). 

**Testing Philosophy:** To preserve AzTracker's low-list, minimalist architectural design, we strictly avoid heavy automated End-to-End (E2E) frameworks (like Selenium or Playwright) that would artificially drain Cloudflare KV Read/List allocations. Instead, we utilize **Edge-Diagnostic Test Vectors**—lightweight, authenticated mock endpoints temporarily injected into `worker.js`—and localized diagnostic flags for Python scripts.

---

## 🛑 Phase 5: Scheduler Resilience & Circuit Breaker

These tests validate the Edge-Node's ability to gracefully handle GitHub API outages without spamming the API, draining Cloudflare quotas, or overwhelming Admins.

| Test ID | Feature Target | Diagnostic Vector / Execution Method | Expected Success Criterion |
| :--- | :--- | :--- | :--- |
| **TC-501** | Actions Health Detection | Inject a bad `GH_WORKFLOW_TOKEN` (or mock a 502 response) during `triggerWorkflow()`. | The `fetch` catch block safely wraps the error into a structured `{ ok: false, status: 502 }` object without crashing the worker execution. |
| **TC-502** | Circuit Breaker: OPEN | Send consecutive failed pings to the diagnostic trigger route `/test/trigger/fail`. | `caches.default` writes the `/_internal/circuit/open` flag. Subsequent cron pings are instantly rejected with an HTTP 503 (Circuit Open), consuming **0 KV Reads**. |
| **TC-503** | Auto-Alert System | Trigger **TC-502**. | Exactly one Telegram push notification ("🚨 GitHub Actions Outage") is fired to the Root Admin. The `alerted` cache flag suppresses further spam. |
| **TC-504** | Circuit Breaker: HALF-OPEN | Mock a 15-minute time-jump by overriding the cache TTL, then send a cron ping. | The engine permits exactly **one** exploratory dispatch to GitHub Actions while keeping the circuit technically restricted. |
| **TC-505** | Circuit Breaker: CLOSED (Recovery) | Following a HALF-OPEN probe, return a mock HTTP 204 Success. | The circuit resets to `CLOSED`. A "✅ System Recovered" Telegram alert is fired. Normal scheduling resumes. |
| **TC-506** | Scheduler Status API | Send a `GET` request to `/scheduler/status` with the `x-scheduler-key` header. | Returns valid JSON detailing the current state (`CLOSED`/`OPEN`), alerted flag status, and the upcoming jitter slots for the hour. |

---

## ⚙️ Phase 6: Operational Tooling (GitOps & Provisioning)

These tests validate the `setup.py` automation suite, ensuring frictionless onboarding for new deployments without leaking cryptographic secrets.

| Test ID | Feature Target | Diagnostic Vector / Execution Method | Expected Success Criterion |
| :--- | :--- | :--- | :--- |
| **TC-601** | Secret Generation & GitIgnore | Run `python setup.py --dry-run`. Provide dummy inputs. | Generates secure 32-byte strings for `CRON_AUTH_KEY` and Webhook secret. Verifies `.env` and `wrangler.toml` are dynamically appended to `.gitignore`. |
| **TC-602** | GitHub Secret Encryption | Execute the PyNaCl encryption mock function with a dummy public key. | Outputs a valid base64 encoded sealed box that matches the NaCl structural requirements for GitHub Actions APIs. |
| **TC-603** | Cloudflare KV Provisioning | Feed a mock Cloudflare REST API response containing `{"result": {"id": "mock_id_123"}}`. | The script correctly parses the ID and performs an in-place regex replacement of `id = "..."` inside `wrangler.toml`. |
| **TC-604** | Worker Secret Injection | Run the Wrangler CLI execution wrapper module. | Verifies the script correctly issues `npx wrangler secret put` commands for all 6 required production variables. |
| **TC-605** | Telegram Webhook & Gate | Trigger the final health probe sequence in `setup.py`. | Telegram responds with "Webhook was set". The setup script correctly queries `/scheduler/status` to verify worker instantiation. |
| **TC-606** | Curated Broadcast Queue | Inject a mock array of 3 price drops into `QUEUE:PUBLIC_BROADCAST`. Trigger the 15-minute Cloudflare cron event natively via Wrangler. | The worker dispatches exactly one message (the highest percentage drop) using `AMZN_ASSOCIATES_TAG_PUBLIC`, and successfully flushes the `QUEUE:PUBLIC_BROADCAST` KV array to a length of 0. |

---

## 🌍 Phase 7: Platform Expansion (Multi-Region)

These tests validate the backend array sharding and the dynamic API rate-limit backoff logic within the Python PA-API engine.

| Test ID | Feature Target | Diagnostic Vector / Execution Method | Expected Success Criterion |
| :--- | :--- | :--- | :--- |
| **TC-701** | Geofence URL Parsing | Send `amazon.ae` and `amazon.sa` links to the Telegram bot UI. | The edge node accepts them, extracts the domains, and correctly writes `"region": "amazon.ae"` into the user's `user:{chat_id}:products` KV array. |
| **TC-702** | Python Batch Sharding | Run `price_tracker.py` locally using a mocked KV payload containing both EG and AE items. | The `fetch_batch()` queues strictly separate ASINs by region. The EG batch fires with the EG credentials/endpoints; the AE batch fires with the AE endpoints. |
| **TC-703** | Adaptive Backoff (Success) | Mock the PA-API response to return 200 OK. | The engine sleeps for exactly 1.0 seconds between batch iterations, minimizing idle time. |
| **TC-704** | Adaptive Backoff (429) | Mock the PA-API response to return HTTP 429 Too Many Requests with a header `Retry-After: 7`. | The engine catches the rate limit, parses the header, and forces an `asyncio.sleep(7)` before retrying the exact same batch. |
| **TC-705** | Double 429 Failsafe | Mock consecutive 429 responses. | The engine breaks the batch loop entirely, queues a Telegram alert to the Admins detailing the endpoint exhaustion, and safely commits partial data. |

---

## 🛠️ Testing Execution Protocol

**For Edge-Diagnostics (Phases 5 & 7 UI):**
1. Ensure you are on the correct feature branch (e.g., `feature/phase-5`).
2. Inside `worker.js`, locate the `// --- DIAGNOSTIC ROUTES ---` block (to be implemented).
3. Uncomment the block and deploy to your dev worker namespace.
4. Execute test cases via standard `curl` or Postman requests utilizing the `x-test-key` header.
5. **Critical:** Re-comment or delete the diagnostic block before merging to `main`.

**For Python Engine (Phase 7 Backend):**
1. Set the GitHub Actions `workflow_dispatch` input `run_mode` to `DIAGNOSTIC`.
2. The script will bypass Cloudflare KV fetches and instead read from a local `tests/mock_db.json` file.
3. Review the terminal execution output to verify batch sharding and backoff parameters.
