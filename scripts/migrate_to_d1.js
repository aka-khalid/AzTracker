const fs = require('fs');

/**
 * Offline migration script to extract Cloudflare KV JSON blobs
 * and convert them into D1 relational INSERT statements.
 * Fully aligned with the Phase 6.8 D1 Schema.
 */
async function generateMigration() {
  console.log("Starting offline KV to D1 migration...");
  
  let kvData = [];
  try {
    kvData = JSON.parse(fs.readFileSync('./kv_export.json', 'utf8'));
  } catch (err) {
    console.warn("No local kv_export.json found. Creating a blank migration stub.");
  }

  const sqlStatements = [];
  
  // 1. Migrate Users
  const globalApproved = kvData.find(k => k.key === 'global:approved_users')?.value || [];
  const globalAdmins = kvData.find(k => k.key === 'global:admins')?.value || [];
  
  for (const userId of globalApproved) {
    const role = globalAdmins.includes(userId) ? 'admin' : 'approved';
    const limit = 5; // Default fallback
    // Try to find the approved_by sidecar key
    const approvedByKey = kvData.find(k => k.key === `approved_by:${userId}`)?.value || null;
    const approvedByStr = approvedByKey ? `'${approvedByKey}'` : 'NULL';

    sqlStatements.push(`INSERT OR IGNORE INTO Users (chat_id, first_name, username, role, item_limit, approved_by, created_at) VALUES ('${userId}', NULL, NULL, '${role}', ${limit}, ${approvedByStr}, ${Date.now()});`);
  }

  // Helper to safely escape SQL strings
  const esc = (str) => {
      if (str === null || str === undefined) return 'NULL';
      return `'${String(str).replace(/'/g, "''")}'`;
  };

  const now = Date.now();

  // 2. Migrate Global Products & Subscriptions
  for (const entry of kvData) {
    if (entry.key.startsWith('user:') && entry.key.endsWith(':products')) {
      const chatId = entry.key.split(':')[1];
      const products = entry.value;

      for (const prod of products) {
        const asinMatch = prod.url.match(/\/dp\/([A-Z0-9]{10})/);
        const asin = asinMatch ? asinMatch[1] : null;
        if (!asin) continue;

        // Fetch corresponding item data
        const itemDataEntry = kvData.find(k => k.key === `item:${asin}`);
        const itemData = itemDataEntry ? itemDataEntry.value : null;

        let name = prod.name || "Unknown Product";
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

            // Calculate derived stats
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

        // Insert Global_Products with all known KV properties
        sqlStatements.push(`INSERT OR REPLACE INTO Global_Products 
        (asin, name, new_price, used_price, amazon_price, new_seller, used_seller, amazon_seller, hist_mean, hist_stdev, is_atl_new, last_updated) 
        VALUES ('${asin}', ${esc(name)}, ${new_price}, ${used_price}, ${amazon_price}, ${new_seller}, ${used_seller}, ${amazon_seller}, ${histMean}, ${histStdev}, ${isAtlNew}, ${lastUpdated});`);

        // Insert User_Subscriptions
        const target = prod.target_price || 'NULL';
        const isPaused = prod.paused ? 1 : 0;
        sqlStatements.push(`INSERT OR IGNORE INTO User_Subscriptions (chat_id, asin, target_price, is_paused, added_at) VALUES ('${chatId}', '${asin}', ${target}, ${isPaused}, ${now});`);
      }
    }
  }

  // 3. Output
  fs.writeFileSync('./d1_seed.sql', sqlStatements.join('\n'));
  console.log(`Migration script generated ${sqlStatements.length} SQL statements to d1_seed.sql`);
  console.log("Run: npx wrangler d1 execute aztracker-prod-db --local --file=./d1_seed.sql");
  console.log("Note: Remove --local to execute against the live Cloudflare production database.");
}

generateMigration().catch(console.error);
