import { scheduled } from './workers/cron_trigger.js';
import { queue } from './workers/queue_worker.js';
import { handleTelegramWebhook } from './routes/telegram_webhook.js';
import { fetchAPI } from './routes/crm_dashboard.js';

export default {
  async scheduled(event, env, ctx) {
    return scheduled(event, env, ctx);
  },

  async queue(batch, env, ctx) {
    return queue(batch, env, ctx);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Route: Telegram Webhook
    if (request.method === 'POST' && (url.pathname === '/webhook' || url.pathname.startsWith('/webhook/'))) {
      return handleTelegramWebhook(request, env, ctx);
    }

    // Pass all other requests to the internal API router
    return fetchAPI(request, env, ctx);
  }
};
