"""
AzTracker Amazon.eg Price Tracker Engine
Uses the Amazon Creators API for real prices — no scraping, no honeypots.
Sends a Telegram notification immediately when a price drop is detected.
Optimized for batch requests (up to 10 products per API call) to prevent rate limiting.
"""

import os
import time
import requests
import traceback
from datetime import datetime
import pytz
from amazon_creatorsapi import AmazonCreatorsApi, Country
from amazon_creatorsapi.models import GetItemsResource

# ── Config (from GitHub Secrets) ─────────────────────────────────────────────
TELEGRAM_TOKEN     = os.environ.get("TELEGRAM_TOKEN", "")
ALLOWED_USERS      = os.environ.get("ALLOWED_USERS", "")
AMAZON_ACCESS_KEY  = os.environ.get("AMAZON_ACCESS_KEY", "")
AMAZON_SECRET_KEY  = os.environ.get("AMAZON_SECRET_KEY", "")
AMAZON_PARTNER_TAG = os.environ.get("AMAZON_PARTNER_TAG", "")
AMAZON_API_VERSION = os.environ.get("AMAZON_API_VERSION", "")
# ─────────────────────────────────────────────────────────────────────────────

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

# ── Core Helpers ──────────────────────────────────────────────────────────────

def get_product_id(url):
    return url.rstrip("/").split("/")[-1]


def truncate_name(name: str) -> str:
    return name[:MAX_NAME_LEN] + "..." if len(name) > MAX_NAME_LEN else name


# ── Telegram ──────────────────────────────────────────────────────────────────

def send_telegram(chat_id, text):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True
    }
    try:
        requests.post(url, json=payload)
    except Exception as e:
        print(f"Telegram error: {e}")

def notify_admins_of_error(error_message):
    """Sends a fatal error alert to all Root Admins."""
    if not ALLOWED_USERS:
        return
    
    admin_ids = [uid.strip() for uid in ALLOWED_USERS.split(",") if uid.strip()]
    for admin_id in admin_ids:
        # Truncate error message if it exceeds Telegram's 4096 char limit
        safe_msg = error_message[:4000]
        alert_text = f"🚨 <b>AzTracker Engine Crash</b>\n\nThe background workflow encountered a fatal error:\n\n<pre>{safe_msg}</pre>"
        send_telegram(admin_id, alert_text)


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

            return batch_results

        except Exception as e:
            print(f"  [Attempt {attempt+1}] API error for batch: {e}")
            time.sleep(2 * (attempt + 1))

    return batch_results


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID")
    CF_NAMESPACE_ID = os.environ.get("CF_NAMESPACE_ID")
    CF_API_TOKEN = os.environ.get("CF_API_TOKEN")
    
    if not all([CF_ACCOUNT_ID, CF_NAMESPACE_ID, CF_API_TOKEN]):
        err_msg = "❌ Missing Cloudflare API credentials. Cannot sync database."
        print(err_msg)
        notify_admins_of_error(err_msg)
        return

    cf_headers = {"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"}
    cf_base_url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{CF_NAMESPACE_ID}"

    cairo_tz = pytz.timezone('Africa/Cairo')
    now = datetime.now(cairo_tz).strftime("%Y-%m-%d %H:%M %Z")

    # 1. Fetch all multi-tenant users from Cloudflare KV
    print("🔍 Fetching multi-tenant data from Cloudflare KV...")
    keys_res = requests.get(f"{cf_base_url}/keys?prefix=user:", headers=cf_headers)
    if keys_res.status_code != 200:
        err_msg = f"❌ Failed to connect to KV. HTTP {keys_res.status_code}: {keys_res.text}"
        print(err_msg)
        notify_admins_of_error(err_msg)
        return
        
    user_keys = keys_res.json().get("result", [])
    users_data = {}
    unique_asins = set()

    for k in user_keys:
        key_name = k["name"]
        chat_id = key_name.split(":")[1]
        
        val_res = requests.get(f"{cf_base_url}/values/{key_name}", headers=cf_headers)
        if val_res.status_code == 200:
            products = val_res.json()
            users_data[chat_id] = products
            for p in products:
                if not p.get("paused", False):
                    asin = get_product_id(p["url"])
                    if asin:
                        unique_asins.add((asin, p["url"]))

    if not unique_asins:
        print("No active products to track across any users.")
        return

    active_products = [{"asin": a[0], "url": a[1]} for a in unique_asins]

    # 2. Batch and Fetch
    BATCH_SIZE = 10
    batches = [active_products[i:i + BATCH_SIZE] for i in range(0, len(active_products), BATCH_SIZE)]
    all_fetched_results = {}
    print(f"📋 Found {len(active_products)} unique items across {len(users_data)} users.")

    for idx, batch in enumerate(batches):
        print(f"\n🚀 Fetching batch {idx+1}/{len(batches)}...")
        asin_list = [p["asin"] for p in batch]
        results = fetch_batch(asin_list)
        all_fetched_results.update(results)
        if idx < len(batches) - 1:
            time.sleep(1)

    # 3. Fetch Global Price History from Cloudflare
    gp_res = requests.get(f"{cf_base_url}/values/global_prices", headers=cf_headers)
    global_prices = gp_res.json() if gp_res.status_code == 200 else {}
    updates = {}

    # 4. Evaluate prices & route personalized Telegram notifications
    for chat_id, products in users_data.items():
        for p in products:
            if p.get("paused", False):
                continue

            product_id = get_product_id(p["url"])
            url = p["url"]
            res = all_fetched_results.get(product_id)
            
            if not res:
                continue

            name, price = res
            price = round(price, 2)
            display_name = truncate_name(name)

            last_entry = global_prices.get(product_id)
            last_price = None
            if isinstance(last_entry, dict):
                last_price = last_entry.get("price")
            elif isinstance(last_entry, (int, float)):
                last_price = last_entry

            if last_price is None or price >= last_price:
                updates[product_id] = {"price": price, "name": name}
                continue

            # IT'S A PRICE DROP! Notify THIS specific user
            diff = last_price - price
            pct  = (diff / last_price) * 100
            
            target_price = p.get("target_price")

            if target_price:
                if price <= target_price:
                    send_telegram(chat_id,
                        f"🎯 <b>TARGET MET: {display_name}</b>\n"
                        f"💰 <b>{price:,.2f} EGP</b>\n"
                        f"Target was {target_price:,.2f} EGP (Down {diff:,.2f} EGP)\n"
                        f"🕐 {now}\n"
                        f'<a href="{url}">View on Amazon.eg</a>'
                    )
                    time.sleep(0.5)
            else:
                send_telegram(chat_id,
                    f"📉 <b>{display_name}</b>\n"
                    f"💰 <b>{price:,.2f} EGP</b>\n"
                    f"Down {diff:,.2f} EGP ({pct:.1f}% off, was {last_price:,.2f})\n"
                    f"🕐 {now}\n"
                    f'<a href="{url}">View on Amazon.eg</a>'
                )
                time.sleep(0.5)

    # 5. Push updated master price list back to Cloudflare
    global_prices.update(updates)
    requests.put(f"{cf_base_url}/values/global_prices", headers=cf_headers, json=global_prices)
    print("\n✅ Global database synced to Cloudflare KV.")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Catch ANY unhandled exception and send the traceback to the Admin
        error_trace = traceback.format_exc()
        print("FATAL ERROR:")
        print(error_trace)
        notify_admins_of_error(str(e) + "\n\n" + error_trace)
