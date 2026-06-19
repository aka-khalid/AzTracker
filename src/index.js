import { scheduled } from './workers/cron_trigger.js';
import { queue } from './workers/queue_worker.js';
import { handleTelegramWebhook } from './routes/telegram_webhook.js';
import { fetchAPI } from './routes/crm_dashboard.js';
import { fetchUserAPI } from './routes/user_dashboard.js';

// ── IP-based Rate Limiting ────────────────────────────────────────────────
const RATE_WINDOW_MS = 60_000; // 1-minute window
const rateMap = new Map();

/**
 * Check IP-based rate limit.
 * @param {string} ip - Client IP
 * @param {number} maxReq - Maximum requests allowed in the window
 * @returns {boolean} true if request is allowed, false if rate-limited
 */
function checkIPRateLimit(ip, maxReq) {
  const now = Date.now();
  let entry = rateMap.get(ip);

  // Reset if window expired
  if (!entry || (now - entry.windowStart) >= RATE_WINDOW_MS) {
    entry = { count: 1, windowStart: now };
    rateMap.set(ip, entry);
    return true;
  }

  entry.count += 1;

  // Safety valve: prevent memory leak if map grows too large
  if (rateMap.size > 50000) rateMap.clear();

  return entry.count <= maxReq;
}

// Rate limit config per route group (requests per minute)
const RATE_LIMITS = {
  testAsin: 10,    // /api/test-asin — public PA API tool, limit strictly
  crm: 60,         // /crm HTML + /api/crm/* — admin tools, generous
  user: 60,        // /user_app HTML + /api/user/* — user WebApp, generous
};

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

      // Rate limit + route: CRM API endpoints
      if (url.pathname.startsWith('/api/crm/')) {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!checkIPRateLimit(ip, RATE_LIMITS.crm)) {
          return new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" } });
        }
        return await fetchAPI(request, env, ctx);
      }

      // Rate limit + route: CRM HTML + test-asin + migrate-kv
      if (url.pathname === '/crm' || url.pathname === '/api/test-asin' || url.pathname === '/api/migrate-kv') {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const limit = url.pathname === '/api/test-asin' ? RATE_LIMITS.testAsin : RATE_LIMITS.crm;
        if (!checkIPRateLimit(ip, limit)) {
          return new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" } });
        }
        return await fetchAPI(request, env, ctx);
      }

      // Try User API routing (rate-limited inside fetchUserAPI)
      const userRes = await fetchUserAPI(request, env, ctx);
      if (userRes) return userRes;

      // Catch-all: unknown paths get a 404 (prevents endpoint enumeration)
      return new Response(null, { status: 404 });
    } catch (e) {
      console.error("Worker Global Error:", e);
      return new Response("An unexpected error occurred. Please try again later.", { status: 500 });
    }
  }
};
