#!/usr/bin/env node
/**
 * migrate_to_d1.js — KV to D1 Migration Generator
 *
 * Reads Cloudflare KV data (from a local JSON file or by exporting live via
 * the Cloudflare API) and generates a D1-compatible SQL seed file.
 *
 * Usage:
 *   node scripts/migrate_to_d1.js [options]
 *
 * Options:
 *   --help              Show this help message
 *   --input <file>      Path to kv_export.json (default: ./kv_export.json)
 *   --output <file>     Path to write SQL output (default: ./d1_seed.sql)
 *   --export-kv         Export KV data live via Cloudflare API first
 *   --account-id <id>   Cloudflare account ID (or CF_ACCOUNT_ID env)
 *   --api-token <token> Cloudflare API token (or CF_API_TOKEN env)
 *   --kv-ns <id>        KV namespace ID (or CF_KV_NAMESPACE_ID env)
 *   --dry-run           Parse KV data but do not write SQL file
 *
 * Environment variables:
 *   CF_ACCOUNT_ID       Cloudflare account ID
 *   CF_API_TOKEN        Cloudflare API token (Workers KV Storage: Read)
 *   CF_KV_NAMESPACE_ID   KV namespace ID to export
 *
 * Examples:
 *   # Generate SQL from an existing kv_export.json file:
 *   node scripts/migrate_to_d1.js
 *
 *   # Export KV data live and generate SQL:
 *   node scripts/migrate_to_d1.js --export-kv --api-token YOUR_TOKEN
 *
 *   # Custom paths:
 *   node scripts/migrate_to_d1.js --input ./my_kv.json --output ./my_seed.sql
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

function getArg(flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defaultValue || null;
}

if (args.includes('--help') || args.includes('-h')) {
  const scriptName = path.basename(__filename);
  console.log(`
${scriptName} — KV to D1 Migration Generator

USAGE:
  node ${scriptName} [options]

OPTIONS:
  --help, -h          Show this help message
  --input <file>      Path to kv_export.json (default: ./kv_export.json)
  --output <file>     Path to write SQL output (default: ./d1_seed.sql)
  --export-kv         Export KV data live via Cloudflare API first
  --account-id <id>   Cloudflare account ID (or CF_ACCOUNT_ID env)
  --api-token <token> Cloudflare API token (or CF_API_TOKEN env)
  --kv-ns <id>        KV namespace ID (or CF_KV_NAMESPACE_ID env)
  --dry-run           Parse KV data but do not write SQL file

ENVIRONMENT:
  CF_ACCOUNT_ID       Cloudflare account ID
  CF_API_TOKEN        Cloudflare API token (Workers KV Storage: Read)
  CF_KV_NAMESPACE_ID   KV namespace ID to export

EXAMPLES:
  # Generate SQL from existing kv_export.json:
  node ${scriptName}

  # Export KV data live and generate SQL:
  node ${scriptName} --export-kv --api-token YOUR_TOKEN

  # Custom paths:
  node ${scriptName} --input ./my_kv.json --output ./my_seed.sql
`);
  process.exit(0);
}

const OPT_INPUT = getArg('--input', './kv_export.json');
const OPT_OUTPUT = getArg('--output', './d1_seed.sql');
const OPT_EXPORT_KV = args.includes('--export-kv');
const OPT_DRY_RUN = args.includes('--dry-run');
const CF_ACCOUNT_ID = getArg('--account-id') || process.env.CF_ACCOUNT_ID || null;
const CF_API_TOKEN = getArg('--api-token') || process.env.CF_API_TOKEN || null;
const CF_KV_NAMESPACE_ID = getArg('--kv-ns') || process.env.CF_KV_NAMESPACE_ID || null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function esc(str) {
  if (str === null || str === undefined) return 'NULL';
  return `'${String(str).replace(/'/g, "''")}'`;
}

function log(msg) {
  console.log(`  ${msg}`);
}

function warn(msg) {
  console.warn(`  ⚠ ${msg}`);
}

function error(msg) {
  console.error(`  ✖ ${msg}`);
}

// ---------------------------------------------------------------------------
// Step 1: Optionally export KV data via Cloudflare API
// ---------------------------------------------------------------------------
async function exportKvViaApi() {
  if (!CF_API_TOKEN) {
    error('CF_API_TOKEN is required for --export-kv. Set it via --api-token or env.');
    process.exit(1);
  }
  if (!CF_ACCOUNT_ID) {
    error('CF_ACCOUNT_ID is required for --export-kv. Set it via --account-id or env.');
    process.exit(1);
  }
  if (!CF_KV_NAMESPACE_ID) {
    error('CF_KV_NAMESPACE_ID is required for --export-kv. Set it via --kv-ns or env.');
    process.exit(1);
  }

  console.log('\n☁  Exporting KV data via Cloudflare API...');

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

  // List all keys (paginated)
  let allKeys = [];
  let cursor = null;
  let page = 0;

  do {
    page++;
    let apiPath = `/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/keys?limit=1000`;
    if (cursor) apiPath += `&cursor=${cursor}`;

    const result = await cfApi('GET', apiPath);
    if (!result.success) {
      error(`API error listing keys: ${JSON.stringify(result.errors)}`);
      process.exit(1);
    }

    allKeys = allKeys.concat(result.result);
    cursor = result.result_info?.cursor;
    log(`Page ${page}: ${result.result.length} keys (total: ${allKeys.length})`);
  } while (cursor);

  console.log(`  Total keys found: ${allKeys.length}`);

  // Filter out audit/state keys
  const dataKeys = allKeys.filter(k => !k.name.startsWith('audit:') && !k.name.startsWith('state:'));
  log(`Data keys (excluding audit/state): ${dataKeys.length}`);

  // Fetch each key's value
  const kvData = [];
  let count = 0;
  let errors = 0;

  for (const item of dataKeys) {
    count++;
    const key = item.name;
    process.stdout.write(`  [${count}/${dataKeys.length}] ${key} ... `);

    try {
      const result = await cfApi('GET',
        `/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`
      );

      let parsedValue;
      try {
        parsedValue = JSON.parse(result);
      } catch {
        parsedValue = result;
      }

      kvData.push({ key, value: parsedValue });
      console.log('OK');
    } catch (e) {
      errors++;
      console.log(`SKIP (${e.message})`);
    }
  }

  fs.writeFileSync(OPT_INPUT, JSON.stringify(kvData, null, 2));
  console.log(`\n  ✔ Exported ${kvData.length} records to ${OPT_INPUT} (${errors} skipped)`);
}

// ---------------------------------------------------------------------------
// Step 2: Load KV data from file
// ---------------------------------------------------------------------------
function loadKvData() {
  console.log(`\n📂 Loading KV data from ${OPT_INPUT}...`);

  if (!fs.existsSync(OPT_INPUT)) {
    warn(`File not found: ${OPT_INPUT}`);
    console.log('  Tip: Run with --export-kv to fetch data from Cloudflare API first.');
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(OPT_INPUT, 'utf8'));
    if (!Array.isArray(data)) {
      warn('kv_export.json does not contain an array. Expected [{key, value}, ...].');
      return [];
    }
    log(`Loaded ${data.length} KV entries.`);
    return data;
  } catch (err) {
    error(`Failed to parse ${OPT_INPUT}: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Step 3: Generate SQL from KV data
// ---------------------------------------------------------------------------
function generateSql(kvData) {
  console.log('\n🔨 Generating SQL seed...');

  if (kvData.length === 0) {
    warn('No KV data to migrate. Generating empty stub file.');
    fs.writeFileSync(OPT_OUTPUT, '-- No KV data found. Empty migration stub.\n');
    log(`Written empty stub to ${OPT_OUTPUT}`);
    return 0;
  }

  const sqlStatements = [];
  let userCount = 0;
  let productCount = 0;
  let subscriptionCount = 0;
  let queueCount = 0;
  let skippedProducts = 0;

  // -- 1. Migrate Users --
  const globalApproved = kvData.find(k => k.key === 'global:approved_users')?.value || [];
  const globalAdminsRaw = kvData.find(k => k.key === 'global:admins')?.value;
  const globalAdminsArr = Array.isArray(globalAdminsRaw)
    ? globalAdminsRaw
    : (globalAdminsRaw != null ? [globalAdminsRaw] : []);
  const rootAdminId = globalAdminsArr[0] || 'ROOT_ADMIN';

  if (globalApproved.length > 0) {
    log(`Migrating ${globalApproved.length} approved users...`);
  }

  for (const userId of globalApproved) {
    const role = globalAdminsArr.map(String).includes(String(userId)) ? 'admin' : 'approved';
    const limit = 5;
    const approvedByKey = kvData.find(k => k.key === `approved_by:${userId}`)?.value || null;
    const approvedByStr = approvedByKey ? esc(approvedByKey) : esc(rootAdminId);

    sqlStatements.push(
      `INSERT OR IGNORE INTO Users (chat_id, first_name, username, role, item_limit, approved_by, created_at) VALUES (${esc(userId)}, NULL, NULL, ${esc(role)}, ${limit}, ${approvedByStr}, ${Date.now()});`
    );
    userCount++;
  }

  // -- 2. Migrate Pending Users from join queue --
  const globalJoinQueue = kvData.find(k => k.key === 'global:join_queue')?.value || [];

  if (globalJoinQueue.length > 0) {
    log(`Migrating ${globalJoinQueue.length} pending users from join queue...`);
  }

  for (const userId of globalJoinQueue) {
    if (globalApproved.includes(userId)) {
      continue; // Already approved, skip
    }
    sqlStatements.push(
      `INSERT OR IGNORE INTO Users (chat_id, first_name, username, role, item_limit, approved_by, created_at) VALUES (${esc(userId)}, NULL, NULL, 'pending', 0, NULL, ${Date.now()});`
    );
    queueCount++;
  }

  // -- 3. Migrate Global Products & Subscriptions --
  const now = Date.now();
  const productEntries = kvData.filter(e => e.key.startsWith('user:') && e.key.endsWith(':products'));

  if (productEntries.length > 0) {
    log(`Processing ${productEntries.length} user product entries...`);
  }

  for (const entry of productEntries) {
    const chatId = entry.key.split(':')[1];
    const products = entry.value;

    if (!Array.isArray(products)) {
      warn(`Skipping ${entry.key}: value is not an array.`);
      continue;
    }

    for (const prod of products) {
      const asinMatch = prod.url?.match(/\/dp\/([A-Z0-9]{10})/);
      const asin = asinMatch ? asinMatch[1] : null;
      if (!asin) {
        skippedProducts++;
        continue;
      }

      // Fetch corresponding item data
      const itemDataEntry = kvData.find(k => k.key === `item:${asin}`);
      const itemData = itemDataEntry ? itemDataEntry.value : null;

      let name = prod.name || 'Unknown Product';
      let new_price = 'NULL', used_price = 'NULL', amazon_price = 'NULL';
      let new_seller = 'NULL', used_seller = 'NULL', amazon_seller = 'NULL';
      let histMean = 0, histStdev = 0, isAtlNew = 0;
      let lastUpdated = now;

      if (itemData) {
        name = itemData.name || name;
        new_price = itemData.new_price || 'NULL';
        used_price = itemData.used_price || 'NULL';
        amazon_price = itemData.amazon_price || 'NULL';
        new_seller = esc(itemData.new_seller);
        used_seller = esc(itemData.used_seller);
        amazon_seller = esc(itemData.amazon_seller);
        lastUpdated = itemData.last_updated || now;

        if (itemData.history_new && Array.isArray(itemData.history_new) && itemData.history_new.length >= 2) {
          const newPrices = itemData.history_new;
          const sum = newPrices.reduce((a, b) => a + b, 0);
          const mean = sum / newPrices.length;
          const variance = newPrices.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (newPrices.length - 1);
          histMean = mean;
          histStdev = Math.sqrt(variance);
          const atl = Math.min(...newPrices);
          isAtlNew = (itemData.new_price && itemData.new_price < atl) ? 1 : 0;
        }
      }

      // Insert Global_Products
      sqlStatements.push(
        `INSERT OR IGNORE INTO Global_Products (asin, name, new_price, used_price, amazon_price, new_seller, used_seller, amazon_seller, hist_mean, hist_stdev, is_atl_new, last_updated) VALUES (${esc(asin)}, ${esc(name)}, ${new_price}, ${used_price}, ${amazon_price}, ${new_seller}, ${used_seller}, ${amazon_seller}, ${histMean}, ${histStdev}, ${isAtlNew}, ${lastUpdated});`
      );
      productCount++;

      // Insert User_Subscriptions
      const target = prod.target_price || 'NULL';
      const isPaused = prod.paused ? 1 : 0;
      sqlStatements.push(
        `INSERT OR IGNORE INTO User_Subscriptions (chat_id, asin, target_price, is_paused, added_at) VALUES (${esc(chatId)}, ${esc(asin)}, ${target}, ${isPaused}, ${now});`
      );
      subscriptionCount++;
    }
  }

  if (skippedProducts > 0) {
    warn(`${skippedProducts} products skipped (missing ASIN in URL).`);
  }

  // -- 4. Write output --
  if (OPT_DRY_RUN) {
    console.log(`\n  🔍 Dry-run mode — NOT writing to ${OPT_OUTPUT}`);
    console.log(`  Would generate ${sqlStatements.length} SQL statements.`);
    console.log(`  Users: ${userCount} | Queue: ${queueCount} | Products: ${productCount} | Subscriptions: ${subscriptionCount}`);
    return sqlStatements.length;
  }

  const header = [
    '-- D1 Seed File — Generated by scripts/migrate_to_d1.js',
    `-- Generated at: ${new Date().toISOString()}`,
    `-- Source KV entries: ${kvData.length}`,
    `-- Statements: ${sqlStatements.length}`,
    '',
    'PRAGMA foreign_keys = OFF;',
    ''
  ].join('\n');

  fs.writeFileSync(OPT_OUTPUT, header + sqlStatements.join('\n') + '\nPRAGMA foreign_keys = ON;\n');
  log(`Written ${sqlStatements.length} statements to ${OPT_OUTPUT}`);

  return sqlStatements.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  AzTracker KV → D1 Migration Generator');
  console.log('═══════════════════════════════════════════');

  // Step 1: Optionally export KV data
  if (OPT_EXPORT_KV) {
    await exportKvViaApi();
  }

  // Step 2: Load KV data
  const kvData = loadKvData();

  // Step 3: Generate SQL
  const count = generateSql(kvData);

  // Summary
  console.log('\n═══════════════════════════════════════════');
  console.log('  Migration Summary');
  console.log('═══════════════════════════════════════════');
  console.log(`  Input:  ${OPT_INPUT}`);
  console.log(`  Output: ${OPT_OUTPUT}`);
  console.log(`  SQL statements: ${count}`);
  console.log('');
  console.log('  Next step: Apply the seed to your D1 database:');
  console.log(`    npx wrangler d1 execute <db-name> --remote --file=${OPT_OUTPUT}`);
  console.log('═══════════════════════════════════════════\n');
}

main().catch(err => {
  error(`Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
