const fs = require('fs');

async function syncKV() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  
  if (!accountId || !apiToken) {
    console.error("Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN");
    process.exit(1);
  }

  const prodKvId = '90fcfcb742fe4d7299087c076bd1ba4d'; // Prod
  const devKvId = 'bd7a240d6727457cb1a5338450aa0969'; // Dev

  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`;
  const headers = {
    'Authorization': `Bearer ${apiToken}`,
    'Content-Type': 'application/json'
  };

  console.log("Fetching keys from Prod KV...");
  let keys = [];
  let cursor = '';
  
  do {
    const url = `${baseUrl}/${prodKvId}/keys${cursor ? `?cursor=${cursor}` : ''}`;
    const res = await fetch(url, { headers });
    const json = await res.json();
    if (!json.success) {
      console.error("Failed to fetch keys:", json.errors);
      process.exit(1);
    }
    keys = keys.concat(json.result);
    cursor = json.result_info.cursor;
  } while (cursor);

  console.log(`Found ${keys.length} keys. Fetching values...`);
  
  const bulkPayload = [];
  
  // Fetch sequentially to avoid rate limits, or in small batches
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i].name;
    const res = await fetch(`${baseUrl}/${prodKvId}/values/${encodeURIComponent(key)}`, { headers });
    if (!res.ok) {
      console.warn(`Failed to fetch value for key ${key}`);
      continue;
    }
    const value = await res.text(); // KV values can be string or JSON
    bulkPayload.push({ key: key, value: value });
    
    if (i % 50 === 0 && i > 0) {
      console.log(`Fetched ${i} values...`);
    }
  }

  if (bulkPayload.length === 0) {
    console.log("No keys to sync.");
    return;
  }

  console.log(`Uploading ${bulkPayload.length} keys to Dev KV...`);
  
  // Bulk upload supports max 10,000 keys per request. 
  // We'll chunk it into 5,000 just to be safe.
  const chunkSize = 5000;
  for (let i = 0; i < bulkPayload.length; i += chunkSize) {
    const chunk = bulkPayload.slice(i, i + chunkSize);
    const res = await fetch(`${baseUrl}/${devKvId}/bulk`, {
      method: 'PUT',
      headers: headers,
      body: JSON.stringify(chunk)
    });
    const json = await res.json();
    if (!json.success) {
      console.error("Failed to upload bulk payload:", json.errors);
      process.exit(1);
    }
    console.log(`Uploaded chunk ${i / chunkSize + 1}`);
  }

  console.log("KV Sync Complete!");
}

syncKV().catch(console.error);
