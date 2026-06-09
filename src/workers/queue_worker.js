import { executeScrapeEngine } from './scraper_engine.js';
import { sendTelegramMessage } from '../core/telegram.js';

export async function queue(batch, env, ctx) {
    if (batch.queue === 'scraper-queue') {
      return; // Kill switch to manual trigger for scraper engine to avoid infinite loops during development
      for (const msg of batch.messages) {
        try {
          const offset = msg.body.offset || 0;
          const hasMore = await executeScrapeEngine(env, offset);
          if (hasMore) {
            // Recurse: Trigger the next batch with a 2-second linear delay
            await env.SCRAPER_QUEUE.send({ offset: offset + 10 }, { delaySeconds: 1 });
          }
          msg.ack();
        } catch (e) {
          console.error("Scraper Queue Error:", e);
          msg.retry({ delaySeconds: 30 });
        }
      }
      return;
    }

    let rateLimited = false;
    let retryDelay = 5;
    for (const msg of batch.messages) {
      if (rateLimited) {
        msg.retry({ delaySeconds: retryDelay });
        continue;
      }
      try {
        const payload = msg.body;
        if (payload.type === 'telegram_alert' || payload.type === 'telegram_alert_new' || payload.type === 'telegram_alert_used') {
          const res = await sendTelegramMessage(env, payload.chatId, payload.text, payload.markup);
          if (res && !res.ok) {
            if (res.error_code === 429) {
              rateLimited = true;
              retryDelay = res.parameters?.retry_after || 5;
              msg.retry({ delaySeconds: retryDelay });
              continue;
            } else if (res.error_code === 403) {
              // User blocked the bot - Pause them!
              await env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 1 WHERE chat_id = ?").bind(payload.chatId).run();
              msg.ack();
              continue;
            }
            throw new Error(res.description || "Telegram API Error");
          } else {
            // Atomic 2PC: Update D1 lock ONLY on successful delivery
            if (payload.asin && payload.type === 'telegram_alert_new') {
               await env.DB.prepare("UPDATE User_Subscriptions SET alert_sent_new = 1 WHERE chat_id = ? AND asin = ?").bind(payload.chatId, payload.asin).run();
            }
            if (payload.asin && payload.type === 'telegram_alert_used') {
               await env.DB.prepare("UPDATE User_Subscriptions SET alert_sent_used = 1 WHERE chat_id = ? AND asin = ?").bind(payload.chatId, payload.asin).run();
            }
          }
        }
        msg.ack();
      } catch (e) {
        console.error("Queue error:", e);
        msg.retry();
      }
    }
}
