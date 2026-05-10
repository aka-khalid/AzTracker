"""
Amazon.eg Price Tracker
Fetches the current price and sends a Telegram notification.
Designed to be run by GitHub Actions every hour.
"""

import requests
import random
import time
import os
import sys
from bs4 import BeautifulSoup
from datetime import datetime

# ── Config (loaded from GitHub Secrets) ──────────────────────────────────────
PRODUCT_URL      = os.environ["PRODUCT_URL"]
PRODUCT_NAME     = os.environ.get("PRODUCT_NAME", "Tracked Product")
TELEGRAM_TOKEN   = os.environ["TELEGRAM_TOKEN"]
TELEGRAM_CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]
# ─────────────────────────────────────────────────────────────────────────────

HEADERS_LIST = [
    {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "ar-EG,ar;q=0.9,en;q=0.8",
    },
    {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                      "AppleWebKit/605.1.15 (KHTML, like Gecko) "
                      "Version/17.0 Safari/605.1.15",
        "Accept-Language": "en-US,en;q=0.9",
    },
]


def fetch_price(url, retries=3):
    scraper_api_key = os.environ.get("SCRAPER_API_KEY")
    
    for attempt in range(retries):
        try:
            time.sleep(random.uniform(1, 3))
            if scraper_api_key:
                # Route through ScraperAPI to bypass Amazon's blocking
                api_url = "http://api.scraperapi.com"
                params = {"api_key": scraper_api_key, "url": url, "country_code": "eg"}
                resp = requests.get(api_url, params=params, timeout=60)
            else:
                headers = random.choice(HEADERS_LIST)
                resp = requests.get(url, headers=headers, timeout=15)
            resp.raise_for_status()
        except requests.RequestException as e:
            print(f"[Attempt {attempt+1}] Request error: {e}")
            continue

        soup = BeautifulSoup(resp.text, "lxml")
        selectors = [
            ("span", {"class": "a-price-whole"}),
            ("span", {"id": "priceblock_ourprice"}),
            ("span", {"id": "priceblock_dealprice"}),
            ("span", {"class": "a-offscreen"}),
        ]
        for tag, attrs in selectors:
            el = soup.find(tag, attrs)
            if el:
                price = parse_price(el.get_text().strip())
                if price:
                    return price

        print(f"[Attempt {attempt+1}] Price element not found.")
    return None


def parse_price(raw: str):
    cleaned = "".join(ch for ch in raw if ch.isdigit() or ch == ".")
    try:
        return float(cleaned) if cleaned else None
    except ValueError:
        return None


def send_telegram(message: str):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    resp = requests.post(url, json={
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "HTML"
    }, timeout=10)
    if resp.status_code == 200:
        print("Telegram notification sent.")
    else:
        print(f"Telegram error: {resp.text}")
        sys.exit(1)


def main():
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    print(f"Checking price at {now}...")

    price = fetch_price(PRODUCT_URL)

    if price is None:
        send_telegram(
            f"⚠️ <b>{PRODUCT_NAME}</b>\n"
            f"Could not fetch price at {now}.\n"
            f"Amazon may be blocking the request."
        )
        sys.exit(1)

    print(f"Price: {price:.2f} EGP")

    send_telegram(
        f"🛒 <b>{PRODUCT_NAME}</b>\n"
        f"💰 <b>{price:,.2f} EGP</b>\n"
        f"🕐 {now}\n"
        f'<a href="{PRODUCT_URL}">View on Amazon.eg</a>'
    )


if __name__ == "__main__":
    main()
