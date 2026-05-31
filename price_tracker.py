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
import json
from datetime import datetime
from urllib.parse import urlencode
from zoneinfo import ZoneInfo
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
AMAZON_EG_MERCHANT_ID = os.environ.get("AMZN_EG_MERCHANT_ID", "A1ZVRGNO5AYLOV")
AMAZON_RESALE_MERCHANT_ID = os.environ.get("AMZN_RESALE_MERCHANT_ID", "A2N2MP47XAP1MK")

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
    GetItemsResource.OFFERS_V2_DOT_LISTINGS_DOT_CONDITION
]

# ── Core Helpers ──────────────────────────────────────────────────────────────

def get_product_id(url):
    if not url:
        return None
    dp_match = re.search(r'/dp/([A-Z0-9]{10})', url, re.IGNORECASE)
    if dp_match: return dp_match.group(1).upper()
    gp_match = re.search(r'/gp/product/([A-Z0-9]{10})', url, re.IGNORECASE)
    if gp_match: return gp_match.group(1).upper()
    return None

def truncate_name(name: str) -> str:
    return name[:MAX_NAME_LEN] + "..." if len(name) > MAX_NAME_LEN else name

def normalize_offer_label(value) -> str:
    if not value:
        return ""
    label = str(value).strip().lower()
    if "." in label:
        label = label.rsplit(".", 1)[-1]
    return label.replace("_", " ")

def is_used_like_offer(condition_value: str, subcondition_value: str, seller_name: str = "") -> bool:
    condition_tokens = ("used", "refurbished", "renewed", "collectible")
    subcondition_tokens = ("likenew", "like new", "verygood", "very good", "good", "acceptable", "open box", "openbox", "refurbished", "oem")
    seller_tokens = ("resale", "warehouse", "renewed")
    seller_value = normalize_offer_label(seller_name)
    return (
        any(token in condition_value for token in condition_tokens) or
        any(token in subcondition_value for token in subcondition_tokens) or
        any(token in seller_value for token in seller_tokens)
    )

def is_amazon_eg_merchant(merchant_id: str) -> bool:
    return bool(merchant_id and merchant_id == AMAZON_EG_MERCHANT_ID)

def is_amazon_resale_merchant(merchant_id: str, seller_name: str = "") -> bool:
    seller_value = normalize_offer_label(seller_name)
    return (
        merchant_id == AMAZON_RESALE_MERCHANT_ID or
        "resale" in seller_value
    )

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

async def async_delete_kv(session, url, headers):
    async with session.delete(url, headers=headers) as response:
        return response.status == 200

async def notify_admins_of_error(session, error_message):
    if not ALLOWED_USERS: return
    admin_ids = [uid.strip() for uid in ALLOWED_USERS.split(",") if uid.strip()]
    safe_msg = html.escape(error_message[:4000])
    alert_text = f"🚨 <b>AzTracker Engine Crash</b>\n\nThe background workflow encountered a fatal error:\n\n<pre>{safe_msg}</pre>"
    tasks = [async_send_telegram(session, admin_id, alert_text) for admin_id in admin_ids]
    await asyncio.gather(*tasks)

def send_telegram_sync_fallback(error_message):
    if not ALLOWED_USERS: return
    admin_ids = [uid.strip() for uid in ALLOWED_USERS.split(",") if uid.strip()]
    safe_msg = html.escape(error_message[:4000])
    alert_text = f"🚨 <b>AzTracker Engine Crash (Fatal)</b>\n\n<pre>{safe_msg}</pre>"
    for admin_id in admin_ids:
        send_telegram(admin_id, alert_text)

async def async_put_kv(session, url, headers, payload):
    async with session.put(url, headers=headers, json=payload) as response:
        return response.status == 200

async def async_put_kv_bulk(session, cf_base_url, headers, payload):
    """Executes a native Cloudflare KV Bulk write operation."""
    if not payload: return True
    url = f"{cf_base_url}/bulk"
    async with session.put(url, headers=headers, json=payload) as response:
        if response.status != 200:
            err_text = await response.text()
            print(f"KV Bulk Write Error: {err_text}")
        return response.status == 200

# ── Telegram ──────────────────────────────────────────────────────────────────

def send_telegram(chat_id, text, reply_markup=None):
    import json, urllib.request
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status == 200
    except Exception as e:
        print(f"Telegram sync fallback error: {e}")
        return False

async def async_send_telegram(session, chat_id, text, reply_markup=None, max_retries=3):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
    if reply_markup: payload["reply_markup"] = reply_markup
        
    for attempt in range(max_retries):
        try:
            tg_timeout = aiohttp.ClientTimeout(total=15)
            async with session.post(url, json=payload, timeout=tg_timeout) as response:
                if response.status == 200: 
                    return True, 200
                elif response.status == 429:
                    resp_json = await response.json()
                    wait_time = resp_json.get("parameters", {}).get("retry_after", 3)
                    await asyncio.sleep(wait_time)
                    continue 
                else: 
                    return False, response.status
        except Exception as e:
            return False, 0
    return False, 0

# ── Amazon Creators API Batch Fetch ───────────────────────────────────────────

def fetch_batch(asin_list, retries=3):
    """Fetches a batch of ASINs and extracts New/Used split states."""
    batch_results = {}
    for attempt in range(retries):
        try:
            items = api.get_items(asin_list, resources=RESOURCES, condition=Condition.ANY)
            if not items:
                print(f"  [Attempt {attempt+1}] No items returned for this batch.")
                continue

            for item in items:
                asin = getattr(item, 'asin', None)
                if not asin: continue

                name = None
                try: name = item.item_info.title.display_value
                except: pass

                all_listings = getattr(item.offers_v2, 'listings', [])
                print(f"      [DEBUG] {asin} | Total listings returned: {len(all_listings)}")

                new_listings = []
                used_listings = []

                for lst in all_listings:
                    try:
                        p_val = round(float(lst.price.money.amount), 2)
                        s_name = "Unknown"
                        m_id = None
                        m_info = getattr(lst, 'merchant_info', None)
                        if m_info:
                            if getattr(m_info, 'name', None): s_name = m_info.name
                            if getattr(m_info, 'id', None): m_id = m_info.id
                        c_info = getattr(lst, 'condition', None)
                        condition_value = normalize_offer_label(getattr(c_info, 'value', None) if c_info else None)
                        subcondition_value = normalize_offer_label(
                            (getattr(c_info, 'subcondition', None) or getattr(c_info, 'sub_condition', None)) if c_info else None
                        )
                        is_winner = getattr(lst, 'is_buy_box_winner', False)
                        offer = {
                            "price": p_val,
                            "seller": s_name,
                            "mid": m_id,
                            "condition": condition_value or "unknown",
                            "subcondition": subcondition_value or "unknown",
                            "is_buybox": bool(is_winner)
                        }
                        print(f"      [OFFER] {asin} | {offer['condition']}/{offer['subcondition']} | {p_val} | {s_name} | {m_id or '-'} | BB={bool(is_winner)}")

                        if condition_value == "new":
                            new_listings.append(offer)
                        elif is_used_like_offer(condition_value, subcondition_value, s_name):
                            used_listings.append(offer)
                        else:
                            print(f"      [WARN] Skipping unsupported condition for {asin}: {condition_value or 'missing'} / {subcondition_value or 'missing'}")
                    except (AttributeError, TypeError, ValueError) as offer_err:
                        print(f"      [WARN] Skipping malformed offer for {asin}: {offer_err}")
                        continue

                new_price, new_seller, new_mid = None, None, None
                used_price, used_seller, used_mid = None, None, None
                amazon_price, amazon_seller, amazon_mid, amazon_is_buybox = None, None, None, False
                seen_amazon_eg = False
                seen_resale = False
                
                used_offers = sorted(used_listings, key=lambda x: (x["price"], x["seller"]))

                if new_listings:
                    # Anchor to Buy Box winner if present, otherwise fallback to lowest
                    winner = next((l for l in new_listings if l["is_buybox"]), None)
                    best_new = winner if winner else min(new_listings, key=lambda x: x["price"])
                    new_price, new_seller, new_mid = best_new["price"], best_new["seller"], best_new["mid"]

                    amazon_new_offers = [
                        offer for offer in new_listings
                        if is_amazon_eg_merchant(offer.get("mid"))
                    ]
                    
                    if amazon_new_offers:
                        seen_amazon_eg = True
                        best_amazon = min(amazon_new_offers, key=lambda x: x["price"])
                        if best_amazon is not best_new:
                            amazon_price = best_amazon["price"]
                            amazon_seller = best_amazon["seller"]
                            amazon_mid = best_amazon["mid"]
                            amazon_is_buybox = best_amazon["is_buybox"]

                if used_offers:
                    seen_resale = any(
                        is_amazon_resale_merchant(
                            offer.get("mid"),
                            offer.get("seller", "")
                        )
                        for offer in used_offers
                    )
                    best_used = used_offers[0]
                    used_price, used_seller, used_mid = best_used["price"], best_used["seller"], best_used["mid"]
                    
                if name:
                    batch_results[asin] = (
                        name,
                        new_price,
                        new_seller,
                        new_mid,
                        used_price,
                        used_seller,
                        used_mid,
                        amazon_price,
                        amazon_seller,
                        amazon_mid,
                        amazon_is_buybox,
                        used_offers,
                        seen_amazon_eg,
                        seen_resale
                    )
                    print(f"    ✅ Parsed: {name[:30]}... | New: {new_price} | Amazon.eg: {amazon_price} | Used: {used_price} ({len(used_offers)} returned)")
                else:
                    print(f"    ❌ Skipping {asin} - Missing Name Data")

            return batch_results
        except Exception as e:
            print(f"  [Attempt {attempt+1}] API error for batch: {e}")
            wait_time = 5 * (attempt + 1)
            time.sleep(wait_time)

    return batch_results

# ── Main Async Engine ────────────────────────────────────────────────────────

async def async_main():
    CF_ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    CF_NAMESPACE_ID = os.environ.get("CLOUDFLARE_KV_NAMESPACE_ID")
    CF_API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN")
    
    if not all([CF_ACCOUNT_ID, CF_NAMESPACE_ID, CF_API_TOKEN]):
        print("❌ Missing Cloudflare credentials.")
        return

    cf_headers = {"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"}
    cf_base_url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{CF_NAMESPACE_ID}"
    cairo_tz = ZoneInfo('Africa/Cairo')
    now = datetime.now(cairo_tz).strftime("%Y-%m-%d %H:%M %Z")
    unix_now_ms = int(time.time() * 1000)

    kv_timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=kv_timeout) as session:
        # --- CONCURRENCY SHIELD ---
        # Limit simultaneous TCP connections to prevent Layer 7 floods & exhaustion
        sem = asyncio.Semaphore(15)

        async def bounded_get_kv(url):
            async with sem:
                return await async_get_kv(session, url, cf_headers)

        async def bounded_put_kv(url, payload):
            async with sem:
                return await async_put_kv(session, url, cf_headers, payload)

        async def bounded_delete_kv(url):
            async with sem:
                return await async_delete_kv(session, url, cf_headers)

        # 1. Fetch multi-tenant directory (PAGINATED)
        user_keys = []
        cursor = ""
        while True:
            url = f"{cf_base_url}/keys?prefix=user:"
            if cursor: url += f"&cursor={cursor}"
            page_res = await bounded_get_kv(url)
            if not page_res: break
            user_keys.extend(page_res.get("result", []))
            cursor = page_res.get("result_info", {}).get("cursor")
            if not cursor: break

        if not user_keys: return
            
        users_data = {}
        unique_asins = set()
        dirty_users = set()
        outbox = []

        fetch_tasks = [bounded_get_kv(f"{cf_base_url}/values/{k['name']}") for k in user_keys]
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
                                target_price = p.get("target_price")
                                if target_price is not None:
                                    added_at = p.get("added_at")
                                    if not added_at:
                                        p["added_at"] = unix_now_ms
                                        dirty_users.add(chat_id)
                                    elif (unix_now_ms - added_at) > 7776000000:
                                        p["paused"] = True
                                        dirty_users.add(chat_id)
                                        safe_name = html.escape(truncate_name(p.get("name", "Unknown Product")))
                                        msg = (
                                            f"⏳ <b>STALE TARGET RETIRED</b>\n\n"
                                            f"📦 <b>{safe_name}</b>\n"
                                            f"└ 🆔 <code>{asin}</code>\n\n"
                                            f"Your target price of <b>{target_price:,.2f} EGP</b> has been active for over 90 days without being met.\n\n"
                                            f"<i>To conserve system resources, tracking for this item has been automatically paused. You can resume it from your dashboard anytime.</i>"
                                        )
                                        outbox.append({
                                            "chat_id": chat_id,
                                            "product_id": asin,
                                            "target_price": None,
                                            "lock_keys": [],
                                            "text": msg,
                                            "markup": None
                                        })
                                        continue
                                unique_asins.add(asin)

        if not unique_asins: return
        active_products = [{"asin": a} for a in unique_asins]

        # 2. Batch and Fetch
        BATCH_SIZE = 10
        batches = [active_products[i:i + BATCH_SIZE] for i in range(0, len(active_products), BATCH_SIZE)]
        all_fetched_results = {}

        for idx, batch in enumerate(batches):
            asin_list = [p["asin"] for p in batch]
            results = await asyncio.to_thread(fetch_batch, asin_list)
            all_fetched_results.update(results)
            if idx < len(batches) - 1: await asyncio.sleep(3)

        # 3. Fetch Price History & Legacy Wrapper
        global_prices = {}
        # Fetch shards for ALL active ASINs to detect missing ones
        price_tasks = [bounded_get_kv(f"{cf_base_url}/values/price:{asin}") for asin in unique_asins]
        
        try:
            price_results = await asyncio.gather(*price_tasks)
        except KVRateLimitedError as e:
            err_msg = f"🚨 KV Rate Limit hit. Aborting run.\n{e}"
            await notify_admins_of_error(session, err_msg)
            return
            
        for asin, price_data in zip(unique_asins, price_results):
            if price_data:
                # ⬅️ LEGACY SHARD WRAPPER
                if "price" in price_data and "new_price" not in price_data:
                    global_prices[asin] = {
                        "new_price": price_data.get("price"),
                        "new_seller": price_data.get("seller", "Unknown"),
                        "new_mid": price_data.get("merchant_id"),
                        "used_price": None,
                        "used_seller": None,
                        "used_mid": None,
                        "used_offers": [],
                        "new_missing_since": None,
                        "used_missing_since": None,
                        "amazon_missing_since": None,
                        "amazon_price": None,
                        "amazon_seller": None,
                        "amazon_mid": None,
                        "amazon_is_buybox": False,
                        "name": price_data.get("name"), 
                        "last_updated": price_data.get("last_updated")
                    }
                else:
                    global_prices[asin] = price_data

        updates = {}
        history_updates = 0
        unix_now = int(time.time())
        bulk_payload = []

        # ── MIA HYSTERESIS ENGINE (Dead ASIN Detection) ──
        # FAILSAFE: If we expected items but got 0 back, assume a global PA-API outage. Do not start clocks.
        missing_asins = set()
        if not (len(unique_asins) > 0 and len(all_fetched_results) == 0):
            missing_asins = unique_asins - set(all_fetched_results.keys())
            
        for asin in missing_asins:
            last_entry = global_prices.get(asin, {})
            mia_since = last_entry.get("mia_since_ms")
            is_delisted = last_entry.get("delisted", False)
            
            new_state = last_entry.copy()
            
            # State 1: Just went missing. Stamp the time (1 KV Write)
            if not mia_since:
                new_state["mia_since_ms"] = unix_now_ms
                updates[asin] = new_state
                
            # State 2: Missing for 24 hours (86,400,000 ms). Delist it (1 KV Write)
            elif (unix_now_ms - mia_since) > 86400000 and not is_delisted:
                new_state["delisted"] = True
                updates[asin] = new_state
                
            # State 3: Missing, but under 24 hours. DO NOTHING. (0 KV Writes)

        # ── DELTA HISTORY LOGGER (OR-Gate Trigger) ──
        # Precompute active targets for the 1 EGP debounce bypass
        targets_by_asin = {}
        for chat_id, products in users_data.items():
            for p in products:
                if not p.get("paused", False) and p.get("target_price"):
                    p_url = p.get("url")
                    if p_url:
                        p_asin = get_product_id(p_url)
                        if p_asin:
                            targets_by_asin.setdefault(p_asin, []).append(p["target_price"])

        for asin, res_tuple in all_fetched_results.items():
            (
                name,
                c_new_price,
                c_new_seller,
                c_new_mid,
                c_used_price,
                c_used_seller,
                c_used_mid,
                c_amazon_price,
                c_amazon_seller,
                c_amazon_mid,
                c_amazon_is_buybox,
                c_used_offers,
                c_seen_amazon_eg,
                c_seen_resale
            ) = res_tuple
            if c_new_price is not None: c_new_price = round(c_new_price, 2)
            if c_used_price is not None: c_used_price = round(c_used_price, 2)
            if c_amazon_price is not None: c_amazon_price = round(c_amazon_price, 2)
            
            last_entry = global_prices.get(asin, {})
            last_seen_amazon_eg_at = last_entry.get("seen_amazon_eg_at")
            last_seen_resale_at = last_entry.get("seen_resale_at")            
            last_new_price = last_entry.get("new_price")
            last_used_price = last_entry.get("used_price")

            # --- TIME-BASED STICKY STATE ---
            new_missing_since = last_entry.get("new_missing_since")
            used_missing_since = last_entry.get("used_missing_since")
            amazon_missing_since = last_entry.get("amazon_missing_since")

            # New Price Anti-Flap (2.5 hours = 9000000 ms)
            if c_new_price is None and last_new_price is not None:
                if not new_missing_since: new_missing_since = unix_now_ms
                if (unix_now_ms - new_missing_since) < 9000000:
                    c_new_price = last_new_price
                    c_new_seller = last_entry.get("new_seller")
                    c_new_mid = last_entry.get("new_mid")
            elif c_new_price is not None:
                new_missing_since = None

            # Used Price Anti-Flap (2.5 hours = 9000000 ms)
            if c_used_price is None and last_used_price is not None:
                if not used_missing_since: used_missing_since = unix_now_ms
                if (unix_now_ms - used_missing_since) < 9000000:
                    c_used_price = last_used_price
                    c_used_seller = last_entry.get("used_seller")
                    c_used_mid = last_entry.get("used_mid")
                    c_used_offers = last_entry.get("used_offers", [])
            elif c_used_price is not None:
                used_missing_since = None

            # Amazon Price Anti-Flap (1 hour = 3600000 ms)
            if c_amazon_price is None and last_entry.get("amazon_price") is not None:
                if not amazon_missing_since: amazon_missing_since = unix_now_ms
                if (unix_now_ms - amazon_missing_since) < 3600000:
                    c_amazon_price = last_entry.get("amazon_price")
                    c_amazon_seller = last_entry.get("amazon_seller")
                    c_amazon_mid = last_entry.get("amazon_mid")
                    c_amazon_is_buybox = last_entry.get("amazon_is_buybox")
            elif c_amazon_price is not None:
                amazon_missing_since = None
            # --------------------------------------------

            # --- LAZY REFRESH TIMESTAMPS ---
            seen_amazon_eg_at = last_seen_amazon_eg_at
            if c_seen_amazon_eg:
                if not last_seen_amazon_eg_at or (unix_now_ms - last_seen_amazon_eg_at) > 21600000:
                    seen_amazon_eg_at = unix_now_ms
                    
            seen_resale_at = last_seen_resale_at
            if c_seen_resale:
                if not last_seen_resale_at or (unix_now_ms - last_seen_resale_at) > 21600000:
                    seen_resale_at = unix_now_ms

            # --- 1 EGP NOISE DEBOUNCE FILTER ---
            asin_targets = targets_by_asin.get(asin, [])
            last_amazon_price = last_entry.get("amazon_price")
            
            new_delta = abs(c_new_price - last_new_price) if c_new_price is not None and last_new_price is not None else 0
            used_delta = abs(c_used_price - last_used_price) if c_used_price is not None and last_used_price is not None else 0
            amazon_delta = abs(c_amazon_price - last_amazon_price) if c_amazon_price is not None and last_amazon_price is not None else 0
            
            new_state_changed = (c_new_price is None) != (last_new_price is None)
            used_state_changed = (c_used_price is None) != (last_used_price is None)
            amazon_state_changed = (c_amazon_price is None) != (last_amazon_price is None)
            
            target_crossed_new = False
            if c_new_price is not None and last_new_price is not None:
                target_crossed_new = any(c_new_price <= t < last_new_price for t in asin_targets)
                        
            target_crossed_used = False
            if c_used_price is not None and last_used_price is not None:
                target_crossed_used = any(c_used_price <= t < last_used_price for t in asin_targets)

            # Discard changes if they are < 1.0 EGP and no state/target limits were crossed
            if not (new_state_changed or new_delta >= 1.0 or target_crossed_new):
                c_new_price = last_new_price
                c_new_seller = last_entry.get("new_seller")
                c_new_mid = last_entry.get("new_mid")
            
            if not (used_state_changed or used_delta >= 1.0 or target_crossed_used):
                c_used_price = last_used_price
                c_used_seller = last_entry.get("used_seller")
                c_used_mid = last_entry.get("used_mid")
                c_used_offers = last_entry.get("used_offers", [])
                
            if not (amazon_state_changed or amazon_delta >= 1.0):
                c_amazon_price = last_amazon_price
                c_amazon_seller = last_entry.get("amazon_seller")
                c_amazon_mid = last_entry.get("amazon_mid")
                c_amazon_is_buybox = last_entry.get("amazon_is_buybox", False)

            new_changed = c_new_price != last_new_price
            used_changed = c_used_price != last_used_price

            is_atl_new = False

            if new_changed or used_changed:
                hist_url = f"{cf_base_url}/values/history:{asin}"
                history_data = await bounded_get_kv(hist_url) or []
                if not isinstance(history_data, list): history_data = []

                if new_changed and c_new_price is not None and len(history_data) > 0:
                    valid_n = [pt.get("n") for pt in history_data if pt.get("n") is not None]
                    if valid_n:
                        hist_min = min(valid_n)
                        if c_new_price < hist_min:
                            is_atl_new = True

                history_data.append({"n": c_new_price, "u": c_used_price, "t": unix_now})
                history_data = history_data[-150:]
                # Cloudflare Bulk requires the value to be a stringified JSON
                bulk_payload.append({"key": f"history:{asin}", "value": json.dumps(history_data)})
                history_updates += 1

            if (new_changed or used_changed or
                name != last_entry.get("name") or
                c_new_seller != last_entry.get("new_seller") or
                c_used_seller != last_entry.get("used_seller") or
                c_new_mid != last_entry.get("new_mid") or
                c_used_mid != last_entry.get("used_mid") or
                c_amazon_price != last_entry.get("amazon_price") or
                c_amazon_seller != last_entry.get("amazon_seller") or
                c_amazon_mid != last_entry.get("amazon_mid") or
                c_amazon_is_buybox != bool(last_entry.get("amazon_is_buybox", False)) or
                c_used_offers != last_entry.get("used_offers", []) or
                new_missing_since != last_entry.get("new_missing_since") or
                used_missing_since != last_entry.get("used_missing_since") or
                amazon_missing_since != last_entry.get("amazon_missing_since") or
                seen_amazon_eg_at != last_entry.get("seen_amazon_eg_at") or
                seen_resale_at != last_entry.get("seen_resale_at") or
                last_entry.get("mia_since_ms") is not None or
                last_entry.get("delisted", False)):

                updates[asin] = {
                    "new_price": c_new_price,
                    "new_seller": c_new_seller,
                    "new_mid": c_new_mid,
                    "used_price": c_used_price,
                    "used_seller": c_used_seller,
                    "used_mid": c_used_mid,
                    "used_offers": c_used_offers,
                    "new_missing_since": new_missing_since,
                    "used_missing_since": used_missing_since,
                    "amazon_missing_since": amazon_missing_since,
                    "seen_amazon_eg_at": seen_amazon_eg_at,
                    "seen_resale_at": seen_resale_at,
                    "amazon_price": c_amazon_price,
                    "amazon_seller": c_amazon_seller,
                    "amazon_mid": c_amazon_mid,
                    "amazon_is_buybox": c_amazon_is_buybox,
                    "name": name,
                    "last_updated": unix_now_ms,
                    "mia_since_ms": None,
                    "delisted": False,
                    "is_atl_new": is_atl_new
                }

        # 4. Evaluate prices & route personalized notifications
        for chat_id, products in users_data.items():
            for p in products:
                if p.get("paused", False): continue
                url = p.get("url")
                if not url: continue
                product_id = get_product_id(url)

                latest_state = updates.get(product_id) or global_prices.get(product_id, {})
                if not latest_state: continue

                # 1. Detect Delisted ASINs first
                if latest_state.get("delisted"):
                    p["paused"] = True
                    dirty_users.add(chat_id)
                    safe_name = html.escape(truncate_name(latest_state.get("name", "Unknown Product")))
                    msg = (
                        f"🚨 <b>ITEM DELISTED FROM AMAZON</b>\n\n"
                        f"📦 <b>{safe_name}</b>\n"
                        f"└ 🆔 <code>{product_id}</code>\n\n"
                        f"Amazon has completely removed this product page (404 Not Found) for 24+ consecutive hours.\n\n"
                        f"<i>Your tracking for this item has been automatically paused.</i>"
                    )
                    outbox.append({
                        "chat_id": chat_id,
                        "product_id": product_id,
                        "target_price": None,
                        "lock_keys": [],
                        "text": msg,
                        "markup": None
                    })
                    continue

                # 2. If missing but not yet fully delisted, skip standard evaluation
                if product_id not in all_fetched_results: continue

                name = latest_state.get("name", "Unknown Product")
                new_price = latest_state.get("new_price")
                new_seller = latest_state.get("new_seller")
                new_mid = latest_state.get("new_mid")
                used_price = latest_state.get("used_price")
                used_seller = latest_state.get("used_seller")
                used_mid = latest_state.get("used_mid")
                amazon_price = latest_state.get("amazon_price")
                
                current_seen_amazon_eg_at = latest_state.get("seen_amazon_eg_at")
                current_seen_resale_at = latest_state.get("seen_resale_at")
                
                if "alert_sent" in p:
                    p["alert_sent_new"] = p.get("alert_sent")
                    p["alert_sent_used"] = False
                    del p["alert_sent"]
                    dirty_users.add(chat_id)
                    
                display_name = truncate_name(name)
                is_initial_scan = product_id not in global_prices
                last_entry = global_prices.get(product_id, {})
                last_new_price = last_entry.get("new_price")
                last_used_price = last_entry.get("used_price")
                target_price = p.get("target_price")
                is_atl_new = latest_state.get("is_atl_new", False)
                                    
                def queue_alert(cond_label, price, last_price, seller, mid, is_target, alert_key, is_atl=False):
                    base_url = f"https://www.amazon.eg/dp/{product_id}"
                    
                    primary_mid = AMAZON_RESALE_MERCHANT_ID if "(Used" in cond_label else mid
                    
                    q_params = {}
                    if primary_mid: q_params["m"] = primary_mid
                    if AMAZON_PARTNER_TAG: q_params["tag"] = AMAZON_PARTNER_TAG
                    
                    alert_url = f"{base_url}?{urlencode(q_params)}" if q_params else base_url
                    btn_text = "📦 Open Amazon Resale" if "(Used" in cond_label else "🛒 Open in Amazon.eg"
                    
                    btn_markup = {"inline_keyboard": [[{"text": btn_text, "url": alert_url}]]}
                    
                    safe_name = html.escape(display_name)
                    safe_seller = html.escape(seller) if seller else "Unknown"
                    
                    historical_links = []
                    current_seller_is_amazon = is_amazon_eg_merchant(mid)
                    current_seller_is_resale = is_amazon_resale_merchant(mid, seller)
                    now_ms = int(time.time() * 1000)
                    
                    amazon_seen_recently = current_seen_amazon_eg_at and (now_ms - current_seen_amazon_eg_at) < (14 * 24 * 60 * 60 * 1000)
                    resale_seen_recently = current_seen_resale_at and (now_ms - current_seen_resale_at) < (14 * 24 * 60 * 60 * 1000)
                    
                    if not current_seller_is_amazon:
                        amazon_eg_url = f"https://www.amazon.eg/dp/{product_id}?m={AMAZON_EG_MERCHANT_ID}"
                        if AMAZON_PARTNER_TAG: amazon_eg_url += f"&tag={AMAZON_PARTNER_TAG}"
                        
                        if amazon_price is not None:
                            historical_links.append(f"└ 🛡️ <a href=\"{amazon_eg_url}\">Amazon.eg</a>: <b>{amazon_price:,.2f} EGP</b>")
                        elif amazon_seen_recently:
                            historical_links.append(f"└ 🛡️ <a href=\"{amazon_eg_url}\">Amazon.eg</a> <i>(Check Stock)</i>")
                        
                    if not current_seller_is_resale:
                        resale_url = f"https://www.amazon.eg/dp/{product_id}?m={AMAZON_RESALE_MERCHANT_ID}"
                        if AMAZON_PARTNER_TAG: resale_url += f"&tag={AMAZON_PARTNER_TAG}"
                        
                        if used_price is not None:
                            historical_links.append(f"└ 📦 <a href=\"{resale_url}\">Amazon Resale</a>: <b>{used_price:,.2f} EGP</b> <i>(Used)</i>")
                        elif resale_seen_recently:
                            historical_links.append(f"└ 📦 <a href=\"{resale_url}\">Amazon Resale</a> <i>(Check Stock)</i>")
                        
                    alert_alts = []
                    if historical_links:
                        alert_alts.append("💡 <b>Other Options:</b>")
                        alert_alts.extend(historical_links)

                    final_smart_alts = ("\n\n" + "\n".join(alert_alts)) if alert_alts else ""
                    atl_banner = "🔥 <b>ALL-TIME LOW</b>\n\n" if is_atl else ""
                    
                    if is_target:
                        diff = (last_price - price) if last_price else 0
                        down_text = f" (Down {diff:,.2f} EGP)" if diff > 0 else ""
                        msg = (
                            f"{atl_banner}🎯 <b>TARGET MET! {cond_label}</b>\n\n"
                            f"📦 <b>{safe_name}</b>\n"
                            f"└ 🆔 <code>{product_id}</code>\n\n"
                            f"💰 <b>Current Price:</b> {price:,.2f} EGP\n"
                            f"📉 <b>Target:</b> {target_price:,.2f} EGP{down_text}\n"
                            f"🏬 <b>Seller:</b> <i>{safe_seller}</i>"
                            f"{final_smart_alts}\n\n"
                            f"🕐 <i>{now}</i>"
                        )
                    else:
                        if last_price is None:
                            msg = (
                                f"{atl_banner}🚨 <b>RESTOCK ALERT {cond_label}</b>\n\n"
                                f"📦 <b>{safe_name}</b>\n"
                                f"└ 🆔 <code>{product_id}</code>\n\n"
                                f"💰 <b>Price:</b> {price:,.2f} EGP\n"
                                f"🏬 <b>Seller:</b> <i>{safe_seller}</i>"
                                f"{final_smart_alts}\n\n"
                                f"🕐 <i>{now}</i>"
                            )
                        else:
                            diff = last_price - price
                            pct = (diff / last_price * 100) if last_price else 0
                            msg = (
                                f"{atl_banner}🚨 <b>PRICE DROP ALERT {cond_label}</b>\n\n"
                                f"📦 <b>{safe_name}</b>\n"
                                f"└ 🆔 <code>{product_id}</code>\n\n"
                                f"💰 <b>New Price:</b> {price:,.2f} EGP\n"
                                f"📉 <b>Dropped:</b> {diff:,.2f} EGP ({pct:.1f}% off)\n"
                                f"🏷️ <b>Was:</b> {last_price:,.2f} EGP\n"
                                f"🏬 <b>Seller:</b> <i>{safe_seller}</i>"
                                f"{final_smart_alts}\n\n"
                                f"🕐 <i>{now}</i>"
                            )
                    outbox_item = {
                        "chat_id": chat_id,
                        "product_id": product_id,
                        "target_price": target_price if is_target else None,
                        "lock_keys": [alert_key] if is_target and alert_key else [],
                        "text": msg,
                        "markup": btn_markup
                    }
                    outbox.append(outbox_item)
                    return outbox_item
                    
                target_alert = None
                
                if new_price is not None:
                    if target_price and new_price > target_price:
                        if p.get("alert_sent_new", False):
                            p["alert_sent_new"] = False
                            dirty_users.add(chat_id)
                            
                    if target_price:
                        if new_price <= target_price and not p.get("alert_sent_new", False):
                            target_alert = queue_alert("(New)", new_price, last_new_price, new_seller, new_mid, True, "alert_sent_new", is_atl=is_atl_new)
                            
                    else: 
                        if last_new_price is None and not is_initial_scan:
                            target_alert = queue_alert("(New - Restocked)", new_price, None, new_seller, new_mid, False, "alert_sent_new", is_atl=False)
                        elif last_new_price is not None and new_price < last_new_price:
                            target_alert = queue_alert("(New)", new_price, last_new_price, new_seller, new_mid, False, "alert_sent_new", is_atl=is_atl_new)
                            
                else: 
                    if p.get("alert_sent_new", False):
                        p["alert_sent_new"] = False
                        dirty_users.add(chat_id)

                            
                if used_price is not None:
                    if target_price and used_price > target_price:
                        if p.get("alert_sent_used", False):
                            p["alert_sent_used"] = False
                            dirty_users.add(chat_id)
                    if target_price:
                        if used_price <= target_price and not p.get("alert_sent_used", False):
                            if target_alert:
                                target_alert["lock_keys"].append("alert_sent_used")
                            else:
                                target_alert = queue_alert("(Used - Amazon Resale)", used_price, last_used_price, used_seller, used_mid, True, "alert_sent_used")
                else:
                    if p.get("alert_sent_used", False):
                        p["alert_sent_used"] = False
                        dirty_users.add(chat_id)
                            
                if p.get("name") != name:
                    p["name"] = name
                    dirty_users.add(chat_id)

        # 5. Execute Webhooks & Unified Two-Phase Commit (2PC) Sync
        delivered_locks = {}
        failed_deliveries = 0
        dead_users = set() # <-- NEW
        
        if outbox:
            for alert in outbox:
                delivered, status_code = await async_send_telegram(session, alert["chat_id"], alert["text"], alert["markup"])
                if delivered:
                    lock_keys = [key for key in alert.get("lock_keys", []) if key]
                    if lock_keys:
                        chat_locks = delivered_locks.setdefault(alert["chat_id"], {})
                        product_locks = chat_locks.setdefault(alert["product_id"], {
                            "target_price": alert.get("target_price"),
                            "lock_keys": set()
                        })
                        product_locks["lock_keys"].update(lock_keys)
                else:
                    failed_deliveries += 1
                    # <-- NEW: Catch 403 Forbidden
                    if status_code == 403:
                        dead_users.add(alert["chat_id"])
                await asyncio.sleep(0.5)

        final_tasks = []
        if updates:
            for asin, data in updates.items():
                bulk_payload.append({"key": f"price:{asin}", "value": json.dumps(data)})
                
        sync_users = dirty_users | set(delivered_locks.keys()) | dead_users 
        if sync_users:
            # 2PC TOCTOU Fix: Fetch all sync states concurrently to compress the race window
            async def fetch_user_state(cid):
                try:
                    res = await bounded_get_kv(f"{cf_base_url}/values/user:{cid}:products")
                    return cid, (res if isinstance(res, list) else [])
                except KVRateLimitedError as e:
                    await notify_admins_of_error(session, f"KV 429 during 2PC fresh-fetch for user {cid} — sync aborted for this user.\n{e}")
                    return cid, None

            fetch_tasks = [fetch_user_state(cid) for cid in sync_users]
            fresh_user_states = await asyncio.gather(*fetch_tasks)

            for chat_id, latest_products in fresh_user_states:
                if latest_products is None:
                    continue  # Skip this user; rate limit occurred

                # <-- NEW: Check if the user is in the pruning list
                is_dead = chat_id in dead_users

                engine_by_asin = {}
                for engine_product in users_data.get(chat_id, []):
                    engine_asin = get_product_id(engine_product.get("url"))
                    if engine_asin: engine_by_asin[engine_asin] = engine_product

                chat_delivered_locks = delivered_locks.get(chat_id, {})
                changed = False

                for current_product in latest_products:
                    # <-- NEW: Force pause all items if the user blocked the bot
                    if is_dead and not current_product.get("paused", False):
                        current_product["paused"] = True
                        changed = True

                    current_asin = get_product_id(current_product.get("url"))
                    engine_product = engine_by_asin.get(current_asin)
                    
                    if engine_product:
                        if current_product.get("name") != engine_product.get("name"):
                            current_product["name"] = engine_product.get("name")
                            changed = True

                        same_alert_context = (current_product.get("target_price") == engine_product.get("target_price") and current_product.get("paused", False) == engine_product.get("paused", False))
                        if same_alert_context:
                            for field in ("alert_sent_new", "alert_sent_used"):
                                if field in engine_product and current_product.get(field) != engine_product[field]:
                                    current_product[field] = engine_product[field]
                                    changed = True

                        if "alert_sent" in current_product:
                            del current_product["alert_sent"]
                            changed = True

                    lock_data = chat_delivered_locks.get(current_asin)
                    if lock_data:
                        same_target = current_product.get("target_price") == lock_data.get("target_price")
                        if same_target and not current_product.get("paused", False):
                            for field in lock_data["lock_keys"]:
                                if current_product.get(field) is not True:
                                    current_product[field] = True
                                    changed = True

                if changed:
                    bulk_payload.append({"key": f"user:{chat_id}:products", "value": json.dumps(latest_products)})

        # 6. Push System Stats with Dashboard Heartbeat Throttle
        try:
            old_stats = await bounded_get_kv(f"{cf_base_url}/values/global:stats") or {}
        except KVRateLimitedError:
            old_stats = {}  
            
        old_active = old_stats.get("active_api_calls", 0)
        old_hivemind = old_stats.get("hivemind_size", 0)
        old_timestamp = old_stats.get("last_run_timestamp", 0)

        # We no longer calculate hivemind_size here to save KV LIST quotas. 
        # The 4-hour GitHub backup cron securely handles the total count.
        if (len(unique_asins) != old_active or 
            (unix_now_ms - old_timestamp) > 1800000):
            
            system_stats = {
                "active_api_calls": len(unique_asins), 
                "hivemind_size": old_hivemind, # Preserve the cron's injected value
                "last_run_timestamp": unix_now_ms
            }
            bulk_payload.append({"key": "global:stats", "value": json.dumps(system_stats)})

        # The True Atomic Single-Push Execution
        if bulk_payload:
            success = await async_put_kv_bulk(session, cf_base_url, cf_headers, bulk_payload)
            if not success:
                await notify_admins_of_error(session, "CRITICAL: KV Unified 2PC Bulk Sync failed. State integrity compromised.")
                
        if failed_deliveries:
            await notify_admins_of_error(session, f"Telegram delivery failed for {failed_deliveries} alert(s); locks were not persisted.")

if __name__ == "__main__":
    try:
        asyncio.run(async_main())
    except Exception as e:
        error_trace = traceback.format_exc()
        send_telegram_sync_fallback(str(e) + "\n\n" + error_trace)
