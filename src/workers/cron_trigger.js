import { logAudit } from '../core/db.js';
import { t } from '../core/i18n.js';

export async function scheduled(event, env, ctx) {
    console.log(`[CRON START] Received event for schedule: ${event.cron}`);
    
    // Dynamically parse the hardware cron interval from the event
    let hardwareMinutes = 5; // fallback
    if (event.cron) {
        const minPart = event.cron.split(' ')[0];
        if (minPart.startsWith('*/')) {
            hardwareMinutes = parseInt(minPart.substring(2), 10);
        } else if (minPart === '*') {
            hardwareMinutes = 1;
        }
    }
    const hardwareCronMs = hardwareMinutes * 60000;
    try {
        const now = Date.now();
        // 1. D1 Garbage Collection, Dormancy Sweep & Save Hardware Cron
        await env.DB.prepare("DELETE FROM Bot_States WHERE expires_at < ?").bind(now).run();
        await env.DB.prepare("INSERT OR REPLACE INTO Bot_States (key, value, expires_at) VALUES ('hardware_cron_interval', ?, ?)").bind(hardwareCronMs.toString(), now + 86400000 * 30).run();

        // 1b. Dormancy Sweep (30 Days)
        const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
        const dormantCutoff = now - thirtyDaysMs;
        await env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 1 WHERE is_paused = 0 AND chat_id IN (SELECT chat_id FROM Users WHERE last_active > 0 AND last_active < ?)").bind(dormantCutoff).run();

        // 1c. Idle User Cleanup (7 Days)
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        const idleCutoff = now - sevenDaysMs;
        const idleUsersRes = await env.DB.prepare("SELECT chat_id, lang FROM Users WHERE role = 'approved' AND last_active IS NULL AND created_at < ?").bind(idleCutoff).all();
        
        if (idleUsersRes.results && idleUsersRes.results.length > 0) {
            for (const user of idleUsersRes.results) {
                const targetId = user.chat_id.toString();
                await env.DB.prepare("UPDATE Users SET role = 'rejected' WHERE chat_id = ?").bind(targetId).run();
                
                // Clear their auth cache so they are instantly logged out
                ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/roles/${targetId}`)));
                
                // Send the polite warning message
                const tl = user.lang || 'masry';
                await env.MESSAGE_QUEUE.send({
                    chatId: targetId,
                    text: t('crm.notify_revoked_idle', tl)
                });
                
                // Log it automatically in CRM
                ctx.waitUntil(logAudit(env, 'SYSTEM', 'AUTO_CLEANUP_IDLE', targetId, {}));
            }
        }

        // 2. Fetch Dynamic Limits
        const todayStr = new Date().toISOString().split('T')[0];
        const lastProbeStr = await env.DB.prepare("SELECT value FROM Bot_States WHERE key = 'amazon_last_probe_date'").first('value');
        
        let currentLimitStr = null;
        let ssthreshStr = null;
        if (env.AZTRACKER_DB) {
            currentLimitStr = await env.AZTRACKER_DB.get('amazon_dynamic_limit');
            ssthreshStr = await env.AZTRACKER_DB.get('amazon_ssthresh');
        }
        let currentLimit = parseInt(currentLimitStr || (env.AMAZON_DAILY_LIMIT || '8640'), 10);
        const ssthresh = ssthreshStr ? parseInt(ssthreshStr, 10) : Infinity;

        // 3. Dynamic Governor Logic & Bottleneck Selection
        const lastRunStr = await env.DB.prepare("SELECT value FROM Bot_States WHERE key = 'last_run_time'").first('value');
        const lastRunMs = lastRunStr ? parseInt(lastRunStr, 10) : 0;
        
        const poolSizeRes = await env.DB.prepare(`
            SELECT COUNT(*) as c FROM (
                SELECT asin FROM Global_Products WHERE always_track = 1
                UNION
                SELECT asin FROM User_Subscriptions WHERE is_paused = 0
            )
        `).first();
        const poolSize = poolSizeRes ? poolSizeRes.c : 0;
        
        if (poolSize === 0) {
          console.log(`[GOVERNOR] Aborting: Pool size is 0`);
          return;
        }
        
        const batches = Math.ceil(poolSize / 10);
        
        // CF Budget
        const opsLimit = parseInt(env.DAILY_QUEUE_LIMIT || '10000', 10);
        const dailyMessageBudget = Math.floor((opsLimit * 0.9) / 3);
        const cfMaxRuns = Math.max(1, Math.floor(dailyMessageBudget / batches));
        
        // Amazon Budget (1 batch = 1 API request approx due to caching)
        const amazonMaxRuns = Math.max(1, Math.floor(currentLimit / batches));
        
        // Bottleneck selection
        const maxRuns = Math.min(cfMaxRuns, amazonMaxRuns);
        const activeBottleneck = cfMaxRuns < amazonMaxRuns ? 'CLOUDFLARE' : 'AMAZON';

        // 4. AIMD Daily Probe (TCP Slow Start & Congestion Avoidance)
        if (lastProbeStr !== todayStr && env.AZTRACKER_DB) {
            if (activeBottleneck === 'AMAZON') {
                if (currentLimit < ssthresh) {
                    // Safe Territory: Slow Start (+50%)
                    currentLimit = Math.floor(currentLimit * 1.50);
                    console.log(`[GOVERNOR] 🚀 Daily Probe (Slow Start): Limit increased to ${currentLimit}`);
                } else {
                    // Danger Zone: Congestion Avoidance (+5%)
                    currentLimit = Math.floor(currentLimit * 1.05);
                    console.log(`[GOVERNOR] 🛸 Daily Probe (Cruising): Limit increased to ${currentLimit}`);
                }
                await env.AZTRACKER_DB.put('amazon_dynamic_limit', currentLimit.toString());
            } else {
                console.log(`[GOVERNOR] 🛡️ Daily Probe Skipped: Engine is safely bottlenecked by Cloudflare. Amazon limit was not tested.`);
            }
            await env.DB.prepare("INSERT OR REPLACE INTO Bot_States (key, value, expires_at) VALUES ('amazon_last_probe_date', ?, ?)").bind(todayStr, now + 86400000 * 30).run();
        }

        const intervalMs = Math.floor(86400000 / maxRuns);

        console.log(`[GOVERNOR] Bottleneck: ${activeBottleneck} | Max Runs: ${maxRuns} | Calc -> intervalMs: ${intervalMs} | Time since last run: ${now - lastRunMs}`);

        if ((now - lastRunMs) >= intervalMs) {
          console.log(`[GOVERNOR] Dispatching queue offset 0`);
          // Update lock and trigger the recursive chain reaction
          await env.SCRAPER_QUEUE.send({ offset: 0 });
          await env.DB.prepare("INSERT OR REPLACE INTO Bot_States (key, value, expires_at) VALUES ('last_run_time', ?, ?)").bind(now.toString(), now + 86400000).run();
        } else {
          console.log(`[GOVERNOR] Skipped: Interval not met.`);
        }
      } catch (e) {
        console.error("Scheduled execution failed:", e);
      }
}
