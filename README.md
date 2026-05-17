# 📉 AzTracker (Amazon.eg Price Tracker)

> A multi-tenant, serverless Amazon.eg price tracking bot. Track products, share access with friends via an RBAC admin panel, and get instant Telegram push notifications when deals drop.

🔗 **Try the Bot:** [@AzTrackerr_bot](https://t.me/AzTrackerr_bot)

---

## ✨ Features

- 👥 **Multi-Tenant VIP Access:** Share the bot with friends. Each user gets their own isolated tracking database.
- 🛡️ **Role-Based Admin Panel:** Built-in ChatOps approval system. Admins can view users with live name resolution, approve, revoke access, or modify roles entirely through interactive buttons.
- ☁️ **Millisecond Serverless Database:** Powered by Cloudflare KV. Zero file-locking or concurrency issues, even with hundreds of users.
- 📱 **Mobile App Support:** Automatically resolves and extracts ASINs from `amzn.eu` short links shared directly from the Amazon mobile app.
- 🤖 **Auto-Naming:** Product titles are fetched automatically via URL extraction and API validation.
- 🛰️ **Amazon Creators API:** Fetches real prices securely without HTML scraping or honeypot blocks. Batch-optimized (10 items/request) to respect rate limits.
- 🚀 **Fully Automated CI/CD (GitOps):** Modifying `worker.js` and pushing to GitHub automatically compiles and deploys your code to Cloudflare's global edge network within seconds.

---

## 🛠️ Architecture Flow

1. **The Frontend (Cloudflare Worker):** Intercepts Telegram messages. If a user pastes an Amazon link, the Worker resolves it, extracts the ASIN, and saves it instantly to their profile in Cloudflare KV. Unhandled text is cleanly wiped to maintain a pristine, button-only UI.
2. **The Bouncer (RBAC):** Unapproved users are blocked. Admins can view a live directory registry with real names or drop a raw ID to trigger a management card.
3. **The Engine (GitHub Actions):** Triggered on a schedule (e.g., every 30-60 minutes). It wakes up, pulls everyone's tracking lists from Cloudflare KV, deduplicates the items to prevent rate-limiting, and queries the Amazon API.
4. **The Notifier (Python):** Compares live prices against the global price history in KV. If a drop is detected, it routes personalized Telegram push notifications only to the users tracking that specific item.

---

## 🚀 Quick Start Guide

### What you'll need
- A [GitHub](https://github.com) account
- A [Cloudflare](https://dash.cloudflare.com/) account (Free tier)
- A [Telegram](https://telegram.org) account
- An Amazon Associates account with Creators API access
- A [cron-job.org](https://cron-job.org) account (Free)

---

### Step 1 — Setup Telegram & The Repo
1. Fork or clone this repository.
2. Open Telegram, search **@BotFather**, send `/newbot`, and copy the **Bot Token**.
3. Search **@userinfobot**, send `/start`, and copy your personal **Telegram ID**.
4. *(Optional)* In @BotFather, use `/setcommands` and add: `start - Open Control Center`.

### Step 2 — Setup Cloudflare KV & Wrangler Configuration
1. Log into Cloudflare → **Storage & Databases** → **KV** → Create a namespace called `AZTRACKER_DB`. Copy its **Namespace ID** string.
2. Go to **Workers & Pages** → Create a new Worker named `aztracker-bot`. 
3. Open your local repository files, locate `wrangler.toml`, and paste your KV Namespace ID string into the ID field.
4. Go to your Cloudflare Worker's **Settings → Variables** in the web dashboard:
   * Add a text variable: `ALLOWED_USERS` = `[Your Telegram ID]` (This makes you the Root Admin).
   * Add a text variable: `GITHUB_OWNER` = `[Your GitHub Username]`
   * Add a text variable: `GITHUB_REPO` = `AzTracker`
   * Add a secret variable: `GITHUB_PAT` = `[Your GitHub Personal Access Token]`

### Step 3 — Get Amazon Creators API Credentials
1. Log in at [affiliate-program.amazon.eg](https://affiliate-program.amazon.eg).
2. Go to **Tools → Creators API**.
3. Generate credentials and copy your **Access Key**, **Secret Key**, **Partner Tag**, and **API Version**.

### Step 4 — Configure GitHub Secrets
In your GitHub Repo, go to **Settings → Secrets and variables → Actions** and add the following keys. These secrets power *both* your background price-checking scraper and your automated Worker deployment pipeline:

| Secret | Value |
|---|---|
| `TELEGRAM_TOKEN` | From @BotFather |
| `TELEGRAM_CHAT_ID` | Your Root Admin Telegram ID |
| `AMAZON_ACCESS_KEY` | From Amazon Creators API |
| `AMAZON_SECRET_KEY` | From Amazon Creators API |
| `AMAZON_PARTNER_TAG` | Your Amazon Associates ID |
| `AMAZON_API_VERSION` | Exact API Version generated (e.g., `2.2`) |
| `CF_ACCOUNT_ID` | Found on your main Cloudflare Dashboard right sidebar |
| `CF_NAMESPACE_ID` | Found in your Cloudflare KV `AZTRACKER_DB` settings |
| `CF_API_TOKEN` | Generated CF Token (Needs Account + Workers KV Storage Edit permissions) |

### Step 5 — Set up the Scheduler
Use [cron-job.org](https://cron-job.org) to trigger the workflow.
1. Generate a GitHub Fine-Grained Token with **Actions: Read & Write** permissions.
2. Create a POST request to: `https://api.github.com/repos/YOUR_USERNAME/AzTracker/actions/workflows/price_tracker.yml/dispatches`
3. Add Headers:
   * `Authorization: Bearer YOUR_GITHUB_TOKEN`
   * `Accept: application/vnd.github+json`
4. Add Body: `{"ref":"main"}`
5. **Schedule:** Every 30 to 60 minutes is highly recommended to respect Amazon API rate limits and GitHub Actions free-tier quotas.

---

## 👑 Admin Guide: Managing Users

AzTracker is a closed VIP system. Random users cannot use it without your permission.
1. Share your bot's `@username` with a friend.
2. When they click Start, the bot will reject them and provide their `Telegram ID`.
3. Click **👑 Admin Panel** inside your bot, select **👥 View Approved Users** to inspect your active directory registry with live name resolution, or simply paste their raw numeric ID directly into the chat window to pull up their permission card instantly.
4. Click **✅ Approve User** to grant access, or **🗑️ Revoke User** to instantly detach them from your tracking system.

---

## 📂 Repo Structure

```text
AzTracker/
├── price_tracker.py          # Background engine (Throttled & Batched)
├── requirements.txt          # Uses a custom Amazon PAAPI fork for .eg support
├── worker.js                 # Edge routing engine (ChatOps GUI App UI)
├── wrangler.toml             # Cloudflare edge deployment configuration
└── .github/
    └── workflows/
        ├── deploy_worker.yml # Automated Cloudflare Worker CD pipeline
        └── price_tracker.yml # Serverless scheduled execution pipeline
```

*(Note: Persistent tracking states and price history are saved completely in Cloudflare KV. There are no local JSON storage dependencies inside this repository.)*

---

## 👨‍💻 Author & Acknowledgements

Architected and engineered by **Khalid Ibrahim**.

Special thanks to **[Abdelrahman Elkhayat](https://www.facebook.com/bodaa.elkhayat)** for generously providing the Amazon Creators API Credentials that power the core tracking engine.

Built with the assistance of [Claude](https://claude.ai) by Anthropic and [Gemini](https://gemini.google.com) by Google.

---

## License

MIT — free to use, modify, and distribute.
