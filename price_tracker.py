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
import re
import asyncio
import aiohttp
import html
from datetime import datetime
import pytz
from amazon_creatorsapi import AmazonCreatorsApi, Country
from amazon_creatorsapi.models import GetItemsResource, Condition

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
    if not url:
        return None
    # Matches /dp/B0...
    dp_match = re.search(r'/dp/([A-Z0-9]{10})', url, re.IGNORECASE)
    if dp_match:
        return dp_match.group(1).upper()
    # Matches /gp/product/B0...
    gp_match = re.search(r'/gp/product/([A-Z0-9]{10})', url, re.IGNORECASE)
    if gp_match:
        return gp_match.group(1).upper()
    return None

def truncate_name(name: str) -> str:
    return name[:MAX_NAME_LEN] + "..." if len(name) > MAX_NAME_LEN else name

# ── Async Cloudflare KV Helpers ──────────────────────────────────────────────

class KVRateLimitedError(Exception):
    pass

async def async_get_kv(session, url, headers):
    async with session.get(url, headers=headers) as response:
        if response.status == 200:
            return await response.json(content_type=None)
        elif response.status == 429:
            raise KVRateLimitedError(f"KV rate limited on GET {url}")
        return None

async def notify_admins_of_error(session, error_message):
    """Sends a fatal error alert to all Root Admins (non-blocking)."""
    if not ALLOWED_USERS:
        return
    admin_ids = [uid.strip() for uid in ALLOWED_USERS.split(",") if uid.strip()]
    safe_msg = html.escape(error_message[:4000])
    alert_text = f"🚨 <b>AzTracker Engine Crash</b>\n\nThe background workflow encountered a fatal error:\n\n<pre>{safe_msg}</pre>"
    tasks = [async_send_telegram(session, admin_id, alert_text) for admin_id in admin_ids]
    await asyncio.gather(*tasks)

def send_telegram_sync_fallback(error_message):
    """Synchronous fallback solely for the outer __main__ exception handler."""
    if not ALLOWED_USERS:
        return
    admin_ids = [uid.strip() for uid in ALLOWED_USERS.split(",") if uid.strip()]
    safe_msg = html.escape(error_message[:4000])
    alert_text = f"🚨 <b>AzTracker Engine Crash (Fatal)</b>\n\n<pre>{safe_msg}</pre>"
    for admin_id in admin_ids:
        send_telegram(admin_id, alert_text)

async def async_put_kv(session, url, headers, payload):
    async with session.put(url, headers=headers, json=payload) as response:
        return response.status == 200

# ── Telegram ──────────────────────────────────────────────────────────────────

def send_telegram(chat_id, text, reply_markup=None):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
        
    try:
        res = requests.post(url, json=payload, timeout=10)
        return res.status_code == 200
    except Exception as e:
        print(f"Telegram error: {e}")
        return False

async def async_send_telegram(session, chat_id, text, reply_markup=None, max_retries=3):
    """Async variant with native 429 Too Many Requests backoff handling."""
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
        
    for attempt in range(max_retries):
        try:
            async with session.post(url, json=payload, timeout=10) as response:
                if response.status == 200:
                    return True
                elif response.status == 429:
                    # Telegram Rate Limit Hit: Read the required wait time
                    resp_json = await response.json()
                    wait_time = resp_json.get("parameters", {}).get("retry_after", 3)
                    print(f"⚠️ Telegram 429 Limit Hit. Pausing alert for {wait_time}s...")
                    await asyncio.sleep(wait_time)
                    continue # Retry the loop
                else:
                    print(f"Telegram async error: HTTP {response.status}")
                    return False
        except Exception as e:
            print(f"Telegram async exception: {e}")
            return False
            
    return False # Failed after max_retries

# ── Amazon Creators API Batch Fetch ───────────────────────────────────────────

def fetch_batch(asin_list, retries=3):
    """Fetches a batch of up to 10 ASINs in a single API call."""
    batch_results = {}
    for attempt in range(retries):
        try:
            items = api.get_items(asin_list, resources=RESOURCES, condition=Condition.ANY)
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
                merchant_id = None

                try:
                    listing = item.offers_v2.listings[0]
                    price = listing.price.money.amount
                    
                    if getattr(listing, 'merchant_info', None):
                        if getattr(listing.merchant_info, 'name', None):
                            seller = listing.merchant_info.name
                        if getattr(listing.merchant_info, 'id', None):
                            merchant_id = listing.merchant_info.id
                        
                except (AttributeError, IndexError, TypeError) as e:
                    print(f"    ⚠️ [ASIN: {asin}] Price Parse Silent Fail: {repr(e)}")
                except Exception as e:
                    print(f"    🚨 [ASIN: {asin}] Unexpected PRICE ERROR: {repr(e)}")

                if name and price:
                    batch_results[asin] = (name, float(price), seller, merchant_id)
                    print(f"    ✅ Parsed: {name[:30]}... | {price} EGP | By: {seller}")
                else:
                    print(f"    ❌ Skipping {asin} - Missing data")

            return batch_results

        except Exception as e:
            print(f"  [Attempt {attempt+1}] API error for batch: {e}")
            wait_time = 5 * (attempt + 1)
            print(f"  ⏳ Cooling down for {wait_time} seconds before retrying...")
            time.sleep(wait_time)

    return batch_results

# ── Main Async Engine ────────────────────────────────────────────────────────

async def async_main():
    CF_ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    CF_NAMESPACE_ID = os.environ.get("CLOUDFLARE_KV_NAMESPACE_ID")
    CF_API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN")
    
    if not all([CF_ACCOUNT_ID, CF_NAMESPACE_ID, CF_API_TOKEN]):
        err_msg = "❌ Missing Cloudflare API credentials. Cannot sync database."
        print(err_msg)
        async with aiohttp.ClientSession() as err_session:
            await notify_admins_of_error(err_session, err_msg)
        return

    cf_headers = {"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"}
    cf_base_url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{CF_NAMESPACE_ID}"

    cairo_tz = pytz.timezone('Africa/Cairo')
    now = datetime.now(cairo_tz).strftime("%Y-%m-%d %H:%M %Z")
    unix_now_ms = int(time.time() * 1000)

    async with aiohttp.ClientSession() as session:
        # 1. Fetch multi-tenant directory (Keys)
        print("🔍 Fetching multi-tenant data concurrently from Cloudflare KV...")
        keys_res = await async_get_kv(session, f"{cf_base_url}/keys?prefix=user:", cf_headers)
        if not keys_res:
            err_msg = "❌ Failed to fetch user keys from KV."
            print(err_msg)
            await notify_admins_of_error(err_msg)
            return
            
        user_keys = keys_res.get("result", [])
        users_data = {}
        unique_asins = set()

        # CONCURRENT FETCH: Pull all users at the same time
        fetch_tasks = [async_get_kv(session, f"{cf_base_url}/values/{k['name']}", cf_headers) for k in user_keys]
        fetched_results = await asyncio.gather(*fetch_tasks)

        for k, products in zip(user_keys, fetched_results):
            if products:
                chat_id = k["name"].split(":")[1]
                users_data[chat_id] = products
                for p in products:
                    if not p.get("paused", False):
                        url = p.get("url")
                        if url:
                            asin = get_product_id(url)
                            if asin:
                                unique_asins.add(asin) # ⬅️ ONLY add the ASIN

        if not unique_asins:
            print("No active products to track across any users.")
            return

        active_products = [{"asin": a} for a in unique_asins] # ⬅️ ONLY pass the ASIN

        # 2. Batch and Fetch (Synchronous API calls to Amazon)
        BATCH_SIZE = 10
        batches = [active_products[i:i + BATCH_SIZE] for i in range(0, len(active_products), BATCH_SIZE)]
        all_fetched_results = {}
        print(f"📋 Found {len(active_products)} unique items across {len(users_data)} users.")

        for idx, batch in enumerate(batches):
            print(f"\n🚀 Fetching batch {idx+1}/{len(batches)}...")
            asin_list = [p["asin"] for p in batch]
            
            # Offload the synchronous SDK and time.sleep() calls to a background thread
            results = await asyncio.to_thread(fetch_batch, asin_list)
            
            all_fetched_results.update(results)
            if idx < len(batches) - 1:
                await asyncio.sleep(3)

        # 3. Fetch Price History (Native Sharded Fetch)
        global_prices = {}
        
        print("📦 Fetching individual price shards concurrently...")
        price_tasks = [async_get_kv(session, f"{cf_base_url}/values/price:{asin}", cf_headers) for asin in all_fetched_results.keys()]
        
        try:
            price_results = await asyncio.gather(*price_tasks)
        except KVRateLimitedError as e:
            err_msg = f"🚨 KV Rate Limit hit during price shard fetch. Aborting run to prevent write storm.\n{e}"
            print(err_msg)
            await notify_admins_of_error(session, err_msg)
            return
            
        for asin, price_data in zip(all_fetched_results.keys(), price_results):
            if price_data:
                global_prices[asin] = price_data

        updates = {}

        # ── DELTA HISTORY LOGGER ──
        print("📊 Evaluating price deltas for history logs...")
        history_updates = 0
        unix_now = int(time.time())
        history_tasks = []

        for asin, (name, current_price, seller, merchant_id) in all_fetched_results.items():
            current_price = round(current_price, 2)
            
            last_entry = global_prices.get(asin)
            last_price = None
            if isinstance(last_entry, dict):
                last_price = last_entry.get("price")
            elif isinstance(last_entry, (int, float)):
                last_price = last_entry

            if last_price is None or current_price != last_price:
                # We fetch history synchronously for safety before mutating, but write async
                hist_url = f"{cf_base_url}/values/history:{asin}"
                history_data = await async_get_kv(session, hist_url, cf_headers) or []
                if not isinstance(history_data, list):
                    history_data = []
                
                history_data.append({"p": current_price, "t": unix_now})
                history_data = history_data[-150:]
                
                # Queue the concurrent write
                history_tasks.append(async_put_kv(session, hist_url, cf_headers, history_data))
                print(f"    📝 Queued delta log for {asin}: {current_price} EGP")
                history_updates += 1

        if history_tasks:
            await asyncio.gather(*history_tasks)
            print(f"    ✅ Logged {history_updates} price deltas concurrently.")
        else:
            print("    ➖ No price changes detected. History logs untouched.")

        # 4. Evaluate prices & route personalized Telegram notifications
        dirty_users = set()
        outbox = [] # ⬅️ Initialize the safe holding queue

        for chat_id, products in users_data.items():
            for p in products:
                if p.get("paused", False):
                    continue
                
                url = p.get("url")
                if not url:
                    continue

                product_id = get_product_id(url)
                res = all_fetched_results.get(product_id)
                if not res:
                    continue

                name, price, seller, merchant_id = res
                price = round(price, 2)
                display_name = truncate_name(name)
                
                # --- UNIVERSAL URL GENERATOR ---
                base_url = f"https://www.amazon.eg/dp/{product_id}"
                query_params = []
                if merchant_id:
                    query_params.append(f"m={merchant_id}")
                if AMAZON_PARTNER_TAG:
                    query_params.append(f"tag={AMAZON_PARTNER_TAG}")
                    
                alert_url = f"{base_url}?{'&'.join(query_params)}" if query_params else base_url
                
                # The Native Telegram Button Mask
                button_markup = {
                    "inline_keyboard": [
                        [{"text": "🛒 Open in Amazon.eg", "url": alert_url}]
                    ]
                }
                # --------------------------------

                if p.get("name") != name:
                    p["name"] = name
                    dirty_users.add(chat_id)

                last_entry = global_prices.get(product_id)
                last_price = None
                last_name = None
                last_seller = None
                
                if isinstance(last_entry, dict):
                    last_price = last_entry.get("price")
                    last_name = last_entry.get("name")
                    last_seller = last_entry.get("seller")
                elif isinstance(last_entry, (int, float)):
                    last_price = last_entry

                if last_price != price or last_name != name or last_seller != seller:
                    updates[product_id] = {
                        "price": price, 
                        "name": name, 
                        "seller": seller, 
                        "merchant_id": merchant_id, 
                        "last_updated": unix_now_ms
                    }

                diff = (last_price - price) if last_price is not None else 0
                pct  = (diff / last_price * 100) if last_price and last_price > 0 else 0
                target_price = p.get("target_price")
                down_text = f" (Down {diff:,.2f} EGP)" if diff > 0 else ""
                
                if target_price and price > target_price:
                    if p.get("alert_sent", False): 
                        p["alert_sent"] = False
                        dirty_users.add(chat_id)

                if target_price:
                    if price <= target_price and not p.get("alert_sent", False):
                        safe_name = html.escape(display_name)
                        safe_seller = html.escape(seller)
                        
                        # ⬅️ QUEUE INSTEAD OF SENDING
                        msg_text = (
                            f"🎯 <b>TARGET MET!</b>\n\n"
                            f"📦 <b>{safe_name}</b>\n"
                            f"└ 🆔 <code>{product_id}</code>\n\n"
                            f"💰 <b>Current Price:</b> {price:,.2f} EGP\n"
                            f"📉 <b>Target:</b> {target_price:,.2f} EGP{down_text}\n"
                            f"🏬 <b>Seller:</b> <i>{safe_seller}</i>\n"
                            f"🕐 <i>{now}</i>"
                        )
                        outbox.append({"chat_id": chat_id, "text": msg_text, "markup": button_markup})
                        p["alert_sent"] = True
                        dirty_users.add(chat_id)
                else:
                    if last_price is not None and price < last_price:
                        safe_name = html.escape(display_name)
                        safe_seller = html.escape(seller)
                        
                        # ⬅️ QUEUE INSTEAD OF SENDING
                        msg_text = (
                            f"🚨 <b>PRICE DROP ALERT</b>\n\n"
                            f"📦 <b>{safe_name}</b>\n"
                            f"└ 🆔 <code>{product_id}</code>\n\n"
                            f"💰 <b>New Price:</b> {price:,.2f} EGP\n"
                            f"📉 <b>Dropped:</b> {diff:,.2f} EGP ({pct:.1f}% off)\n"
                            f"🏷️ <b>Was:</b> {last_price:,.2f} EGP\n"
                            f"🏬 <b>Seller:</b> <i>{safe_seller}</i>\n"
                            f"🕐 <i>{now}</i>"
                        )
                        outbox.append({"chat_id": chat_id, "text": msg_text, "markup": button_markup})

        # 5. Push System Stats, Price Shards, and Dirty Users Concurrently
        final_tasks = []

        if updates:
            for asin, data in updates.items():
                final_tasks.append(async_put_kv(session, f"{cf_base_url}/values/price:{asin}", cf_headers, data))
            print(f"\n✅ Queued {len(updates)} individual price shards for sync.")
        else:
            print("\n➖ No prices changed. Skipping DB writes.")

        if dirty_users:
            print(f"💾 Queued {len(dirty_users)} dirty user states for sync.")
            for chat_id in dirty_users:
                final_tasks.append(async_put_kv(session, f"{cf_base_url}/values/user:{chat_id}:products", cf_headers, users_data[chat_id]))

        # Calculate accurate Hivemind size by counting sharded keys
        prices_keys_res = await async_get_kv(session, f"{cf_base_url}/keys?prefix=price:", cf_headers)
        hivemind_size = len(prices_keys_res.get("result", [])) if prices_keys_res else 0
        system_stats = {
            "active_api_calls": len(unique_asins),
            "hivemind_size": hivemind_size,
            "last_run_timestamp": unix_now_ms
        }
        final_tasks.append(async_put_kv(session, f"{cf_base_url}/values/global:stats", cf_headers, system_stats))
        print(f"📊 Queued System stats update: {system_stats}")

        # 6. The Two-Phase Commit Execution (Outbox Pattern)
        if final_tasks:
            write_results = await asyncio.gather(*final_tasks)
            
            # If ANY write failed (e.g., False due to Quota Limit), we abort the Telegram outbox
            if all(write_results):
                print("🚀 Executed all queued database writes concurrently!")
                
                # Release the Outbox!
                if outbox:
                    print(f"📨 Dispatching {len(outbox)} Telegram alerts from Outbox...")
                    for alert in outbox:
                        await async_send_telegram(session, alert["chat_id"], alert["text"], alert["markup"])
                        await asyncio.sleep(0.5) # Anti-flood pacing
            else:
                err_msg = "❌ CRITICAL: One or more KV Writes failed (Quota Exceeded?). Telegram Outbox aborted to prevent spam loops."
                print(err_msg)
                await notify_admins_of_error(err_msg)


if __name__ == "__main__":
    try:
        asyncio.run(async_main())
    except Exception as e:
        error_trace = traceback.format_exc()
        print("FATAL ERROR:")
        print(error_trace)
        send_telegram_sync_fallback(str(e) + "\n\n" + error_trace)
