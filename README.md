# 📉 AzTracker (Amazon.eg Price Tracker)

> A multi-tenant, serverless Amazon.eg price tracking bot. Track products, share access with friends via an RBAC admin panel, and get instant Telegram push notifications when deals drop.

AzTracker operates on a hybrid serverless architecture. A **Cloudflare Worker** and **Cloudflare KV** database handle instant, multi-user Telegram ChatOps (UI, adding/removing products, and admin approvals). A scheduled **GitHub Actions** pipeline runs the heavy Python scraper, intelligently batching requests to Amazon's official Creators API to check for price drops in the background.

---

## ✨ Features

- 👥 **Multi-Tenant VIP Access:** Share the bot with friends. Each user gets their own isolated tracking database.
- 🛡️ **Role-Based Admin Panel:** Built-in ChatOps approval system. Root Admins can approve users, revoke access, and promote Sub-Admins entirely through Telegram buttons.
- ☁️ **Millisecond Serverless Database:** Powered by Cloudflare KV. Zero file-locking or concurrency issues, even with hundreds of users.
- 📱 **Mobile App Support:** Automatically resolves and extracts ASINs from `amzn.eu` short links shared directly from the Amazon mobile app.
- 🤖 **Auto-Naming:** Product titles are fetched automatically via URL extraction and API validation.
- 🛰️ **Amazon Creators API:** Fetches real prices securely without HTML scraping or honeypot blocks. Batch-optimized (10 items/request) to respect rate limits.
- 💸 **100% Free Architecture:** Utilizes the generous free tiers of Cloudflare, GitHub Actions, and Cron-job.org.

---

## 🛠️ Architecture Flow

1. **The Frontend (Cloudflare Worker):** Intercepts Telegram messages. If a user pastes an Amazon link, the Worker resolves it, extracts the ASIN, and saves it instantly to their profile in Cloudflare KV.
2. **The Bouncer (RBAC):** If an unauthorized user messages the bot, they are rejected and given an ID. Admins can paste this ID into the chat to generate a management card and approve them.
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
4. *(Optional but recommended)* In @BotFather, use `/setcommands` and add: `start - Open Control Center`.

### Step 2 — Setup Cloudflare KV & Worker
1. Log into Cloudflare → **Storage & Databases** → **KV** → Create a namespace called `AZTRACKER_DB`.
2. Go to **Workers & Pages** → Create a new Worker.
3. Replace the default code with the `worker.js` script (handling the UI and Routing).
4. Go to your Worker's **Settings → Variables**:
   * Add a text variable: `ALLOWED_USERS` = `[Your Telegram ID]` (This makes you the Root Admin).
   * Add a text variable: `GITHUB_OWNER` = `[Your GitHub Username]`
   * Add a text variable: `GITHUB_REPO` = `AzTracker`
   * Add a secret variable: `GITHUB_PAT` = `[Your Personal Access Token]`
5. Go to **Settings → Bindings**:
   * Add a KV binding. Variable name: `AZTRACKER_DB`. Select your created namespace.

### Step 3 — Get Amazon Creators API Credentials
1. Log in at [affiliate-program.amazon.eg](https://affiliate-program.amazon.eg).
2. Go to **Tools → Creators API**.
3. Generate credentials and copy your **Access Key**, **Secret Key**, **Partner Tag** (e.g., `yourname-21`), and **API Version** (e.g., `2.2`).

### Step 4 — Configure GitHub Secrets
In your GitHub Repo, go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|---|---|
| `TELEGRAM_TOKEN` | From @BotFather |
| `TELEGRAM_CHAT_ID` | Your Root Admin Telegram ID |
| `AMAZON_ACCESS_KEY` | From Amazon Creators API |
| `AMAZON_SECRET_KEY` | From Amazon Creators API |
| `AMAZON_PARTNER_TAG` | Your Amazon Associates ID |
| `AMAZON_API_VERSION` | API Version (e.g., `2.2`) |
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

## 👑 Admin Guide: Adding Friends

AzTracker is a closed VIP system. Random users cannot use it without your permission.
1. Share your bot's `@username` with a friend.
2. When they click Start, the bot will reject them and give them their `Telegram ID`.
3. They send that ID to you.
4. **Copy and paste their ID directly into your bot chat.**
5. A User Management Card will appear. Click **✅ Approve User**.
6. They will instantly receive a welcome notification and gain full tracking access!

---

## 📂 Repo Structure

```text
AzTracker/
├── price_tracker.py        # Background engine (Throttled & Batched)
├── requirements.txt        # Uses a custom Amazon PAAPI fork for .eg support
├── worker.js               # Router logic (ChatOps GUI UI Backend)
└── .github/
    └── workflows/
        └── price_tracker.yml # Serverless execution pipeline
```

*(Note: Data is stored entirely in Cloudflare KV. There are no local JSON files in this repository.)*

---

## 👨‍💻 Author & Acknowledgements

Architected and engineered by **Khalid Ibrahim**.

Special thanks to **[Abdelrahman Elkhayat](https://www.facebook.com/bodaa.elkhayat)** for generously providing the Amazon Creators API Credentials that power the core tracking engine.

Built with the help of [Claude](https://claude.ai) by Anthropic and [Gemini](https://gemini.google.com) by Google.

---

## License

MIT — free to use, modify, and distribute.
