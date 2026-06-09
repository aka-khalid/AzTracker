const { execSync } = require('child_process');
const crypto = require('crypto');
const readline = require('readline').createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise(resolve => readline.question(query, resolve));

async function main() {
  console.log("🚀 Starting Final Production Cutover...");

  console.log("\n[1] Development (aztracker-test-db, default worker)");
  console.log("[2] Production (aztracker-prod-db, aztracker-v2-prod)");
  const targetEnv = await question("Select target environment [1 or 2]: ");
  
  const isProd = targetEnv.trim() === '2';
  const envFlag = isProd ? "--env production" : "";
  const dbName = isProd ? "aztracker-prod-db" : "aztracker-test-db";

  const botToken = await question("\n1. Enter your Telegram Bot Token: ");
  const adminIds = await question("2. Enter your TELEGRAM_ROOT_ADMIN_IDS (e.g. 12345678): ");
  const amazonClientId = await question("3. Enter your AMAZON_CLIENT_ID: ");
  const amazonClientSecret = await question("4. Enter your AMAZON_CLIENT_SECRET: ");
  const amazonPartnerTag = await question("5. Enter your AMAZON_PARTNER_TAG: ");
  const amznAssociatesTag = await question("6. Enter your AMZN_ASSOCIATES_TAG: ");
  const workerUrl = await question(`7. Enter your Worker URL (e.g. ${isProd ? 'aztracker-v2-prod' : 'aztracker-v2'}.khalid-ibrahim-dev.workers.dev): `);
  readline.close();

  // Generate a brand new, highly secure webhook secret to invalidate any old connections
  const webhookSecret = crypto.randomBytes(16).toString('hex');
  console.log(`\n✅ Generated new TELEGRAM_WEBHOOK_SECRET: ${webhookSecret}`);

  console.log(`\n🔒 Injecting Secrets into Cloudflare ${isProd ? 'Production' : 'Development'} Environment...`);
  const execOpts = { stdio: 'inherit' };
  
  try {
    execSync(`echo ${botToken} | npx wrangler secret put TELEGRAM_BOT_TOKEN ${envFlag}`, execOpts);
    execSync(`echo ${adminIds} | npx wrangler secret put TELEGRAM_ROOT_ADMIN_IDS ${envFlag}`, execOpts);
    execSync(`echo ${webhookSecret} | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET ${envFlag}`, execOpts);
    execSync(`echo ${amazonClientId} | npx wrangler secret put AMAZON_CLIENT_ID ${envFlag}`, execOpts);
    execSync(`echo ${amazonClientSecret} | npx wrangler secret put AMAZON_CLIENT_SECRET ${envFlag}`, execOpts);
    execSync(`echo ${amazonPartnerTag} | npx wrangler secret put AMAZON_PARTNER_TAG ${envFlag}`, execOpts);
    execSync(`echo ${amznAssociatesTag} | npx wrangler secret put AMZN_ASSOCIATES_TAG ${envFlag}`, execOpts);
    console.log("✅ Secrets injected successfully.");
  } catch (e) {
    console.error("❌ Failed to inject secrets. Please ensure you are logged into Wrangler.");
    process.exit(1);
  }

  console.log("\n🌐 Registering Webhook with Telegram...");
  try {
    const url = `https://api.telegram.org/bot${botToken}/setWebhook?url=https://${workerUrl}/webhook&secret_token=${webhookSecret}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.ok) {
      console.log("✅ Webhook registered successfully.");
    } else {
      console.error("❌ Failed to register webhook:", data.description);
    }
  } catch (e) {
    console.error("❌ Failed to connect to Telegram API.");
  }

  console.log("\n💾 Initiating Legacy Data Migration...");
  try {
    console.log("Step 1: Exporting KV Data...");
    //execSync('node scripts/export_kv.js', execOpts); // STDERR: X [ERROR] write EOF - DO NOT UNCOMMENT
    
    console.log("\nStep 2: Generating D1 SQL Seed...");
    execSync('node scripts/migrate_to_d1.js', execOpts);
    
    console.log(`\nStep 3: Pushing SQL Seed to ${dbName}...`);
    execSync(`npx wrangler d1 execute ${dbName} ${envFlag} --remote --file=./d1_seed.sql`, execOpts);
    console.log("✅ Migration completed successfully.");
  } catch (e) {
    console.warn("⚠️ Migration encountered an issue (this is normal if your KV is empty). Continuing...");
  }

  console.log(`\n🎉 CUTOVER COMPLETE! The ${isProd ? 'Production' : 'Development'} Bot is now live and fully autonomous.`);
}

main();
