# 🚀 AzTracker: Comprehensive Deployment Guide

AzTracker relies on a decoupled, serverless architecture. The Cloudflare Worker handles the UI and routing, while GitHub Actions handles the heavy processing. They communicate securely via Cloudflare KV. 

Follow these steps exactly in order. Skipping a step or misnaming a secret will break the authentication chain.

---

## Phase 1: Telegram Bootstrapping

1. **Create the Bot:**
   * Open Telegram and search for `@BotFather`.
   * Send `/newbot`, choose a name, and choose a username ending in `_bot`.
   * Copy the **HTTP API Token**. Save it as `TELEGRAM_BOT_TOKEN`.
2. **Get Your Root Admin ID:**
   * Search for `@userinfobot` in Telegram and send `/start`.
   * Copy your **Id** (a string of numbers like `123456789`). Save it as `TELEGRAM_ROOT_ADMIN_IDS`.
3. **Configure Bot Menu (Optional but recommended):**
   * Go back to `@BotFather` and send `/setcommands`.
   * Select your bot and paste: `start - Open Control Center`

---

## Phase 2: Cloudflare Database & Edge Setup

1. **Create the KV Namespace:**
   * Log in to your Cloudflare Dashboard.
   * Go to **Storage & Databases** -> **KV**.
   * Click **Create a namespace**. Name it `AZTRACKER_DB`.
   * Copy the **Namespace ID** (a long alphanumeric string). Save it as `CLOUDFLARE_KV_NAMESPACE_ID`.
2. **Get Your Account ID:**
   * Look at the URL in your browser: `https://dash.cloudflare.com/YOUR_ACCOUNT_ID/workers/kv...`
   * Copy that 32-character string. Save it as `CLOUDFLARE_ACCOUNT_ID`.
3. **Generate a Cloudflare API Token:**
   * Go to **My Profile** (top right) -> **API Tokens** -> **Create Token**.
   * Select **Create Custom Token**.
   * Name: `AzTracker KV Access`
   * Permissions:
     * `Account` | `Workers KV Storage` | `Edit`
   * Continue to summary and create. Save the token as `CLOUDFLARE_API_TOKEN`.

---

## Phase 3: Amazon Creators API

1. Log into your Amazon Egypt Affiliate account at `affiliate-program.amazon.eg`.
2. Go to **Tools** -> **Creators API**.
3. Generate your credentials. You will need:
   * **Access Key** (`AMZN_CREATORS_ACCESS_KEY`)
   * **Secret Key** (`AMZN_CREATORS_SECRET_KEY`)
   * **Partner Tag** (`AMZN_ASSOCIATES_TAG` - e.g., `yourname-21`)
   * **API Version** (Usually `3.2`. Save as `AMZN_API_VERSION`).

---

## Phase 4: GitHub Security & Secrets

### Part A: The Fine-Grained PAT
The Cloudflare Worker needs permission to trigger your Python script on GitHub Actions.
1. In GitHub, go to **Settings** (Account level) -> **Developer Settings** -> **Personal access tokens** -> **Fine-grained tokens**.
2. Click **Generate new token**.
3. Name it `AzTracker Actions Trigger`. Set expiration.
4. **Repository access:** Select "Only select repositories" and choose your AzTracker repo.
5. **Permissions:**
   * `Actions`: **Read and Write**
   * `Contents`: **Read and Write**
6. Generate and save the token as `GH_WORKFLOW_TOKEN`.

### Part B: Repository Secrets
1. Go to your AzTracker repository -> **Settings** -> **Secrets and variables** -> **Actions**.
2. Click **New repository secret**. You must add **ALL** of the following exact keys:

| Secret Name | Description / Value |
| :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | From Phase 1 |
| `TELEGRAM_ROOT_ADMIN_IDS` | From Phase 1 |
| `CLOUDFLARE_ACCOUNT_ID` | From Phase 2 |
| `CLOUDFLARE_KV_NAMESPACE_ID` | From Phase 2 |
| `CLOUDFLARE_API_TOKEN` | From Phase 2 |
| `AMZN_CREATORS_ACCESS_KEY` | From Phase 3 |
| `AMZN_CREATORS_SECRET_KEY` | From Phase 3 |
| `AMZN_ASSOCIATES_TAG` | From Phase 3 |
| `AMZN_API_VERSION` | From Phase 3 (e.g., `3.2`) |
| `GH_WORKFLOW_TOKEN` | The PAT you just created in Part A |
| `CRON_AUTH_KEY` | Create a random password (e.g., `MySuperSecretCron123`) |
| `TELEGRAM_WEBHOOK_SECRET` | Create a random password (e.g., `AzTrackerSecureWebhook99`) |

---

## Phase 5: Cloudflare Worker Deployment

1. Open `wrangler.toml` in your repository.
2. Update the `kv_namespaces` section with your actual ID from Phase 2.
3. Update the `[vars]` block with your exact GitHub Username and Repository name:
   ```toml
   [vars]
   GITHUB_OWNER = "aka-khalid"
   GITHUB_REPO = "aztracker"
   ```
4. Push these changes to your `main` branch on GitHub.
5. **The Deployment:** Your GitHub Action (`deploy_worker.yml`) should automatically run and deploy the `worker.js` to Cloudflare. 
6. **Inject Secrets to Cloudflare:** Once deployed, log into your Cloudflare Dashboard -> **Workers & Pages** -> select your `aztracker-bot` worker -> **Settings** -> **Variables and Secrets**. You must add these **six** encrypted secrets to match the GitHub deployment:
   * `TELEGRAM_BOT_TOKEN`
   * `TELEGRAM_WEBHOOK_SECRET` (Must match the one in GitHub)
   * `GH_WORKFLOW_TOKEN` (Must match the PAT in GitHub)
   * `CRON_AUTH_KEY` (Must match the one in GitHub)
   * `TELEGRAM_ROOT_ADMIN_IDS` (Must match the one in GitHub for Admin UI access)
   * `AMZN_ASSOCIATES_TAG` (Must match the one in GitHub for link generation)

---

## Phase 6: Securing the Telegram Webhook

You must tell Telegram to route user messages to your newly deployed Cloudflare Worker, secured by your Webhook Secret.

1. Find your Worker's URL in the Cloudflare Dashboard (e.g., `https://aztracker-bot.your-username.workers.dev`).
2. Open your computer's terminal (or Git Bash/Command Prompt) and run this exact `curl` command. Replace the bracketed variables with your real data:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_TELEGRAM_BOT_TOKEN>/setWebhook" \
     -d "url=<YOUR_WORKER_URL>" \
     -d "secret_token=<YOUR_TELEGRAM_WEBHOOK_SECRET>"
```
*If successful, it will return `{"ok":true,"result":true,"description":"Webhook was set"}`.*

---

## Phase 7: The Jitter Scheduler (Cron)

We use an external cron job to ping the Worker, which then decides if it's time to randomly trigger the GitHub Action.

1. Go to [cron-job.org](https://cron-job.org) and create a free account.
2. Click **Create Cronjob**.
3. **Title:** `AzTracker Engine Ping`
4. **URL:** `<YOUR_WORKER_URL>/scheduler` (e.g., `https://aztracker-bot...workers.dev/scheduler`)
5. **Execution schedule:** `Every 1 minute`
6. Click the **Advanced** tab:
   * Request Method: `GET`
   * Headers -> Add Header:
     * **Header:** `x-scheduler-key`
     * **Value:** `<YOUR_CRON_AUTH_KEY>` (The password you created in Phase 4).
7. Save. 

---

## 🎉 Phase 8: System Boot

1. Open Telegram and navigate to your bot.
2. Send `/start`. 
3. Because your Telegram ID matches the `TELEGRAM_ROOT_ADMIN_IDS` in GitHub, the Worker will recognize you as the owner and grant you the **👑 Admin Panel** dashboard. 
4. Paste an Amazon.eg link in the chat to begin tracking!
