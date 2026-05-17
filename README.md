# AzTracker 🛒

> Track Amazon.eg product prices and get instant Telegram alerts when they drop — no server, no cost.

AzTracker runs entirely on GitHub Actions, triggered by cron-job.org. Just add your product URLs, set up a Telegram bot, and you'll get notified the moment a price drops. No device needs to stay on.

---

## Features

- 🔔 Telegram notifications on **confirmed** price drops only — no spam
- 📦 Track multiple products from a single file
- 🤖 Product names fetched automatically — no manual labeling
- ☁️ Fully serverless — runs on GitHub Actions
- ✅ Price drop verification — waits 10s and re-checks before notifying (prevents false alerts)
- 🕐 Cairo timezone (EET/EEST) — automatically adjusts for daylight saving
- 💸 100% free with the right setup

---

## How It Works

1. Fetches product name and price from Amazon.eg
2. Compares with last known price
3. **If price drops**: Waits 10 seconds, re-fetches the price to confirm
4. **If confirmed**: Sends Telegram notification with price change details
5. **If price reverted**: Silently updates and skips notification

This prevents false alerts from temporary price fluctuations or scraping errors.

---

## Quick Start

### What you'll need
- A [GitHub](https://github.com) account
- A [Telegram](https://telegram.org) account
- A [ScraperAPI](https://www.scraperapi.com) account (free tier)
- A [cron-job.org](https://cron-job.org) account (free)

---

### Step 1 — Fork or clone this repo

```
https://github.com/aka-khalid/AzTracker
```

Make it **private** if you don't want your product URLs visible publicly.

---

### Step 2 — Add your products

Edit `products.json` with the Amazon.eg URLs you want to track:

```json
[
  { "url": "https://www.amazon.eg/dp/B0CX1234XY" },
  { "url": "https://www.amazon.eg/dp/B0CXXXX8AB" }
]
```

> ⚠️ Use full product URLs only. Shortened links like `amzn.eu/...` might not work.

> 📝 The URLs above are for demonstration only. Replace them with your actual Amazon.eg product URLs.

---

### Step 3 — Create a Telegram bot

1. Open Telegram → search **@BotFather** → send `/newbot` → follow the steps → copy the **token**
2. Search **@userinfobot** → send `/start` → copy your **Chat ID**
3. Open your new bot and send it any message so it can reply to you

---

### Step 4 — Get a ScraperAPI key

Sign up at [scraperapi.com](https://www.scraperapi.com) and copy your API key from the dashboard.

> ScraperAPI is used to bypass Amazon's bot detection. The free tier includes 1,000 requests/month.

---

### Step 5 — Add GitHub Secrets

Go to your repo → **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret | Value |
|---|---|
| `TELEGRAM_TOKEN` | from @BotFather |
| `TELEGRAM_CHAT_ID` | from @userinfobot |
| `SCRAPER_API_KEY` | from ScraperAPI |

---

### Step 6 — Set up the scheduler

GitHub's built-in cron scheduler is unreliable on free accounts, so we use cron-job.org to trigger runs instead.

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
| Schedule | Every 1 hour (see note below) |

---

## Choosing a check frequency

Each run uses **1 ScraperAPI request per product**. When a price drop is detected, an **additional confirmation request** is made 60 seconds later. Plan accordingly:

**Base requests (without drops):**

| Products | Every 1h | Every 2h | Every 3h |
|---|---|---|---|
| 1 | 720 ✅ | 360 ✅ | 240 ✅ |
| 3 | 2,160 ❌ | 1,080 ❌ | 720 ✅ |
| 5 | 3,600 ❌ | 1,800 ❌ | 1,200 ❌ |

Numbers are monthly requests. Free tier limit is **1,000/month**.

**⚠️ Important**: Confirmation requests are only triggered when price drops are detected. If products frequently drop in price, add extra margin or use multiple API keys. The table above shows the baseline; actual usage depends on how often prices drop.

**Need more?** You can add multiple ScraperAPI keys (one per free account) as a comma-separated secret:
```
key1,key2,key3
```
The tracker will rotate between them automatically.

---

## Repo Structure

```
AzTracker/
├── price_tracker.py        # main script
├── products.json           # your product URLs
├── requirements.txt        # Python dependencies
├── prices.json             # auto-generated price history
└── .github/
    └── workflows/
        └── price_tracker.yml
```

---

## Notification Format

```
📉 Samsung 55" QLED TV
💰 18,999.00 EGP
Down 2,000.00 EGP (was 20,999.00)
🕐 2026-05-11 10:00 EET
View on Amazon.eg
```

*Timestamps are in Cairo timezone (EET/EEST), automatically adjusted for daylight saving.*

---

## What Happens During a Run

### Success Flow
- ✅ Product fetched successfully
- ✅ Price compared with last known price
- 📈 Price went up or stayed the same → no notification
- 📉 Price dropped → **waits 10 seconds**
- 🔄 Re-fetches product to confirm price
- ✅ Price confirmed → **sends notification**
- 💾 Price saved for next run

### Skip Scenarios
- First run → saves price, no notification
- Price went up or unchanged → skips silently
- Confirmation fetch fails → skips without notifying
- Price reverted during confirmation → updates saved price, skips

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| "Could not fetch product" | Shortened or invalid URL, or ScraperAPI returning 500 errors | Use full `amazon.eg/dp/...` URLs; check ScraperAPI status or retry later |
| "Could not confirm price — skipping" | ScraperAPI or Amazon temporarily unreachable during confirmation | This is expected during high traffic; will retry on next run |
| "Price reverted — skipping" | Temporary price drop detected but reverted within 60 seconds | This prevents false alerts and is working as intended |
| "chat not found" from Telegram | Bot not activated | Send your bot any message first |
| 401 on cron-job.org test | Bad GitHub token | Regenerate with Actions: Read and write |
| 403 on cron-job.org test | Wrong token permission | Make sure Actions (not just Workflows) is Read and write |
| Runs delayed or skipped | GitHub scheduler unreliable | Expected — cron-job.org fixes this |
| Hit ScraperAPI limit mid-month | Too many requests (including confirmations) | Add a second API key or reduce frequency |

---

## Acknowledgements

Built with the help of [Claude](https://claude.ai) by Anthropic.

---

## License

MIT — free to use, modify, and distribute.
