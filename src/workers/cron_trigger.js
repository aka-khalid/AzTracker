export async function scheduled(event, env, ctx) {
    console.log(`[CRON START] Received event for schedule: ${event.cron}`);
    if (event.cron === "*/5 * * * *") { //daily rate-limit emergency survival
    //if (event.cron === "* * * * *") {
    try {
        const now = Date.now();
        // 1. D1 Garbage Collection for Bot_States
        await env.DB.prepare("DELETE FROM Bot_States WHERE expires_at < ?").bind(now).run();

        // 2. Dynamic Governor Logic
        const lastRunStr = await env.DB.prepare("SELECT value FROM Bot_States WHERE key = 'last_run_time'").first('value');
        const lastRunMs = lastRunStr ? parseInt(lastRunStr, 10) : 0;
        
        const poolSizeRes = await env.DB.prepare("SELECT COUNT(DISTINCT asin) as c FROM User_Subscriptions WHERE is_paused = 0").first();
        const poolSize = poolSizeRes ? poolSizeRes.c : 0;
        
        console.log(`[GOVERNOR] Pool Size: ${poolSize} | lastRunMs: ${lastRunMs} | Now: ${now}`);
        if (poolSize === 0) {
          console.log(`[GOVERNOR] Aborting: Pool size is 0`);
          return;
        }
        
        const batches = Math.ceil(poolSize / 10);
        const maxRuns = Math.floor(8640 / batches);
        const intervalMs = Math.floor(86400000 / maxRuns);

        console.log(`[GOVERNOR] Calc -> intervalMs: ${intervalMs} | Time since last run: ${now - lastRunMs}`);

        if ((now - lastRunMs) >= intervalMs) {s
          console.log(`[GOVERNOR] Dispatching queue offset 0`);
          // Update lock and trigger the recursive chain reaction
          await env.DB.prepare("INSERT OR REPLACE INTO Bot_States (key, value, expires_at) VALUES ('last_run_time', ?, ?)").bind(now.toString(), now + 86400000).run();
          await env.SCRAPER_QUEUE.send({ offset: 0 });
        } else {
          console.log(`[GOVERNOR] Skipped: Interval not met.`);
        }
      } catch (e) {
        console.error("Scheduled execution failed:", e);
      }
    }
}
