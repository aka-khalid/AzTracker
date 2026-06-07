const fs = require('fs');

/**
 * Offline migration script to extract Cloudflare KV JSON blobs
 * and convert them into D1 relational INSERT statements.
 */
async function generateMigration() {
  console.log("Starting offline KV to D1 migration...");
  
  // In a real scenario, this would fetch from Cloudflare KV API or read a KV export JSON
  // For demonstration, we assume `kv_export.json` exists locally.
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
    sqlStatements.push(`INSERT OR IGNORE INTO Users (chat_id, role, item_limit, created_at) VALUES ('${userId}', '${role}', ${limit}, ${Date.now()});`);
  }

  // 2. Migrate Global Products & Subscriptions
  for (const entry of kvData) {
    if (entry.key.startsWith('user:') && entry.key.endsWith(':products')) {
      const chatId = entry.key.split(':')[1];
      const products = entry.value;

      for (const prod of products) {
        // Mock ASIN extraction
        const asinMatch = prod.url.match(/\/dp\/([A-Z0-9]{10})/);
        const asin = asinMatch ? asinMatch[1] : `ASIN${Math.floor(Math.random()*1000000)}`;

        // Seed Global_Products (Write-on-Delta expects a baseline)
        sqlStatements.push(`INSERT OR IGNORE INTO Global_Products (asin, name, last_updated) VALUES ('${asin}', '${prod.name.replace(/'/g, "''")}', ${Date.now()});`);

        // Seed User_Subscriptions
        sqlStatements.push(`INSERT OR IGNORE INTO User_Subscriptions (chat_id, asin, target_price, is_paused, added_at) VALUES ('${chatId}', '${asin}', ${prod.target_price || null}, ${prod.paused ? 1 : 0}, ${Date.now()});`);
      }
    }
  }

  fs.writeFileSync('./d1_seed.sql', sqlStatements.join('\n'));
  console.log(`Migration script generated ${sqlStatements.length} SQL statements to d1_seed.sql`);
  console.log("Run: npx wrangler d1 execute aztracker-v2-db --local --file=./d1_seed.sql");
}

generateMigration().catch(console.error);
