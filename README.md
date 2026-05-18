# 📉 AzTracker (Amazon.eg Price Tracker)

> A multi-tenant, serverless Amazon.eg price tracking bot. Track products, share access with friends via an RBAC admin panel, and get instant Telegram push notifications when deals drop.

🔗 **Try the Bot:** [@AzTrackerr_bot](https://t.me/AzTrackerr_bot)

---

## ✨ Features

* 👥 **Multi-Tenant VIP Access:** Share the bot with friends. Each user gets their own isolated tracking database.

* 🛡️ **Role-Based Admin Panel:** Built-in ChatOps approval system. Admins can view users with live name resolution, approve, revoke access, or modify roles entirely through interactive buttons.

* 👁️ **Admin God Mode:** Remotely inspect, pause, or force-delete tracked products from any user's registry directly from their management card.

* 🎯 **Target Price Thresholds:** Users can set a custom desired maximum price for any item. The engine intelligently filters out minor price fluctuations and only sends a push notification when the deal actually meets their specific budget.

* 📄 **Smart UI Pagination:** Dynamically generated pages (5 items per page) keep the Telegram ChatOps interface clean while bypassing Telegram inline keyboard limits.

* 🧹 **Zero-Clutter UI (SPA):** Implements a Single-Page-Application style Telegram interface. Old menus, commands, and ghost inputs are automatically cleaned up to keep chats pristine.

* ☁️ **Millisecond Serverless Database:** Powered by Cloudflare KV. No local JSON files, file-locking, or concurrency headaches.

* 📱 **Mobile App Support:** Automatically resolves and extracts ASINs from `amzn.to` and `amzn.eu` short links shared directly from the Amazon mobile app.

* 🤖 **Auto-Naming:** Product titles are automatically extracted and validated using Amazon API responses.

* 🛰️ **Amazon Creators API:** Fetches real prices securely without HTML scraping or honeypot blocks. Batch-optimized (10 items/request) to respect rate limits.

* 🎲 **Randomized Scheduler Engine:** Prevents robotic fixed-minute execution patterns by generating randomized hourly execution slots while maintaining a stable 4-runs-per-hour cadence.

* 🔒 **Distributed Execution Locking:** Prevents duplicate workflow dispatches and accidental overlapping runs using KV-backed execution locks.

* ⚡ **Deduplicated Batch Processing:** Multiple users tracking the same ASIN only trigger a single Amazon API request, dramatically reducing API pressure and improving scalability.

* 🚨 **Automatic Crash Reporting:** Fatal workflow exceptions are automatically pushed to Root Admins through Telegram with full traceback visibility.

* 🌍 **Cairo-Timezone Native Scheduling:** Scheduler windows, timestamps, and notifications operate using Egypt local time instead of UTC.

* 🚀 **Fully Automated CI/CD (GitOps):** Modifying `worker.js` and pushing to GitHub automatically compiles and deploys your code to Cloudflare's global edge network within seconds.

---

## 🛠️ Architecture Flow

1. **The Frontend (Cloudflare Worker):** Intercepts Telegram messages. If a user pastes an Amazon link, the Worker resolves it, extracts the ASIN, and saves it instantly to their profile in Cloudflare KV. Unhandled text is cleanly wiped to maintain a pristine button-only UI.

2. **The Bouncer (RBAC):** Unapproved users are blocked. Admins can view a live directory registry with real names or drop a raw ID to trigger a management card.

3. **The Scheduler Layer (Cloudflare Worker):** A hidden `/scheduler` endpoint is pinged every minute by cron-job.org. The Worker generates randomized execution slots inside each hour, stores them in Cloudflare KV, and dispatches GitHub Actions only when the current minute matches one of those slots.

4. **The Engine (GitHub Actions):** Triggered through the randomized scheduler system. It wakes up, pulls everyone's tracking lists from Cloudflare KV, deduplicates items to prevent rate-limiting, and queries the Amazon Creators API in optimized batches.

5. **The Notifier (Python):** Compares live prices against the global price history in KV. If a drop is detected, it routes personalized Telegram push notifications only to users tracking that specific item.

---

## 🚀 Quick Start Guide

### What You'll Need

* A [GitHub](https://github.com) account
* A [Cloudflare](https://dash.cloudflare.com/) account (Free tier)
* A [Telegram](https://telegram.org) account
* An Amazon Associates account with Creators API access
* A [cron-job.org](https://cron-job.org) account (Free)

---

### Step 1 — Setup Telegram & The Repo

1. Fork or clone this repository.
2. Open Telegram, search **@BotFather**, send `/newbot`, and copy the **Bot Token**.
3. Search **@userinfobot**, send `/start`, and copy your personal **Telegram ID**.
4. *(Optional)* In @BotFather, use `/setcommands` and add:

```text
start - Open Control Center
```

---

### Step 2 — Setup Cloudflare KV & Wrangler Configuration

1. Log into Cloudflare → **Storage & Databases** → **KV** → Create a namespace called `AZTRACKER_DB`.
2. Copy the Namespace ID.
3. Go to **Workers & Pages** → Create a Worker named:

```text
aztracker-bot
```

4. Open `wrangler.toml` and configure:

```toml
[vars]
GITHUB_OWNER = "your-github-username"
GITHUB_REPO = "AzTracker"
```

5. Configure your KV Namespace ID in `wrangler.toml`.

---

### Step 3 — Get Amazon Creators API Credentials

1. Log in at [affiliate-program.amazon.eg](https://affiliate-program.amazon.eg)
2. Navigate to:

```text
Tools → Creators API
```

3. Generate:

   * Access Key
   * Secret Key
   * Partner Tag
   * API Version

---

### Step 4 — Configure GitHub Secrets

Go to:

```text
Settings → Secrets and variables → Actions
```

Add the following:

| Secret               | Value                                                      |
| -------------------- | ---------------------------------------------------------- |
| `TELEGRAM_TOKEN`     | From @BotFather                                            |
| `ALLOWED_USERS`      | Your Root Admin Telegram ID                                |
| `AMAZON_ACCESS_KEY`  | Amazon Creators API Access Key                             |
| `AMAZON_SECRET_KEY`  | Amazon Creators API Secret Key                             |
| `AMAZON_PARTNER_TAG` | Amazon Associates Tag                                      |
| `AMAZON_API_VERSION` | API Version                                                |
| `CF_ACCOUNT_ID`      | Cloudflare Account ID                                      |
| `CF_NAMESPACE_ID`    | Cloudflare KV Namespace ID                                 |
| `CF_API_TOKEN`       | Cloudflare API Token                                       |
| `GITHUB_PAT`         | GitHub Personal Access Token used for workflow dispatching |
| `SCHEDULER_SECRET`   | Secret protecting the hidden `/scheduler` endpoint         |

---

### Step 5 — Set Up the Scheduler

Use [cron-job.org](https://cron-job.org) to ping your Worker every minute.

Method:

```text
GET
```

URL:

```text
https://YOUR_WORKER.workers.dev/scheduler?key=YOUR_SCHEDULER_SECRET
```

Schedule:

```text
Every minute
```

The Worker internally decides whether the current minute should dispatch GitHub Actions.

#### Recommended Alternative Authentication

Instead of exposing the secret in the query string, cron-job.org can send:

```http
x-scheduler-key: YOUR_SCHEDULER_SECRET
```

---

## 🔐 Security Design

* 🔒 Hidden scheduler endpoint protected by secret validation
* 👑 Root Admin / Admin / Approved User hierarchy
* ☁️ Cloudflare KV user isolation
* 🚫 No HTML scraping or browser automation
* 🔑 Secrets managed through GitHub Actions and Cloudflare Workers
* 🔒 GitHub Actions concurrency protection prevents overlapping runs

---

## 👑 Admin Guide: Managing Users

AzTracker is a closed VIP system. Random users cannot use it without approval.

1. Share your bot's `@username` with a friend.
2. When they click Start, the bot rejects them and displays their Telegram ID.
3. Open **👑 Admin Panel** → **👥 View Approved Users**.
4. Approve, revoke, promote, or inspect users directly through Telegram inline controls.
5. Admins can remotely inspect, pause, or force-delete tracked products from any user's registry.

---

## 📂 Repo Structure

```text
AzTracker/
├── price_tracker.py
├── requirements.txt
├── worker.js
├── wrangler.toml
└── .github/
    └── workflows/
        ├── deploy_worker.yml
        └── price_tracker.yml
```

> Persistent tracking states, scheduler windows, locks, UI state, and global price history are stored entirely inside Cloudflare KV.

> 💡 **Note on Deployment & Bundling:** AzTracker utilizes automated GitOps compiling. When GitHub Actions pushes `worker.js` to Cloudflare, Wrangler internally bundles and optimizes the Worker for edge execution. If you inspect the Cloudflare dashboard version, emojis and scopes may appear transformed/minified — this is expected behavior and functionally identical to the repository source.

---

## 👨‍💻 Author & Acknowledgements

Architected and engineered by **Khalid Ibrahim**.

Special thanks to **[Abdelrahman Elkhayat](https://www.facebook.com/bodaa.elkhayat)** for generously providing the Amazon Creators API credentials that power the core tracking engine.

Built with assistance from:

* [Claude](https://claude.ai) by Anthropic
* [Gemini](https://gemini.google.com) by Google
* [ChatGPT](https://chatgpt.com) by OpenAI

---

## License

MIT — free to use, modify, and distribute.
