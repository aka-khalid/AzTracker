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
TELEGRAM_TOKEN     = os.environ.get("TELEGRAM_BOT_TOKEN", "")
ALLOWED_USERS      = os.environ.get("TELEGRAM_ROOT_ADMIN_IDS", "")
AMAZON_ACCESS_KEY  = os.environ.get("AMZN_CREATORS_ACCESS_KEY", "")
AMAZON_SECRET_KEY  = os.environ.get("AMZN_CREATORS_SECRET_KEY", "")
AMAZON_PARTNER_TAG = os.environ.get("AMZN_ASSOCIATES_TAG", "")
AMAZON_API_VERSION = os.environ.get("AMZN_API_VERSION", "")
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
    GetItemsResource.OFFERS_V2_DOT_LISTINGS_DOT_MERCHANT_INFO,
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
        res = requests.post(url, json=payload, timeout=10)
        return res.status_code == 200
    except Exception as e:
        print(f"Telegram error: {e}")
        return False

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
                except Exception as e:
                    print(f"    ⚠️ [ASIN: {asin}] Name Parse Error: {repr(e)}")

                price = None
                seller = "Unknown"
                try:
                    listing = item.offers_v2.listings[0]
                    price = listing.price.money.amount
                    
                    if getattr(listing, 'merchant_info', None) and getattr(listing.merchant_info, 'name', None):
                        seller = listing.merchant_info.name
                        
                except (AttributeError, IndexError, TypeError):
                    # Silently catch items that are Out of Stock or missing a Buy Box
                    pass 
                except Exception as e:
                    print(f"    🚨 [ASIN: {asin}] Unexpected PRICE ERROR: {repr(e)}")

                if name and price:
                    # Notice we are now returning a tuple of 3 items
                    batch_results[asin] = (name, float(price), seller)
                    print(f"    ✅ Parsed: {name[:30]}... | {price} EGP | By: {seller}")
                else:
                    print(f"    ❌ Skipping {asin} - Missing data (Name: {bool(name)}, Price: {bool(price)})")

            return batch_results

        except Exception as e:
            print(f"  [Attempt {attempt+1}] API error for batch: {e}")
            # Dynamic backoff: 5s, 10s, 15s
            wait_time = 5 * (attempt + 1)
            print(f"  ⏳ Cooling down for {wait_time} seconds before retrying...")
            time.sleep(wait_time)

    return batch_results


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    CF_ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    CF_NAMESPACE_ID = os.environ.get("CLOUDFLARE_KV_NAMESPACE_ID")
    CF_API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN")
    
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
                    # Use .get() instead of strict ["url"]
                    url = p.get("url")
                    if url:
                        asin = get_product_id(url)
                        if asin:
                            unique_asins.add((asin, url))

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
            time.sleep(3) # Increased throttle to respect Amazon limits

        # 3. Fetch Global Price History from Cloudflare
    gp_res = requests.get(f"{cf_base_url}/values/global_prices", headers=cf_headers)
    global_prices = gp_res.json() if gp_res.status_code == 200 else {}
    updates = {}

    # ── MILESTONE 1: DELTA HISTORY LOGGER ──
    print("📊 Evaluating price deltas for history logs...")
    history_updates = 0
    unix_now = int(time.time())

    for asin, (name, current_price, seller) in all_fetched_results.items():
        current_price = round(current_price, 2)
        
        # Safely extract last price
        last_entry = global_prices.get(asin)
        last_price = None
        if isinstance(last_entry, dict):
            last_price = last_entry.get("price")
        elif isinstance(last_entry, (int, float)):
            last_price = last_entry

        # IF brand new OR price changed -> Log a Delta!
        if last_price is None or current_price != last_price:
            hist_key = f"history:{asin}"
            hist_url = f"{cf_base_url}/values/{hist_key}"
            
            # Fetch existing history array safely
            hist_res = requests.get(hist_url, headers=cf_headers)
            try:
                history_data = hist_res.json() if hist_res.status_code == 200 else []
                # If the database got corrupted into a dict or string, force it back to a list
                if not isinstance(history_data, list):
                    history_data = []
            except Exception:
                history_data = []
            
            # Append new data point (p = price, t = unix timestamp)
            history_data.append({"p": current_price, "t": unix_now})
            
            # Keep array lean (Max 150 entries per ASIN)
            history_data = history_data[-150:]
            
            # Save back to KV
            requests.put(hist_url, headers=cf_headers, json=history_data)
            print(f"    📝 Logged new delta for {asin}: {current_price} EGP")
            history_updates += 1

    if history_updates == 0:
        print("    ➖ No price changes detected. History logs untouched.")
    # ───────────────────────────────────────

    # 4. Evaluate prices & route personalized Telegram notifications
    dirty_users = set()
    for chat_id, products in users_data.items():
        for p in products:
            if p.get("paused", False):
                continue
            
            # Safely grab the URL, skip if corrupted
            url = p.get("url")
            if not url:
                continue

            product_id = get_product_id(url)
            res = all_fetched_results.get(product_id)
            
            if not res:
                continue

            name, price, seller = res
            price = round(price, 2)
            display_name = truncate_name(name)

            # --- AUTO-HEAL: Update the user's personal database if the name is missing/wrong
            if p.get("name") != name:
                p["name"] = name
                dirty_users.add(chat_id)
            # -----------------------------------------------------------------------------

            # 1. Calculate the Last Price
            last_entry = global_prices.get(product_id)
            last_price = None
            if isinstance(last_entry, dict):
                last_price = last_entry.get("price")
            elif isinstance(last_entry, (int, float)):
                last_price = last_entry

            # 2. Always update the price in the master 'updates' list 
            #    (This ensures database stays current)
            updates[product_id] = {"price": price, "name": name, "seller": seller, "last_updated": now}

            # 3. Calculate drop metrics (for the message)
            # Use 0 if there was no last_price to avoid math errors
            diff = (last_price - price) if last_price is not None else 0
            pct  = (diff / last_price * 100) if last_price and last_price > 0 else 0

            target_price = p.get("target_price")

            # Calculate "Down" text only if there is an actual difference
            down_text = f" (Down {diff:,.2f} EGP)" if diff > 0 else ""
            
            # 4. State Management: Reset alert flag if price fluctuates back above target
            if target_price and price > target_price:
                if p.get("alert_sent", False): # Only flag if it actually changes
                    p["alert_sent"] = False
                    dirty_users.add(chat_id)

            # 5. Notification Logic (Mutually Exclusive Routing)
            if target_price:
                # SCENARIO A: Target is set. Suppress all noise until target is crossed.
                if price <= target_price and not p.get("alert_sent", False):
                    success = send_telegram(chat_id,
                        f"🎯 <b>TARGET MET: {display_name}</b>\n"
                        f"💰 <b>{price:,.2f} EGP</b>\n"
                        f"🏬 <b>Sold by:</b> {seller}\n"
                        f"Target was {target_price:,.2f} EGP{down_text}\n"
                        f"🕐 {now}\n"
                        f'<a href="{url}">View on Amazon.eg</a>'
                    )
                    # ONLY flag as sent if Telegram actually delivered it
                    if success:
                        p["alert_sent"] = True
                        dirty_users.add(chat_id)
                        time.sleep(0.5)
            else:
                # SCENARIO B: No target set. Evaluate for general price drops.
                if last_price is not None and price < last_price:
                    send_telegram(chat_id,
                        f"📉 <b>{display_name}</b>\n"
                        f"💰 <b>{price:,.2f} EGP</b>\n"
                        f"🏬 <b>Sold by:</b> {seller}\n"
                        f"Down {diff:,.2f} EGP ({pct:.1f}% off, was {last_price:,.2f})\n"
                        f"🕐 {now}\n"
                        f'<a href="{url}">View on Amazon.eg</a>'
                    )
                    time.sleep(0.5)

    # 5. Push updated master price list back to Cloudflare ONLY if there are updates
    if updates:
        global_prices.update(updates)
        requests.put(f"{cf_base_url}/values/global_prices", headers=cf_headers, json=global_prices)
        print("\n✅ Global database synced to Cloudflare KV.")
    else:
        print("\n➖ Global database unchanged. Skipping KV write.")

    # 6. Persist user product changes ONLY for users whose state changed (Dirty tracking)
    if dirty_users:
        print(f"💾 Syncing {len(dirty_users)} updated user states to Cloudflare...")
        for chat_id in dirty_users:
            requests.put(f"{cf_base_url}/values/user:{chat_id}:products", 
                         headers=cf_headers, 
                         json=users_data[chat_id])
        print("✅ Dirty user states saved.")
    else:
        print("➖ No user states modified. Skipping KV writes.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Catch ANY unhandled exception and send the traceback to the Admin
        error_trace = traceback.format_exc()
        print("FATAL ERROR:")
        print(error_trace)
        notify_admins_of_error(str(e) + "\n\n" + error_trace)
