#!/usr/bin/env node
/**
 * finalize_cutover.js — AzTracker V1 → V2 Production Cutover
 *
 * Migrates a legacy AzTracker KV-based deployment to the new D1-backed V2
 * architecture. Handles secret injection, webhook registration, and data
 * migration in a single guided flow.
 *
 * Usage:
 *   node finalize_cutover.js [options]
 *
 * Options:
 *   --help, -h          Show this help message
 *   --dry-run           Print what would happen without making changes
 *   --env <name>        Target environment: dev | prod (default: dev)
 *   --db <name>         D1 database name (default: aztracker-test-db)
 *   --skip-migration    Skip the KV → D1 data migration step
 *   --skip-secrets      Skip the secret injection step
 *   --skip-webhook      Skip the Telegram webhook registration step
 *
 * Environment variables (all optional — script will prompt for any not set):
 *   TELEGRAM_BOT_TOKEN         Telegram bot token
 *   TELEGRAM_ROOT_ADMIN_IDS     Comma-separated admin chat IDs
 *   AMAZON_CLIENT_ID            Amazon Creators API client ID
 *   AMAZON_CLIENT_SECRET        Amazon Creators API client secret
 *   AMAZON_PARTNER_TAG          Amazon partner tag for affiliate links
 *   AMZN_ASSOCIATES_TAG         Amazon Associates tag
 *   WORKER_URL                  Worker URL (e.g. aztracker-v2.workers.dev)
 *   CF_ACCOUNT_ID               Cloudflare account ID
 *   CF_API_TOKEN                Cloudflare API token
 *   CF_KV_NAMESPACE_ID          KV namespace ID (for data migration)
 *
 * Examples:
 *   # Interactive guided cutover (prompts for all values):
 *   node finalize_cutover.js
 *
 *   # Dry run to see what would happen:
 *   node finalize_cutover.js --dry-run
 *
 *   # Production cutover with env vars pre-set:
 *   TELEGRAM_BOT_TOKEN=xxx TELEGRAM_ROOT_ADMIN_IDS=123 node finalize_cutover.js --env prod
 */

const { execSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

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
${scriptName} — AzTracker V1 → V2 Production Cutover

USAGE:
  node ${scriptName} [options]

OPTIONS:
  --help, -h          Show this help message
  --dry-run           Print what would happen without making changes
  --env <name>        Target environment: dev | prod (default: dev)
  --db <name>         D1 database name (default: aztracker-test-db)
  --skip-migration    Skip the KV → D1 data migration step
  --skip-secrets      Skip the secret injection step
  --skip-webhook      Skip the Telegram webhook registration step

ENVIRONMENT:
  TELEGRAM_BOT_TOKEN         Telegram bot token
  TELEGRAM_ROOT_ADMIN_IDS     Comma-separated admin chat IDs
  AMAZON_CLIENT_ID            Amazon Creators API client ID
  AMAZON_CLIENT_SECRET        Amazon Creators API client secret
  AMAZON_PARTNER_TAG          Amazon partner tag for affiliate links
  AMZN_ASSOCIATES_TAG         Amazon Associates tag
  WORKER_URL                  Worker URL (e.g. aztracker-v2.workers.dev)
  CF_ACCOUNT_ID               Cloudflare account ID
  CF_API_TOKEN                Cloudflare API token
  CF_KV_NAMESPACE_ID          KV namespace ID (for data migration)

EXAMPLES:
  # Interactive guided cutover:
  node ${scriptName}

  # Dry run:
  node ${scriptName} --dry-run

  # Production cutover with env vars:
  TELEGRAM_BOT_TOKEN=xxx node ${scriptName} --env prod
`);
  process.exit(0);
}

const DRY_RUN = args.includes('--dry-run');
const TARGET_ENV = getArg('--env', 'dev');
const DB_NAME = getArg('--db', TARGET_ENV === 'prod' ? 'aztracker-prod-db' : 'aztracker-test-db');
const SKIP_MIGRATION = args.includes('--skip-migration');
const SKIP_SECRETS = args.includes('--skip-secrets');
const SKIP_WEBHOOK = args.includes('--skip-webhook');

const IS_PROD = TARGET_ENV === 'prod';
const ENV_FLAG = IS_PROD ? '--env production' : '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(msg) {
  console.log(`  ${msg}`);
}

function warn(msg) {
  console.warn(`  ⚠ ${msg}`);
}

function ok(msg) {
  console.log(`  ✔ ${msg}`);
}

function fail(msg) {
  console.error(`  ✖ ${msg}`);
}

function header(title) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  ${title}`);
  console.log(`${'─'.repeat(50)}`);
}

function execSafe(cmd, opts = {}) {
  if (DRY_RUN) {
    log(`[DRY-RUN] Would execute: ${cmd}`);
    return '';
  }
  try {
    return execSync(cmd, { encoding: 'utf-8', ...opts });
  } catch (e) {
    throw new Error(`Command failed: ${cmd}\n${e.stderr || e.message}`);
  }
}

function question(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => {
    rl.question(query, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Step 0: Prerequisite checks
// ---------------------------------------------------------------------------
async function checkPrerequisites() {
  header('Prerequisite Checks');
  let allPassed = true;

  // Check Node.js version
  try {
    const nodeVersion = process.version;
    const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);
    if (major >= 18) {
      ok(`Node.js ${nodeVersion}`);
    } else {
      warn(`Node.js ${nodeVersion} — v18+ recommended`);
    }
  } catch {
    fail('Node.js not found');
    allPassed = false;
  }

  // Check wrangler
  try {
    const wranglerVersion = execSafe('npx wrangler --version', { stdio: ['pipe', 'pipe', 'pipe'] });
    ok(`wrangler ${wranglerVersion.trim()}`);
  } catch {
    fail('wrangler not found. Install with: npm install -g wrangler');
    allPassed = false;
  }

  // Check wrangler auth (unless dry-run)
  if (!DRY_RUN) {
    try {
      execSafe('npx wrangler whoami', { stdio: ['pipe', 'pipe', 'pipe'] });
      ok('wrangler authenticated');
    } catch {
      fail('wrangler not authenticated. Run: npx wrangler login');
      allPassed = false;
    }
  }

  // Check schema.sql exists
  if (fs.existsSync('./schema.sql')) {
    ok('schema.sql found');
  } else {
    fail('schema.sql not found in current directory');
    allPassed = false;
  }

  // Check migration script exists
  if (fs.existsSync('./scripts/migrate_to_d1.js')) {
    ok('scripts/migrate_to_d1.js found');
  } else {
    fail('scripts/migrate_to_d1.js not found');
    allPassed = false;
  }

  if (!allPassed) {
    console.error('\n  ✖ Some prerequisites failed. Please fix them before proceeding.');
    process.exit(1);
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// Step 1: Gather inputs
// ---------------------------------------------------------------------------
async function gatherInputs() {
  header('Configuration');

  const inputs = {};

  // Environment
  log(`Target environment: ${IS_PROD ? 'Production' : 'Development'}`);
  log(`D1 database: ${DB_NAME}`);

  // Bot token
  const botTokenEnv = process.env.TELEGRAM_BOT_TOKEN;
  inputs.botToken = botTokenEnv || await question('Telegram Bot Token: ');

  // Admin IDs
  const adminIdsEnv = process.env.TELEGRAM_ROOT_ADMIN_IDS;
  inputs.adminIds = adminIdsEnv || await question('Telegram Root Admin IDs (comma-separated): ');

  // Amazon credentials
  const amazonClientIdEnv = process.env.AMAZON_CLIENT_ID;
  inputs.amazonClientId = amazonClientIdEnv || await question('Amazon Client ID: ');

  const amazonClientSecretEnv = process.env.AMAZON_CLIENT_SECRET;
  inputs.amazonClientSecret = amazonClientSecretEnv || await question('Amazon Client Secret: ');

  const amazonPartnerTagEnv = process.env.AMAZON_PARTNER_TAG;
  inputs.amazonPartnerTag = amazonPartnerTagEnv || await question('Amazon Partner Tag: ');

  const amznAssociatesTagEnv = process.env.AMZN_ASSOCIATES_TAG;
  inputs.amznAssociatesTag = amznAssociatesTagEnv || await question('Amazon Associates Tag: ');

  // Worker URL
  const workerUrlEnv = process.env.WORKER_URL;
  const defaultWorkerUrl = IS_PROD
    ? 'aztracker-v2-prod.YOUR_SUBDOMAIN.workers.dev'
    : 'aztracker-v2.YOUR_SUBDOMAIN.workers.dev';
  inputs.workerUrl = workerUrlEnv || await question(`Worker URL [${defaultWorkerUrl}]: `) || defaultWorkerUrl;

  // Validate required fields
  if (!inputs.botToken) {
    fail('Telegram Bot Token is required.');
    process.exit(1);
  }
  if (!inputs.adminIds) {
    fail('Telegram Root Admin IDs is required.');
    process.exit(1);
  }

  // Generate webhook secret
  inputs.webhookSecret = crypto.randomBytes(16).toString('hex');
  ok(`Generated TELEGRAM_WEBHOOK_SECRET: ${inputs.webhookSecret}`);

  return inputs;
}

// ---------------------------------------------------------------------------
// Step 2: Inject secrets
// ---------------------------------------------------------------------------
async function injectSecrets(inputs) {
  if (SKIP_SECRETS) {
    log('Skipping secret injection (--skip-secrets).');
    return;
  }

  header('Injecting Secrets');

  const secrets = [
    { name: 'TELEGRAM_BOT_TOKEN', value: inputs.botToken },
    { name: 'TELEGRAM_ROOT_ADMIN_IDS', value: inputs.adminIds },
    { name: 'TELEGRAM_WEBHOOK_SECRET', value: inputs.webhookSecret },
    { name: 'AMAZON_CLIENT_ID', value: inputs.amazonClientId },
    { name: 'AMAZON_CLIENT_SECRET', value: inputs.amazonClientSecret },
    { name: 'AMAZON_PARTNER_TAG', value: inputs.amazonPartnerTag },
    { name: 'AMZN_ASSOCIATES_TAG', value: inputs.amznAssociatesTag },
  ];

  for (const secret of secrets) {
    if (!secret.value) {
      log(`Skipping ${secret.name} (not provided)`);
      continue;
    }

    try {
      // Use execFileSync to avoid shell injection via secret.value
      execFileSync('npx', ['wrangler', 'secret', 'put', secret.name, ENV_FLAG], {
        encoding: 'utf-8',
        input: secret.value,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      ok(`${secret.name} injected`);
    } catch (e) {
      fail(`Failed to inject ${secret.name}: ${e.message}`);
      console.error(`  Remediation: Run manually: echo <value> | npx wrangler secret put ${secret.name} ${ENV_FLAG}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3: Register webhook
// ---------------------------------------------------------------------------
async function registerWebhook(inputs) {
  if (SKIP_WEBHOOK) {
    log('Skipping webhook registration (--skip-webhook).');
    return;
  }

  header('Registering Telegram Webhook');

  const url = `https://api.telegram.org/bot${inputs.botToken}/setWebhook?url=https://${inputs.workerUrl}/webhook&secret_token=${inputs.webhookSecret}`;

  if (DRY_RUN) {
    log(`[DRY-RUN] Would call: ${url.replace(inputs.botToken, '***TOKEN***').replace(inputs.webhookSecret, '***SECRET***')}`);
    return;
  }

  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.ok) {
      ok('Webhook registered successfully');
    } else {
      fail(`Webhook registration failed: ${data.description}`);
      log('  Remediation: Check bot token and worker URL, then retry.');
    }
  } catch (e) {
    fail(`Failed to connect to Telegram API: ${e.message}`);
    log('  Remediation: Check your internet connection and bot token.');
  }
}

// ---------------------------------------------------------------------------
// Step 4: Migrate KV data to D1
// ---------------------------------------------------------------------------
async function migrateKvToD1() {
  if (SKIP_MIGRATION) {
    log('Skipping data migration (--skip-migration).');
    return;
  }

  header('Data Migration (KV → D1)');

  // Step 4a: Check if kv_export.json exists
  if (!fs.existsSync('./kv_export.json')) {
    warn('kv_export.json not found.');
    log('  Attempting to export KV data via Cloudflare API...');

    const exportCmd = 'node scripts/export_kv.js';
    try {
      execSafe(exportCmd, { stdio: 'inherit' });
      ok('KV data exported to kv_export.json');
    } catch (e) {
      fail(`KV export failed: ${e.message}`);
      log('  Remediation: Export manually with:');
      log('    1. npx wrangler kv key list');
      log('    2. Fetch each key value');
      log('    3. Save as kv_export.json');
      log('  Or run: node scripts/migrate_to_d1.js --export-kv --api-token YOUR_TOKEN');
      return;
    }
  }

  // Step 4b: Generate D1 SQL seed
  log('Generating D1 SQL seed from kv_export.json...');
  try {
    execSafe('node scripts/migrate_to_d1.js', { stdio: 'inherit' });
    ok('d1_seed.sql generated');
  } catch (e) {
    fail(`Migration script failed: ${e.message}`);
    log('  Remediation: Check kv_export.json format and try: node scripts/migrate_to_d1.js --input ./kv_export.json');
    return;
  }

  // Step 4c: Push SQL to D1
  log(`Pushing SQL seed to ${DB_NAME}...`);

  try {
    const seed = fs.readFileSync('./d1_seed.sql', 'utf8');
    const singleLine = seed.split(';').map(s => s.trim()).filter(s => s.length > 0)
      .map(s => s.replace(/\s+/g, ' ').trim()).join(';\n') + ';';
    const cutoverFile = './d1_seed_cutover.sql';
    fs.writeFileSync(cutoverFile, 'PRAGMA foreign_keys = OFF;\n' + singleLine + '\nPRAGMA foreign_keys = ON;\n');

    execSafe(`npx wrangler d1 execute ${DB_NAME} ${ENV_FLAG} --remote --file=${cutoverFile}`, { stdio: 'inherit' });
    ok('SQL seed applied to D1');
  } catch (e) {
    fail(`Failed to push SQL to D1: ${e.message}`);
    log('  Remediation: Try manually:');
    log(`    npx wrangler d1 execute ${DB_NAME} ${ENV_FLAG} --remote --file=./d1_seed.sql`);
  }
}

// ---------------------------------------------------------------------------
// Step 5: Summary
// ---------------------------------------------------------------------------
function printSummary(inputs) {
  header('Cutover Complete');

  console.log(`
  Environment:     ${IS_PROD ? 'Production' : 'Development'}
  D1 Database:     ${DB_NAME}
  Worker URL:      ${inputs.workerUrl}
  Bot Token:       ${inputs.botToken ? '***' + inputs.botToken.slice(-4) : 'NOT SET'}
  Admin IDs:       ${inputs.adminIds}
  Webhook Secret:  ${inputs.webhookSecret}

  Next steps:
    1. Verify the bot responds: curl https://${inputs.workerUrl}/webhook
    2. Check the CRM dashboard: https://${inputs.workerUrl}/crm
    3. Enable CRON triggers in wranger.toml if desired
    4. Test a /start command in Telegram
`);

  if (SKIP_MIGRATION) {
    log('Note: Data migration was skipped. Run manually if needed:');
    log('  node scripts/migrate_to_d1.js');
    log(`  npx wrangler d1 execute ${DB_NAME} ${ENV_FLAG} --remote --file=./d1_seed.sql`);
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  AzTracker V1 → V2 Cutover');
  if (DRY_RUN) console.log('  *** DRY RUN MODE — No changes will be made ***');
  console.log('═══════════════════════════════════════════════════════');

  // Step 0: Prerequisites
  await checkPrerequisites();

  // Step 1: Gather inputs
  const inputs = await gatherInputs();

  // Confirmation
  if (!DRY_RUN) {
    console.log('\n  Ready to begin cutover.');
    console.log(`  Environment: ${IS_PROD ? 'PRODUCTION' : 'Development'}`);
    console.log(`  Database:    ${DB_NAME}`);
    const confirm = await question('\n  Proceed? (yes/no): ');
    if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
      console.log('  Aborted.');
      process.exit(0);
    }
  }

  // Step 2: Inject secrets
  await injectSecrets(inputs);

  // Step 3: Register webhook
  await registerWebhook(inputs);

  // Step 4: Migrate data
  await migrateKvToD1();

  // Step 5: Summary
  printSummary(inputs);
}

main().catch(err => {
  console.error(`\n  ✖ Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
