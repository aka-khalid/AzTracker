# 🚀 AzTracker: Comprehensive Deployment Guide

AzTracker relies on a fully decoupled, serverless architecture running exclusively on Cloudflare Workers and Cloudflare D1. Background processing is handled natively by Cloudflare CRON triggers and Queues, while Disaster Recovery is backed by a Google Cloud Platform (GCP) Serverless Bridge.

Follow these steps exactly in order.

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
   * Copy your **Credential ID**, **Secret**, and **Associates Tag** from your Amazon affiliate dashboard.

---

## Phase 2: D1 & KV Infrastructure Provisioning

AzTracker uses D1 for relational user data and locks, and KV for legacy session storage.

1. Run the local setup:
   ```bash
   npm install
   ```
2. Provision the D1 database:
   ```bash
   npx wrangler d1 create aztracker-prod-db
   ```
   *Copy the output `database_id` and update `wrangler.toml` under `[[env.production.d1_databases]]`.*
3. Execute the database schema:
   ```bash
   npx wrangler d1 execute aztracker-prod-db --env production --remote --file=schema.sql
   ```

---

## Phase 3: Deployment & Secrets Injection

The edge router requires all secrets to be securely injected before the cron triggers can run.

1. Deploy the worker to the production environment:
   ```bash
   npx wrangler deploy --env production
   ```
2. Inject the production secrets into the worker securely:
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN --env production
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --env production
   npx wrangler secret put AMAZON_ACCESS_KEY --env production
   npx wrangler secret put AMAZON_SECRET_KEY --env production
   ```

---

## Phase 4: Disaster Recovery (GCP Bridge)

Because Cloudflare Workers have strict memory constraints, we offload the heavy SQLite `.sql` export generation to a GCP Cloud Function.

1. Deploy the Node.js function from `gcp_backup_bridge.md` to GCP Cloud Functions (2nd Gen).
2. Ensure the Cloud Function requires OIDC authentication.
3. Configure a Google Cloud Scheduler job (`0 0 * * *`) that invokes the Cloud Function.
4. Add the OIDC token header in Cloud Scheduler pointing to your authorized Service Account.

---

## 🎉 Phase 5: System Boot & Administration

1. Open Telegram and navigate to your bot.
2. Send `/start`.
3. Because your Telegram ID matches the `GLOBAL_ADMINS` (or you are the root admin), the Worker will recognize you as the owner and grant you the **👑 Admin Panel**.
4. Paste an Amazon link in the chat to begin tracking!
