"""
Amazon.eg Price Tracker
Reads URLs from products.json, fetches name and price automatically,
and sends a Telegram notification only when a price changes.
"""

import requests
import random
import time
import os
import sys
import json
from bs4 import BeautifulSoup
from datetime import datetime

# ── Config (from GitHub Secrets) ─────────────────────────────────────────────
TELEGRAM_TOKEN   = os.environ["TELEGRAM_TOKEN"]
TELEGRAM_CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]
SCRAPER_API_KEYS = os.environ.get("SCRAPER_API_KEY", "").split(",")
# ─────────────────────────────────────────────────────────────────────────────

LAST_PRICE_DIR = "prices"

HEADERS_LIST = [
    {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "ar-EG,ar;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Referer": "https://www.google.com/",
        "DNT": "1",
        "Upgrade-Insecure-Requests": "1",
    },
]


def get_price_file(url):
    product_id = url.rstrip("/").split("/")[-1]
    os.makedirs(LAST_PRICE_DIR, exist_ok=True)
    return f"{LAST_PRICE_DIR}/{product_id}.txt"


def read_last_price(url):
    try:
        with open(get_price_file(url), "r") as f:
            return float(f.read().strip())
    except:
        return None


def write_last_price(url, price):
    with open(get_price_file(url), "w") as f:
        f.write(str(price))


def fetch_product(url, retries=3):
    """Returns (name, price) tuple or (None, None) on failure."""
    for attempt in range(retries):
        try:
            time.sleep(random.uniform(2, 4))
            if SCRAPER_API_KEY:
                resp = requests.get(
                    "http://api.scraperapi.com",
                    params={"api_key": random.choice(SCRAPER_API_KEYS), "url": url, "country_code": "eg"},
                    timeout=60
                )
            else:
                headers = random.choice(HEADERS_LIST)
                resp = requests.get(url, headers=headers, timeout=15)
            resp.raise_for_status()
        except requests.RequestException as e:
            print(f"  [Attempt {attempt+1}] Request error: {e}")
            continue

        soup = BeautifulSoup(resp.text, "lxml")

        # ── Name ──────────────────────────────────────────────
        name = None
        name_el = soup.find("span", {"id": "productTitle"})
        if name_el:
            name = name_el.get_text().strip()

        # ── Price ─────────────────────────────────────────────
        price = None
        price_selectors = [
            ("span", {"class": "a-price-whole"}),
            ("span", {"id": "priceblock_ourprice"}),
            ("span", {"id": "priceblock_dealprice"}),
            ("span", {"class": "a-offscreen"}),
        ]
        for tag, attrs in price_selectors:
            el = soup.find(tag, attrs)
            if el:
                price = parse_price(el.get_text().strip())
                if price:
                    break

        if name and price:
            return name, price

        print(f"  [Attempt {attempt+1}] Could not find name or price.")

    return None, None


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
        print("  ✅ Telegram notification sent.")
    else:
        print(f"  ⚠️  Telegram error: {resp.text}")


def main():
    with open("products.json") as f:
        products = json.load(f)

    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")

    for product in products:
        url = product["url"]
        print(f"\nChecking: {url}")

        name, price = fetch_product(url)

        if name is None or price is None:
            print("  ❌ Could not fetch product.")
            send_telegram(
                f"⚠️ Could not fetch product at {now}.\n"
                f'<a href="{url}">View on Amazon.eg</a>'
            )
            continue

        print(f"  📦 {name}")
        print(f"  💰 {price:,.2f} EGP")

        last_price = read_last_price(url)
        write_last_price(url, price)

        if last_price is None:
            print("  📝 First run — price saved, no notification sent.")
            continue

        if price == last_price:
            print("  ➡️  Unchanged — no notification sent.")
            continue

        diff = price - last_price
        arrow = "📉" if diff < 0 else "📈"
        direction = "Down" if diff < 0 else "Up"

        send_telegram(
            f"{arrow} <b>{name}</b>\n"
            f"💰 <b>{price:,.2f} EGP</b>\n"
            f"{direction} {abs(diff):,.2f} EGP (was {last_price:,.2f})\n"
            f"🕐 {now}\n"
            f'<a href="{url}">View on Amazon.eg</a>'
        )


if __name__ == "__main__":
    main()
