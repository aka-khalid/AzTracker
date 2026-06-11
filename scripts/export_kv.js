const https = require('https');
const fs = require('fs');

// Cloudflare API credentials
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID;

if (!CF_API_TOKEN) {
  console.error("❌ Set CF_API_TOKEN environment variable first.");
  console.error("   Get one at: https://dash.cloudflare.com/profile/api-tokens");
  console.error("   Required permission: Workers KV Storage > Read");
  process.exit(1);
}
if (!ACCOUNT_ID) {
  console.error("❌ Set CF_ACCOUNT_ID environment variable first.");
  process.exit(1);
}
if (!KV_NAMESPACE_ID) {
  console.error("❌ Set CF_KV_NAMESPACE_ID environment variable first.");
  console.error("   Find it with: npx wrangler kv:namespace list");
  process.exit(1);
}

function cfApi(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.cloudflare.com',
      path: path,
      method: method,
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  console.log("Fetching all keys from KV namespace via Cloudflare API...");

  // Step 1: List all keys (paginated)
  let allKeys = [];
  let cursor = null;
  let page = 0;

  do {
    page++;
    let path = `/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/keys?limit=1000`;
    if (cursor) path += `&cursor=${cursor}`;

    const result = await cfApi('GET', path);
    if (!result.success) {
      console.error("API error:", result.errors);
      process.exit(1);
    }

    allKeys = allKeys.concat(result.result);
    cursor = result.result_info?.cursor;
    console.log(`  Page ${page}: fetched ${result.result.length} keys (total: ${allKeys.length})`);
  } while (cursor);

  console.log(`\nTotal keys: ${allKeys.length}`);

  // Step 2: Filter out audit/state keys
  const dataKeys = allKeys.filter(k => !k.name.startsWith('audit:') && !k.name.startsWith('state:'));
  console.log(`Data keys (excluding audit/state): ${dataKeys.length}`);

  // Step 3: Fetch each key's value
  const kvData = [];
  let count = 0;
  let errors = 0;

  for (const item of dataKeys) {
    count++;
    const key = item.name;
    process.stdout.write(`[${count}/${dataKeys.length}] ${key} ... `);

    try {
      const result = await cfApi('GET',
        `/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`
      );

      let parsedValue;
      try {
        parsedValue = JSON.parse(result);
      } catch {
        parsedValue = result;
      }

      kvData.push({ key, value: parsedValue });
      console.log("OK");
    } catch (e) {
      errors++;
      console.log(`SKIP (${e.message})`);
    }
  }

  fs.writeFileSync('./kv_export.json', JSON.stringify(kvData, null, 2));
  console.log(`\n✅ Exported ${kvData.length} records to kv_export.json (${errors} skipped)`);
  console.log("Next: node scripts/migrate_to_d1.js");
}

main().catch(e => console.error("Fatal:", e));
