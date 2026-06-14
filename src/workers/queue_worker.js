import { executeScrapeEngine } from './scraper_engine.js';
import { sendTelegramMessage } from '../core/telegram.js';

const MAX_RETRY_ATTEMPTS = 5;
const DLQ_TABLE = 'Failed_Queue_Messages';

/**
 * Dead-letter a message that exceeded max retries.
 * Stores in D1 for later inspection/replay.
 */
async function deadLetter(env, queueName, msg, error) {
  try {
    await env.DB.prepare(
      "INSERT INTO Failed_Queue_Messages (queue_name, body, attempts, last_error, failed_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(queueName, JSON.stringify(msg.body), msg.attempts || 0, error.message, Date.now()).run();
  } catch (e) {
    console.error("DLQ write failed:", e);
  }
}

export async function queue(batch, env, ctx) {
    if (batch.queue.startsWith('scraper-queue')) {
      for (const msg of batch.messages) {
        try {
          if ((msg.attempts || 0) >= MAX_RETRY_ATTEMPTS) {
            console.error(`[ScraperQueue] Msg exceeded ${MAX_RETRY_ATTEMPTS} retries, dead-lettering`);
            await deadLetter(env, 'scraper-queue', msg, new Error('Max retries exceeded'));
            msg.ack();
            continue;
          }
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
        if ((msg.attempts || 0) >= MAX_RETRY_ATTEMPTS) {
          console.error(`[MsgQueue] Msg exceeded ${MAX_RETRY_ATTEMPTS} retries, dead-lettering`);
          await deadLetter(env, 'message-queue', msg, new Error('Max retries exceeded'));
          msg.ack();
          continue;
        }
        const payload = msg.body;
        if (payload.type === 'telegram_alert' || payload.type === 'telegram_alert_new' || payload.type === 'telegram_alert_used' || payload.type === 'telegram_broadcast') {
          const res = await sendTelegramMessage(env, payload.chatId, payload.text, payload.markup);
          if (res && !res.ok) {
            if (res.error_code === 429) {
              rateLimited = true;
              retryDelay = res.parameters?.retry_after || 5;
              msg.retry({ delaySeconds: retryDelay });
              continue;
            } else if (res.error_code === 403) {
              // User blocked the bot - Pause subscriptions to save resources
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
        if ((msg.attempts || 0) >= MAX_RETRY_ATTEMPTS) {
          console.error(`[MsgQueue] Msg exceeded ${MAX_RETRY_ATTEMPTS} retries, dead-lettering`);
          await deadLetter(env, 'message-queue', msg, e);
          msg.ack();
        } else {
          msg.retry();
        }
      }
    }
  }

