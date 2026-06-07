const { execSync } = require('child_process');
const fs = require('fs');

console.log("Fetching all keys from KV namespace...");

const execOptions = { 
  encoding: 'utf8', 
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' } 
};

try {
  const keysOutput = execSync('npx wrangler kv key list --binding=AZTRACKER_DB', execOptions);
  const keys = JSON.parse(keysOutput);
  
  console.log(`Found ${keys.length} keys. Downloading values...`);
  
  const kvData = [];
  let count = 0;
  
  for (const item of keys) {
    const key = item.name;
    // Skip audit logs and ephemeral states, we only need user and product data for D1
    if (key.startsWith('audit:') || key.startsWith('state:') || key === 'global:join_queue') {
      continue;
    }
    
    count++;
    console.log(`[${count}/${keys.length}] Fetching value for key: ${key}`);
    
    // Get value for each key
    const valueOutput = execSync(`npx wrangler kv key get "${key}" --binding=AZTRACKER_DB`, execOptions);
    
    let parsedValue = valueOutput;
    try {
        parsedValue = JSON.parse(valueOutput);
    } catch (e) {
        // If it's not JSON, store as string
        parsedValue = valueOutput.trim();
    }
    
    kvData.push({
      key: key,
      value: parsedValue
    });
  }
  
  fs.writeFileSync('./kv_export.json', JSON.stringify(kvData, null, 2));
  console.log(`\n✅ Success! Exported ${kvData.length} records to kv_export.json`);
  console.log("You can now run: node scripts/migrate_to_d1.js");

} catch (error) {
  console.error("❌ Error exporting KV data.");
  if (error.stdout) console.error("STDOUT:", error.stdout);
  if (error.stderr) console.error("STDERR:", error.stderr);
  console.error(error.message);
}
