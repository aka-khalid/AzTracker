"""
Amazon.eg Price Tracker
Reads URLs from products.json, fetches name and price automatically,
and sends a Telegram notification only when a price drops.
"""

import requests
import random
import time
import os
import json
import threading
from bs4 import BeautifulSoup
from datetime import datetime
import pytz
from concurrent.futures import ThreadPoolExecutor, as_completed

# ── Config (from GitHub Secrets) ─────────────────────────────────────────────
TELEGRAM_TOKEN   = os.environ["TELEGRAM_TOKEN"]
TELEGRAM_CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]
SCRAPER_API_KEYS = os.environ.get("SCRAPER_API_KEY", "").split(",")
_key_index = 0
_key_lock  = threading.Lock()

def next_api_key():
    global _key_index
    with _key_lock:
        key = SCRAPER_API_KEYS[_key_index % len(SCRAPER_API_KEYS)]
        _key_index += 1
        return key
# ─────────────────────────────────────────────────────────────────────────────

PRICES_FILE  = "prices.json"
MAX_NAME_LEN = 60

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


# ── Price store ───────────────────────────────────────────────────────────────

def load_prices():
    try:
        with open(PRICES_FILE, "r") as f:
            return json.load(f)
    except:
        return {}


def save_prices(prices: dict):
    with open(PRICES_FILE, "w") as f:
        json.dump(prices, f, indent=2)


def get_product_id(url):
    return url.rstrip("/").split("/")[-1]


def truncate_name(name: str) -> str:
    return name[:MAX_NAME_LEN] + "..." if len(name) > MAX_NAME_LEN else name


# ── Scraper ───────────────────────────────────────────────────────────────────

def fetch_product(url, retries=3):
    """Returns (name, price, attempts) or (name_or_None, None, attempts) on failure."""
    for attempt in range(retries):
        try:
            time.sleep(random.uniform(2, 4))
            if SCRAPER_API_KEYS:
                resp = requests.get(
                    "http://api.scraperapi.com",
                    params={"api_key": next_api_key(), "url": url, "country_code": "eg"},
                    timeout=60
                )
            else:
                resp = requests.get(url, headers=random.choice(HEADERS_LIST), timeout=15)
            resp.raise_for_status()
        except requests.RequestException as e:
            print(f"  [Attempt {attempt+1}] Request error: {e}")
            continue

        soup = BeautifulSoup(resp.text, "lxml")

        name = None
        name_el = soup.find("span", {"id": "productTitle"})
        if name_el:
            name = name_el.get_text().strip()

        price = None
        for tag, attrs in [
            ("span", {"class": "a-price-whole"}),
            ("span", {"id": "priceblock_ourprice"}),
            ("span", {"id": "priceblock_dealprice"}),
            ("span", {"class": "a-offscreen"}),
        ]:
            el = soup.find(tag, attrs)
            if el:
                price = parse_price(el.get_text().strip())
                if price:
                    break

        if name and price:
            return name, price, attempt + 1

        missing = []
        if not name: missing.append("name")
        if not price: missing.append("price")
        print(f"  [Attempt {attempt+1}] Could not find: {', '.join(missing)}.")

    return name, None, retries


def parse_price(raw: str):
    cleaned = "".join(ch for ch in raw if ch.isdigit() or ch == ".")
    try:
        return float(cleaned) if cleaned else None
    except ValueError:
        return None


# ── Telegram ──────────────────────────────────────────────────────────────────

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


# ── Per-product check ─────────────────────────────────────────────────────────

def check_product(product, prices, now):
    url    = product["url"]
    paused = product.get("paused", False)
    product_id = get_product_id(url)

    if paused:
        print(f"\n⏸ Skipping (paused): {url}")
        return product_id, None

    print(f"\nChecking: {url}")

    name, price, attempts = fetch_product(url)

    if price is None:
        print("  ❌ Could not fetch product.")
        label = truncate_name(name) if name else url
        send_telegram(
            f"⚠️ <b>{label}</b>\n"
            f"Could not fetch price after {attempts} attempt(s) at {now}.\n"
            f'<a href="{url}">View on Amazon.eg</a>'
        )
        return product_id, None

    price = round(price, 2)
    display_name = truncate_name(name)
    print(f"  📦 {display_name}")
    print(f"  💰 {price:,.2f} EGP")

    last_price = prices.get(product_id)

    if last_price is None:
        print("  📝 First run — price saved, no notification sent.")
        return product_id, price

    if price >= last_price:
        print("  📈 Price went up or unchanged — no notification sent.")
        return product_id, price

    # Price drop detected — confirm with direct request
    print("  🔄 Price drop detected, confirming directly...")
    time.sleep(60)

    try:
        resp = requests.get(url, headers=random.choice(HEADERS_LIST), timeout=15)
        soup = BeautifulSoup(resp.text, "lxml")
        confirmed_price = None
        for tag, attrs in [
            ("span", {"class": "a-price-whole"}),
            ("span", {"id": "priceblock_ourprice"}),
            ("span", {"id": "priceblock_dealprice"}),
            ("span", {"class": "a-offscreen"}),
        ]:
            el = soup.find(tag, attrs)
            if el:
                confirmed_price = parse_price(el.get_text().strip())
                if confirmed_price:
                    confirmed_price = round(confirmed_price, 2)
                    break
    except Exception as e:
        print(f"  ❌ Direct confirmation failed: {e}")
        return product_id, last_price

    if confirmed_price is None:
        print("  ❌ Could not parse price from direct request — skipping.")
        return product_id, last_price

    if confirmed_price != price:
        print(f"  ❌ Price mismatch: ScraperAPI={price}, Direct={confirmed_price} — skipping.")
        return product_id, confirmed_price

    diff = last_price - price
    pct  = (diff / last_price) * 100

    send_telegram(
        f"📉 <b>{display_name}</b>\n"
        f"💰 <b>{price:,.2f} EGP</b>\n"
        f"Down {diff:,.2f} EGP ({pct:.1f}% off, was {last_price:,.2f})\n"
        f"🕐 {now}\n"
        f'<a href="{url}">View on Amazon.eg</a>'
    )

    return product_id, price


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    with open("products.json") as f:
        products = json.load(f)

    prices = load_prices()
    cairo_tz = pytz.timezone('Africa/Cairo')
    now = datetime.now(cairo_tz).strftime("%Y-%m-%d %H:%M %Z")
    updates = {}

    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {
            executor.submit(check_product, p, prices, now): p["url"]
            for p in products
        }
        for future in as_completed(futures):
            product_id, new_price = future.result()
            if new_price is not None:
                updates[product_id] = new_price

    prices.update(updates)
    save_prices(prices)


if __name__ == "__main__":
    main()
