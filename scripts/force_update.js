const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

// Force Update Broadcast Script
// This script pulls all users from the D1 database and sends them a broadcast message
// telling them to hit /start to refresh their cached UI.

const args = process.argv.slice(2);
const isProd = args.includes('--env') && args[args.indexOf('--env') + 1] === 'prod';
const envName = isProd ? 'production' : 'local';

console.log(`\n🚀 Starting Force Update Broadcast (${envName.toUpperCase()})...`);

let token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
    console.error('❌ Could not find TELEGRAM_BOT_TOKEN environment variable.');
    console.error('Since it is stored securely in Cloudflare Secrets, you must provide it when running the script:');
    console.error('On Windows (PowerShell):');
    console.error('  $env:TELEGRAM_BOT_TOKEN="your_token_here"; node scripts/force_update.js --env prod');
    process.exit(1);
}

async function run() {
    try {
        console.log('📦 Fetching non-admin users from D1 Database...');
        
        // Execute wrangler command to get users, excluding admins
        const dbCmd = isProd 
            ? `npx wrangler d1 execute DB --env production --remote --command "SELECT chat_id, lang FROM Users WHERE role != 'admin' OR role IS NULL" --json`
            : `npx wrangler d1 execute DB --remote --command "SELECT chat_id, lang FROM Users WHERE role != 'admin' OR role IS NULL" --json`;
            
        const output = execSync(dbCmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        const data = JSON.parse(output);
        const users = data[0].results;
        
        console.log(`✅ Found ${users.length} regular users. Beginning broadcast...`);
        console.log(`⚠️  Rate limiting to 20 messages per second to respect Telegram API limits.\n`);

        let successCount = 0;
        let failCount = 0;

        for (const user of users) {
            const chatId = user.chat_id;
            const lang = user.lang || 'masry';
            
            // Localized message
            const text = lang === 'masry' 
                ? '🚀 عملنا تحديث جديد وكبير للبوت!\n\nعشان المنيو الجديد والواجهة يظبطوا معاك، دوس على كلمة "Menu" تحت على الشمال، وبعدين اختار "Main Menu (/start)".'
                : '🚀 We\'ve just launched a massive update to the bot!\n\nTo ensure your interface and native menu are fully synced, please click on "Menu" in the bottom left, and then select "Main Menu (/start)".';

            const body = {
                chat_id: chatId,
                text: text
            };

            try {
                const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                
                if (res.ok) {
                    successCount++;
                    process.stdout.write('🟢');
                } else {
                    const err = await res.json();
                    if (err.error_code === 403) {
                        // User blocked the bot
                        process.stdout.write('🔴');
                    } else {
                        failCount++;
                        process.stdout.write('🟡');
                    }
                }
            } catch (e) {
                failCount++;
                process.stdout.write('🟡');
            }

            // Sleep 50ms to strictly enforce < 30 msgs/sec limit
            await new Promise(r => setTimeout(r, 50));
        }

        console.log(`\n\n🎉 Broadcast Complete!`);
        console.log(`✅ Delivered: ${successCount}`);
        console.log(`❌ Failed: ${failCount}`);

    } catch (e) {
        console.error('\n❌ Failed to execute script:', e.message);
    }
}

run();
