# AzTracker 🛒

A lightweight Amazon.eg price tracker that runs on GitHub Actions and sends Telegram notifications when a price changes.

---

## How It Works

1. cron-job.org triggers the GitHub Actions workflow every hour
2. The script fetches the current price for each product in `products.json`
3. If the price changed since the last check, a Telegram notification is sent
4. The latest prices are committed back to the repo in the `prices/` folder

---

## Repo Structure

```
AzTracker/
├── price_tracker.py        # main script
├── products.json           # list of product URLs to track
├── requirements.txt        # Python dependencies
├── prices/                 # auto-generated, one .txt file per product
└── .github/
    └── workflows/
        └── price_tracker.yml
```

---

## Setup

### 1. Telegram Bot
- Open Telegram → search **@BotFather** → send `/newbot` → copy the token
- Search **@userinfobot** → send `/start` → copy your Chat ID
- Send your bot any message so it can message you back

### 2. ScraperAPI
- Sign up at [scraperapi.com](https://www.scraperapi.com) (free tier: 1,000 requests/month)
- Copy your API key from the dashboard
- To add multiple keys, comma-separate them in the GitHub secret: `key1,key2,key3`

### 3. GitHub Secrets
Go to your repo → **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|---|---|
| `TELEGRAM_TOKEN` | from @BotFather |
| `TELEGRAM_CHAT_ID` | from @userinfobot |
| `SCRAPER_API_KEY` | from ScraperAPI (comma-separated for multiple) |

### 4. cron-job.org
- Sign up at [cron-job.org](https://cron-job.org) (free)
- Create a new cronjob with these settings:
  - **URL:** `https://api.github.com/repos/YOUR_USERNAME/AzTracker/actions/workflows/price_tracker.yml/dispatches`
  - **Method:** `POST`
  - **Headers:**
    - `Authorization: Bearer YOUR_GITHUB_TOKEN`
    - `Accept: application/vnd.github+json`
  - **Body:** `{"ref":"main"}`
  - **Schedule:** every 1 hour (or adjust based on usage)

### 5. GitHub Personal Access Token
- GitHub → **Settings → Developer settings → Fine-grained tokens**
- Select your repo, add **Actions: Read and write** permission
- Copy the token and paste it into cron-job.org as the Bearer token

---

## Adding Products

Edit `products.json` — just add the full Amazon.eg product URL:

```json
[
  { "url": "https://www.amazon.eg/dp/B0CX1234XY" },
  { "url": "https://www.amazon.eg/dp/B0CX5678AB" }
]
```

- Use full URLs only (`amazon.eg/dp/...`), not shortened links (`amzn.eu/...`)
- Product names are fetched automatically from the page
- Commit and push — the next run will pick up the new products

---

## Free Tier Limits

| Service | Free limit | Hourly usage (6 products) |
|---|---|---|
| ScraperAPI | 1,000 req/month | ~4,320 ❌ |
| ScraperAPI x2 keys | 2,000 req/month | ~4,320 ❌ |
| ScraperAPI x3 keys | 3,000 req/month | ~4,320 ❌ |
| GitHub Actions | 2,000 min/month | ~360 min ✅ |
| cron-job.org | Unlimited | ✅ |

> For 6 products, run every **3 hours** to stay within 1 ScraperAPI key's free limit (672 req/2 weeks).

---

## Telegram Notification Format

```
📉 Product Name
💰 4,299.00 EGP
Down 200.00 EGP (was 4,499.00)
🕐 2026-05-11 10:00 UTC
View on Amazon.eg
```

---

## Troubleshooting

| Issue | Cause | Fix |
|---|---|---|
| "Could not fetch product" | Amazon blocking or wrong URL | Use full `amazon.eg/dp/...` URL, not shortened links |
| "chat not found" Telegram error | Bot never messaged first | Send your bot any message on Telegram |
| 401 on cron-job.org | Bad GitHub token | Regenerate token with Actions: Read and write |
| Runs delayed or skipped | GitHub scheduler unreliable | cron-job.org handles this — ignore GitHub's built-in schedule |
| Hit ScraperAPI limit | Too many requests | Add a second API key or reduce check frequency |
