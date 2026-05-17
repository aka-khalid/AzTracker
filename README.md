# 📉 AzTracker (Amazon.eg Price Tracker)

> Track Amazon.eg product prices and get instant Telegram alerts when they drop — no server, no cost.

AzTracker runs entirely on GitHub Actions, triggered by cron-job.org. Just add your product URLs, set up a Telegram bot, and you'll get notified the moment a price drops. No device needs to stay on.

---

## Features

- 🔔 Telegram notifications on price drops — instant, no spam
- 📦 Track multiple products from a single file (with the ability to pause specific items)
- 🤖 Product names fetched automatically — no manual labeling
- ☁️ Fully serverless — runs on GitHub Actions
- 🛰️ Uses Amazon's official Creators API — real prices, no scraping, no honeypots
- 🕐 Cairo timezone (EET/EEST) — automatically adjusts for daylight saving
- 💸 100% free with the right setup

---

## How It Works

1. Fetches product name and price directly from Amazon via the official Creators API.
2. Compares with last known price.
3. If price dropped → sends Telegram notification instantly.
4. Saves latest price for next run.

---

## Quick Start

### What you'll need
- A [GitHub](https://github.com) account
- A [Telegram](https://telegram.org) account
- An Amazon Associates account with Creators API access
- A [cron-job.org](https://cron-job.org) account (free)

---

### Step 1 — Fork or clone this repo

```text
[https://github.com/YOUR_USERNAME/AzTracker](https://github.com/YOUR_USERNAME/AzTracker)
```

---

### Step 2 — Add your products

Edit `products.json` with the Amazon.eg URLs you want to track. You can pause tracking for specific items without deleting them by setting `"paused": true`:

```json
[
  { 
    "url": "https://www.amazon.eg/dp/B0CX1234XY",
    "paused": false
  },
  { 
    "url": "https://www.amazon.eg/dp/B0CXXXX8AB",
    "paused": true
  }
]
```

> ⚠️ Use full product URLs only. Shortened links like `amzn.eu/...` won't work.

---

### Step 3 — Create a Telegram bot

1. Open Telegram → search **@BotFather** → send `/newbot` → follow the steps → copy the **token**
2. Search **@userinfobot** → send `/start` → copy your **Chat ID**
3. Open your new bot and send it any message so it can reply to you

---

### Step 4 — Get Amazon Creators API credentials

You need an Amazon Associates account with Creators API access:

1. Log in at [affiliate-program.amazon.eg](https://affiliate-program.amazon.eg)
2. Go to **Tools → Creators API**
3. Create an app and generate credentials
4. Copy your **Access Key** (Client ID), **Secret Key**, **Partner Tag** (your Associates store ID, e.g. `yourname-21`), and note your **API Version** (e.g., `2.2`).

> ⚠️ API access requires at least 10 qualifying sales in the past 30 days. It may take up to 48 hours after generating credentials before access is granted.

---

### Step 5 — Add GitHub Secrets

Go to your repo → **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret | Value |
|---|---|
| `TELEGRAM_TOKEN` | from @BotFather |
| `TELEGRAM_CHAT_ID` | from @userinfobot |
| `AMAZON_ACCESS_KEY` | from Creators API dashboard (Starts with `amzn1...`) |
| `AMAZON_SECRET_KEY` | from Creators API dashboard |
| `AMAZON_PARTNER_TAG` | your Associates store ID |
| `AMAZON_API_VERSION` | The Creators API version generated in Step 4 |

---

### Step 6 — Set up the scheduler

GitHub's built-in cron scheduler is unreliable on free accounts, so we use cron-job.org to trigger the `Amazon Price Tracker` workflow dispatches instead.

1. Sign up at [cron-job.org](https://cron-job.org)
2. Create a GitHub Personal Access Token:
   - GitHub → **Settings → Developer settings → Fine-grained personal access tokens**
   - Select your repo → add **Actions: Read and write** and **Workflows: Read and write** permissions → generate and copy the token
3. Create a new cronjob on cron-job.org with these settings:

| Setting | Value |
|---|---|
| URL | `https://api.github.com/repos/YOUR_USERNAME/AzTracker/actions/workflows/price_tracker.yml/dispatches` |
| Method | `POST` |
| Header 1 | `Authorization: Bearer YOUR_GITHUB_TOKEN` |
| Header 2 | `Accept: application/vnd.github+json` |
| Body | `{"ref":"main"}` |
| Schedule | *(See note below)* |

> 💡 **Important: Choosing an Execution Schedule**
> Your schedule interval depends heavily on whether your GitHub repository is **Public** or **Private**:
> 
> * **🌍 Public Repositories:** GitHub Actions is 100% free and completely unlimited. You can safely set your cron-job.org schedule to **Every 15 minutes** (or even faster) without ever running into limits or costs.
> * **🔒 Private Repositories:** GitHub limits free accounts to **2,000 compute minutes per month** for private repos. Because GitHub rounds every single execution up to 1 full minute, your choice matters:
>   * *Every 15 minutes* = ~2,880 runs/month ❌ (**Exceeds the 2,000 free minutes limit**)
>   * *Every 30 minutes* = ~1,440 runs/month  (**Safe** — leaves a buffer of ~560 minutes)
>   * *Every 1 hour* = ~720 runs/month  (**Highly recommended** — very safe and perfectly fine for standard price tracking)

---

## Repo Structure

```text
AzTracker/
├── price_tracker.py        # main script
├── products.json           # your product URLs
├── requirements.txt        # uses your custom fork: git+[https://github.com/aka-khalid/python-amazon-paapi.git](https://github.com/aka-khalid/python-amazon-paapi.git)
├── prices.json             # auto-generated price history
└── .github/
    └── workflows/
        └── price_tracker.yml
```

---

## Notification Format

```text
📉 Samsung 55" QLED TV
💰 18,999.00 EGP
Down 2,000.00 EGP (9.5% off, was 20,999.00)
🕐 2026-05-17 10:00 EEST
View on Amazon.eg
```

---

## What Happens During a Run

### Success Flow
- ✅ Dependencies are installed automatically using `pip install -r requirements.txt`.
- ✅ Product fetched via Amazon Creators API.
- ✅ Price compared with last known price.
- 📈 Price went up or stayed the same → no notification.
- 📉 Price dropped → **sends notification immediately**.
- 💾 Price saved for next run. The workflow configures git as `price-bot` and pushes a `chore: update prices` commit to save the state.

### Skip Scenarios
- First run → saves price, no notification.
- Price went up or unchanged → skips silently.
- Item marked as `"paused": true` → completely skips fetching.
- API fetch fails → sends a warning notification.

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| "Could not fetch product" | Invalid URL or API error | Use full `amazon.eg/dp/...` URLs; check API credentials |
| "invalid_client" error | Bad credentials or spaces | Ensure `AMAZON_API_VERSION` matches your dash, and secrets have no trailing spaces |
| "AssociateNotEligible" error | API access not yet granted | Wait up to 48 hours after generating credentials, or ensure sales quota is met |
| "chat not found" from Telegram | Bot not activated | Send your bot any message first |
| 401 on cron-job.org test | Bad GitHub token | Regenerate with Actions: Read and write |
| 403 on cron-job.org test | Wrong token permission | Make sure Actions (not just Workflows) is Read and write |

---

## Acknowledgements

Built with the help of [Claude](https://claude.ai) by Anthropic and [Gemini](https://gemini.google.com) by Google.

---

## License

MIT — free to use, modify, and distribute.
