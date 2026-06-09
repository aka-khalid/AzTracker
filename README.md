<div align="center">

<img src="assets/logo.png" alt="AzTracker Logo" width="200">

### The Serverless Amazon.eg Price Engine

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![ES6 JavaScript](https://img.shields.io/badge/ES6-JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Cloudflare D1](https://img.shields.io/badge/Cloudflare-D1-0051C3?style=for-the-badge&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)
[![Cloudflare KV](https://img.shields.io/badge/Cloudflare-KV-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/kv/)
[![Telegram API](https://img.shields.io/badge/Telegram-ChatOps-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white)](https://core.telegram.org/bots)

> A highly scalable, multi-tenant price tracking architecture built purely on Cloudflare Workers, D1 SQL, and Queues. It features an interactive ChatOps UI, dual-hysteresis anti-flap protection, and dynamic queue-based scheduling.

🔗 **Try the Bot:** [@AzTrackerr_bot](https://t.me/AzTrackerr_bot)

📢 **Live Demo (Public Deals Channel):** [@AzTrackerr](https://t.me/AzTrackerr)

<img src="assets/StatsGraphDemo.jpg" alt="AzTracker Analytics Graph" width="400">
</div>

---

## 🚀 Key Engineering Achievements

### 🗄️ Hybrid Database Architecture (D1 + KV)
To bypass edge limitations, AzTracker strictly separates state from time-series telemetry. **Cloudflare D1 (SQLite)** handles all relational user tracking, concurrency locks, and the Hysteresis Engine. The legacy **Cloudflare KV** namespace is retained strictly as a NoSQL document store to handle massive time-series arrays for UI rendering (`history:{asin}`) and the Omnichannel Global Matrix, dropping database read-exhaustion to near zero.

### 🛡️ Edge-Rendered CRM & SIEM Auditing
The `/manage` command bypasses native Telegram constraints by serving an edge-rendered, Tailwind-styled Command Center Web App. The `/api/crm/audit` route acts as a forensic SIEM ledger, secured via HMAC-SHA256 signature token verification against the `TELEGRAM_WEBHOOK_SECRET` to prevent unauthorized dashboard access.

### ⚛️ Decoupled Async Message Delivery
To prevent race conditions and ensure optimal reliability, Telegram alerts are decoupled from the main scraper engine using Cloudflare Queues (`telegram-outbox`). The Telegram delivery worker uses an atomic lock that updates the database only on a successful 200 OK delivery, creating a flawless Two-Phase Commit (2PC).

### 📦 Smart Alternatives & Hidden Warehouse Deals
AzTracker parses complex condition sub-schemas from the Amazon Creators API to unearth hidden "Amazon Resale" (Used/Warehouse) deals. The engine routes these discoveries to a dynamic, context-aware Telegram UI, rendering specialized checkout buttons based on the exact condition.

### 📉 Distributed Scraping with Dynamic Governor Logic
To prevent API rate-limiting, the scraper engine utilizes Cloudflare Queues (`scraper-queue`) with recursive triggering. A dynamic Governor script calculates the optimal batch sizes and distribution based on the total active user pool, ensuring requests are perfectly distributed across the hour.

---

## 🛠️ Architecture Pipeline

```mermaid
graph TD;
    User([📱 User Drops Amazon Link]) --> Webhook[⚡ Telegram Webhook Route];
    Webhook --> D1[(☁️ CF D1: Users & Subs)];
    Cron[⏱️ CF Cron Trigger: * * * * *] --> Governor[⚡ Dynamic Governor];
    Governor -- Dispatches Batches --> SQ[📦 CF Queue: scraper-queue];
    SQ --> Engine[⚙️ Scraper Engine Worker];
    Engine -- Batched Creators API Call --> CreatorsAPI[🛒 Amazon Creators API];
    CreatorsAPI -- Live Prices --> Engine;
    Engine -- Anti-Flap Logic & KV Deltas --> KV_Hist[(☁️ CF KV: Price History)];
    Engine -- Updates Global State --> D1;
    Engine -- Pushes Alerts --> TQ[📦 CF Queue: telegram-outbox];
    TQ --> TG[📲 Telegram Notification];
```

---

## ✨ System Features

* 👥 **Automated Join Queue:** Built-in ChatOps approval pipeline to manage guests safely, protected against "Thundering Herd" race conditions with a strict depth limit.
* 🌍 **Dynamic Geofencing:** Automatically parses incoming links and hard-rejects non-supported regions (locking the database securely to `amazon.eg`).
* 🎯 **Strict Boolean Target Locks:** Users set specific budgets. The engine features zero-spam target locks—alerting exactly once upon matching the target price.
* 📦 **Deduplicated Batch Processing:** 10 users tracking the same item triggers only 1 API request.

---

## ⚙️ Routing Logic & Architecture

The application is structured entirely using ES6 Modules within the `src/` directory, exporting fetch and queue handlers through `src/index.js`.

### 🚏 Core Routes (`src/routes/` & `src/api/`)
- `POST /webhook/*`: Serves the primary Telegram Bot interface and ChatOps logic (`telegram_webhook.js`).
- `GET /crm`: Serves the secure administrative web app and charting UI (`crm_dashboard.js`).
- `GET /api/crm/data` & `GET /api/crm/history/*`: Hydrates the frontend dashboard with live D1/KV data.
- `POST /api/crm/action`: Administrative mutations (approving users, deleting data).
- `GET /audit` & `GET /api/audit`: Cryptographically signed routes for SIEM access.

### 🔄 Background Jobs (`src/workers/`)
- **`cron_trigger.js`**: Triggered by Cloudflare's `* * * * *` cron. Manages D1 garbage collection and dynamically calculates scraping velocity using the active subscription pool. Dispatches initial jobs to the scraper queue.
- **`scraper_engine.js`**: Core Creators API consumer. Processes database chunks, evaluates complex condition logic, pushes history to KV, updates D1, and determines alert priority.
- **`queue_worker.js`**: Consumer for both `scraper-queue` and `telegram-outbox`. Ensures stable delivery and exponential backoff retry for Telegram rate limits.

---

## 🔑 Environment Variables & Secrets

The engine requires the following critical variables injected via `wrangler.toml` or Cloudflare Secrets:

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Your Telegram Bot API token. |
| `TELEGRAM_WEBHOOK_SECRET` | Security token to validate incoming Telegram webhook requests. |
| `TELEGRAM_ROOT_ADMIN_IDS` | Comma-separated list of root-level Telegram user IDs. |
| `AMAZON_CLIENT_ID` | Amazon Creators API Credential ID. |
| `AMAZON_CLIENT_SECRET` | Amazon Creators API Secret. |
| `AMAZON_PARTNER_TAG` | Your Amazon Associates Tracking ID for Product URLs. |
| `AMZN_ASSOCIATES_TAG` | Your Amazon Associates Tracking ID for the Creators API Payload. |
| `DEFAULT_USER_PRODUCT_LIMIT` | Global limit on concurrent tracks per user. |
| `TELEGRAM_PUBLIC_CHANNEL_ID` | (Optional) Target ID for automated Deal Broadcasting. |

---

## 👨💻 Architect & Acknowledgements

Engineered and maintained by **Khalid Ibrahim**, built upon core cloud infrastructure and system architecture principles.

Special thanks to **[Abdelrahman Elkhayat](https://www.facebook.com/bodaa.elkhayat)** for generously providing the Amazon Creators API credentials that power the core tracking engine.
