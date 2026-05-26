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
from urllib.parse import urlencode
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
AMAZON_EG_MERCHANT_ID = os.environ.get("AMZN_EG_MERCHANT_ID", "A1ZVRGNO5AYLOV")
AMAZON_RESALE_MERCHANT_ID = os.environ.get("AMZN_RESALE_MERCHANT_ID", "A2N2MP47XAP1MK")
AMAZON_ALT_MAX_MULTIPLIER = 1.15
MAX_USED_ALT_OFFERS = 2

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

# ── Telegram ──────────────────────────────────────────────────────────────────

def send_telegram(chat_id, text, reply_markup=None):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
    if reply_markup: payload["reply_markup"] = reply_markup
    try:
        res = requests.post(url, json=payload, timeout=10)
        return res.status_code == 200
    except Exception as e:
        print(f"Telegram error: {e}")
        return False

async def async_send_telegram(session, chat_id, text, reply_markup=None, max_retries=3):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
    if reply_markup: payload["reply_markup"] = reply_markup
        
    for attempt in range(max_retries):
        try:
            async with session.post(url, json=payload, timeout=10) as response:
                if response.status == 200: return True
                elif response.status == 429:
                    resp_json = await response.json()
                    wait_time = resp_json.get("parameters", {}).get("retry_after", 3)
                    await asyncio.sleep(wait_time)
                    continue 
                else: return False
        except Exception as e:
            return False
    return False

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
                    except: continue

                new_price, new_seller, new_mid = None, None, None
                used_price, used_seller, used_mid = None, None, None
                amazon_price, amazon_seller, amazon_mid, amazon_is_buybox = None, None, None, False
                seen_amazon_eg = False
                seen_resale = False
                
                used_offers = sorted(used_listings, key=lambda x: x["price"])

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
                        
                    if amazon_new_offers:
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
    cairo_tz = pytz.timezone('Africa/Cairo')
    now = datetime.now(cairo_tz).strftime("%Y-%m-%d %H:%M %Z")
    unix_now_ms = int(time.time() * 1000)

    async with aiohttp.ClientSession() as session:
        # 1. Fetch multi-tenant directory
        keys_res = await async_get_kv(session, f"{cf_base_url}/keys?prefix=user:", cf_headers)
        if not keys_res: return
            
        user_keys = keys_res.get("result", [])
        users_data = {}
        unique_asins = set()

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
                            if asin: unique_asins.add(asin)

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
        price_tasks = [async_get_kv(session, f"{cf_base_url}/values/price:{asin}", cf_headers) for asin in all_fetched_results.keys()]
        
        try:
            price_results = await asyncio.gather(*price_tasks)
        except KVRateLimitedError as e:
            err_msg = f"🚨 KV Rate Limit hit. Aborting run.\n{e}"
            await notify_admins_of_error(session, err_msg)
            return
            
        for asin, price_data in zip(all_fetched_results.keys(), price_results):
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
                        "used_miss_streak": 0,
                        "used_last_seen": None,
                        "amazon_price": None,
                        "amazon_seller": None,
                        "amazon_mid": None,
                        "amazon_is_buybox": False,
                        "name": price_data.get("name"), # Preserved to prevent First-Run Write Storm
                        "last_updated": price_data.get("last_updated")
                    }
                else:
                    global_prices[asin] = price_data

        updates = {}

        # ── DELTA HISTORY LOGGER (OR-Gate Trigger) ──
        history_updates = 0
        unix_now = int(time.time())
        history_tasks = []

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

            # --- STICKY STATE (HYSTERESIS) ---
            miss_streak = last_entry.get("used_miss_streak", 0)
            used_last_seen = last_entry.get("used_last_seen")

            if c_used_price is None and last_used_price is not None:
                miss_streak += 1
                if miss_streak < 4:  # Tolerate up to 3 misses (~30 mins) before dropping
                    c_used_price = last_used_price
                    c_used_seller = last_entry.get("used_seller")
                    c_used_mid = last_entry.get("used_mid")
                    c_used_offers = last_entry.get("used_offers", [])
                else:
                    used_last_seen = None
            elif c_used_price is not None:
                miss_streak = 0
                used_last_seen = unix_now_ms
            # ---------------------------------

            # --- LAZY REFRESH TIMESTAMPS ---
            # Only mutate the timestamp if it's missing, or older than 24 hours (86,400,000 ms)
            # This prevents minute-by-minute KV write storms while maintaining the 14-day TTL memory.
            
            seen_amazon_eg_at = last_seen_amazon_eg_at
            if c_seen_amazon_eg:
                if not last_seen_amazon_eg_at or (unix_now_ms - last_seen_amazon_eg_at) > 86400000:
                    seen_amazon_eg_at = unix_now_ms
                    
            seen_resale_at = last_seen_resale_at
            if c_seen_resale:
                if not last_seen_resale_at or (unix_now_ms - last_seen_resale_at) > 86400000:
                    seen_resale_at = unix_now_ms

            new_changed = c_new_price != last_new_price
            used_changed = c_used_price != last_used_price

            if new_changed or used_changed:
                hist_url = f"{cf_base_url}/values/history:{asin}"
                history_data = await async_get_kv(session, hist_url, cf_headers) or []
                if not isinstance(history_data, list): history_data = []
                history_data.append({"n": c_new_price, "u": c_used_price, "t": unix_now})
                history_data = history_data[-150:]
                history_tasks.append(async_put_kv(session, hist_url, cf_headers, history_data))
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
                miss_streak != last_entry.get("used_miss_streak", 0) or
                seen_amazon_eg_at != last_entry.get("seen_amazon_eg_at") or
                seen_resale_at != last_entry.get("seen_resale_at")):

                updates[asin] = {
                    "new_price": c_new_price,
                    "new_seller": c_new_seller,
                    "new_mid": c_new_mid,
                    "used_price": c_used_price,
                    "used_seller": c_used_seller,
                    "used_mid": c_used_mid,
                    "used_offers": c_used_offers,
                    "used_miss_streak": miss_streak,
                    "used_last_seen": used_last_seen,
                    "seen_amazon_eg_at": seen_amazon_eg_at,
                    "seen_resale_at": seen_resale_at,
                    "amazon_price": c_amazon_price,
                    "amazon_seller": c_amazon_seller,
                    "amazon_mid": c_amazon_mid,
                    "amazon_is_buybox": c_amazon_is_buybox,
                    "name": name,
                    "last_updated": unix_now_ms
                }

        if history_tasks: await asyncio.gather(*history_tasks)

        # 4. Evaluate prices & route personalized notifications
        dirty_users = set()
        outbox = []

        for chat_id, products in users_data.items():
            for p in products:
                if p.get("paused", False): continue
                url = p.get("url")
                if not url: continue
                product_id = get_product_id(url)
                res = all_fetched_results.get(product_id)
                if not res: continue

                (
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
                ) = res
                if not isinstance(used_offers, list):
                    used_offers = []
                
                # ⬅️ LEGACY PROFILE SANITIZER
                if "alert_sent" in p:
                    p["alert_sent_new"] = p.get("alert_sent")
                    p["alert_sent_used"] = False
                    del p["alert_sent"]
                    dirty_users.add(chat_id)
                    
                display_name = truncate_name(name)
                last_entry = global_prices.get(product_id, {})
                last_new_price = last_entry.get("new_price")
                last_used_price = last_entry.get("used_price")
                target_price = p.get("target_price")
                
                def queue_alert(cond_label, price, last_price, seller, mid, is_target, alert_key):
                    base_url = f"https://www.amazon.eg/dp/{product_id}"
                    q_params = {}
                    if mid: q_params["m"] = mid
                    if AMAZON_PARTNER_TAG: q_params["tag"] = AMAZON_PARTNER_TAG
                    alert_url = f"{base_url}?{urlencode(q_params)}" if q_params else base_url
                    btn_markup = {"inline_keyboard": [[{"text": "🛒 Open in Amazon.eg", "url": alert_url}]]}
                    
                    safe_name = html.escape(display_name)
                    safe_seller = html.escape(seller) if seller else "Unknown"
                    
                    # Smart Alternatives Builder
                    alert_alts = []
                    amazon_alt_eligible = (
                        amazon_price is not None and
                        not amazon_is_buybox and
                        new_price is not None and
                        amazon_price <= new_price * AMAZON_ALT_MAX_MULTIPLIER and
                        mid != amazon_mid
                    )
                    if amazon_alt_eligible:
                        safe_amazon_seller = html.escape(amazon_seller or "Amazon.eg")
                        premium = ((amazon_price - new_price) / new_price * 100) if new_price else 0
                        premium_text = f", +{premium:.1f}%" if premium > 0 else ""
                        alert_alts.append(f"└ 🛡️ <b>{safe_amazon_seller}:</b> {amazon_price:,.2f} EGP <i>(Amazon.eg{premium_text})</i>")

                    if cond_label.startswith("(New)"):
                        used_alt_count = 0
                        for offer in used_offers if isinstance(used_offers, list) else []:
                            offer_price = offer.get("price")
                            if offer_price is None or offer_price >= price:
                                continue
                            safe_used_seller = html.escape(offer.get("seller") or "Amazon Resale")
                            alert_alts.append(f"└ 📦 <b>{safe_used_seller}:</b> {offer_price:,.2f} EGP <i>(Used)</i>")
                            used_alt_count += 1
                            if used_alt_count >= MAX_USED_ALT_OFFERS:
                                break
                    else:
                        if new_price is not None and new_price <= price:
                            alert_alts.append(f"└ 🛒 <b>Buy Box:</b> {new_price:,.2f} EGP <i>(New)</i>")
                        elif new_price is None:
                            alert_alts.append(f"└ ❌ <b>Buy Box:</b> Out of Stock <i>(New)</i>")
                    final_smart_alts = ("\n\n💡 <b>Smart Alternatives:</b>\n" + "\n".join(alert_alts)) if alert_alts else ""
                    
                    if is_target:
                        diff = (last_price - price) if last_price else 0
                        down_text = f" (Down {diff:,.2f} EGP)" if diff > 0 else ""
                        msg = (
                            f"🎯 <b>TARGET MET! {cond_label}</b>\n\n"
                            f"📦 <b>{safe_name}</b>\n"
                            f"└ 🆔 <code>{product_id}</code>\n\n"
                            f"💰 <b>Current Price:</b> {price:,.2f} EGP\n"
                            f"📉 <b>Target:</b> {target_price:,.2f} EGP{down_text}\n"
                            f"🏬 <b>Seller:</b> <i>{safe_seller}</i>"
                            f"{final_smart_alts}\n\n"
                            f"🕐 <i>{now}</i>"
                        )
                    else:
                        diff = last_price - price
                        pct = (diff / last_price * 100) if last_price else 0
                        msg = (
                            f"🚨 <b>PRICE DROP ALERT {cond_label}</b>\n\n"
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

                # Evaluate New
                if new_price is not None:
                    if target_price and new_price > target_price:
                        if p.get("alert_sent_new", False):
                            p["alert_sent_new"] = False
                            dirty_users.add(chat_id)
                    if target_price:
                        if new_price <= target_price and not p.get("alert_sent_new", False):
                            target_alert = queue_alert("(New)", new_price, last_new_price, new_seller, new_mid, True, "alert_sent_new")
                    else:
                        if last_new_price is not None and new_price < last_new_price:
                            queue_alert("(New)", new_price, last_new_price, new_seller, new_mid, False, "alert_sent_new")
                else:
                    # Reset target lock if the item goes Out of Stock
                    if p.get("alert_sent_new", False):
                        p["alert_sent_new"] = False
                        dirty_users.add(chat_id)
                            
                # Evaluate Used
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
                        if last_used_price is not None and used_price < last_used_price:
                            queue_alert("(Used - Amazon Resale)", used_price, last_used_price, used_seller, used_mid, False, "alert_sent_used")
                else:
                    # Reset target lock if the item goes Out of Stock
                    if p.get("alert_sent_used", False):
                        p["alert_sent_used"] = False
                        dirty_users.add(chat_id)
                            
                if p.get("name") != name:
                    p["name"] = name
                    dirty_users.add(chat_id)

        # 5. Push System Stats
        final_tasks = []
        if updates:
            for asin, data in updates.items():
                final_tasks.append(async_put_kv(session, f"{cf_base_url}/values/price:{asin}", cf_headers, data))
        if dirty_users:
            for chat_id in dirty_users:
                latest_products = await async_get_kv(session, f"{cf_base_url}/values/user:{chat_id}:products", cf_headers) or []
                if not isinstance(latest_products, list):
                    latest_products = []

                engine_by_asin = {}
                for engine_product in users_data.get(chat_id, []):
                    engine_asin = get_product_id(engine_product.get("url"))
                    if engine_asin:
                        engine_by_asin[engine_asin] = engine_product

                changed = False
                for current_product in latest_products:
                    current_asin = get_product_id(current_product.get("url"))
                    engine_product = engine_by_asin.get(current_asin)
                    if not engine_product:
                        continue

                    if current_product.get("name") != engine_product.get("name"):
                        current_product["name"] = engine_product.get("name")
                        changed = True

                    same_alert_context = (
                        current_product.get("target_price") == engine_product.get("target_price") and
                        current_product.get("paused", False) == engine_product.get("paused", False)
                    )
                    if same_alert_context:
                        for field in ("alert_sent_new", "alert_sent_used"):
                            if field in engine_product and current_product.get(field) != engine_product[field]:
                                current_product[field] = engine_product[field]
                                changed = True

                    if "alert_sent" in current_product:
                        del current_product["alert_sent"]
                        changed = True

                if changed:
                    final_tasks.append(async_put_kv(session, f"{cf_base_url}/values/user:{chat_id}:products", cf_headers, latest_products))

        prices_keys_res = await async_get_kv(session, f"{cf_base_url}/keys?prefix=price:", cf_headers)
        hivemind_size = len(prices_keys_res.get("result", [])) if prices_keys_res else 0
        system_stats = {"active_api_calls": len(unique_asins), "hivemind_size": hivemind_size, "last_run_timestamp": unix_now_ms}
        final_tasks.append(async_put_kv(session, f"{cf_base_url}/values/global:stats", cf_headers, system_stats))

        # 6. Two-Phase Commit
        if final_tasks:
            write_results = await asyncio.gather(*final_tasks)
            if all(write_results):
                delivered_locks = {}
                failed_deliveries = 0
                if outbox:
                    for alert in outbox:
                        delivered = await async_send_telegram(session, alert["chat_id"], alert["text"], alert["markup"])
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
                        await asyncio.sleep(0.5)

                if delivered_locks:
                    lock_tasks = []
                    for chat_id, locks_by_asin in delivered_locks.items():
                        latest_products = await async_get_kv(session, f"{cf_base_url}/values/user:{chat_id}:products", cf_headers) or []
                        if not isinstance(latest_products, list):
                            latest_products = []

                        changed = False
                        for current_product in latest_products:
                            current_asin = get_product_id(current_product.get("url"))
                            lock_data = locks_by_asin.get(current_asin)
                            if not lock_data:
                                continue

                            same_target = current_product.get("target_price") == lock_data.get("target_price")
                            if not same_target or current_product.get("paused", False):
                                continue

                            for field in lock_data["lock_keys"]:
                                if current_product.get(field) is not True:
                                    current_product[field] = True
                                    changed = True

                        if changed:
                            lock_tasks.append(async_put_kv(session, f"{cf_base_url}/values/user:{chat_id}:products", cf_headers, latest_products))

                    if lock_tasks:
                        lock_results = await asyncio.gather(*lock_tasks)
                        if not all(lock_results):
                            await notify_admins_of_error(session, "CRITICAL: Telegram sent, but alert lock persistence failed.")

                if failed_deliveries:
                    await notify_admins_of_error(session, f"Telegram delivery failed for {failed_deliveries} alert(s); locks were not persisted.")
            else:
                err_msg = "❌ CRITICAL: KV Writes failed. Telegram Outbox aborted to prevent spam loops."
                await notify_admins_of_error(session, err_msg)

if __name__ == "__main__":
    try:
        asyncio.run(async_main())
    except Exception as e:
        error_trace = traceback.format_exc()
        send_telegram_sync_fallback(str(e) + "\n\n" + error_trace)
