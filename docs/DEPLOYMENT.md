# AzTracker Deployment Guide

> **Architecture:** Phase 6.11 Modular ES6 + Localization
> **Workflow:** Dual-Environment (Development & Production)

AzTracker runs on Cloudflare Workers using a hybrid D1 (relational) + KV (time-series) database architecture. Background work is fully decoupled, driven by Cloudflare Queues (`scraper-queue`, `telegram-outbox`), and dynamically governed by a CRON trigger. It is fully localized and ready for V2 production deployment.

---

## 1. Dual-Environment Workflow

The project utilizes a strict Dual-Environment Workflow to ensure safe development and resilient production systems.

### 1.1 Worker Configurations
We maintain two separate Worker environments defined in `wrangler.toml`:
- **Development** (Default): `aztracker-dev-worker`
- **Production**: `aztracker-prod-worker`

When deploying or testing locally, `aztracker-dev-worker` is used. Production releases require the `--env production` flag.

### 1.2 Infrastructure Separation
| Resource | Development (`aztracker-dev-worker`) | Production (`aztracker-prod-worker`) |
|----------|-----------------------------|---------------------------------|
| **D1 Database** | `aztracker-dev-db` | `aztracker-prod-db` |
| **KV Namespace** | Shared (`AZTRACKER_DB`) | Shared (`AZTRACKER_DB`) |
| **Queues** | `scraper-queue`, `telegram-outbox` | `scraper-queue`, `telegram-outbox` |
| **Cron Trigger** | `* * * * *` (if active) | `* * * * *` (if active) |

_Note: KV is shared across both environments to leverage shared historical price metrics, whereas D1 separates active user and subscription states._

---

## 2. V2 Modular Structure (ES6)

AzTracker is structured using ES6 modules. The deployment process bundles the `src/` directory.

```text
src/
├── index.js                 # Worker Entry Point
├── core/
│   ├── amazon.js            # Amazon Creators API Client
│   ├── db.js                # D1 Database Operations
│   ├── i18n.js              # Localization (en, masry)
│   ├── telegram.js          # Telegram API SDK
│   └── utils.js             # Shared Utilities
├── routes/
│   ├── crm_dashboard.js     # Web App CRM Route
│   └── telegram_webhook.js  # ChatOps Handler
└── workers/
    ├── cron_trigger.js      # CRON Dynamic Governor
    ├── queue_worker.js      # Consumer for all Queues
    └── scraper_engine.js    # Business logic & APIs
```

---

## 3. Provisioning & Deployment Protocol

### 3.1 Initial Provisioning (First-Time Setup)

```bash
# 1. Install dependencies
npm install

# 2. Provision D1 Databases
npx wrangler d1 create aztracker-dev-db
npx wrangler d1 create aztracker-prod-db
# Add returned IDs to wrangler.toml

# 3. Apply Schema
npx wrangler d1 execute aztracker-dev-db --local --file=schema.sql
npx wrangler d1 execute aztracker-prod-db --env production --remote --file=schema.sql
```

### 3.2 Secret Management
Secrets must be injected per environment. They are never stored in plaintext.
```bash
# Development
npx wrangler secret put TELEGRAM_BOT_TOKEN
# Production
npx wrangler secret put TELEGRAM_BOT_TOKEN --env production
```

**Required Secrets:**
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ROOT_ADMIN_IDS`
- `AMAZON_CLIENT_ID`, `AMAZON_CLIENT_SECRET`, `AMAZON_PARTNER_TAG`, `AMZN_ASSOCIATES_TAG`

### 3.3 Deploying Code
```bash
# Deploy to Development
npx wrangler deploy

# Deploy to Production
npx wrangler deploy --env production
```

### 3.4 Webhook Registration
To start receiving messages from Telegram, you must register the webhook URL:
```bash
curl -F "url=https://aztracker-prod-worker.<your-cloudflare-subdomain>.workers.dev/webhook/<TELEGRAM_WEBHOOK_SECRET>" \
     https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook
```
*(Replace placeholders with your actual production domain and secret.)*


