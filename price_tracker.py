"""
Amazon.eg Price Tracker
Uses the Amazon Creators API for real prices — no scraping, no honeypots.
Sends a Telegram notification immediately when a price drop is detected.
"""

import os
import json
import time
import requests
from datetime import datetime
import pytz
from concurrent.futures import ThreadPoolExecutor, as_completed
from amazon_creatorsapi import AmazonCreatorsApi, Country
from amazon_creatorsapi.models import GetItemsResource

# ── Config (from GitHub Secrets) ─────────────────────────────────────────────
TELEGRAM_TOKEN     = os.environ["TELEGRAM_TOKEN"]
TELEGRAM_CHAT_ID   = os.environ["TELEGRAM_CHAT_ID"]
AMAZON_ACCESS_KEY  = os.environ["AMAZON_ACCESS_KEY"]
AMAZON_SECRET_KEY  = os.environ["AMAZON_SECRET_KEY"]
AMAZON_PARTNER_TAG = os.environ["AMAZON_PARTNER_TAG"]
# ─────────────────────────────────────────────────────────────────────────────

PRICES_FILE  = "prices.json"
MAX_NAME_LEN = 60

api = AmazonCreatorsApi(
    credential_id=AMAZON_ACCESS_KEY,
    credential_secret=AMAZON_SECRET_KEY,
    tag=AMAZON_PARTNER_TAG,
    country=Country.EG,
)

RESOURCES = [
    GetItemsResource.ITEMINFO_TITLE,
    GetItemsResource.OFFERS_LISTINGS_PRICE,
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


# ── Amazon Creators API fetch ─────────────────────────────────────────────────

def fetch_product(asin, retries=3):
    """Returns (name, price) or (None, None) on failure."""
    for attempt in range(retries):
        try:
            items = api.get_items([asin], resources=RESOURCES)
            if not items:
                print(f"  [Attempt {attempt+1}] No items returned for {asin}.")
                continue

            item = items[0]

            name = None
            try:
                name = item.item_info.title.display_value
            except:
                pass

            price = None
            try:
                price = item.offers.listings[0].price.money.amount
            except:
                pass

            if name and price:
                return name, float(price)

            missing = []
            if not name: missing.append("name")
            if not price: missing.append("price")
            print(f"  [Attempt {attempt+1}] Could not find: {', '.join(missing)}.")

        except Exception as e:
            print(f"  [Attempt {attempt+1}] API error: {e}")
            time.sleep(2)

    return None, None


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


# ── Per-product fetch (runs in parallel) ──────────────────────────────────────

def initial_fetch(product):
    url    = product["url"]
    paused = product.get("paused", False)
    product_id = get_product_id(url)

    if paused:
        print(f"\n⏸ Skipping (paused): {url}")
        return product_id, None, None, None

    print(f"\nChecking: {url}")
    name, price = fetch_product(product_id)
    return product_id, name, price, url


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    with open("products.json") as f:
        products = json.load(f)

    prices = load_prices()
    cairo_tz = pytz.timezone('Africa/Cairo')
    now = datetime.now(cairo_tz).strftime("%Y-%m-%d %H:%M %Z")
    updates = {}

    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {executor.submit(initial_fetch, p): p for p in products}
        fetch_results = [future.result() for future in as_completed(futures)]

    for product_id, name, price, url in fetch_results:
        if url is None:
            continue

        if price is None:
            print(f"\n  ❌ Could not fetch {url}")
            label = truncate_name(name) if name else url
            send_telegram(
                f"⚠️ <b>{label}</b>\n"
                f"Could not fetch price at {now}.\n"
                f'<a href="{url}">View on Amazon.eg</a>'
            )
            continue

        price = round(price, 2)
        display_name = truncate_name(name)
        print(f"\n  📦 {display_name}")
        print(f"  💰 {price:,.2f} EGP")

        last_price = prices.get(product_id)

        if last_price is None:
            print("  📝 First run — price saved, no notification sent.")
            updates[product_id] = price
            continue

        if price >= last_price:
            print("  📈 Price went up or unchanged — no notification sent.")
            updates[product_id] = price
            continue

        diff = last_price - price
        pct  = (diff / last_price) * 100

        send_telegram(
            f"📉 <b>{display_name}</b>\n"
            f"💰 <b>{price:,.2f} EGP</b>\n"
            f"Down {diff:,.2f} EGP ({pct:.1f}% off, was {last_price:,.2f})\n"
            f"🕐 {now}\n"
            f'<a href="{url}">View on Amazon.eg</a>'
        )

        updates[product_id] = price

    prices.update(updates)
    save_prices(prices)


if __name__ == "__main__":
    main()
    
