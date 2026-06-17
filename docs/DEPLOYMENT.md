# AzTracker Deployment Guide

> **Architecture:** Phase 6.16 Modular ES6 + Native Dialogs & Toasts
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

# 3. Apply Schema Migrations
npx wrangler d1 migrations apply DB --local
npx wrangler d1 migrations apply DB --env production --remote
```

### 3.2 Secret Management
Secrets must be injected per environment into Cloudflare. They are never stored in plaintext.
```bash
# Development
npx wrangler secret put TELEGRAM_BOT_TOKEN
# Production
npx wrangler secret put TELEGRAM_BOT_TOKEN --env production
```

**Required Cloudflare Secrets:**
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ROOT_ADMIN_IDS`
- `AMAZON_CLIENT_ID`, `AMAZON_CLIENT_SECRET`, `AMAZON_PARTNER_TAG`, `AMZN_ASSOCIATES_TAG`

### 3.3 GitHub Actions CI/CD Secrets
To enable automated deployments and dual-environment database syncs via GitHub Actions, configure the following **Repository Secrets** in GitHub:
- `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare Account ID.
- `CLOUDFLARE_API_TOKEN`: A Custom API Token with the following permissions:
  1. `Account` | `Worker Scripts` | `Edit` (Required for deploying)
  2. `Account` | `D1` | `Edit` (Required for syncing D1 databases)
  3. `Account` | `Workers KV Storage` | `Edit` (Required for syncing KV namespaces)

### 3.4 Deploying Code
```bash
# Deploy to Development
npx wrangler deploy

# Deploy to Production
npx wrangler deploy --env production
```

Alternatively, push to the `main` or `dev` branches to automatically trigger the GitHub Actions deployment workflow (`deploy_worker.yml`).

### 3.5 Synchronizing Environments
Use the GitHub Action **"Sync Prod to Dev"** (`sync-prod-to-dev.yml`) to automatically export production data, transform it, and import it safely into the Dev D1 Database and KV namespace without dropping tables or breaking constraints.

### 3.6 Webhook Registration
To start receiving messages from Telegram, you must register the webhook URL:
```bash
curl -F "url=https://aztracker-prod-worker.<your-cloudflare-subdomain>.workers.dev/webhook/<TELEGRAM_WEBHOOK_SECRET>" \
     https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook
```
*(Replace placeholders with your actual production domain and secret.)*

### 3.7 Persistent Menu Initialization
The bot utilizes the native Telegram API to construct a bilingual persistent menu (`/lang`, `/help`) instead of legacy inline keyboards. Because of the Dual-Environment workflow, this must be executed locally twice (once for the Dev Bot Token, once for the Prod Bot Token):
```bash
# Set Dev Bot Menu
TELEGRAM_BOT_TOKEN="YOUR_DEV_BOT_TOKEN" node scripts/setup_bot_commands.js

# Set Prod Bot Menu
TELEGRAM_BOT_TOKEN="YOUR_PROD_BOT_TOKEN" node scripts/setup_bot_commands.js
```


