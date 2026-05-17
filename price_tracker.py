"""
Amazon.eg Price Tracker (Batched Version)
Uses the Amazon Creators API for real prices — no scraping, no honeypots.
Sends a Telegram notification immediately when a price drop is detected.
Optimized for batch requests (up to 10 products per API call) to prevent rate limiting.
"""

import os
import json
import time
import requests
from datetime import datetime
import pytz
from amazon_creatorsapi import AmazonCreatorsApi, Country
from amazon_creatorsapi.models import GetItemsResource

# ── Config (from GitHub Secrets) ─────────────────────────────────────────────
TELEGRAM_TOKEN     = os.environ["TELEGRAM_TOKEN"]
TELEGRAM_CHAT_ID   = os.environ["TELEGRAM_CHAT_ID"]
AMAZON_ACCESS_KEY  = os.environ["AMAZON_ACCESS_KEY"]
AMAZON_SECRET_KEY  = os.environ["AMAZON_SECRET_KEY"]
AMAZON_PARTNER_TAG = os.environ["AMAZON_PARTNER_TAG"]
AMAZON_API_VERSION = os.environ["AMAZON_API_VERSION"]
# ─────────────────────────────────────────────────────────────────────────────

PRICES_FILE  = "prices.json"
MAX_NAME_LEN = 60

api = AmazonCreatorsApi(
    credential_id=AMAZON_ACCESS_KEY,
    credential_secret=AMAZON_SECRET_KEY,
    version=AMAZON_API_VERSION,
    tag=AMAZON_PARTNER_TAG,
    country=Country.EG,
)

RESOURCES = [
    GetItemsResource.ITEM_INFO_DOT_TITLE,
    GetItemsResource.OFFERS_V2_DOT_LISTINGS_DOT_PRICE,
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


# ── Amazon Creators API Batch Fetch ───────────────────────────────────────────

def fetch_batch(asin_list, retries=3):
    """Fetches a batch of up to 10 ASINs in a single API call.
    Returns a dict mapping {asin: (name, price)}."""
    batch_results = {}
    for attempt in range(retries):
        try:
            items = api.get_items(asin_list, resources=RESOURCES)
            if not items:
                print(f"  [Attempt {attempt+1}] No items returned for this batch.")
                continue

            for item in items:
                asin = getattr(item, 'asin', None)
                if not asin:
                    continue

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
                    batch_results[asin] = (name, float(price))

            # If the API call succeeded, return what we found (even if partial)
            return batch_results

        except Exception as e:
            print(f"  [Attempt {attempt+1}] API error for batch: {e}")
            time.sleep(2 * (attempt + 1))  # Waits 2s on attempt 1, 4s on attempt 2, etc.

    return batch_results


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


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    with open("products.json") as f:
        products = json.load(f)

    prices = load_prices()
    cairo_tz = pytz.timezone('Africa/Cairo')
    now = datetime.now(cairo_tz).strftime("%Y-%m-%d %H:%M %Z")
    updates = {}

    # 1. Filter out paused products and map tracking info
    active_products = []
    for p in products:
        url = p["url"]
        paused = p.get("paused", False)
        product_id = get_product_id(url)

        if paused:
            print(f"⏸ Skipping (paused): {url}")
            continue

        active_products.append({"asin": product_id, "url": url})

    if not active_products:
        print("No active products to track.")
        return

    # 2. Divide active products into batches of up to 10 ASINs
    BATCH_SIZE = 10
    batches = [active_products[i:i + BATCH_SIZE] for i in range(0, len(active_products), BATCH_SIZE)]
    
    all_fetched_results = {}
    print(f"📋 Found {len(active_products)} active products. Splitting into {len(batches)} batches.")

    # 3. Fetch each batch sequentially with a polite delay to prevent throttling
    for idx, batch in enumerate(batches):
        print(f"\n🚀 Fetching batch {idx+1}/{len(batches)} ({len(batch)} items)...")
        asin_list = [p["asin"] for p in batch]
        
        results = fetch_batch(asin_list)
        all_fetched_results.update(results)
        
        # Anti-throttling delay between API calls (Amazon allows 1 request per second)
        if idx < len(batches) - 1:
            time.sleep(1)

    # 4. Evaluate prices and send alerts
    for p in active_products:
        product_id = p["asin"]
        url = p["url"]

        res = all_fetched_results.get(product_id)
        if res is None:
            print(f"\n  ❌ Could not fetch {url}")
            send_telegram(
                f"⚠️ <b>{url}</b>\n"
                f"Could not fetch price at {now}.\n"
                f'<a href="{url}">View on Amazon.eg</a>'
            )
            time.sleep(1) # Protect Telegram API limits
            continue

        name, price = res
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
        
        # Anti-flooding delay to prevent spamming the Telegram API on massive drops
        time.sleep(1)

        updates[product_id] = price

    prices.update(updates)
    save_prices(prices)


if __name__ == "__main__":
    main()
