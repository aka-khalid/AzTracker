<div align="center">

<img src="docs/assets/logo.png" alt="AzTracker Logo" width="200">

### The Serverless Amazon.eg Price Engine

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![ES6 JavaScript](https://img.shields.io/badge/ES6-JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Cloudflare D1](https://img.shields.io/badge/Cloudflare-D1-0051C3?style=for-the-badge&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)
[![Cloudflare KV](https://img.shields.io/badge/Cloudflare-KV-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/kv/)
[![Telegram API](https://img.shields.io/badge/Telegram-ChatOps-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white)](https://core.telegram.org/bots)

> A highly scalable, multi-tenant price tracking architecture built purely on Cloudflare Workers, D1 SQL, and Queues. It features a fully localized (English/Egyptian Arabic) interactive Admin CRM Web App, dual-hysteresis anti-flap protection, and dynamic queue-based scheduling.

🔗 **Try the Bot:** [@AzTrackerr_bot](https://t.me/AzTrackerr_bot)

📢 **Live Demo (Public Deals Channel):** [@AzTrackerr](https://t.me/AzTrackerr)


</div>

## 🖼️ Web App CRM Gallery

AzTracker features a securely embedded Telegram WebApp CRM that natively supports both LTR (English) and RTL (Masry/Arabic) modes out-of-the-box.

<a href="docs/GALLERY.md">
  <img src="docs/assets/01_dashboard.png" width="800" alt="Dashboard Hero">
</a>

👉 **[View Full Screenshot Gallery](docs/GALLERY.md)**  
*(Contains side-by-side LTR/RTL comparisons of all 13 interactive views, drawers, and charts!)*

---

## 🚀 Key Engineering Achievements

### 🗄️ Hybrid Database Architecture (D1 + KV)
AzTracker strictly separates relational state from time-series telemetry. **Cloudflare D1 (SQLite)** handles all user tracking, subscriptions, concurrency locks, audit logs, and the Hysteresis Engine. **Cloudflare KV** serves as a NoSQL document store for massive time-series arrays and cached Amazon access tokens, avoiding database read-exhaustion.

### 🛡️ Edge-Rendered CRM & SIEM Auditing
The Admin Panel opens an edge-rendered, Tailwind-styled Command Center Web App served directly from the Worker. It features full **RTL/LTR dual-localization (English and Egyptian Arabic)**. Authentication uses Telegram Web App `initData` verified via HMAC-SHA256. The `/audit` route serves a forensic SIEM ledger page for all admin actions.

### ⚛️ Decoupled Async Message Delivery
Telegram alerts are decoupled from the main scraper engine using Cloudflare Queues (`telegram-outbox`). The queue worker implements a Two-Phase Commit (2PC) that prevents duplicate alerts by updating D1 flags only upon a successful HTTP 200 Telegram delivery. Failed deliveries trigger automatic retry with exponential backoff.

### 📉 Distributed Scraping with Dynamic Governor Logic
The scraper engine processes products in batches of 10 via Cloudflare Queues (`scraper-queue`). A dynamic Governor in the cron trigger calculates optimal batch sizes and distribution intervals based on the total active subscription pool.

### 📱 User Web App Dashboard & Fallback Scraping
The standard user product management has been fully upgraded to an interactive Telegram Web App. It shares the same secure HMAC-SHA256 edge-rendering architecture as the admin CRM. Additionally, an intelligent HTTP fallback scraper explicitly targets both English (`en_AE`) and Arabic (`ar_AE`) amazon.eg locales if the Creators API fails, guaranteeing perfect cross-lingual localization without relying on user IP logic.

---

## 🛠️ Architecture Pipeline

```mermaid
graph TD;
    User([📱 User Drops Amazon Link]) --> Webhook[⚡ Telegram Webhook Route];
    Webhook --> D1[(☁️ CF D1: Users, Subs, Audit)];
    Webhook --> KV[(☁️ CF KV: Price History, Tokens)];
    Cron[⏱️ CF Cron Trigger] --> Governor[⚡ Dynamic Governor];
    Governor -- "Dispatches offset:0" --> SQ[📦 CF Queue: scraper-queue];
    SQ --> Engine[⚙️ Scraper Engine Worker];
    Engine -- "Batched Creators API Call" --> CreatorsAPI[🛒 Amazon Creators API];
    CreatorsAPI -- "Live Prices + Arabic Names" --> Engine;
    Engine -- "Anti-Flap + Price Deltas" --> KV;
    Engine -- "Pushes Alerts to telegram-outbox" --> TQ[📦 CF Queue: telegram-outbox];
    Engine -- "Commits State to D1 (On Success)" --> D1;
    TQ --> QW[⚙️ Queue Worker];
    QW -- "2PC: Update D1 on 200 OK" --> D1;
    QW -- "sendMessage" --> TG[📲 Telegram API];
```

---

## ⚙️ V2 Modular Architecture (ES6)

The application is structured completely around an ES6 module design pattern under `src/`, eliminating massive monolithic files and promoting logical separation of concerns.

### Directory Structure

```text
src/
├── index.js                 # Worker Entry Point (fetch, queue, scheduled)
├── core/
│   ├── amazon.js            # Amazon Creators API Client, Parser, and Fallback Web Scraper
│   ├── db.js                # D1 Database Operations, Audit Logging, and Cache API
│   ├── i18n.js              # Localization Engine (English & Egyptian Arabic)
│   ├── telegram.js          # Telegram API SDK Wrapper
│   └── utils.js             # Shared Utilities (Formatting, Time, Delay)
├── routes/
│   ├── crm_dashboard.js     # Admin CRM Web App & API Endpoints
│   └── telegram_webhook.js  # Telegram Bot Command & Callback Router
└── workers/
    ├── cron_trigger.js      # Dynamic Governor & D1 Garbage Collection
    ├── queue_worker.js      # Consumer for Telegram Outbox & Scraper Engine
    └── scraper_engine.js    # Core Price Evaluation & Anti-Flap Hysteresis
```

### 🚏 Core Routes (`src/routes/`)
All HTTP requests are routed by the `fetch` handler in `src/index.js` to their appropriate domain:
- `POST /webhook` and `POST /webhook/*`: Sent to `telegram_webhook.js` for ChatOps interaction.
- All other routes (e.g., `GET /crm`, `GET /api/crm/*`, `POST /api/crm/*`): Fall through to `fetchAPI` in `crm_dashboard.js`, which serves both the Edge-Rendered Admin UI and JSON endpoints (handling its own 404s).

### 🔧 Core Modules (`src/core/`)
State-agnostic libraries used universally:
- `amazon.js`: Native JS execution for Amazon's Creators API token management, schema parsing, and a fallback HTTP scraper (`scrapeArabicTitle`) for extracting native Arabic titles from `amazon.eg` pages.
- `db.js`: Contains shared D1 operations like role verification and audit logging, backed by Cloudflare's in-memory Cache API (`caches.default`) to prevent D1 read exhaustion.
- `telegram.js`: Native REST wrapper over Telegram's Bot API.
- `i18n.js`: Comprehensive string resolution dictionaries supporting English (en) and Egyptian Arabic (masry), complete with emoji layout adjustments.
- `utils.js`: Helpers for EGP currency formatting, HTML escaping, and time manipulation.

### 🔄 Background Jobs (`src/workers/`)
Decoupled logic for queue consumers and crons:
- `scraper_engine.js`: The complex business logic that queries the Amazon API, applies hysteresis timers, checks bounds against User Subscriptions, updates KV price histories, and enqueues alerts.
- `queue_worker.js`: Cloudflare Queue consumer for both `scraper-queue` (for triggering the scraper engine) and `telegram-outbox` (for delivering alerts reliably via 2PC).
- `cron_trigger.js`: Generates the dynamic interval calculations and issues the first batch of scrapes.

---

## 📚 Documentation

Detailed documentation for various aspects of the system can be found in the `docs/` directory:

- **[ROADMAP.md](docs/ROADMAP.md)**: Architectural milestones, feature history, and tech debt tracking.
- **[DEPLOYMENT.md](docs/DEPLOYMENT.md)**: Dual-environment infrastructure, deployment workflow, and webhook registration.
- **[TESTING.md](docs/TESTING.md)**: Diagnostic vectors, queue testing protocols, and async execution tests.
- **[GALLERY.md](docs/GALLERY.md)**: Visual tour of the fully localized LTR/RTL CRM Dashboard.

---
## 🔑 Environment Variables & Secrets

### Plaintext Variables (set in `wrangler.toml` `[vars]`)

| Variable | Description |
|----------|-------------|
| `DEFAULT_USER_PRODUCT_LIMIT` | Global limit on concurrent tracks per user (default: `"3"`). |
| `DAILY_QUEUE_LIMIT` | Global limit for queued executions (default: `"10000"`). |
| `AMZN_EG_MERCHANT_ID` | Amazon.eg Retail merchant ID (default: `'A1ZVRGNO5AYLOV'`). |
| `AMZN_RESALE_MERCHANT_ID` | Amazon Resale merchant ID (default: `'A2N2MP47XAP1MK'`). |
| `GITHUB_OWNER` | GitHub owner for the project. |
| `GITHUB_REPO` | GitHub repository name. |

### Secrets (must be injected via `wrangler secret put`)

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token. |
| `TELEGRAM_WEBHOOK_SECRET` | Secret token to validate incoming Telegram webhook requests and CRM auth. |
| `TELEGRAM_ROOT_ADMIN_IDS` | Comma-separated list of root-level Telegram user IDs. |
| `AMAZON_CLIENT_ID` | Amazon Creators API Credential ID. |
| `AMAZON_CLIENT_SECRET` | Amazon Creators API Secret. |
| `AMAZON_PARTNER_TAG` | Amazon Associates Tracking ID for product URLs. |
| `AMZN_ASSOCIATES_TAG` | Amazon Associates Tracking ID for the Creators API payload. |
| `TELEGRAM_PUBLIC_CHANNEL_ID` | Target channel ID for automated deal broadcasting. |

### Cloudflare Bindings (configured in `wrangler.toml`)

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 Database | Relational models. |
| `AZTRACKER_DB` | KV Namespace | Time-series metrics and tokens. |
| `MESSAGE_QUEUE` | Queue Producer | Pushes alerts to `telegram-outbox` (internally logged as `message-queue`). |
| `SCRAPER_QUEUE` | Queue Producer | Pushes offsets to `scraper-queue`. |

---

## 👨‍💻 Architect & Acknowledgements

Engineered and maintained by **Khalid Ibrahim**, built upon core cloud infrastructure and system architecture principles.

Special thanks to **[Abdelrahman Elkhayat](https://www.facebook.com/bodaa.elkhayat)** for generously providing the Amazon Creators API credentials that power the core tracking engine.
