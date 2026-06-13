const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const delay = ms => new Promise(res => setTimeout(res, ms));

async function run() {
    const crmPath = path.join(__dirname, '..', 'src', 'routes', 'crm_dashboard.js');
    const crmBackupPath = path.join(__dirname, '..', 'src', 'routes', 'crm_dashboard.backup.js');
    
    const userPath = path.join(__dirname, '..', 'src', 'routes', 'user_dashboard.js');
    const userBackupPath = path.join(__dirname, '..', 'src', 'routes', 'user_dashboard.backup.js');
    
    const tomlPath = path.join(__dirname, '..', 'wrangler.toml');
    const tempTomlPath = path.join(__dirname, '..', 'wrangler.temp.toml');
    
    // 1. Backup and Patch
    console.log("Patching crm_dashboard.js for Puppeteer auth bypass...");
    fs.copyFileSync(crmPath, crmBackupPath);
    
    let code = fs.readFileSync(crmPath, 'utf8');
    const patchTarget = `async function authAdmin(req, environment) {`;
    const patchReplacement = `async function authAdmin(req, environment) {
      if (req.headers.get("Authorization") === "Bearer puppeteer_mock") {
          return { user: { id: 760872964, first_name: "Khalid" }, isRootAdmin: true };
      }
    `;
    code = code.replace(patchTarget, patchReplacement);
    fs.writeFileSync(crmPath, code);

    console.log("Patching user_dashboard.js for Puppeteer auth bypass...");
    fs.copyFileSync(userPath, userBackupPath);
    
    let userCode = fs.readFileSync(userPath, 'utf8');
    const userPatchTarget = `    const initData = authHeader.substring("Bearer ".length);`;
    const userPatchReplacement = `    const initData = authHeader.substring("Bearer ".length);
    if (initData === "puppeteer_mock") {
        var chatId = "760872964";
    } else {
    `;
    const userClosePatchTarget = `    if (!chatId) return new Response("Unauthorized", { status: 401 });`;
    const userClosePatchReplacement = `    } // close else block
    if (!chatId) return new Response("Unauthorized", { status: 401 });`;
    
    userCode = userCode.replace(userPatchTarget, userPatchReplacement);
    userCode = userCode.replace(userClosePatchTarget, userClosePatchReplacement);
    fs.writeFileSync(userPath, userCode);

    console.log("Creating temporary wrangler.temp.toml targeting production database...");
    let tomlCode = fs.readFileSync(tomlPath, 'utf8');
    tomlCode = tomlCode.replace(/name = "aztracker-dev-worker"/, 'name = "aztracker-temp-ui"');
    // Bind the top-level D1 to prod instead of dev
    tomlCode = tomlCode.replace(/database_name = "aztracker-dev-db"/, 'database_name = "aztracker-prod-db"');
    tomlCode = tomlCode.replace(/database_id = "8e5a0b8c-d5e7-4f2d-a738-388b0c60bb43"/, 'database_id = "7998ba93-e8ef-42c5-b37b-580e233a2d6a"');
    
    tomlCode = tomlCode.replace(/\[vars\]/, '[vars]\nTELEGRAM_ROOT_ADMIN_IDS = "760872964"');
    
    // Remove queues from the temp TOML because multiple workers cannot consume the same queue
    tomlCode = tomlCode.replace(/\[\[queues.*?\]\][\s\S]*?(?=\[|$)/g, '');
    tomlCode = tomlCode.replace(/\[\[env\.production\.queues.*?\]\][\s\S]*?(?=\[|$)/g, '');
    
    fs.writeFileSync(tempTomlPath, tomlCode);

    console.log("Deploying temporary worker aztracker-temp-ui to Cloudflare...");
    const deployArgs = ['wrangler', 'deploy', '--config', 'wrangler.temp.toml'];
    const deploy = spawn('npx', deployArgs, { shell: true });
    
    await new Promise((resolve, reject) => {
        let deployedUrl = '';
        deploy.stdout.on('data', (data) => {
            const str = data.toString();
            console.log("[Deploy]", str.trim());
            const match = str.match(/(https:\/\/[^\s]+)/);
            if (match && match[1].includes('aztracker-temp-ui')) {
                deployedUrl = match[1];
            }
        });
        deploy.stderr.on('data', (data) => console.log("[Deploy ERR]", data.toString().trim()));
        deploy.on('close', (code) => {
            if (code === 0 && deployedUrl) resolve(deployedUrl);
            else reject(new Error("Deploy failed or URL not found"));
        });
    });

    const url = 'https://aztracker-temp-ui.khalid-ibrahim-dev.workers.dev/crm';
    console.log("Worker deployed successfully. URL: " + url);
    console.log("Launching Puppeteer...");

    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    
    // Intercept and block the official Telegram script so it doesn't overwrite our mock
    await page.setRequestInterception(true);
    page.on('request', request => {
        if (request.url().includes('telegram-web-app.js')) {
            request.respond({
                status: 200,
                contentType: 'application/javascript',
                body: 'console.log("Mocked Telegram API blocked");'
            });
        } else {
            request.continue();
        }
    });
    
    // iPhone 15 Pro Max preset
    await page.setViewport({ width: 430, height: 932, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');

    await page.evaluateOnNewDocument(() => {
        window.Telegram = { WebApp: { initData: "puppeteer_mock", colorScheme: "dark", expand: () => {}, ready: () => {}, setHeaderColor: () => {}, setBackgroundColor: () => {} } };
    });

    const assetsDir = path.join(__dirname, '..', 'docs', 'assets');
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

    async function snap(name, waitMs = 500) {
        if (waitMs) await delay(waitMs);
        await page.evaluate(() => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            const nodes = [];
            while (walker.nextNode()) nodes.push(walker.currentNode);
            for (const node of nodes) {
                const text = node.nodeValue;
                if (/@\w+/.test(text) || /\(\d{8,11}\)/.test(text)) {
                    if (!node.parentNode || node.parentNode.style.filter.includes('blur')) continue;
                    const blurredHTML = text.replace(/(@\w+|\(\d{8,11}\))/g, '<span style="filter: blur(4px)">$1</span>');
                    const span = document.createElement('span');
                    span.innerHTML = blurredHTML;
                    node.parentNode.replaceChild(span, node);
                }
            }
        });
        await page.screenshot({ path: path.join(assetsDir, name + '.png') });
        console.log("Captured: " + name);
    }

    // Run for both English and Arabic
    const langs = ['en', 'ar'];
    for (const lang of langs) {
        const langSuffix = lang === 'ar' ? '_ar' : '';
        const targetUrl = url + '?lang=' + (lang === 'ar' ? 'masry' : 'en');
        
        console.log(`\nNavigating to CRM (${lang.toUpperCase()})...`);
        await page.goto(targetUrl, { waitUntil: 'networkidle0' });
        await snap('01_dashboard' + langSuffix, 2000);

        // Users view
        await page.click('#main-tab-users-view');
        await snap('02_users_approved' + langSuffix, 1500);

        await page.click('#tab-queue');
        await snap('03_users_pending' + langSuffix, 1500);

        await page.click('#tab-banned');
        await snap('04_users_banned' + langSuffix, 1500);

        await page.click('#tab-admins');
        await snap('05_users_admins' + langSuffix, 1500);

        // Audit view
        await page.click('#main-tab-audit-view');
        await snap('06_security_audit' + langSuffix, 2000);

        // Back to system view
        await page.click('#main-tab-system-view');
        await delay(500);

        // Active Drawer
        await page.evaluate(() => openActiveDrawer());
        await snap('07_active_products_drawer' + langSuffix, 1500);
        await page.evaluate(() => closeActiveDrawer());
        await delay(500);

        // Top Charts Drawer
        await page.evaluate(() => openTopChartsDrawer());
        await snap('08_top_charts_drawer' + langSuffix, 1500);
        await page.evaluate(() => closeTopChartsDrawer());
        await delay(500);

        // Paused Drawer
        await page.evaluate(() => openPausedDrawer());
        await snap('09_paused_products_drawer' + langSuffix, 1500);
        await page.evaluate(() => closePausedDrawer());
        await delay(500);

        // Graveyard Drawer
        await page.evaluate(() => openGraveyardDrawer());
        await snap('10_ghost_graveyard_drawer' + langSuffix, 1500);
        await page.evaluate(() => closeGraveyardDrawer());
        await delay(500);

        // Product Subscribers Drawer (using B0F43PYM98)
        await page.evaluate(() => openProductSubsDrawer('B0F43PYM98'));
        await snap('12_product_subscribers_drawer' + langSuffix, 2000);
        await page.evaluate(() => closeProductSubsDrawer());
        await delay(500);

        // Chart Modal (using B0F43PYM98)
        await page.evaluate(() => openChartModal('B0F43PYM98'));
        await snap('13_chart_modal' + langSuffix, 2000);
        await page.evaluate(() => closeChartModal());
        await delay(500);

        // User Products Drawer (using user 760872964)
        await page.evaluate(() => openDrawer('760872964'));
        await snap('11_user_products_drawer' + langSuffix, 2000);
        await page.evaluate(() => closeDrawer());
        await delay(500);

        // --- NEW USER DASHBOARD SCREENS ---
        console.log(`Navigating to User Dashboard (${lang.toUpperCase()})...`);
        const userUrl = url.replace('/crm', '/user_app') + '?lang=' + (lang === 'ar' ? 'masry' : 'en');
        await page.goto(userUrl, { waitUntil: 'networkidle0' });
        await snap('14_user_dashboard' + langSuffix, 3000); // User Products Tab

        // Click Hot Deals tab
        await page.click('#tab-hotdeals');
        await snap('15_hot_deals' + langSuffix, 2000);
    }

    console.log("Closing browser...");
    await browser.close();

    console.log("Restoring crm_dashboard.js...");
    fs.copyFileSync(crmBackupPath, crmPath);
    fs.unlinkSync(crmBackupPath);
    
    console.log("Restoring user_dashboard.js...");
    fs.copyFileSync(userBackupPath, userPath);
    fs.unlinkSync(userBackupPath);
    
    console.log("Deleting temporary worker...");
    const cleanupArgs = ['wrangler', 'delete', '--config', 'wrangler.temp.toml', '--name', 'aztracker-temp-ui', '--force'];
    const cleanup = spawn('npx', cleanupArgs, { shell: true });
    await new Promise((resolve) => cleanup.on('close', resolve));
    
    console.log("Removing temp toml...");
    if (fs.existsSync(tempTomlPath)) fs.unlinkSync(tempTomlPath);

    console.log("✅ All screenshots captured successfully in docs/assets/");
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
