# 🚀 AzTracker: Comprehensive Deployment Guide

AzTracker relies on a fully decoupled, serverless architecture running exclusively on Cloudflare Workers and Cloudflare D1. Background processing is handled natively by Cloudflare CRON triggers and Queues, while Disaster Recovery is backed by a Google Cloud Platform (GCP) Serverless Bridge.

Follow these steps exactly in order to deploy to either the Development or Production environments.

---

## Architecture Overview

Based on `wrangler.toml`, AzTracker uses a dual-environment setup (Development and Production):
- **Development (default)**: Uses D1 Database `aztracker-test-db` and does not run CRON triggers by default.
- **Production (`env.production`)**: Uses D1 Database `aztracker-prod-db` and runs automated CRON triggers (`* * * * *` and `0 0 * * *`).

Both environments share the following queues:
- `telegram-outbox`: Handles outbound Telegram messages.
- `scraper-queue`: Handles background scraping tasks.

---

## Phase 1: Acquire Root Credentials

Before deploying, you must gather the root authority tokens from your cloud providers.

1. **Telegram:**
   * Talk to `@BotFather`, create a new bot, and copy the **HTTP API Token**.
   * Talk to `@userinfobot`, and copy your numeric **User ID** (Root Admin ID).
2. **Cloudflare:**
   * Copy your **Account ID** from the dashboard URL (`dash.cloudflare.com/<ACCOUNT_ID>/...`).
   * Create an **API Token** (*My Profile -> API Tokens -> Custom*).
     * **Required Permissions:** Select `Account` | `D1` | `Edit` and `Workers KV Storage` | `Edit`.
3. **Google Cloud Platform (GCP):**
   * Download a **Service Account JSON key** with Drive permissions for the Backup Bridge.
4. **Amazon PA-API:**
   * Copy your **Client ID**, **Client Secret**, **Partner Tag**, and **Associates Tag** from your Amazon affiliate dashboard.

---

## Phase 2: D1 Infrastructure Provisioning

AzTracker uses D1 for relational user data and locks. You need to provision databases for both environments.

1. Run the local setup:
   ```bash
   npm install
   ```
2. Provision the D1 databases (if not already created):
   ```bash
   npx wrangler d1 create aztracker-test-db
   npx wrangler d1 create aztracker-prod-db
   ```
   *Note: Update `wrangler.toml` with the respective `database_id` values under `[[d1_databases]]` and `[[env.production.d1_databases]]`.*
3. Execute the database schema for your target environment:
   *For Development:*
   ```bash
   npx wrangler d1 execute aztracker-test-db --local --file=schema.sql
   ```
   *For Production:*
   ```bash
   npx wrangler d1 execute aztracker-prod-db --env production --remote --file=schema.sql
   ```

---

## Phase 3: Deployment & Secrets Injection

The deployment process and secrets injection are heavily automated using the `finalize_cutover.js` script. This script will prompt you for the required credentials, inject them securely, configure the Telegram webhook, and optionally migrate legacy KV data to D1.

1. Deploy the worker to your chosen environment:
   *For Development:*
   ```bash
   npx wrangler deploy
   ```
   *For Production:*
   ```bash
   npx wrangler deploy --env production
   ```
2. Run the final cutover script:
   ```bash
   node finalize_cutover.js
   ```
3. Follow the interactive prompts. The script will ask you whether you are targeting Development `[1]` or Production `[2]`, and it will handle injecting all secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ROOT_ADMIN_IDS`, `AMAZON_CLIENT_ID`, etc.) into the specified environment. It will also generate a new webhook secret, register the webhook with Telegram, and run data migration scripts if applicable.

---

## Phase 4: Disaster Recovery (GCP Bridge)

Because Cloudflare Workers have strict memory constraints, we offload the heavy SQLite `.sql` export generation to a GCP Cloud Function.

1. Navigate to the `gcp_backup_bridge/` directory which contains the Node.js function (`index.js` and `package.json`).
2. Deploy the function to GCP Cloud Functions (2nd Gen).
3. Ensure the Cloud Function requires OIDC authentication.
4. Configure a Google Cloud Scheduler job (`0 0 * * *`) that invokes the Cloud Function.
5. Add the OIDC token header in Cloud Scheduler pointing to your authorized Service Account.

---

## 🎉 Phase 5: System Boot & Administration

1. Open Telegram and navigate to your bot.
2. Send `/start`.
3. Because your Telegram ID matches the `TELEGRAM_ROOT_ADMIN_IDS` provided during cutover, the Worker will recognize you as the owner and grant you the **👑 Admin Panel**.
4. Paste an Amazon link in the chat to begin tracking!
