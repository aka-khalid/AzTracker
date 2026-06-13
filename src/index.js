import { scheduled } from './workers/cron_trigger.js';
import { queue } from './workers/queue_worker.js';
import { handleTelegramWebhook } from './routes/telegram_webhook.js';
import { fetchAPI } from './routes/crm_dashboard.js';
import { fetchUserAPI } from './routes/user_dashboard.js';

export default {
  async scheduled(event, env, ctx) {
    return scheduled(event, env, ctx);
  },

  async queue(batch, env, ctx) {
    return queue(batch, env, ctx);
  },

  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // Route: Telegram Webhook
      if (request.method === 'POST' && (url.pathname === '/webhook' || url.pathname.startsWith('/webhook/'))) {
        return await handleTelegramWebhook(request, env, ctx);
      }

      // Try User API routing
      const userRes = await fetchUserAPI(request, env, ctx);
      if (userRes) return userRes;

      // Pass all other requests to the internal API router
      return await fetchAPI(request, env, ctx);
    } catch (e) {
      console.error("Worker Global Error:", e);
      return new Response("An unexpected error occurred. Please try again later.", { status: 500 });
    }
  }
};
