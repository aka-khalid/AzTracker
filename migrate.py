import os
import time
import asyncio
import aiohttp

async def fetch_and_update(session, key, cf_base_url, cf_headers, unix_now_ms):
    url = f"{cf_base_url}/values/{key}"
    async with session.get(url, headers=cf_headers) as res:
        if res.status != 200: return
        product_data = await res.json(content_type=None)

    if isinstance(product_data, dict):
        # Inject the fresh timestamp into both tracker fields
        product_data["seen_amazon_eg_at"] = unix_now_ms
        product_data["seen_resale_at"] = unix_now_ms

        async with session.put(url, headers=cf_headers, json=product_data) as res:
            if res.status == 200:
                print(f"✅ Updated {key}")

async def force_timestamps():
    CF_ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    CF_NAMESPACE_ID = os.environ.get("CLOUDFLARE_KV_NAMESPACE_ID")
    CF_API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN")

    cf_headers = {"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"}
    cf_base_url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{CF_NAMESPACE_ID}"

    unix_now_ms = int(time.time() * 1000)

    async with aiohttp.ClientSession() as session:
        # 1. Get all price shards
        async with session.get(f"{cf_base_url}/keys?prefix=price:", headers=cf_headers) as res:
            data = await res.json()
            keys = [k["name"] for k in data.get("result", [])]

        print(f"Found {len(keys)} products. Injecting 14-Day TTL timestamps...")

        # 2. Fire simultaneous update tasks for maximum speed
        tasks = [fetch_and_update(session, key, cf_base_url, cf_headers, unix_now_ms) for key in keys]
        await asyncio.gather(*tasks)

if __name__ == "__main__":
    asyncio.run(force_timestamps())
