import { getUserRoles, logAudit } from '../core/db.js';
import { t, getWelcomeMessage } from '../core/i18n.js';
import { getAmazonAccessToken, AmazonEdgeParser } from '../core/amazon.js';
import { executeScrapeEngine, checkCircuitBreaker, recordCircuitSuccess, recordCircuitFailure } from '../workers/scraper_engine.js';
import { sendTelegramMessage as sendTelegram, editTelegramMessage } from '../core/telegram.js';
import { escapeHtml, buildBroadcastMessage, expandAmazonUrl, getAsinFromUrl } from '../core/utils.js';
import { setChatMenuButton } from './telegram_webhook.js';

async function generateSignature(secret, asin, exp) {
  const enc = new TextEncoder();
  if (!secret) throw new Error("Unauthorized: Missing key");
  const key = await crypto.subtle.importKey(
    "raw", 
    enc.encode(secret), 
    { name: "HMAC", hash: "SHA-256" }, 
    false, 
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(`${asin}:${exp}`));
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function verifyInitData(telegramInitData, botToken) {
  if (!telegramInitData || !botToken) return null;
  try {
    const urlParams = new URLSearchParams(telegramInitData);
    const hash = urlParams.get('hash');
    if (!hash) return null;
    urlParams.delete('hash');
    
    const keys = Array.from(urlParams.keys()).sort();
    const dataCheckString = keys.map(key => `${key}=${urlParams.get(key)}`).join('\n');
    
    const enc = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
      "raw",
      enc.encode("WebAppData"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    
    const secretKeyBytes = await crypto.subtle.sign("HMAC", secretKey, enc.encode(botToken));
    
    const hmacKey = await crypto.subtle.importKey(
      "raw",
      secretKeyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    
    const signature = await crypto.subtle.sign("HMAC", hmacKey, enc.encode(dataCheckString));
    const hexSignature = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
    
    if (hexSignature === hash) {
      const authDate = parseInt(urlParams.get('auth_date') || '0', 10);
      const now = Math.floor(Date.now() / 1000);
      if (now - authDate > 86400) {
        console.warn("InitData Verification Error: auth_date expired");
        return null;
      }
      
      const userStr = urlParams.get('user');
      if (userStr) return JSON.parse(userStr);
    }
  } catch (e) {
    console.error("InitData Verification Error:", e);
  }
  return null;
}

async function authAdmin(req, environment) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const initData = authHeader.replace("Bearer ", "");
  const userData = await verifyInitData(initData, environment.TELEGRAM_BOT_TOKEN);
  if (!userData) return null;
  
  const { admins, rootAdmins, lang } = await getUserRoles(userData.id.toString(), environment);
  
  const rootAdminsStr = (rootAdmins || []).map(String);
  const adminsStr = (admins || []).map(String);
  
  if (rootAdminsStr.includes(userData.id.toString())) return { user: userData, isRootAdmin: true, lang };
  if (adminsStr.includes(userData.id.toString())) return { user: userData, isRootAdmin: false, lang };
  
  return null;
}

export async function fetchAPI(request, env, ctx) {
    // CORS preflight — must be handled before any auth checks
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/crm/history/") && request.method === "GET") {
      const asin = url.pathname.split("/").filter(Boolean).pop();
      if (!asin || asin.length < 10) {
        return new Response(JSON.stringify({ error: "Invalid ASIN" }), { status: 400 });
      }

      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });

      let historyData = await env.AZTRACKER_DB.get(`history:${asin}`, "json") || [];
      

      
      return new Response(JSON.stringify(historyData), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }


    
    // --- CRM COMMAND CENTER ENDPOINTS ---
    
    if (url.pathname === "/crm" && request.method === "GET") {
      // Detect language from query param or default to English
      const langParam = url.searchParams.get("lang");
      const lang = langParam === 'masry' ? 'masry' : 'en';
      const isProd = url.hostname.includes('-prod-worker') || url.hostname.includes('prod');
      return new Response(renderCrmHTML(lang, isProd), {
        status: 200,
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }



    // Live price fetch + broadcast preview for CRM (with circuit breaker)
    if (url.pathname === "/api/crm/live-price" && request.method === "POST") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });

      let body;
      try { body = await request.json(); } catch (e) { return new Response("Invalid JSON", { status: 400 }); }
      let { asin, fetch_options = false, lang = 'masry' } = body;
      if (!asin) return new Response("Missing ASIN", { status: 400 });

      if (asin.includes('http')) {
        if (asin.includes('amzn.to') || asin.includes('amzn.eu') || asin.includes('a.co') || /amazon\.eg\/d\//.test(asin)) {
          asin = await expandAmazonUrl(asin);
        }
        const extracted = getAsinFromUrl(asin);
        if (extracted) asin = extracted;
      }
      
      if (!/^[A-Z0-9]{10}$/.test(asin)) {
        return new Response(JSON.stringify({ error: "invalid_asin", message: "Invalid ASIN or Amazon link" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }

      // Circuit breaker check
      const cbState = await checkCircuitBreaker(env);
      if (cbState === "open") {
        return new Response(JSON.stringify({ error: "circuit_open", message: "Amazon API paused — circuit breaker is open" }), { status: 429, headers: { "Content-Type": "application/json" } });
      }

      try {
        let accessToken = await env.AZTRACKER_DB.get('amazon_access_token');
        if (!accessToken) {
          const clientId = env.AMAZON_CLIENT_ID || env.AMZN_CREATORS_ACCESS_KEY || env.AWS_ACCESS_KEY_ID;
          const clientSecret = env.AMAZON_CLIENT_SECRET || env.AMZN_CREATORS_SECRET_KEY || env.AWS_SECRET_ACCESS_KEY;
          accessToken = await getAmazonAccessToken(clientId, clientSecret);
        }
        const parser = new AmazonEdgeParser(accessToken, env.AMAZON_PARTNER_TAG, 'www.amazon.eg', env);
        let items = [];
        let arabicNames = new Map();
        try {
          items = await parser.getItems([asin]);
          arabicNames = await parser.getItemsWithArabic([asin]);
        } catch (authErr) {
          if (authErr.message.includes("401") || authErr.message.includes("403") || authErr.message.includes("Token has expired")) {
            console.warn('[CRM LivePrice] Amazon token expired, refreshing and retrying...');
            await env.AZTRACKER_DB.delete('amazon_access_token');
            const clientId = env.AMAZON_CLIENT_ID || env.AMZN_CREATORS_ACCESS_KEY || env.AWS_ACCESS_KEY_ID;
            const clientSecret = env.AMAZON_CLIENT_SECRET || env.AMZN_CREATORS_SECRET_KEY || env.AWS_SECRET_ACCESS_KEY;
            accessToken = await getAmazonAccessToken(clientId, clientSecret);
            parser.accessToken = accessToken;
            items = await parser.getItems([asin]);
            arabicNames = await parser.getItemsWithArabic([asin]);
          } else {
            throw authErr;
          }
        }

        if (items.length === 0) {
          return new Response(JSON.stringify({ error: "not_found", message: "Product not found on Amazon" }), { status: 404, headers: { "Content-Type": "application/json" } });
        }

        const raw = items[0];
        raw.name_ar = arabicNames.get(asin) || raw.name_ar || null;

        // Determine the seller name for display
        const deal = {
          asin: raw.asin,
          name: raw.name,
          name_ar: raw.name_ar,
          detailPageURL: raw.detailPageURL || null,
          price: raw.amazonPrice || raw.newPrice || raw.usedPrice || 0,
          seller: raw.amazonSeller || raw.newSeller || raw.usedSeller || 'Unknown',
          mid: raw.amazonMid || raw.newMid || raw.usedMid || ''
        };

        // Build the broadcast message preview
        const broadcast = buildBroadcastMessage(env, deal, Date.now(), t);

        // Fetch options (variations) if requested
        let options = [];
        if (fetch_options) {
          try {
            options = await parser.getVariations(asin, lang);
          } catch (e) {
            console.warn('[CRM LivePrice] getVariations failed:', e.message);
          }
        }

        // Record success if half_open (closes the circuit)
        if (cbState === "half_open") {
          if (ctx?.waitUntil) ctx.waitUntil(recordCircuitSuccess(env));
        }

        const shortUrl = raw.detailPageURL;
        const formattedPrice = deal.price > 0 ? deal.price.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' EGP' : '';

        return new Response(JSON.stringify({
          success: true,
          product: { asin: raw.asin, name: raw.name, name_ar: raw.name_ar, shortUrl, price: formattedPrice },
          broadcast_text: broadcast.text,
          inline_keyboard: broadcast.inline_keyboard,
          options: options
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      } catch (e) {
        if (e.message.includes("401") || e.message.includes("403") || e.message.includes("Token has expired")) {
          await env.AZTRACKER_DB.delete('amazon_access_token');
        }
        if (ctx?.waitUntil) ctx.waitUntil(recordCircuitFailure(env));
        return new Response(JSON.stringify({ error: "api_error", message: e.message }), { status: 502, headers: { "Content-Type": "application/json" } });
      }
    }

    if (url.pathname === "/api/crm/generate-text" && request.method === "POST") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      
      let body;
      try { body = await request.json(); } catch (e) { return new Response("Invalid JSON", { status: 400 }); }
      
      const deal = {
        asin: body.asin,
        name: body.name,
        name_ar: body.name_ar ?? body.name,
        detailPageURL: body.detailPageURL || null,
        price: body.numPrice || (body.price ? parseFloat(String(body.price).replace(/[^0-9.]/g, '')) : 0),
        seller: body.seller || 'Unknown',
        mid: body.mid || ''
      };
      
      const broadcast = buildBroadcastMessage(env, deal, Date.now(), t);
      
      return new Response(JSON.stringify({
        success: true,
        broadcast_text: broadcast.text,
        inline_keyboard: broadcast.inline_keyboard
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/api/test-asin") {
      // Protected by shared secret (set via `wrangler secret put TEST_ASIN_KEY`)
      const providedKey = url.searchParams.get("key");
      if (!providedKey || providedKey !== env.TEST_ASIN_KEY) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
      try {
        const asin = url.searchParams.get("asin") || "B094HJ4JSH";
        let accessToken = await env.AZTRACKER_DB.get('amazon_access_token');
        if (!accessToken) {
          const clientId = env.AMAZON_CLIENT_ID || env.AMZN_CREATORS_ACCESS_KEY || env.AWS_ACCESS_KEY_ID;
          const clientSecret = env.AMAZON_CLIENT_SECRET || env.AMZN_CREATORS_SECRET_KEY || env.AWS_SECRET_ACCESS_KEY;
          accessToken = await getAmazonAccessToken(clientId, clientSecret);
        }
        const parser = new AmazonEdgeParser(accessToken, env.AMAZON_PARTNER_TAG, 'www.amazon.eg', env);
        const items = await parser.getItems([asin]);
        const arabicNames = await parser.getItemsWithArabic([asin]);
        return new Response(JSON.stringify({ parsed: items, arabicName: arabicNames.get(asin) || null }, null, 2), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(e.message, { status: 500 });
      }
    }

    if (url.pathname === "/api/migrate-kv" && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
      if (!auth.isRootAdmin) return new Response(JSON.stringify({ error: "Forbidden: Root Admin only" }), { status: 403, headers: { "Content-Type": "application/json" } });
      
      try {
        let migratedCount = 0;
        let cursor = null;
        const stmts = [];
        const now = Date.now();
        
        const adminIds = (await env.AZTRACKER_DB.get("global:admins", "json")) || [];
        const rootAdminsRaw = env.TELEGRAM_ROOT_ADMIN_IDS || env.ROOT_ADMIN_ID || env.TELEGRAM_ADMIN_IDS || "";
        const rootAdminIds = rootAdminsRaw.split(",").filter(Boolean).map(s => s.trim());
        
        const approvedIds = (await env.AZTRACKER_DB.get("global:approved_users", "json")) || [];
        const bannedIds = (await env.AZTRACKER_DB.get("global:banned_users", "json")) || [];
        
        const allValidUsers = Array.from(new Set([...approvedIds, ...adminIds, ...rootAdminIds]));

        const userStmts = [];
        const productStmts = [];
        const subStmts = [];

        for (const uid of allValidUsers) {
          const uidStr = uid.toString();
          const role = (adminIds.includes(uid) || rootAdminIds.includes(uidStr)) ? 'admin' : 'approved';
          userStmts.push(env.DB.prepare("INSERT OR IGNORE INTO Users (chat_id, role, item_limit, created_at) VALUES (?, ?, 5, ?)").bind(uidStr, role, now));
        }
        for (const uid of bannedIds) {
          userStmts.push(env.DB.prepare("INSERT OR IGNORE INTO Users (chat_id, role, item_limit, created_at) VALUES (?, 'rejected', 5, ?)").bind(uid.toString(), now));
        }
        
        do {
          const list = await env.AZTRACKER_DB.list({ prefix: "user:", cursor });
          cursor = list.list_complete ? null : list.cursor;
          
          for (const key of list.keys) {
            if (key.name.endsWith(":products")) {
              const chatIdStr = key.name.split(":")[1];
              const chatId = parseInt(chatIdStr, 10);
              
              if (!allValidUsers.includes(chatId) && !allValidUsers.includes(chatIdStr)) continue;
              const products = await env.AZTRACKER_DB.get(key.name, "json");
              if (products) {
                for (const p of products) {
                  const asinMatch = p.url.match(/\/dp\/([A-Z0-9]{10})/);
                  if (!asinMatch) continue;
                  const asin = asinMatch[1];
                  productStmts.push(env.DB.prepare("INSERT OR IGNORE INTO Global_Products (asin, name, last_updated) VALUES (?, ?, ?)").bind(asin, p.name, now));
                  subStmts.push(env.DB.prepare("INSERT OR IGNORE INTO User_Subscriptions (chat_id, asin, target_price, is_paused, added_at) VALUES (?, ?, ?, ?, ?)").bind(chatIdStr, asin, p.target_price || null, p.paused ? 1 : 0, now));
                  migratedCount++;
                }
              }
            }
          }
        } while (cursor);
        
        const allStmts = [...userStmts, ...productStmts, ...subStmts];
        if (allStmts.length > 0) {
          for (let i = 0; i < allStmts.length; i += 50) {
             await env.DB.batch(allStmts.slice(i, i + 50));
          }
        }
        return new Response(t('crm.migrate_success', 'en', { subscriptions: migratedCount, users: allValidUsers.length }), { status: 200 });
      } catch (err) {
        return new Response(`Migration failed: ${err.message}\n${err.stack}`, { status: 500 });
      }
    }

    if (url.pathname === "/api/crm/audit" && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });

      const { results } = await env.DB.prepare("SELECT * FROM Audit_Logs ORDER BY timestamp DESC LIMIT 50").all();
      const logs = results.map(row => {
        const payload = row.details ? JSON.parse(row.details) : {};
        return {
          ts: row.timestamp,
          adminId: row.actor_id,
          adminHandle: row.actor_name,
          action: row.action,
          target: row.target_id,
          targetHandle: payload.targetHandle,
          details: payload.details
        };
      });
      return new Response(JSON.stringify(logs), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/api/crm/data" && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });

      try {
        const [usersRes, totalProductsRes, lastUpdatedRes, pausedRes, ghostRes, globalRes, hardwareCronRes] = await Promise.all([
          env.DB.prepare(`
            SELECT u.*, COUNT(s.asin) as active_items
            FROM Users u
            LEFT JOIN User_Subscriptions s ON u.chat_id = s.chat_id AND s.is_paused = 0
            GROUP BY u.chat_id
            ORDER BY CASE WHEN u.last_active > 0 THEN 1 ELSE 0 END DESC, COALESCE(NULLIF(u.last_active, 0), u.created_at) DESC
          `).all(),
          env.DB.prepare("SELECT COUNT(DISTINCT asin) as activeWatchPool FROM User_Subscriptions WHERE is_paused = 0").first(),
          env.DB.prepare("SELECT value as lastRunMs FROM Bot_States WHERE key = 'last_run_time'").first(),
          env.DB.prepare("SELECT COUNT(*) as pausedCount FROM (SELECT g.asin FROM Global_Products g LEFT JOIN User_Subscriptions s ON g.asin = s.asin WHERE g.always_track = 0 AND g.delisted = 0 AND (g.last_updated = 0 OR g.new_price IS NOT NULL OR g.used_price IS NOT NULL OR g.amazon_price IS NOT NULL) GROUP BY g.asin HAVING SUM(CASE WHEN s.is_paused = 0 THEN 1 ELSE 0 END) = 0)").first(),
          env.DB.prepare("SELECT COUNT(*) as ghostCount FROM Global_Products WHERE delisted = 1 OR (last_updated > 0 AND new_price IS NULL AND used_price IS NULL AND amazon_price IS NULL)").first(),
          env.DB.prepare("SELECT COUNT(*) as globalCount FROM Global_Products WHERE always_track = 1 AND delisted = 0 AND (last_updated = 0 OR new_price IS NOT NULL OR used_price IS NOT NULL OR amazon_price IS NOT NULL) AND asin NOT IN (SELECT DISTINCT asin FROM User_Subscriptions WHERE is_paused = 0)").first(),
          env.DB.prepare("SELECT value FROM Bot_States WHERE key = 'hardware_cron_interval'").first('value')
        ]);
        
        const rootAdminsRaw = env.TELEGRAM_ROOT_ADMIN_IDS || env.ROOT_ADMIN_ID || "";
        const rootAdmins = rootAdminsRaw.split(",").filter(Boolean).map(String);
        
        let mutableUsers = [];
        const foundIds = new Set();
        if (usersRes.results) {
            mutableUsers = usersRes.results.map(u => {
                const userClone = { ...u };
                const idStr = userClone.chat_id.toString();
                foundIds.add(idStr);
                if (rootAdmins.includes(idStr)) {
                    userClone.role = 'root';
                }
                return userClone;
            });
        }
        // Inject root admins not yet in Users table (e.g. never seeded from KV)
        for (const raId of rootAdmins) {
            if (!foundIds.has(raId)) {
                mutableUsers.unshift({
                    chat_id: raId,
                    role: 'root',
                    first_name: null,
                    username: null,
                    item_limit: 0,
                    created_at: Date.now(),
                    active_items: 0,
                    lang: null
                });
            }
        }
        
        const { results: queueResults } = await env.DB.prepare("SELECT * FROM Join_Queue ORDER BY requested_at DESC").all();
        const joinQueueRes = queueResults.map(q => ({
             id: q.chat_id,
             first_name: q.first_name,
             username: q.username,
             requested_at: q.requested_at,
             admin_messages: q.admin_messages ? JSON.parse(q.admin_messages) : {},
             request_type: q.request_type || 'access'
        }));
        
        const data = {
          systemStats: {
            totalUsers: mutableUsers.filter(u => u.role !== 'rejected').length,
            activeWatchPool: totalProductsRes ? totalProductsRes.activeWatchPool : 0,
            lastRunMs: lastUpdatedRes && lastUpdatedRes.lastRunMs ? parseInt(lastUpdatedRes.lastRunMs, 10) : null,
            pausedProducts: pausedRes ? pausedRes.pausedCount : 0,
            ghostProducts: ghostRes ? ghostRes.ghostCount : 0,
            globalProducts: globalRes ? globalRes.globalCount : 0,
            hardwareIntervalMs: hardwareCronRes || "300000",
            queueLimit: env.DAILY_QUEUE_LIMIT || "10000"
          },
          joinQueue: joinQueueRes || [],
          users: mutableUsers,
          auth: { isRootAdmin: auth.isRootAdmin, adminId: auth.user.id.toString() },
          lang: auth.lang || 'masry'
        };
        const response = new Response(JSON.stringify(data), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            "X-Current-User": auth.user.id.toString()
          }
        });
        return response;
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }
    
    if (url.pathname === "/api/crm/paused-products" && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });

      const rows = await env.DB.prepare(`
        SELECT
            g.asin, g.name, g.name_ar, g.image_url, g.amazon_price, g.new_price, g.used_price,
            g.always_track, g.detail_page_url,
            SUM(CASE WHEN s.is_paused = 0 THEN 1 ELSE 0 END) as active_subs,
            SUM(CASE WHEN s.is_paused = 1 THEN 1 ELSE 0 END) as paused_subs
        FROM Global_Products g
        LEFT JOIN User_Subscriptions s ON g.asin = s.asin
        WHERE g.always_track = 0 AND g.delisted = 0 AND (g.last_updated = 0 OR g.new_price IS NOT NULL OR g.used_price IS NOT NULL OR g.amazon_price IS NOT NULL)
        GROUP BY g.asin
        HAVING active_subs = 0 AND (paused_subs > 0 OR s.asin IS NULL)
        ORDER BY g.always_track DESC, paused_subs DESC
        LIMIT 100
      `).all();

      return new Response(JSON.stringify({
        items: rows.results || []
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/api/crm/active-products" && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });

      const rows = await env.DB.prepare(`
        SELECT s.chat_id, s.asin, s.added_at, s.target_price, p.image_url,
               p.name, p.name_ar, p.amazon_price, p.new_price, p.used_price, p.always_track,
               p.detail_page_url, u.first_name, u.username
        FROM User_Subscriptions s
        JOIN Global_Products p ON s.asin = p.asin
        JOIN Users u ON s.chat_id = u.chat_id
        WHERE s.is_paused = 0
        ORDER BY s.added_at DESC, s.asin ASC
      `).all();

      return new Response(JSON.stringify({
        items: rows.results || []
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    
    if (url.pathname === "/api/crm/top-charts" && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });

      const totalRes = await env.DB.prepare("SELECT COUNT(DISTINCT asin) as total FROM User_Subscriptions WHERE is_paused = 0").first();
      const totalActiveProducts = totalRes ? totalRes.total : 0;
      const limit = Math.max(1, Math.ceil(totalActiveProducts * 0.25));

      const rows = await env.DB.prepare(`
        SELECT gp.asin, gp.name, gp.name_ar, gp.new_price, gp.amazon_price, gp.image_url,
               gp.detail_page_url, COUNT(s.chat_id) as tracker_count
        FROM Global_Products gp
        JOIN User_Subscriptions s ON gp.asin = s.asin AND s.is_paused = 0
        GROUP BY gp.asin
        ORDER BY tracker_count DESC
        LIMIT ?
      `).bind(limit).all();

      return new Response(JSON.stringify({
        items: rows.results || []
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/api/crm/graveyard" && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });

      const rows = await env.DB.prepare(`
        SELECT gp.asin, gp.name, gp.name_ar, gp.delisted, gp.image_url,
               gp.detail_page_url, gp.new_missing_since, gp.used_missing_since,
               gp.amazon_missing_since, gp.last_updated,
               COUNT(CASE WHEN s.is_paused = 0 THEN 1 END) as active_subs
        FROM Global_Products gp
        LEFT JOIN User_Subscriptions s ON gp.asin = s.asin
        WHERE gp.delisted = 1
           OR (gp.last_updated > 0 AND gp.new_price IS NULL AND gp.used_price IS NULL AND gp.amazon_price IS NULL)
        GROUP BY gp.asin
        ORDER BY active_subs ASC, gp.last_updated ASC
      `).all();

      return new Response(JSON.stringify({
        items: rows.results || []
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/api/crm/graveyard/purge" && request.method === "POST") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      if (!auth.isRootAdmin) return new Response("Forbidden", { status: 403 });

      const body = await request.json();
      const { asins } = body;
      if (!asins || !Array.isArray(asins) || asins.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "No ASINs provided" }), { status: 400 });
      }

      const validAsins = asins.filter(a => /^[A-Z0-9]{10}$/.test(a));
      if (validAsins.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "No valid ASINs" }), { status: 400 });
      }

      const stmts = validAsins.map(asin =>
        env.DB.prepare("DELETE FROM Global_Products WHERE asin = ?").bind(asin)
      );
      await env.DB.batch(stmts);

      const adminId = auth.user.id.toString();
      ctx.waitUntil(logAudit(env, adminId, "PURGE_GHOSTS", "global", { count: validAsins.length }));

      return new Response(JSON.stringify({
        success: true,
        purged: validAsins.length
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/api/crm/paused/bulk-delete" && request.method === "POST") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });

      const body = await request.json();
      const { asins } = body;
      if (!asins || !Array.isArray(asins) || asins.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "No ASINs provided" }), { status: 400 });
      }

      const validAsins = asins.filter(a => /^[A-Z0-9]{10}$/.test(a));
      if (validAsins.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "No valid ASINs" }), { status: 400 });
      }

      // Delete from Global_Products and User_Subscriptions
      const stmts = [];
      for (const asin of validAsins) {
        stmts.push(env.DB.prepare("DELETE FROM Global_Products WHERE asin = ?").bind(asin));
        stmts.push(env.DB.prepare("DELETE FROM User_Subscriptions WHERE asin = ?").bind(asin));
      }
      await env.DB.batch(stmts);

      const adminId = auth.user.id.toString();
      ctx.waitUntil(logAudit(env, adminId, "BULK_DELETE", "global", { count: validAsins.length, asins: validAsins }));

      return new Response(JSON.stringify({
        success: true,
        deleted: validAsins.length
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname.startsWith("/api/crm/product-subs/") && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      
      const parts = url.pathname.split("/").filter(Boolean);
      const targetAsin = parts[3];
      if (!targetAsin) return new Response("Invalid ASIN", { status: 400 });
      
      const subs = await env.DB.prepare(`
        SELECT s.chat_id, s.target_price, s.is_paused, s.paused_at, p.image_url,
               p.name, p.name_ar, p.amazon_price, p.new_price, p.used_price, p.asin, p.always_track,
               p.detail_page_url,
               u.first_name, u.username
        FROM User_Subscriptions s
        JOIN Global_Products p ON s.asin = p.asin
        LEFT JOIN Users u ON s.chat_id = u.chat_id
        WHERE s.asin = ?
      `).bind(targetAsin).all();
      
      return new Response(JSON.stringify({ items: subs.results || [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname.startsWith("/api/crm/user/") && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      
      const parts = url.pathname.split("/").filter(Boolean);
      const targetId = parts[3];
      if (!targetId || targetId === "products") return new Response("Invalid ID", { status: 400 });
      
      const products = await env.DB.prepare(`
        SELECT s.asin, s.target_price, s.is_paused, p.image_url,
               p.name, p.name_ar, p.amazon_price, p.new_price, p.used_price, p.last_updated, p.new_seller, p.used_seller, p.amazon_seller, p.always_track,
               p.detail_page_url
        FROM User_Subscriptions s
        JOIN Global_Products p ON s.asin = p.asin
        WHERE s.chat_id = ?
        ORDER BY s.added_at DESC, s.asin ASC
      `).bind(targetId).all();
      
      return new Response(JSON.stringify(products.results || []), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/api/crm/bulk-add-products" && request.method === "POST") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      
      try {
        const body = await request.json();
        const asinsInput = body.asins || [];
        const isPreview = body.preview === true;
        if (!Array.isArray(asinsInput)) return new Response(JSON.stringify({ error: 'invalid_input' }), { status: 400 });

        const validAsins = new Set();
        const invalid = [];
        const items = [];

        for (let token of asinsInput) {
            if (!token || typeof token !== 'string') continue;
            let t = token.trim();
            let asin = null;
            
            if (/^https?:\/\//i.test(t)) {
                const expanded = await expandAmazonUrl(t);
                asin = getAsinFromUrl(expanded);
                if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) asin = null;
            } else {
                const direct = t.match(/^([a-zA-Z0-9]{10})$/);
                if (direct) asin = direct[1].toUpperCase();
                else {
                    const fromUrl = t.match(/\/(?:dp|gp\/product|product)\/([a-zA-Z0-9]{10})/i);
                    if (fromUrl) asin = fromUrl[1].toUpperCase();
                    else {
                        const fallback = t.match(/([a-zA-Z0-9]{10})/);
                        if (fallback) asin = fallback[1].toUpperCase();
                    }
                }
            }
            
            if (asin) {
                items.push({ input: token, asin });
                validAsins.add(asin);
            } else {
                items.push({ input: token, asin: null, status: 'invalid' });
                invalid.push(token);
            }
        }

        const asins = Array.from(validAsins);
        if (asins.length === 0) return new Response(JSON.stringify({ error: "bulk_add_no_valid" }), { status: 400 });

        let added = 0;
        let upgraded = 0;
        let already_global = 0;
        const dbStatusMap = new Map();
        
        for (let i = 0; i < asins.length; i += 50) {
            const chunk = asins.slice(i, i + 50);
            const placeholders = chunk.map(() => '?').join(',');
            
            const existingRes = await env.DB.prepare(`SELECT asin, always_track, name, name_ar FROM Global_Products WHERE asin IN (${placeholders})`).bind(...chunk).all();
            const existingMap = new Map();
            if (existingRes && existingRes.results) {
                existingRes.results.forEach(row => {
                    existingMap.set(row.asin, row);
                });
            }

            const batchStmts = [];
            
            for (const asin of chunk) {
                if (existingMap.has(asin)) {
                    const row = existingMap.get(asin);
                    if (row.always_track === 0) {
                        batchStmts.push(env.DB.prepare("UPDATE Global_Products SET always_track = 1 WHERE asin = ?").bind(asin));
                        upgraded++;
                        dbStatusMap.set(asin, { status: 'upgraded', name: row.name, name_ar: row.name_ar });
                    } else {
                        already_global++;
                        dbStatusMap.set(asin, { status: 'already_global', name: row.name, name_ar: row.name_ar });
                    }
                } else {
                    batchStmts.push(env.DB.prepare("INSERT OR IGNORE INTO Global_Products (asin, always_track, last_updated, name) VALUES (?, 1, 0, ?)").bind(asin, asin));
                    added++;
                    dbStatusMap.set(asin, { status: 'added', name: null, name_ar: null });
                }
            }
            
            if (!isPreview && batchStmts.length > 0) {
                await env.DB.batch(batchStmts);
            }
        }

        const details = items.map(item => {
            if (item.status === 'invalid') return item;
            const dbInfo = dbStatusMap.get(item.asin);
            if (dbInfo) return { ...item, ...dbInfo };
            return item;
        });

        return new Response(JSON.stringify({
            added,
            upgraded,
            already_global,
            invalid: invalid.length,
            total: asinsInput.length,
            valid_asins: asins,
            details
        }), { status: 200, headers: { "Content-Type": "application/json" } });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    if (url.pathname === "/api/crm/global-products" && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });

      const products = await env.DB.prepare(`
        SELECT g.asin, g.name, g.name_ar, g.image_url, g.amazon_price, g.new_price,
               g.used_price, g.detail_page_url, g.always_track, g.last_updated,
               COUNT(CASE WHEN s.is_paused = 0 THEN 1 END) as active_subs
        FROM Global_Products g
        LEFT JOIN User_Subscriptions s ON g.asin = s.asin
        WHERE g.always_track = 1 AND g.delisted = 0 AND (g.last_updated = 0 OR g.new_price IS NOT NULL OR g.used_price IS NOT NULL OR g.amazon_price IS NOT NULL)
        GROUP BY g.asin
        HAVING active_subs = 0
        ORDER BY g.last_updated DESC
        LIMIT 100
      `).all();

      return new Response(JSON.stringify({ items: products.results || [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    
    if (url.pathname === "/api/crm/action" && request.method === "POST") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      
      const body = await request.json();
      const { action, targetId, data } = body;
      const adminId = auth.user.id.toString();
      
      // Resolve admin's language preference for localized action feedback
      const adminLangRow = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(adminId).first();
      const adminLang = adminLangRow?.lang || auth.lang || 'masry';

      // Helper: resolve target user's language (falls back to admin lang, then 'en')
      const resolveTargetLang = async (tid) => {
        const row = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(tid).first();
        return row?.lang || adminLang;
      };
      // Helper: resolve an admin's language preference (falls back to 'en')
      const adminLangPref = async (aid) => {
        if (aid === adminId) return adminLang;
        const row = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(aid).first();
        return row?.lang || 'masry';
      };

      if (action === "force_scrape") {
        // Enqueue to SCRAPER_QUEUE — the queue worker handles the self-perpetuating
        // chain (each batch enqueues the next with delaySeconds:1). A direct call
        // to executeScrapeEngine only processes one batch and misses the rest.

        // Capture pre-scrape state to detect actual completion
        const beforeRes = await env.DB.prepare(
          "SELECT COUNT(*) as cnt, MAX(last_updated) as max_ts FROM Global_Products"
        ).first();
        const now = Date.now();
        await env.DB.prepare("INSERT OR REPLACE INTO Bot_States (key, value, expires_at) VALUES ('last_run_time', ?, ?)").bind(now.toString(), now + 86400000).run();
        
        await env.SCRAPER_QUEUE.send({ offset: 0 });
        ctx.waitUntil(logAudit(env, adminId, "FORCE_SCRAPE", "global", {}));

        // Removed 120s polling loop to prevent hitting Cloudflare 30s waitUntil timeout limit.
        // We notify immediately that the scrape is queued.
        ctx.waitUntil((async () => {
          await sendTelegram(env, adminId, t('crm.action_force_scrape_ok', adminLang));
        })());
        return new Response(JSON.stringify({ success: true, status: "queued" }), { status: 202 });
      }
      
      if (action === "broadcast") {
        if (!data || !data.message) return new Response("Missing message", { status: 400 });

        ctx.waitUntil((async () => {
          // Product deal broadcast → send to public channel with inline keyboard
          if (data.broadcast_type === 'product_broadcast' && data.inline_keyboard) {
            if (!env.TELEGRAM_PUBLIC_CHANNEL_ID) {
              console.error('[Broadcast] TELEGRAM_PUBLIC_CHANNEL_ID not set');
              return;
            }
            await env.MESSAGE_QUEUE.sendBatch([{
              body: {
                type: 'telegram_alert',
                asin: data.asin || '',
                chatId: env.TELEGRAM_PUBLIC_CHANNEL_ID,
                text: data.message,
                markup: { inline_keyboard: data.inline_keyboard }
              }
            }]);
            await logAudit(env, adminId, "PRODUCT_BROADCAST", data.asin || 'unknown', {});
          } else {
            // Generic user broadcast (existing behavior)
            const users = await env.DB.prepare("SELECT chat_id, lang FROM Users WHERE role = 'approved'").all();
            const queueMsgs = users.results.map(row => ({
              body: {
                type: 'telegram_broadcast',
                chatId: row.chat_id,
                text: t('crm.broadcast_prefix', row.lang || 'masry', { message: data.message })
              }
            }));
            for (let i = 0; i < queueMsgs.length; i += 100) {
              await env.MESSAGE_QUEUE.sendBatch(queueMsgs.slice(i, i + 100));
            }
            await logAudit(env, adminId, "GLOBAL_BROADCAST", "all", {});
          }
        })());
        return new Response(JSON.stringify({ success: true, status: "queued" }), { status: 202 });
      }
      
      if (action === "approve") {
        // Read admin_messages and lang BEFORE delete
        const queueRow = await env.DB.prepare("SELECT admin_messages, first_name, username, lang FROM Join_Queue WHERE chat_id = ?").bind(targetId).first();
        // Build human-readable label before DELETE so we can show it in admin notifications
        const targetLabel = queueRow?.username
          ? `${queueRow.first_name} (@${queueRow.username})`
          : `${queueRow?.first_name || 'Unknown'} (${targetId})`;
        // Race guard: delete queue row first, check if another admin already handled it
        const deleteResult = await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();
        if (deleteResult.meta.changes === 0) {
          return new Response(JSON.stringify({ success: false, error: "already_handled", message: "Request was already processed by another admin" }), { status: 200 });
        }
        const defaultLimit = parseInt(env.DEFAULT_USER_PRODUCT_LIMIT) || 3;
        
        // Use UPSERT to preserve existing user data if they were previously banned or already in the system
        await env.DB.prepare(`
          INSERT INTO Users (chat_id, first_name, username, role, item_limit, approved_by, created_at, unban_rejected, lang) 
          VALUES (?, ?, ?, 'approved', ?, ?, ?, 0, ?)
          ON CONFLICT(chat_id) DO UPDATE SET 
            role = 'approved', 
            item_limit = excluded.item_limit, 
            approved_by = excluded.approved_by, 
            unban_rejected = 0,
            lang = COALESCE(Users.lang, excluded.lang)
        `).bind(
          targetId, 
          queueRow?.first_name || '', 
          queueRow?.username || '', 
          defaultLimit, 
          adminId, 
          Date.now(), 
          queueRow?.lang || 'masry'
        ).run();

        ctx.waitUntil((async () => { const tl = await resolveTargetLang(targetId); await sendTelegram(env, targetId, getWelcomeMessage(tl, defaultLimit)); })());
        ctx.waitUntil(logAudit(env, adminId, "APPROVE_USER", targetId, {}));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/roles/${targetId}`)));
        // Invalidate other admins' inline messages so buttons disappear automatically
        if (queueRow?.admin_messages) {
          let adminMessages = {};
          try { adminMessages = typeof queueRow.admin_messages === 'string' ? JSON.parse(queueRow.admin_messages) : queueRow.admin_messages; } catch(e) {}
          for (const [admId, msgId] of Object.entries(adminMessages)) {
            try { const al = await adminLangPref(admId); await editTelegramMessage(env, admId, msgId, t('access.handled_approved', al, { id: targetLabel, admin: 'CRM admin' }), { inline_keyboard: [] }); } catch(e) {}
          }
        }
      } else if (action === "reject") {
        // Read request_type + user info BEFORE deleting (needed for UPSERT)
        const queueRow = await env.DB.prepare("SELECT request_type, admin_messages, first_name, username FROM Join_Queue WHERE chat_id = ?").bind(targetId).first();
        // Build human-readable label before DELETE so we can show it in admin notifications
        const targetLabel = queueRow?.username
          ? `${queueRow.first_name} (@${queueRow.username})`
          : `${queueRow?.first_name || 'Unknown'} (${targetId})`;
        // Get lang from Users if row exists, else default to 'en' (Join_Queue has no language_code column)
        const existingUser = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(targetId).first();
        const userLang = existingUser?.lang || 'masry';
        // Race guard: delete queue row, check if another admin already handled it
        const deleteResult = await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();
        if (deleteResult.meta.changes === 0) {
          // Another admin already handled the queue item. Check if they were approved before forcing a rejection.
          const currentRole = await env.DB.prepare("SELECT role FROM Users WHERE chat_id = ?").bind(targetId).first('role');
          if (currentRole !== 'approved') {
              await env.DB.prepare("INSERT INTO Users (chat_id, first_name, username, role, item_limit, created_at, lang) VALUES (?, ?, ?, 'rejected', ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET role = 'rejected'").bind(targetId, queueRow?.first_name || '', queueRow?.username || '', env.DEFAULT_USER_PRODUCT_LIMIT || "3", Date.now(), userLang).run();
          }
          return new Response(JSON.stringify({ success: false, error: "already_handled", message: "Request was already processed by another admin" }), { status: 200 });
        }
        // UPSERT user: INSERT if new (first rejection), UPDATE if unban was rejected after prior approval.
        // Unlike plain UPDATE, INSERT ON CONFLICT ensures newly rejected users appear in the banned tab.
        if (queueRow?.request_type === 'unban') {
          // Rejecting an unban request → permanently ban the user (unban_rejected=1)
          await env.DB.prepare("INSERT INTO Users (chat_id, first_name, username, role, item_limit, created_at, lang, unban_rejected) VALUES (?, ?, ?, 'rejected', ?, ?, ?, 1) ON CONFLICT(chat_id) DO UPDATE SET role = 'rejected', unban_rejected = 1").bind(targetId, queueRow?.first_name || '', queueRow?.username || '', env.DEFAULT_USER_PRODUCT_LIMIT || "3", Date.now(), userLang).run();
          ctx.waitUntil((async () => { const tl = await resolveTargetLang(targetId); await sendTelegram(env, targetId, t('access.unban_rejected', tl)); })());
        } else {
          // Rejecting initial access request — user can request unban (unban_rejected stays 0)
          await env.DB.prepare("INSERT INTO Users (chat_id, first_name, username, role, item_limit, created_at, lang) VALUES (?, ?, ?, 'rejected', ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET role = 'rejected'").bind(targetId, queueRow?.first_name || '', queueRow?.username || '', env.DEFAULT_USER_PRODUCT_LIMIT || "3", Date.now(), userLang).run();
          ctx.waitUntil((async () => { const tl = await resolveTargetLang(targetId); await sendTelegram(env, targetId, t('crm.notify_rejected', tl)); })());
        }
        ctx.waitUntil(logAudit(env, adminId, "REJECT_USER", targetId, { unban: queueRow?.request_type === 'unban' }));
        // Invalidate other admins' inline messages so buttons disappear automatically
        if (queueRow?.admin_messages) {
          let adminMessages = {};
          try { adminMessages = typeof queueRow.admin_messages === 'string' ? JSON.parse(queueRow.admin_messages) : queueRow.admin_messages; } catch(e) {}
          for (const [admId, msgId] of Object.entries(adminMessages)) {
            try { const al = await adminLangPref(admId); await editTelegramMessage(env, admId, msgId, t('access.handled_request', al, { id: targetLabel, admin: 'CRM admin' }), { inline_keyboard: [] }); } catch(e) {}
          }
        }
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/roles/${targetId}`)));
      } else if (action === "revoke") {
        if (targetId === adminId) return new Response("Cannot revoke yourself", { status: 400 });
        // Soft revoke: preserve user + subscriptions, pause subs.
        // Explicitly set unban_rejected=0 so revoked users keep their one unban chance.
        await env.DB.batch([
          env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 1, paused_at = ? WHERE chat_id = ?").bind(Date.now(), targetId),
          env.DB.prepare("UPDATE Users SET role = 'rejected', unban_rejected = 0 WHERE chat_id = ?").bind(targetId)
        ]);
        ctx.waitUntil((async () => { const tl = await resolveTargetLang(targetId); await sendTelegram(env, targetId, t('crm.notify_revoked', tl)); })());
        ctx.waitUntil(logAudit(env, adminId, "REVOKE_USER", targetId, {}));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/roles/${targetId}`)));
      } else if (action === "unban") {
        // Check if there's a pending unban request in Join_Queue (from user's unban request)
        const queueRow = await env.DB.prepare("SELECT admin_messages, first_name, username FROM Join_Queue WHERE chat_id = ?").bind(targetId).first();
        // Build human-readable label before DELETE so we can show it in admin notifications
        const targetLabel = queueRow?.username
          ? `${queueRow.first_name} (@${queueRow.username})`
          : `${queueRow?.first_name || 'Unknown'} (${targetId})`;
        if (queueRow) {
          // Race guard: delete queue row first, check if another admin already handled it
          const deleteResult = await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();
          if (deleteResult.meta.changes === 0) {
            return new Response(JSON.stringify({ success: false, error: "already_handled", message: "Request was already processed by another admin" }), { status: 200 });
          }
        }
        // If no queue row exists (direct revoke/unban, no pending request), skip to unban directly
        // Unban: restore access, clear permanent ban flag, unpause subscriptions
        await env.DB.batch([
          env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 0, paused_at = NULL WHERE chat_id = ?").bind(targetId),
          env.DB.prepare("UPDATE Users SET role = 'approved', unban_rejected = 0 WHERE chat_id = ?").bind(targetId)
        ]);
        ctx.waitUntil((async () => { const tl = await resolveTargetLang(targetId); await sendTelegram(env, targetId, t('crm.notify_restored', tl)); ctx.waitUntil(setChatMenuButton(env, targetId, 'https://' + new URL(request.url).hostname, tl, false)); })());
        ctx.waitUntil(logAudit(env, adminId, "UNBAN_USER", targetId, {}));
        // Invalidate other admins' inline messages so buttons disappear automatically
        if (queueRow?.admin_messages) {
          let adminMessages = {};
          try { adminMessages = typeof queueRow.admin_messages === 'string' ? JSON.parse(queueRow.admin_messages) : queueRow.admin_messages; } catch(e) {}
          for (const [admId, msgId] of Object.entries(adminMessages)) {
            try { const al = await adminLangPref(admId); await editTelegramMessage(env, admId, msgId, t('access.handled_approved', al, { id: targetLabel, admin: 'CRM admin' }), { inline_keyboard: [] }); } catch(e) {}
          }
        }
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/roles/${targetId}`)));
      } else if (action === "promote") {
        if (!auth.isRootAdmin) return new Response("Forbidden", { status: 403 });
        await env.DB.prepare("UPDATE Users SET role = 'admin' WHERE chat_id = ?").bind(targetId).run();
        ctx.waitUntil((async () => { const tl = await resolveTargetLang(targetId); await sendTelegram(env, targetId, t('crm.notify_promoted', tl)); })());
        ctx.waitUntil(logAudit(env, adminId, "PROMOTE_ADMIN", targetId, {}));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/roles/${targetId}`)));
      } else if (action === "demote") {
        if (!auth.isRootAdmin) return new Response("Forbidden", { status: 403 });
        if (targetId === adminId) return new Response("Cannot demote yourself", { status: 400 });
        await env.DB.prepare("UPDATE Users SET role = 'approved' WHERE chat_id = ?").bind(targetId).run();
        ctx.waitUntil((async () => { const tl = await resolveTargetLang(targetId); await sendTelegram(env, targetId, t('crm.notify_demoted', tl)); })());
        ctx.waitUntil(logAudit(env, adminId, "DEMOTE_ADMIN", targetId, {}));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/roles/${targetId}`)));
      } else if (action === "set_limit") {
        const newLimit = parseInt(data.limit);
        if (isNaN(newLimit) || newLimit < 1) return new Response("Invalid limit", { status: 400 });
        await env.DB.prepare("UPDATE Users SET item_limit = ? WHERE chat_id = ?").bind(newLimit, targetId).run();
        ctx.waitUntil((async () => { const tl = await resolveTargetLang(targetId); await sendTelegram(env, targetId, t('crm.notify_limit_updated', tl, { limit: newLimit })); })());
        ctx.waitUntil(logAudit(env, adminId, "SET_LIMIT", targetId, { limit: newLimit }));
      } else if (action === "delete_product") {
        // DEPRECATED: Delete product action removed from UI. Kept for API compatibility.
        return new Response(JSON.stringify({ error: 'deprecated', message: 'This action is no longer available.' }), { status: 410 });
      } else if (action === "toggle_keep_alive") {
        const asin = data.asin;
        const currentTracker = await env.DB.prepare("SELECT always_track FROM Global_Products WHERE asin = ?").bind(asin).first('always_track');
        const result = await env.DB.prepare("UPDATE Global_Products SET always_track = CASE WHEN always_track = 1 THEN 0 ELSE 1 END WHERE asin = ?").bind(asin).run();
        if (result.meta && result.meta.changes === 0) return new Response(JSON.stringify({ error: 'not_found' }), { status: 200 });
        const actionLog = currentTracker ? "DISABLE_KEEP_ALIVE" : "ENABLE_KEEP_ALIVE";
        ctx.waitUntil(logAudit(env, adminId, actionLog, "global", { asin }));
      } else if (action === "set_target") {
        const asin = data.asin;
        const target = parseFloat(data.target);
        if (isNaN(target)) return new Response("Invalid target", { status: 400 });
        const result = await env.DB.prepare("UPDATE User_Subscriptions SET target_price = ?, alert_sent_new = 0, alert_sent_used = 0 WHERE chat_id = ? AND asin = ?").bind(target, targetId, asin).run();
        if (result.meta && result.meta.changes === 0) return new Response(JSON.stringify({ error: 'not_found' }), { status: 200 });
        ctx.waitUntil(logAudit(env, adminId, "SET_TARGET", targetId, { asin, target }));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/roles/${targetId}`)));
      } else if (action === "toggle_mute_queue") {
        await env.DB.prepare("UPDATE Users SET mute_join_queue = CASE WHEN mute_join_queue = 1 THEN 0 ELSE 1 END WHERE chat_id = ?").bind(adminId).run();
        const newStateRes = await env.DB.prepare("SELECT mute_join_queue FROM Users WHERE chat_id = ?").bind(adminId).first();
        if (newStateRes && newStateRes.mute_join_queue === 1) {
            ctx.waitUntil(logAudit(env, adminId, "MUTE_JOIN_QUEUE", adminId, {}));
        } else {
            ctx.waitUntil(logAudit(env, adminId, "UNMUTE_JOIN_QUEUE", adminId, {}));
        }
      } else if (action === "direct_message") {
        if (!data || !data.message) return new Response("Missing message", { status: 400 });
        ctx.waitUntil((async () => { const tl = await resolveTargetLang(targetId); await sendTelegram(env, targetId, t('crm.notify_direct_message', tl, { message: data.message })); })());
        ctx.waitUntil(logAudit(env, adminId, "DIRECT_MESSAGE", targetId, {}));
      } else {
        return new Response("Unknown action", { status: 400 });
      }
      
      ctx.waitUntil(caches.default.delete(new Request(`${url.origin}/_internal/crm/data`)));
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/crm/sync-env" && request.method === "POST") {
      try {
        const auth = await authAdmin(request, env);
        if (!auth) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
        if (!auth.isRootAdmin) return new Response(JSON.stringify({ error: "Forbidden: Root Admin only" }), { status: 403, headers: { "Content-Type": "application/json" } });
        const adminId = auth.user.id.toString();
        const pat = env.GITHUB_PAT;
        if (!pat) {
            return new Response(JSON.stringify({ error: "GITHUB_PAT not set in environment." }), { status: 500 });
        }
        let targetRef = "main";
        const owner = env.GITHUB_OWNER || 'aka-khalid';
        const repo = env.GITHUB_REPO || 'AzTracker';
        
        const branchesRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches`, {
            headers: {
                "Authorization": `Bearer ${pat}`,
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "AzTracker-Worker"
            }
        });
        if (branchesRes.ok) {
            const branches = await branchesRes.json();
            const featureBranch = branches.find(b => b.name.startsWith("feature/"));
            if (featureBranch) targetRef = featureBranch.name;
        }
        
        const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/sync-prod-to-dev.yml/dispatches`, {
            method: "POST",
            headers: {
                "Accept": "application/vnd.github.v3+json",
                "Authorization": `Bearer ${pat}`,
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "AzTracker-Worker"
            },
            body: JSON.stringify({ ref: targetRef })
        });
        
        if (!ghRes.ok) {
            const errBody = await ghRes.text();
            throw new Error(`GitHub API returned ${ghRes.status}: ${errBody}`);
        }
        
        ctx.waitUntil(logAudit(env, adminId, "SYNC_ENV", "global", {}));
        return new Response(JSON.stringify({ success: true, message: "Synchronization started in background." }), {
            headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

  return new Response("Not Found", { status: 404 });
}
export function renderCrmHTML(lang = 'en', isProd = false) {
  // Escape a translated string for safe injection into a JS double-quoted string literal.
  // JSON.stringify handles quotes, backslashes, newlines, and all special chars.
  const isMasry = lang === 'masry';
  const js = (key, vars) => JSON.stringify(t(key, lang, vars));
  const htmlLang = lang;
  const htmlDir = isMasry ? 'rtl' : 'ltr';

  return `<!DOCTYPE html>
<html lang="${htmlLang}" dir="${htmlDir}" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${t('crm.hub_title', lang)}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Cairo:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script>
      tailwind.config = {
        darkMode: 'class',
        theme: {
          extend: {
            fontFamily: { sans: ['Inter', 'Cairo', 'sans-serif'], arabic: ['Cairo', 'sans-serif'] },
            colors: {
              gray: { 850: '#1f2937', 900: '#111827', 950: '#030712' },
              brand: { 400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7' }
            }
          }
        }
      }
    </script>
    <style>
      body { background-color: #030712; color: #f3f4f6; -webkit-tap-highlight-color: transparent; }
      .glass { background: rgba(31, 41, 55, 0.7); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.05); }
      .toast { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
      .toast-enter { transform: translateY(100%); opacity: 0; }
      .toast-enter-active { transform: translateY(0); opacity: 1; }
      .toast-leave { transform: translateY(0); opacity: 1; }
      .toast-leave-active { transform: translateY(100%); opacity: 0; }
      
      .loader { border-top-color: #38bdf8; -webkit-animation: spinner 1.5s linear infinite; animation: spinner 1.5s linear infinite; }
      @keyframes spinner { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      
      .tab-active { border-bottom: 2px solid #38bdf8; color: #f3f4f6; }
      .tab-inactive { border-bottom: 2px solid transparent; color: #9ca3af; }
    </style>
</head>
<body class="min-h-screen flex flex-col ${isMasry ? 'font-arabic' : 'font-sans'} bg-gray-900 text-gray-100">
  <style>@keyframes spin { 100% { transform: rotate(360deg); } }</style>
  <div id="init-loader" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; width: 100vw; height: 100vh; z-index: 9999; display: flex; align-items: center; justify-content: center; background-color: #0f172a;">
    <div style="width: 48px; height: 48px; border: 4px solid #1e293b; border-top-color: #38bdf8; border-radius: 50%; animation: spin 1s linear infinite;"></div>
  </div>
    
    <header class="glass sticky top-0 z-40 px-4 py-3 flex justify-between items-center shadow-lg">
        <div class="flex items-center gap-2">
            <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center font-bold text-white shadow-lg">A</div>
            <h1 class="font-bold text-lg tracking-tight">${t('crm.hub_title', lang)}</h1>
        </div>
        <button onclick="refreshData()" class="p-2 rounded-full hover:bg-gray-800 transition text-gray-400 hover:text-white">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
        </button>
    </header>

    <main class="flex-1 px-4 py-6 pb-24 space-y-6 max-w-2xl mx-auto w-full" id="app-container">
        
        <!-- HIGHER LEVEL TAB -->
        <div class="mb-4">
            <button onclick="window.location.href='/user_app?lang=${lang}&admin=true'" class="w-full py-3 bg-brand-500/10 hover:bg-brand-500/20 border border-brand-500/30 text-brand-400 font-bold rounded-xl transition flex items-center justify-center gap-2 shadow-lg">
                ${t('dashboard.my_products', lang)}
            </button>
        </div>

        <!-- MAIN TABS -->
        <div class="flex gap-4 border-b border-gray-800 mb-6" id="main-tabs">
            <button onclick="switchMainTab('system-view')" id="main-tab-system-view" class="flex-1 pb-3 text-sm font-medium border-b-2 border-brand-400 text-white transition">🔧 ${t('crm.tab_system', lang)}</button>
            <button onclick="switchMainTab('users-view')" id="main-tab-users-view" class="flex-1 pb-3 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition">
                <span class="relative">
                    👥 ${t('crm.users_title', lang)}
                    <span id="dot-users" class="hidden absolute -top-0.5 -end-2.5 w-2 h-2 bg-red-500 rounded-full shadow-[0_0_8px_rgba(239,68,68,0.8)] animate-pulse"></span>
                </span>
            </button>
            <button onclick="switchMainTab('audit-view')" id="main-tab-audit-view" class="flex-1 pb-3 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition">${t('crm.security_audit', lang)}</button>
        </div>

        <!-- ═══ SYSTEM TAB ═══ -->
        <div id="system-view-container" class="space-y-6">
            <!-- TELEMETRY -->
            <section>
                <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">${t('crm.system_overview', lang)}</h2>
                <div class="grid grid-cols-2 gap-3">
                    <div class="glass rounded-xl p-4 flex flex-col justify-between cursor-pointer hover:bg-gray-800/50 transition border border-emerald-500/20 h-full" onclick="openActiveDrawer()" role="button" tabindex="0" title="${escapeHtml(t('crm.tooltip_pool', lang))}">
                        <div class="text-gray-400 text-sm mb-1">
                            <div class="flex items-center justify-between">
                                <span>${t('crm.products_title', lang)}</span>
                                <button onclick="event.stopPropagation(); document.getElementById('tooltip-pool').classList.toggle('hidden')" class="p-1 hover:text-white transition">
                                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                                </button>
                            </div>
                            <p id="tooltip-pool" class="hidden text-[10px] text-gray-500 mt-1 leading-tight mb-2">${t('crm.tooltip_pool', lang)}</p>
                        </div>
                        <div class="text-2xl font-bold text-brand-400" id="stat-pool">--</div>
                    </div>
                    <div class="glass rounded-xl p-4 flex flex-col justify-between cursor-pointer hover:bg-gray-800/50 transition border border-brand-500/20 h-full" onclick="openTopChartsDrawer()" role="button" tabindex="0">
                        <div class="text-gray-400 text-sm mb-1">${t('crm.top_charts_title', lang)}</div>
                        <div class="text-sm font-bold text-brand-400 mt-1">${t('crm.btn_view', lang)}</div>
                    </div>
                    <div class="glass rounded-xl p-4 flex flex-col justify-between cursor-pointer hover:bg-gray-800/50 transition border border-amber-500/20 h-full" onclick="openPausedDrawer()" role="button" tabindex="0" title="${escapeHtml(t('crm.tooltip_paused', lang))}">
                        <div class="text-gray-400 text-sm mb-1">
                            <div class="flex items-center justify-between">
                                <span>${t('crm.paused_products', lang)}</span>
                                <button onclick="event.stopPropagation(); document.getElementById('tooltip-paused').classList.toggle('hidden')" class="p-1 hover:text-white transition">
                                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                                </button>
                            </div>
                            <p id="tooltip-paused" class="hidden text-[10px] text-gray-500 mt-1 leading-tight mb-2">${t('crm.tooltip_paused', lang)}</p>
                        </div>
                        <div class="text-2xl font-bold text-amber-400" id="stat-paused">--</div>
                    </div>
                    <div class="glass rounded-xl p-4 flex flex-col justify-between cursor-pointer hover:bg-gray-800/50 transition h-full" onclick="openGraveyardDrawer()" role="button" tabindex="0" title="${escapeHtml(t('crm.tooltip_ghost', lang))}">
                        <div class="text-gray-400 text-sm mb-1">
                            <div class="flex items-center justify-between">
                                <span>${t('crm.ghost_products', lang)}</span>
                                <button onclick="event.stopPropagation(); document.getElementById('tooltip-ghost').classList.toggle('hidden')" class="p-1 hover:text-white transition">
                                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                                </button>
                            </div>
                            <p id="tooltip-ghost" class="hidden text-[10px] text-gray-500 mt-1 leading-tight mb-2">${t('crm.tooltip_ghost', lang)}</p>
                        </div>
                        <div class="text-2xl font-bold text-red-400" id="stat-ghost">--</div>
                    </div>
                    <!-- Row 3: Globally Tracked (distinct gradient card) -->
                    <div class="col-span-2 rounded-xl p-[1px] bg-gradient-to-r from-purple-500/40 via-fuchsia-500/40 to-cyan-500/40 cursor-pointer hover:from-purple-500/60 hover:via-fuchsia-500/60 hover:to-cyan-500/60 transition-all" onclick="openGlobalDrawer()" role="button" tabindex="0" title="${escapeHtml(t('crm.tooltip_global', lang))}">
                        <div class="glass rounded-[11px] p-4 bg-gradient-to-br from-purple-950/40 to-gray-900/60 flex items-center justify-between gap-2">
                            <div class="flex items-center gap-2 sm:gap-3">
                                <div class="w-10 h-10 rounded-lg bg-purple-500/15 flex shrink-0 items-center justify-center">
                                    <span class="text-xl">🌐</span>
                                </div>
                                <div>
                                    <div class="text-gray-400 text-sm mb-0.5">
                                        <div class="whitespace-nowrap flex items-center gap-1">
                                            <span class="text-xs sm:text-sm">${t('crm.global_products', lang)}</span>
                                            <button onclick="event.stopPropagation(); document.getElementById('tooltip-global').classList.toggle('hidden')" class="p-0.5 hover:text-white transition">
                                                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                                            </button>
                                        </div>
                                        <p id="tooltip-global" class="hidden text-[10px] text-gray-500 mt-1 leading-tight mb-1 max-w-[200px] whitespace-normal">${t('crm.tooltip_global', lang)}</p>
                                    </div>
                                    <div class="text-xl sm:text-2xl font-bold bg-gradient-to-r from-purple-400 to-fuchsia-400 bg-clip-text text-transparent" id="stat-global">--</div>
                                </div>
                            </div>
                            <button onclick="event.stopPropagation(); openBulkAddModal()" class="px-2.5 py-1.5 sm:px-4 sm:py-2 rounded-lg bg-purple-500/10 text-purple-300 text-[11px] sm:text-sm font-bold hover:bg-purple-500/25 transition-all border border-purple-500/20 hover:border-purple-500/30 whitespace-nowrap shrink-0">
                                ${t('crm.btn_add_products', lang)}
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Broadcast Deals Section -->
                <section class="mt-3">
                    <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">${t('crm.broadcast_deals', lang)}</h2>
                    <div class="glass rounded-xl p-4 border border-gray-800/50">
                        <p class="text-xs text-gray-500 mb-3">${t('crm.broadcast_deals_desc', lang)}</p>
                        <div class="flex gap-2 mb-3">
                            <input type="text" id="broadcast-deals-input"
                                placeholder="${t('crm.broadcast_enter_asin', lang)}"
                                class="flex-1 bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand-500/50">
                            <button onclick="fetchBroadcastDealsPreview()" id="broadcast-deals-fetch-btn"
                                class="px-4 py-2 bg-brand-500/10 text-brand-400 rounded-lg text-xs font-bold hover:bg-brand-500/20 transition border border-brand-500/20 whitespace-nowrap">
                                ${t('crm.broadcast_fetch', lang)}
                            </button>
                        </div>
                        <div id="broadcast-deals-loading" class="hidden text-center py-4">
                            <div class="inline-block animate-spin w-5 h-5 border-2 border-brand-400 border-t-transparent rounded-full mb-2"></div>
                            <p class="text-xs text-gray-400">${t('crm.broadcast_loading', lang)}</p>
                        </div>
                        <div id="broadcast-deals-options" class="hidden mb-3">
                            <p class="text-xs text-brand-400 font-medium mb-2">${t('crm.broadcast_options_found', lang)}</p>
                            <div id="broadcast-deals-options-list" class="space-y-1 max-h-48 overflow-y-auto pr-1"></div>
                        </div>
                        <div id="broadcast-deals-composer" class="hidden">
                            <div class="bg-gray-800/30 rounded-lg p-3 mb-3">
                                <div class="flex justify-between items-center mb-2">
                                    <label class="text-[10px] text-gray-500 uppercase tracking-wider mb-0">${t('crm.broadcast_editor_label', lang)}</label>
                                    <div class="flex gap-2">
                                        <button onclick="goBackToBroadcastDealsOptions()" id="broadcast-deals-back-btn" class="p-1.5 bg-gray-800 rounded-full text-brand-400 hover:text-brand-300 transition hidden">
                                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
                                        </button>
                                        <button onclick="closeBroadcastDealsComposer()" id="broadcast-deals-close-btn" class="p-1.5 bg-gray-800 rounded-full text-gray-400 hover:text-white transition">
                                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                                        </button>
                                    </div>
                                </div>
                                <input type="text" id="broadcast-deals-title" class="w-full bg-transparent border-b border-gray-700 text-sm font-bold text-white py-1 mb-2 focus:outline-none focus:border-brand-500/50">
                                <label class="text-[10px] text-gray-500 uppercase tracking-wider">${t('crm.broadcast_desc_label', lang)}</label>
                                <textarea id="broadcast-deals-body" rows="6" class="w-full bg-transparent text-sm text-gray-300 py-1 focus:outline-none resize-none leading-relaxed"></textarea>
                            </div>
                            <button onclick="confirmBroadcastDeals()" id="broadcast-deals-confirm-btn"
                                class="w-full justify-center bg-brand-500/10 hover:bg-brand-500/20 text-brand-400 text-sm px-4 py-2.5 rounded-lg font-medium transition border border-brand-500/20 flex items-center gap-2">
                                ${t('crm.broadcast_confirm_send', lang)}
                            </button>
                        </div>
                        <div id="broadcast-deals-error" class="hidden text-center py-3">
                            <p class="text-xs text-red-400" id="broadcast-deals-error-text"></p>
                        </div>
                    </div>
                </section>

                <!-- Engine Health Widget -->
                <div class="mt-3 glass rounded-xl p-4" id="engine-health-widget">
                    <div class="flex items-center justify-between mb-2">
                        <div class="text-xs font-semibold text-gray-400 uppercase tracking-wider">${t('crm.engine_health', lang)}</div>
                        <div class="flex items-center gap-1.5">
                            <div class="w-2 h-2 rounded-full bg-green-500" id="engine-status-dot"></div>
                            <span class="text-xs font-medium text-green-400" id="engine-status-text">--</span>
                        </div>
                    </div>
                    <div class="grid grid-cols-3 gap-2 text-center h-full">
                        <div class="bg-gray-800/50 rounded-lg p-2 flex flex-col justify-between h-full min-h-[60px]">
                            <div class="text-[10px] text-gray-500 uppercase mb-1">${t('crm.engine_interval', lang)}</div>
                            <div class="text-sm font-bold text-white" id="engine-interval">--</div>
                        </div>
                        <div class="bg-gray-800/50 rounded-lg p-2 flex flex-col justify-between h-full min-h-[60px]">
                            <div class="text-[10px] text-gray-500 uppercase mb-1">${t('crm.engine_daily_ops', lang)}</div>
                            <div class="text-sm font-bold text-white" id="engine-daily-ops">--</div>
                        </div>
                        <div class="bg-gray-800/50 rounded-lg p-2 flex flex-col justify-between h-full min-h-[60px]">
                            <div class="text-[10px] text-gray-500 uppercase mb-1">${t('crm.engine_batches', lang)}</div>
                            <div class="text-sm font-bold text-white" id="engine-batches">--</div>
                        </div>
                    </div>
                </div>

                <div class="mt-3 glass rounded-xl p-4 flex flex-col gap-3">
                    <div class="text-center w-full">
                        <span class="text-gray-400 text-sm">${t('crm.last_sync', lang)}: </span>
                        <span class="text-sm font-medium" id="stat-sync">--</span>
                    </div>
                    <div class="w-full">
                        <button onclick="triggerGlobalScrape()" class="w-full justify-center bg-gray-800 hover:bg-gray-700 text-white text-xs px-3 py-2 rounded-lg font-medium transition shadow border border-gray-700 flex items-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg> ${t('crm.force_check', lang)}
                        </button>
                    </div>
                </div>
            </section>
            ${isProd ? '' : `
            <!-- ENV SYNC -->
            <section id="env-sync-section" class="mb-6">
                <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">${t('crm.env_sync_title', lang)}</h2>
                <div class="glass rounded-xl p-4 border border-gray-800/50 relative overflow-hidden group">
                    <div class="flex items-center justify-between gap-4 relative z-10">
                        <div class="w-10 h-10 rounded-lg bg-gray-800 flex shrink-0 items-center justify-center shadow-inner group-hover:bg-brand-500/10 transition-colors">
                            <span class="text-lg">🔄</span>
                        </div>
                        <div class="flex-1">
                            <div class="text-sm font-semibold">${t('crm.env_sync_title', lang)}</div>
                            <div class="text-[10px] text-gray-500 mt-1">
                                ${t('crm.env_sync_desc', lang)}
                            </div>
                        </div>
                        <button onclick="triggerSync(this)" class="px-4 py-2 bg-brand-500/10 text-brand-400 rounded-lg text-xs font-bold hover:bg-brand-500/20 transition border border-brand-500/20 flex items-center gap-2 group-hover:shadow-[0_0_15px_rgba(14,165,233,0.3)] whitespace-nowrap shrink-0">
                            <span>🔄</span>
                            ${t('crm.btn_sync', lang)}
                        </button>
                    </div>
                </div>
            </section>
            `}

            <!-- BROADCAST -->
            <section id="broadcast-section">
                <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">${t('crm.system_broadcast', lang)}</h2>
                <div class="glass rounded-xl p-4">
                    <textarea id="broadcast-msg" rows="2" class="w-full bg-gray-900 border border-gray-700 rounded-lg p-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition" placeholder="${escapeHtml(t('crm.broadcast_placeholder', lang))}"></textarea>
                    <div class="flex justify-end mt-3">
                        <button onclick="sendBroadcast()" class="bg-brand-600 hover:bg-brand-500 text-white text-sm px-4 py-2 rounded-lg font-medium transition shadow-lg shadow-brand-500/20 flex items-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"></path></svg> ${t('crm.send_broadcast', lang)}
                        </button>
                    </div>
                </div>
            </section>
        </div>

        <!-- ═══ USERS TAB ═══ -->
        <div id="users-view-container" class="hidden space-y-6">
            <div class="glass rounded-xl p-4 flex items-center justify-between border-b-2 border-brand-500">
                <div class="text-gray-400 text-sm font-medium">${t('crm.users_title', lang)}</div>
                <div class="text-2xl font-bold text-white" id="stat-users">--</div>
            </div>
            <!-- DIRECTORY NAVIGATION -->
            <section>
                <div class="flex border-b border-gray-800 mb-4 overflow-x-auto" style="scrollbar-width: none;">
                    <button onclick="switchTab('users')" id="tab-users" class="px-4 pb-3 text-sm font-medium tab-active transition whitespace-nowrap relative">
                        ${t('crm.tab_approved', lang)}
                    </button>
                    <button onclick="switchTab('queue')" id="tab-queue" class="px-4 pb-3 text-sm font-medium tab-inactive transition flex items-center gap-1.5 whitespace-nowrap">
                        ${t('crm.tab_pending', lang)} <span id="badge-queue" class="hidden bg-brand-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full"></span>
                    </button>
                    <button onclick="switchTab('banned')" id="tab-banned" class="px-4 pb-3 text-sm font-medium tab-inactive transition whitespace-nowrap text-red-400/80">${t('crm.tab_banned', lang)}</button>
                    <button onclick="switchTab('admins')" id="tab-admins" class="px-4 pb-3 text-sm font-medium tab-inactive transition whitespace-nowrap">${t('crm.tab_admins', lang)}</button>
                </div>

                <!-- Queue View -->
                <div id="view-queue" class="hidden space-y-3">
                    
                <div class="flex items-center justify-between bg-gray-800/50 p-4 rounded-xl border border-gray-700/50 mb-2">
                    <div>
                        <span class="text-sm font-bold text-gray-200 block">${t('crm.mute_queue_title', lang) || 'Mute Join Queue Notifications'}</span>
                        <span class="text-[10px] text-gray-500 block leading-tight mt-0.5">${t('crm.mute_queue_desc', lang) || 'Stop receiving Telegram messages when a new user requests access'}</span>
                    </div>
                    <button id="toggle-mute-queue" onclick="performAction('toggle_mute_queue', null, null, this)" class="w-12 h-6 rounded-full relative transition-colors duration-200 focus:outline-none">
                        <div class="w-5 h-5 bg-white rounded-full absolute top-0.5 left-0.5 transition-transform duration-200 shadow-md"></div>
                    </button>
                </div>
                <div id="queue-list" class="text-center py-8 text-gray-500 text-sm">${t('crm.loading_items', lang)}</div>
                </div>

                <!-- Users View -->
                <div id="view-users" class="space-y-3">
                    <div class="relative">
                        <input type="text" id="search-users" onkeyup="filterUsers()" placeholder="${escapeHtml(t('crm.search_users_placeholder', lang))}" class="w-full bg-gray-900 border border-gray-800 rounded-lg ps-10 pe-4 py-2.5 text-sm focus:outline-none focus:border-gray-700 transition">
                        <svg class="w-4 h-4 text-gray-500 absolute start-3.5 top-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                    </div>
                    <div id="users-list" class="space-y-3">
                        <div class="text-center py-8 text-gray-500 text-sm">${t('crm.loading_items', lang)}</div>
                    </div>
                </div>
            </section>
        </div>

        <!-- ═══ SECURITY AUDIT TAB ═══ -->
        <div id="audit-view-container" class="hidden space-y-3">
            <div id="audit-list" class="space-y-3">
                <div class="glass rounded-xl p-6 text-center text-gray-400">${t('crm.compiling_ledger', lang)}</div>
            </div>
        </div>
    </main>

    <!-- Overlay Loader -->
    <div id="overlay" class="fixed inset-0 bg-gray-950/80 backdrop-blur-sm z-50 flex items-center justify-center hidden opacity-0 transition-opacity duration-300">
        <div class="glass rounded-2xl p-6 flex flex-col items-center shadow-2xl border-gray-700">
            <div class="w-10 h-10 border-4 border-gray-700 border-t-brand-500 rounded-full animate-spin mb-4"></div>
            <p class="text-sm font-medium" id="overlay-text">${t('crm.toast_processing', lang)}</p>
        </div>
    </div>

    <!-- Product Drawer -->
    <div id="drawer" class="fixed inset-0 z-50 hidden">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closeDrawer()"></div>
        <div class="absolute bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 rounded-t-2xl transform translate-y-full transition-transform duration-300 ease-out flex flex-col max-h-[85vh]" id="drawer-content">
            <div class="w-12 h-1.5 bg-gray-700 rounded-full mx-auto mt-3 mb-2"></div>
            <div class="px-4 pb-3 border-b border-gray-800 flex justify-between items-center">
                <div>
                    <h3 class="font-bold text-lg" id="drawer-title">${t('crm.user_products', lang)}</h3>
                    <p class="text-xs text-gray-400" id="drawer-subtitle">${t('crm.user_id_label', lang)} --</p>
                </div>
                <button onclick="closeDrawer()" class="p-2 bg-gray-800 rounded-full text-gray-400 hover:text-white">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            <div class="px-4 py-2 border-b border-gray-800 bg-gray-900/50"><input type="text" id="search-drawer-users" oninput="filterDrawer(this.value, 'drawer-items')" placeholder="${escapeHtml(t('crm.search_placeholder', lang))}" class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-brand-500 transition"></div>
            <div class="p-4 overflow-y-auto flex-1 space-y-3" id="drawer-items">
                <div class="text-center py-8 text-gray-500 text-sm">${t('crm.loading_items', lang)}</div>
            </div>
        </div>
    </div>

    <!-- Active Products Drawer -->
    <div id="drawer-active" class="fixed inset-0 z-50 hidden">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closeActiveDrawer()"></div>
        <div class="absolute bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 rounded-t-2xl transform translate-y-full transition-transform duration-300 ease-out flex flex-col max-h-[85vh]" id="drawer-active-content">
            <div class="w-12 h-1.5 bg-gray-700 rounded-full mx-auto mt-3 mb-2"></div>
            <div class="px-4 pb-3 border-b border-gray-800 flex justify-between items-center">
                <div>
                    <h3 class="font-bold text-lg">${t('crm.products_title', lang)}</h3>
                    <p class="text-xs text-emerald-400" id="drawer-active-count">0 ${t('crm.items_label', lang)}</p>
                </div>
                <button onclick="closeActiveDrawer()" class="p-2 bg-gray-800 rounded-full text-gray-400 hover:text-white">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            <div class="px-4 py-2 border-b border-gray-800 bg-gray-900/50 flex gap-2 items-center"><input type="text" id="search-drawer-active" oninput="filterDrawer(this.value, 'drawer-active-items')" placeholder="${escapeHtml(t('crm.search_placeholder', lang))}" class="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-brand-500 transition"><div class="relative shrink-0"><button id="sort-btn-active" onclick="toggleSortDropdown('active')" class="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs font-medium hover:bg-gray-700 transition whitespace-nowrap"><span id="sort-label-active">${t('crm.sort_by', lang)}</span><span id="sort-dir-active" class="text-[10px]">↕</span></button><div id="sort-dropdown-active" class="hidden absolute bottom-full mb-1 end-0 rounded-lg bg-gray-800 border border-gray-700 shadow-xl z-50 overflow-hidden min-w-[130px]"><button data-sort="date" onclick="applySort('active', 'date')" class="w-full text-center px-3 py-2 text-xs hover:bg-gray-700 transition">${t('crm.sort_date', lang)}</button><button data-sort="price" onclick="applySort('active', 'price')" class="w-full text-center px-3 py-2 text-xs hover:bg-gray-700 transition">${t('crm.sort_price', lang)}</button><button data-sort="name" onclick="applySort('active', 'name')" class="w-full text-center px-3 py-2 text-xs hover:bg-gray-700 transition">${t('crm.sort_name', lang)}</button></div></div></div>
            <div class="p-4 overflow-y-auto flex-1 space-y-3" id="drawer-active-items" onscroll="handleActiveScroll()">
            </div>
        </div>
    </div>

    <!-- Top Charts Drawer -->
    <div id="drawer-top-charts" class="fixed inset-0 z-50 hidden">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closeTopChartsDrawer()"></div>
        <div class="absolute bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 rounded-t-2xl transform translate-y-full transition-transform duration-300 ease-out flex flex-col max-h-[85vh]" id="drawer-top-charts-content">
            <div class="w-12 h-1.5 bg-gray-700 rounded-full mx-auto mt-3 mb-2"></div>
            <div class="px-4 pb-3 border-b border-gray-800 flex justify-between items-center">
                <div>
                    <h3 class="font-bold text-lg">${t('crm.top_charts_title', lang)}</h3>
                    <p class="text-xs text-gray-400" id="drawer-top-charts-subtitle">${t('crm.click_to_expand', lang)}</p>
                </div>
                <button onclick="closeTopChartsDrawer()" class="p-2 bg-gray-800 rounded-full text-gray-400 hover:text-white">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            <div class="px-4 py-2 border-b border-gray-800 bg-gray-900/50 flex gap-2 items-center"><input type="text" id="search-drawer-top-charts" oninput="filterDrawer(this.value, 'drawer-top-charts-items')" placeholder="${escapeHtml(t('crm.search_placeholder', lang))}" class="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-brand-500 transition"><div class="relative shrink-0"><button id="sort-btn-top-charts" onclick="toggleSortDropdown('top-charts')" class="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs font-medium hover:bg-gray-700 transition whitespace-nowrap"><span id="sort-label-top-charts">${t('crm.sort_by', lang)}</span><span id="sort-dir-top-charts" class="text-[10px]">↕</span></button><div id="sort-dropdown-top-charts" class="hidden absolute bottom-full mb-1 end-0 rounded-lg bg-gray-800 border border-gray-700 shadow-xl z-50 overflow-hidden min-w-[130px]"><button data-sort="date" onclick="applySort('top-charts', 'date')" class="w-full text-center px-3 py-2 text-xs hover:bg-gray-700 transition">${t('crm.sort_date', lang)}</button><button data-sort="price" onclick="applySort('top-charts', 'price')" class="w-full text-center px-3 py-2 text-xs hover:bg-gray-700 transition">${t('crm.sort_price', lang)}</button><button data-sort="name" onclick="applySort('top-charts', 'name')" class="w-full text-center px-3 py-2 text-xs hover:bg-gray-700 transition">${t('crm.sort_name', lang)}</button></div></div></div>
            <div class="p-4 overflow-y-auto flex-1 space-y-3" id="drawer-top-charts-items">
                <div class="text-center py-8 text-gray-500 text-sm">${t('crm.loading_items', lang)}</div>
            </div>
        </div>
    </div>

    <!-- Paused Products Drawer -->
    <div id="drawer-paused" class="fixed inset-0 z-50 hidden">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closePausedDrawer()"></div>
        <div class="absolute bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 rounded-t-2xl transform translate-y-full transition-transform duration-300 ease-out flex flex-col max-h-[85vh]" id="drawer-paused-content">
            <div class="w-12 h-1.5 bg-gray-700 rounded-full mx-auto mt-3 mb-2"></div>
            <div class="px-4 pb-3 border-b border-gray-800 flex justify-between items-center">
                <div>
                    <h3 class="font-bold text-lg">${t('crm.paused_products', lang)}</h3>
                    <p class="text-xs text-gray-400" id="drawer-paused-subtitle">${t('crm.click_to_expand', lang)}</p>
                </div>
                <button onclick="closePausedDrawer()" class="p-2 bg-gray-800 rounded-full text-gray-400 hover:text-white">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            <div class="px-4 py-2 border-b border-gray-800 bg-gray-900/50 flex gap-2 items-center"><input type="text" id="search-drawer-paused" oninput="filterDrawer(this.value, 'drawer-paused-items')" placeholder="${escapeHtml(t('crm.search_placeholder', lang))}" class="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-brand-500 transition"><div class="relative shrink-0"><button id="sort-btn-paused" onclick="toggleSortDropdown('paused')" class="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs font-medium hover:bg-gray-700 transition whitespace-nowrap"><span id="sort-label-paused">${t('crm.sort_by', lang)}</span><span id="sort-dir-paused" class="text-[10px]">↕</span></button><div id="sort-dropdown-paused" class="hidden absolute bottom-full mb-1 end-0 rounded-lg bg-gray-800 border border-gray-700 shadow-xl z-50 overflow-hidden min-w-[130px]"><button data-sort="date" onclick="applySort('paused', 'date')" class="w-full text-center px-3 py-2 text-xs hover:bg-gray-700 transition">${t('crm.sort_date', lang)}</button><button data-sort="price" onclick="applySort('paused', 'price')" class="w-full text-center px-3 py-2 text-xs hover:bg-gray-700 transition">${t('crm.sort_price', lang)}</button><button data-sort="name" onclick="applySort('paused', 'name')" class="w-full text-center px-3 py-2 text-xs hover:bg-gray-700 transition">${t('crm.sort_name', lang)}</button></div></div></div>
            <div class="px-4 py-2 border-b border-gray-800 bg-red-900/10 flex items-center justify-between" id="drawer-paused-toolbar" style="display: none;">
                <label class="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" id="paused-select-all" onchange="togglePausedSelectAll()" class="rounded bg-gray-800 border-gray-600 text-red-500 focus:ring-red-500">
                    <span class="text-xs text-gray-400">${t('crm.select_all', lang)}</span>
                </label>
                <button onclick="deleteSelectedPaused()" id="paused-delete-selected-btn" class="bg-red-600/20 hover:bg-red-600/30 text-red-400 text-xs px-3 py-1.5 rounded-lg font-medium transition border border-red-500/20 flex items-center gap-1.5">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                    <span>${t('crm.bulk_delete', lang)}</span>
                </button>
            </div>
            <div class="p-4 overflow-y-auto flex-1 space-y-3" id="drawer-paused-items">
                <div class="text-center py-8 text-gray-500 text-sm">${t('crm.loading_items', lang)}</div>
            </div>
        </div>
    </div>

    <!-- Graveyard Drawer -->
    <div id="drawer-graveyard" class="fixed inset-0 z-50 hidden">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closeGraveyardDrawer()"></div>
        <div class="absolute bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 rounded-t-2xl transform translate-y-full transition-transform duration-300 ease-out flex flex-col max-h-[85vh]" id="drawer-graveyard-content">
            <div class="w-12 h-1.5 bg-gray-700 rounded-full mx-auto mt-3 mb-2"></div>
            <div class="px-4 pb-3 border-b border-gray-800 flex justify-between items-center">
                <div>
                    <h3 class="font-bold text-lg">${t('crm.graveyard_title', lang)}</h3>
                    <p class="text-xs text-gray-400" id="drawer-graveyard-count">--</p>
                </div>
                <button onclick="closeGraveyardDrawer()" class="p-2 bg-gray-800 rounded-full text-gray-400 hover:text-white">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            <div class="px-4 py-2 border-b border-gray-800 bg-gray-900/50 flex gap-2 items-center"><input type="text" id="search-drawer-graveyard" oninput="filterDrawer(this.value, 'drawer-graveyard-items')" placeholder="${escapeHtml(t('crm.search_placeholder', lang))}" class="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-brand-500 transition"><div class="relative shrink-0"><button id="sort-btn-graveyard" onclick="toggleSortDropdown('graveyard')" class="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs font-medium hover:bg-gray-700 transition whitespace-nowrap"><span id="sort-label-graveyard">${t('crm.sort_by', lang)}</span><span id="sort-dir-graveyard" class="text-[10px]">↕</span></button><div id="sort-dropdown-graveyard" class="hidden absolute bottom-full mb-1 end-0 rounded-lg bg-gray-800 border border-gray-700 shadow-xl z-50 overflow-hidden min-w-[130px]"><button data-sort="date" onclick="applySort('graveyard', 'date')" class="w-full text-center px-3 py-2 text-xs hover:bg-gray-700 transition">${t('crm.sort_date', lang)}</button><button data-sort="price" onclick="applySort('graveyard', 'price')" class="w-full text-center px-3 py-2 text-xs hover:bg-gray-700 transition">${t('crm.sort_price', lang)}</button><button data-sort="name" onclick="applySort('graveyard', 'name')" class="w-full text-center px-3 py-2 text-xs hover:bg-gray-700 transition">${t('crm.sort_name', lang)}</button></div></div></div>
            <div class="px-4 py-2 border-b border-gray-800 flex justify-between items-center bg-red-900/10" id="drawer-graveyard-toolbar" style="display: none;">
                <label class="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" id="graveyard-select-all" onchange="toggleGraveyardSelectAll()" class="rounded bg-gray-800 border-gray-600 text-red-500 focus:ring-red-500">
                    <span class="text-xs text-gray-400" id="graveyard-select-all-label">${t('crm.select_all', lang)}</span>
                </label>
                <button onclick="purgeSelectedGhosts()" class="bg-red-600/20 hover:bg-red-600/30 text-red-400 text-xs px-3 py-1.5 rounded-lg font-medium transition border border-red-500/20 flex items-center gap-1.5">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                    <span>${t('crm.graveyard_purge_btn', lang)}</span>
                </button>
            </div>
            <div class="p-4 overflow-y-auto flex-1 space-y-3" id="drawer-graveyard-items">
                <div class="text-center py-8 text-gray-500 text-sm">${t('crm.loading_items', lang)}</div>
            </div>
        </div>
    </div>

    <!-- Globally Tracked Drawer -->
    <div id="drawer-global" class="fixed inset-0 z-50 hidden">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closeGlobalDrawer()"></div>
        <div class="absolute bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 rounded-t-2xl transform translate-y-full transition-transform duration-300 ease-out flex flex-col max-h-[85vh]" id="drawer-global-content">
            <div class="w-12 h-1.5 bg-gray-700 rounded-full mx-auto mt-3 mb-2"></div>
            <div class="px-4 pb-3 border-b border-gray-800 flex justify-between items-center">
                <div>
                    <h3 class="font-bold text-lg flex items-center gap-2">🌐 ${t('crm.global_products', lang)}</h3>
                    <p class="text-xs text-gray-400" id="drawer-global-count">--</p>
                </div>
                <div class="flex items-center gap-2">
                    <button onclick="openBulkAddModal()" class="px-3 py-1.5 bg-purple-500/10 text-purple-300 rounded-lg text-xs font-bold hover:bg-purple-500/25 transition border border-purple-500/20 whitespace-nowrap">
                        ${t('crm.btn_add_products', lang)}
                    </button>
                    <button onclick="closeGlobalDrawer()" class="p-2 bg-gray-800 rounded-full text-gray-400 hover:text-white">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>
                </div>
            </div>
            <div class="px-4 py-2 border-b border-gray-800 bg-gray-900/50 flex gap-2 items-center"><input type="text" id="search-drawer-global" oninput="filterDrawer(this.value, 'drawer-global-items')" placeholder="${escapeHtml(t('crm.search_placeholder', lang))}" class="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-brand-500 transition"><div class="relative shrink-0"><button id="sort-btn-global" onclick="toggleSortDropdown('global')" class="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs font-medium hover:bg-gray-700 transition whitespace-nowrap"><span id="sort-label-global">${t('crm.sort_by', lang)}</span><span id="sort-dir-global" class="text-[10px]">↕</span></button><div id="sort-dropdown-global" class="hidden absolute bottom-full mb-1 end-0 rounded-lg bg-gray-800 border border-gray-700 shadow-xl z-50 overflow-hidden min-w-[130px]"><button data-sort="date" onclick="applySort('global', 'date')" class="w-full text-center px-3 py-2 text-xs hover:bg-gray-700 transition">${t('crm.sort_date', lang)}</button><button data-sort="price" onclick="applySort('global', 'price')" class="w-full text-center px-3 py-2 text-xs hover:bg-gray-700 transition">${t('crm.sort_price', lang)}</button><button data-sort="name" onclick="applySort('global', 'name')" class="w-full text-center px-3 py-2 text-xs hover:bg-gray-700 transition">${t('crm.sort_name', lang)}</button></div></div></div>
            <div class="px-4 py-2 border-b border-gray-800 bg-red-900/10 flex items-center justify-between" id="drawer-global-toolbar" style="display: none;">
                <label class="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" id="global-select-all" onchange="toggleGlobalSelectAll()" class="rounded bg-gray-800 border-gray-600 text-red-500 focus:ring-red-500">
                    <span class="text-xs text-gray-400">${t('crm.select_all', lang)}</span>
                </label>
                <button onclick="deleteSelectedGlobal()" class="bg-red-600/20 hover:bg-red-600/30 text-red-400 text-xs px-3 py-1.5 rounded-lg font-medium transition border border-red-500/20 flex items-center gap-1.5">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                    <span>${t('crm.graveyard_purge_btn', lang)}</span>
                </button>
            </div>
            <div class="p-4 overflow-y-auto flex-1 space-y-3" id="drawer-global-items">
                <div class="text-center py-8 text-gray-500 text-sm">${t('crm.loading_items', lang)}</div>
            </div>
        </div>
    </div>

    <!-- Bulk Add Modal -->
    <div id="bulk-add-modal" class="fixed inset-0 z-[60] hidden">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closeBulkAddModal()"></div>
        <div class="absolute bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 rounded-t-2xl transform translate-y-full transition-transform duration-300 ease-out flex flex-col" id="bulk-add-modal-content">
            <div class="w-12 h-1.5 bg-gray-700 rounded-full mx-auto mt-3 mb-2"></div>
            <div class="px-4 pb-3 border-b border-gray-800 flex justify-between items-center">
                <h3 class="font-bold text-lg flex items-center gap-2">📦 ${t('crm.bulk_add_title', lang)}</h3>
                <button onclick="closeBulkAddModal()" class="p-2 bg-gray-800 rounded-full text-gray-400 hover:text-white">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            <div class="p-4 flex flex-col gap-4">
                <textarea id="bulk-add-input" rows="8" placeholder="${escapeHtml(t('crm.bulk_add_placeholder', lang))}" class="w-full bg-gray-800 border border-gray-700 rounded-xl p-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 transition resize-none"></textarea>
                
                <div id="bulk-add-preview" class="hidden glass rounded-xl p-3 border border-purple-500/20">
                    <p class="text-xs font-bold text-purple-400 mb-2">${t('crm.bulk_add_preview', lang)}</p>
                    <div id="bulk-add-summary-text" class="text-sm font-medium"></div>
                </div>

                <div class="flex gap-2 justify-end mt-2">
                    <button onclick="closeBulkAddModal()" class="px-4 py-2 bg-gray-800 text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-700 transition">
                        ${t('crm.confirm_btn_cancel', lang)}
                    </button>
                    <button onclick="submitBulkAdd()" id="bulk-add-submit-btn" class="px-6 py-2 bg-purple-600 text-white rounded-lg text-sm font-bold hover:bg-purple-500 transition shadow-lg shadow-purple-500/20 flex items-center gap-2">
                        <span id="bulk-add-btn-text">${t('crm.bulk_add_preview', lang)}</span>
                    </button>
                </div>
            </div>
        </div>
    </div>

    <!-- Product Subs Drawer -->
    <div id="drawer-product-subs" class="fixed inset-0 z-50 hidden">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closeProductSubsDrawer()"></div>
        <div class="absolute bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 rounded-t-2xl transform translate-y-full transition-transform duration-300 ease-out flex flex-col max-h-[85vh]" id="drawer-product-subs-content">
            <div class="w-12 h-1.5 bg-gray-700 rounded-full mx-auto mt-3 mb-2"></div>
            <div class="px-4 pb-3 border-b border-gray-800 flex justify-between items-center">
                <div>
                    <h3 class="font-bold text-lg" id="drawer-product-subs-title">Subscribers</h3>
                    <p class="text-xs text-gray-400" id="drawer-product-subs-count">--</p>
                </div>
                <button onclick="closeProductSubsDrawer()" class="p-2 bg-gray-800 rounded-full text-gray-400 hover:text-white">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            <div class="p-4 overflow-y-auto flex-1 space-y-3" id="drawer-product-subs-items">
                <div class="text-center py-8 text-gray-500 text-sm">${t('crm.loading_items', lang)}</div>
            </div>
        </div>
    </div>

    <!-- Chart Modal -->
    <div id="chart-modal" class="fixed inset-0 z-50 hidden">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closeChartModal()"></div>
        <div class="absolute inset-x-4 top-1/2 -translate-y-1/2 bg-gray-900 border border-gray-800 rounded-2xl p-4 shadow-2xl flex flex-col max-h-[85vh]">
            <div class="flex justify-between items-center mb-4">
                <h3 class="font-bold text-lg">${t('crm.price_history', lang)}</h3>
                <button onclick="closeChartModal()" class="p-2 bg-gray-800 rounded-full text-gray-400 hover:text-white">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            
            <div class="flex gap-4 mb-4" id="chart-metrics" style="display: none;">
                <div class="flex-1 bg-gray-800 rounded-lg p-2 text-center">
                    <div class="text-[10px] text-gray-400 uppercase">${t('crm.ath', lang)}</div>
                    <div class="font-bold text-red-400 text-sm" id="chart-ath">--</div>
                </div>
                <div class="flex-1 bg-gray-800 rounded-lg p-2 text-center">
                    <div class="text-[10px] text-gray-400 uppercase">${t('crm.avg', lang)}</div>
                    <div class="font-bold text-gray-200 text-sm" id="chart-avg">--</div>
                </div>
                <div class="flex-1 bg-gray-800 rounded-lg p-2 text-center">
                    <div class="text-[10px] text-gray-400 uppercase">${t('crm.atl', lang)}</div>
                    <div class="font-bold text-green-400 text-sm" id="chart-atl">--</div>
                </div>
            </div>
            <div class="flex gap-2 mb-4 overflow-x-auto pb-1" id="chart-intervals" style="display: none;">
                <button data-interval="1W" onclick="renderChartInterval('1W')" class="flex-1 py-1 bg-gray-800 text-gray-400 text-xs rounded-full border border-gray-700 hover:text-white hover:border-gray-500 transition whitespace-nowrap">${t('crm.chart_1w', lang)}</button>
                <button data-interval="1M" onclick="renderChartInterval('1M')" class="flex-1 py-1 bg-gray-800 text-gray-400 text-xs rounded-full border border-gray-700 hover:text-white hover:border-gray-500 transition whitespace-nowrap">${t('crm.chart_1m', lang)}</button>
                <button data-interval="3M" onclick="renderChartInterval('3M')" class="flex-1 py-1 bg-gray-800 text-gray-400 text-xs rounded-full border border-gray-700 hover:text-white hover:border-gray-500 transition whitespace-nowrap">${t('crm.chart_3m', lang)}</button>
                <button data-interval="6M" onclick="renderChartInterval('6M')" class="flex-1 py-1 bg-gray-800 text-gray-400 text-xs rounded-full border border-gray-700 hover:text-white hover:border-gray-500 transition whitespace-nowrap">${t('crm.chart_6m', lang)}</button>
                <button data-interval="ALL" onclick="renderChartInterval('ALL')" class="flex-1 py-1 bg-brand-500/20 text-brand-400 text-xs rounded-full border border-brand-500/50 hover:text-brand-300 transition whitespace-nowrap">${t('crm.chart_all', lang)}</button>
            </div>

            <div id="chart-loading" class="text-center py-8 text-gray-500 text-sm">${t('crm.loading_chart', lang)}</div>
            <div class="w-full relative flex-1 min-h-[300px]">
                <canvas id="crmPriceChart" style="display: none;"></canvas>
            </div>
        </div>
    </div>

    <!-- Broadcast Modal -->
    <div id="broadcast-modal" class="fixed inset-0 z-50 hidden">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closeBroadcastModal()"></div>
        <div class="absolute inset-x-4 top-1/2 -translate-y-1/2 bg-gray-900 border border-gray-800 rounded-2xl p-4 shadow-2xl flex flex-col max-h-[85vh] overflow-y-auto">
            <div class="flex justify-between items-center mb-4">
                <h3 class="font-bold text-lg">${t('crm.broadcast_composer', lang)}</h3>
                <div class="flex gap-2">
                    <button onclick="goBackToBroadcastModalOptions()" id="broadcast-modal-back-btn" class="p-2 bg-gray-800 rounded-full text-brand-400 hover:text-brand-300 hidden transition">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
                    </button>
                    <button onclick="closeBroadcastModal()" id="broadcast-modal-close-btn" class="p-2 bg-gray-800 rounded-full text-gray-400 hover:text-white transition">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>
                </div>
            </div>
            <div id="broadcast-modal-loading" class="text-center py-8">
                <div class="inline-block animate-spin w-6 h-6 border-2 border-brand-400 border-t-transparent rounded-full mb-2"></div>
                <p class="text-xs text-gray-400">${t('crm.broadcast_loading', lang)}</p>
            </div>
            <div id="broadcast-modal-options" class="hidden mb-4">
                <p class="text-xs text-brand-400 font-medium mb-2">${t('crm.broadcast_options_found', lang)}</p>
                <div id="broadcast-modal-options-list" class="space-y-1 max-h-40 overflow-y-auto pr-1"></div>
            </div>
            <div id="broadcast-modal-composer" class="hidden">
                <div class="bg-gray-800/30 rounded-lg p-3 mb-3">
                    <label class="text-[10px] text-gray-500 uppercase tracking-wider">${t('crm.broadcast_editor_label', lang)}</label>
                    <input type="text" id="broadcast-modal-title" class="w-full bg-transparent border-b border-gray-700 text-sm font-bold text-white py-1 mb-2 focus:outline-none focus:border-brand-500/50">
                    <label class="text-[10px] text-gray-500 uppercase tracking-wider">${t('crm.broadcast_desc_label', lang)}</label>
                    <textarea id="broadcast-modal-body" rows="6" class="w-full bg-transparent text-sm text-gray-300 py-1 focus:outline-none resize-none leading-relaxed"></textarea>
                </div>
                <button onclick="confirmBroadcastModal()" id="broadcast-modal-confirm-btn"
                    class="w-full justify-center bg-brand-500/10 hover:bg-brand-500/20 text-brand-400 text-sm px-4 py-2.5 rounded-lg font-medium transition border border-brand-500/20 flex items-center gap-2">
                    ${t('crm.broadcast_confirm_send', lang)}
                </button>
            </div>
            <div id="broadcast-modal-error" class="hidden text-center py-3">
                <p class="text-xs text-red-400" id="broadcast-modal-error-text"></p>
            </div>
        </div>
    </div>

    <!-- Toast Container -->
    <div id="toast-container" class="fixed bottom-6 left-4 right-4 z-[110] flex flex-col gap-2 pointer-events-none"></div>

    <script>
        const tg = (window.Telegram && window.Telegram.WebApp) || {};
        if (tg.expand) tg.expand();
        if (tg.ready) tg.ready();
        if (tg.BackButton) tg.BackButton.hide();
        window.addEventListener('pageshow', (e) => {
            if (e.persisted) { window.location.reload(); }
            if (tg.BackButton) tg.BackButton.hide();
        });
        try {
            if (tg.setHeaderColor) tg.setHeaderColor('#030712');
            if (tg.setBackgroundColor) tg.setBackgroundColor('#030712');
        } catch (e) { console.warn('Telegram theme color not supported:', e); }

        const initData = tg.initData || '';
        let appData = { users: [], joinQueue: [] };
        let activeTab = 'users';

        function escapeHtml(unsafe) {
            if (!unsafe) return "";
            return String(unsafe)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }


        async function fetchAPI(path, method = 'GET', body = null, options = {}) {
            if(!initData) return showToast(${js('crm.local_mode_toast')}, "error");
            try {
                const opts = {
                    method,
                    headers: { 'Authorization': 'Bearer ' + initData, 'Content-Type': 'application/json' },
                    ...options
                };
                if (body) opts.body = JSON.stringify(body);
                
                const res = await fetch('/api/crm' + path, opts);
                if (!res.ok) {
                    let errMsg = 'HTTP ' + res.status;
                    try {
                        const errJson = await res.json();
                        if (errJson.message) errMsg = errJson.message;
                        else if (errJson.error) errMsg = errJson.error;
                    } catch (e) {}
                    throw new Error(errMsg);
                }
                
                if (res.status === 202) return { status: 'queued' };
                const json = await res.json();
                const dbLang = res.headers.get("X-User-Lang") || json.lang;
                if (dbLang && dbLang !== (new URLSearchParams(window.location.search).get('lang') || 'masry')) {
                    window.location.replace(window.location.pathname + '?lang=' + dbLang + window.location.hash);
                    return null;
                }
                const currentUser = res.headers.get("X-Current-User");
                if (currentUser) json._currentUser = currentUser;
                return json;
            } catch (err) {
                console.error(err);
                showToast(${js('crm.toast_network_error')} + ": " + err.message, 'error');
                return null;
            }
        }

        async function refreshData() {
            showLoader(${js('crm.toast_syncing')});
            const data = await fetchAPI('/data');
            hideLoader();
            const initLoader = document.getElementById('init-loader');
            if (initLoader) initLoader.remove();
            if (data) {
                appData = data;
                renderTelemetry();
                renderTabs();
                showToast(${js('crm.toast_synced')}, "success");
            }
        }

        function renderTelemetry() {
            const activeLength = appData.systemStats.activeWatchPool || 0;
            document.getElementById('stat-users').innerText = appData.systemStats.totalUsers || 0;
            document.getElementById('stat-pool').innerText = activeLength;
            document.getElementById('stat-paused').innerText = appData.systemStats.pausedProducts || 0;
            document.getElementById('stat-ghost').innerText = appData.systemStats.ghostProducts || 0;
            document.getElementById('stat-global').innerText = appData.systemStats.globalProducts || 0;
            const ms = appData.systemStats.lastRunMs;
            document.getElementById('stat-sync').innerText = ms ? new Date(ms).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : ${js('crm.never')};

            // Engine Health calculation (zero extra D1 reads — reuses activeWatchPool)
            renderEngineHealth(appData.systemStats.activeWatchPool || 0);

            const badge = document.getElementById('badge-queue');
            const dot = document.getElementById('dot-users');
            if(appData.joinQueue.length > 0) {
                badge.innerText = appData.joinQueue.length;
                badge.classList.remove('hidden');
                if(dot) dot.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
                if(dot) dot.classList.add('hidden');
            }

            const me = appData.users.find(u => u.chat_id == appData.auth.adminId);
            if (me) {
                const btn = document.getElementById('toggle-mute-queue');
                if (btn) {
                    if (me.mute_join_queue === 1) {
                        btn.classList.add('bg-brand-500');
                        btn.classList.remove('bg-gray-600');
                        btn.firstElementChild.style.transform = 'translateX(1.5rem)';
                    } else {
                        btn.classList.add('bg-gray-600');
                        btn.classList.remove('bg-brand-500');
                        btn.firstElementChild.style.transform = 'translateX(0)';
                    }
                }
            }
        }

        // Engine Health: replicates cron_trigger.js governor math in-browser
        // Reuses poolSize from systemStats — zero extra D1 reads
        function renderEngineHealth(poolSize) {
            if (poolSize === 0) {
                document.getElementById('engine-interval').innerText = 'N/A';
                document.getElementById('engine-daily-ops').innerText = '0';
                document.getElementById('engine-batches').innerText = '0';
                document.getElementById('engine-status-dot').className = 'w-2 h-2 rounded-full bg-gray-500';
                document.getElementById('engine-status-text').innerText = 'Idle';
                document.getElementById('engine-status-text').className = 'text-xs font-medium text-gray-400';
                return;
            }

            // Exact same math as cron_trigger.js
            const batches = Math.ceil(poolSize / 10);
            const opsLimit = parseInt(appData.systemStats.queueLimit || '10000', 10);
            const dailyMessageBudget = Math.floor((opsLimit * 0.9) / 3);
            const maxRuns = Math.floor(dailyMessageBudget / batches);
            const intervalMs = Math.floor(86400000 / maxRuns);

            // Fetch dynamic hardware cron interval from systemStats (default 5 mins)
            const hardwareIntervalMs = parseInt(appData.systemStats.hardwareIntervalMs || '300000', 10);
            const hardwareIntervalMin = Math.round(hardwareIntervalMs / 60000);

            // Format interval for display, clamping to actual hardware cron limit
            const intervalMin = Math.max(hardwareIntervalMin, Math.round(intervalMs / 60000));
            document.getElementById('engine-interval').innerText = intervalMin + ' ' + ${js('crm.minutes_short')};

            // Actual engine runs per day are strictly bounded by the dynamic hardware cron trigger
            // 86,400,000 ms per day / hardwareIntervalMs = max hardware wake-ups per day.
            const actualRunsPerDay = Math.floor(86400000 / Math.max(hardwareIntervalMs, intervalMs));

            // Daily Queue Operations = actual runs * batches * 3 (1 message = write + read + delete)
            const dailyOps = actualRunsPerDay * batches * 3;
            document.getElementById('engine-daily-ops').innerText = dailyOps.toLocaleString();

            document.getElementById('engine-batches').innerText = batches;

            // Status: color-code based on how close to daily ops limit
            const opsRatio = dailyOps / opsLimit;
            const dot = document.getElementById('engine-status-dot');
            const text = document.getElementById('engine-status-text');

            if (opsRatio < 0.5) {
                dot.className = 'w-2 h-2 rounded-full bg-green-500';
                text.innerText = ${js('crm.engine_status_ok')};
                text.className = 'text-xs font-medium text-green-400';
            } else if (opsRatio < 0.8) {
                dot.className = 'w-2 h-2 rounded-full bg-amber-500';
                text.innerText = ${js('crm.engine_status_warn')};
                text.className = 'text-xs font-medium text-amber-400';
            } else {
                dot.className = 'w-2 h-2 rounded-full bg-red-500';
                text.innerText = ${js('crm.engine_status_critical')};
                text.className = 'text-xs font-medium text-red-400';
            }
        }

        function switchMainTab(tabId) {
            const tabs = ['system-view', 'users-view', 'audit-view'];
            tabs.forEach(t => {
                const el = document.getElementById('main-tab-' + t);
                if (el) {
                    if (t === tabId) {
                        el.classList.add('border-brand-400', 'text-white');
                        el.classList.remove('border-transparent', 'text-gray-400');
                    } else {
                        el.classList.add('border-transparent', 'text-gray-400');
                        el.classList.remove('border-brand-400', 'text-white');
                    }
                }
                document.getElementById(t + '-container').classList.toggle('hidden', t !== tabId);
            });

            if (tabId === 'audit-view' && !appData.auditLoaded) {
                loadAuditTab();
            }
        }
        
        async function loadAuditTab() {
            const container = document.getElementById('audit-list');
            container.innerHTML = '<div class="glass rounded-xl p-6 text-center text-gray-400">' + ${js('crm.loading_audit')} + '</div>';
            
            const logs = await fetchAPI('/audit');
            if (!logs) {
                container.innerHTML = '<div class="glass rounded-xl p-6 text-center text-red-400">' + ${js('crm.toast_network_error')} + '</div>';
                return;
            }
            appData.auditLoaded = true;
            
            if (logs.length === 0) {
                container.innerHTML = '<div class="glass rounded-xl p-6 text-center text-gray-500 border border-gray-800 border-dashed">' + ${js('crm.no_audit')} + '</div>';
                return;
            }
            
            const locale = document.documentElement.lang === 'masry' ? 'ar-EG' : 'en-GB';
            const actionMap = {
                'PURGE_GHOSTS': ${js('audit.action.purge_ghosts')},
                'FORCE_SCRAPE': ${js('audit.action.force_scrape')},
                'GLOBAL_BROADCAST': ${js('audit.action.global_broadcast')},
                'PRODUCT_BROADCAST': ${js('audit.action.product_broadcast')},
                'BULK_DELETE': ${js('audit.action.bulk_delete')},
                'APPROVE_USER': ${js('audit.action.approve_user')},
                'REJECT_USER': ${js('audit.action.reject_user')},
                'REVOKE_USER': ${js('audit.action.revoke_user')},
                'UNBAN_USER': ${js('audit.action.unban_user')},
                'PROMOTE_ADMIN': ${js('audit.action.promote_admin')},
                'DEMOTE_ADMIN': ${js('audit.action.demote_admin')},
                'SET_LIMIT': ${js('audit.action.set_limit')},
                'DELETE_PRODUCT': ${js('audit.action.delete_product')},
                'TOGGLE_KEEP_ALIVE': ${js('audit.action.toggle_keep_alive')},
                'MUTE_JOIN_QUEUE': ${js('audit.action.mute_join_queue')},
                'UNMUTE_JOIN_QUEUE': ${js('audit.action.unmute_join_queue')},
                'ENABLE_KEEP_ALIVE': ${js('audit.action.enable_keep_alive')},
                'DISABLE_KEEP_ALIVE': ${js('audit.action.disable_keep_alive')},
                'DIRECT_MESSAGE': ${js('audit.action.direct_message')},
                'SET_TARGET': ${js('audit.action.set_target')},
                'SYNC_ENV': ${js('audit.action.sync_env')},
                'AUTO_CLEANUP_IDLE': ${js('audit.action.auto_cleanup_idle')}
            };

            container.innerHTML = logs.map(log => {
                const date = new Date(log.ts);
                const timeStr = date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

                const adminDisplay = log.adminHandle ? escapeHtml(log.adminHandle) + ' <span class="text-[10px] opacity-60">(' + escapeHtml(log.adminId) + ')</span>' : '<code class="bg-gray-800 px-1 py-0.5 rounded">' + escapeHtml(log.adminId) + '</code>';
                let targetDisplay = '<code class="bg-gray-800 px-1 py-0.5 rounded">' + escapeHtml(log.target) + '</code>';
                if (log.targetHandle) targetDisplay = escapeHtml(log.targetHandle) + ' <span class="text-[10px] opacity-60">(' + escapeHtml(log.target) + ')</span>';
                const actionEsc = escapeHtml(log.action);

                let detailsStr = log.details || '';
                if (typeof log.details === 'object' && log.details !== null) {
                    let template = actionMap[log.action] || log.action;
                    for (const [k, v] of Object.entries(log.details)) {
                        template = template.replace(new RegExp('{' + k + '}', 'g'), escapeHtml(String(v)));
                    }
                    if (log.action === 'REJECT_USER' && log.details.unban) {
                        template += (document.documentElement.lang === 'masry' ? ' (رفض فك البلوك)' : ' (unban — permanent)');
                    }
                    detailsStr = template;
                }
                const detailsEsc = typeof log.details === 'string' ? escapeHtml(log.details) : detailsStr;

                return '<div class="glass rounded-xl p-4">' +
                    '<div class="flex justify-between items-center text-xs opacity-80 border-b border-gray-700/50 pb-2 mb-2">' +
                        '<span>' + adminDisplay + '</span>' +
                        '<span>\u{1F552} ' + timeStr + '</span>' +
                    '</div>' +
                    '<div class="text-sm flex gap-2 mb-1"><span class="font-semibold opacity-80 w-16">' + ${js('crm.audit_target')} + '</span><span class="break-all">' + targetDisplay + '</span></div>' +
                    '<div class="text-sm flex gap-2"><span class="font-semibold opacity-80 w-16">' + ${js('crm.audit_details')} + '</span><span class="break-all">' + detailsEsc + '</span></div>' +
                '</div>';
            }).join('');
        }

        function switchTab(tab) {
            activeTab = tab;
            const tabs = ['users', 'queue', 'banned', 'admins'];
            const baseClasses = {
                'users': 'px-4 pb-3 text-sm font-medium transition whitespace-nowrap relative',
                'queue': 'px-4 pb-3 text-sm font-medium transition flex items-center gap-1.5 whitespace-nowrap',
                'banned': 'px-4 pb-3 text-sm font-medium transition whitespace-nowrap text-red-400/80',
                'admins': 'px-4 pb-3 text-sm font-medium transition whitespace-nowrap'
            };
            tabs.forEach(t => {
                const el = document.getElementById('tab-' + t);
                if (el) {
                    const cls = t === tab ? 'tab-active' : 'tab-inactive';
                    el.className = baseClasses[t] + ' ' + cls;
                }
            });
            
            document.getElementById('view-queue').style.display = tab === 'queue' ? 'block' : 'none';
            document.getElementById('view-users').style.display = tab !== 'queue' ? 'block' : 'none';
            
            renderTabs();
        }

        function renderTabs() {
            if (activeTab === 'queue') {
                const list = document.getElementById('queue-list');
                if (!appData.joinQueue || appData.joinQueue.length === 0) {
                    list.innerHTML = '<div class="text-center py-10 text-gray-500 text-sm glass rounded-xl border border-gray-800 border-dashed">' + ${js('crm.no_pending')} + '</div>';
                    return;
                }
                
                list.innerHTML = appData.joinQueue.map(u => {
                    const time = new Date(u.requested_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                    const isUnban = u.request_type === 'unban';
                    const typeLabel = isUnban ? ${js('crm.queue_type_unban')} : ${js('crm.queue_type_access')};
                    const typeColor = isUnban ? 'bg-orange-500/15 text-orange-400 border-orange-500/20' : 'bg-brand-500/15 text-brand-400 border-brand-500/20';
                    const idEsc = escapeHtml(String(u.id));
                    const firstEsc = escapeHtml(u.first_name) || 'User';
                    const userDisplay = u.username ? '@' + escapeHtml(u.username) : idEsc;
                    const borderClass = isUnban ? 'border-s-2 border-s-orange-500/40' : '';
                    const actionApprove = isUnban ? 'unban' : 'approve';
                    const approveTitle = isUnban ? (${js('crm.btn_unban')} || 'Unban') : 'Approve';
                    const approveInner = isUnban
                        ? '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>'
                        : '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>';
                    const approveAttr = isUnban ? ' title="' + approveTitle + '"' : '';
                    const rejectTitle = isUnban ? (${js('crm.btn_deny')} || 'Deny') : 'Reject';
                    const rejectAttr = ' title="' + rejectTitle + '"';
                    return '<div class="glass rounded-xl p-3 flex justify-between items-center ' + borderClass + '">' +
                        '<div class="min-w-0 flex-1">' +
                            '<div class="flex items-center gap-2 mb-1">' +
                                '<div class="font-medium text-sm truncate">' + firstEsc + ' <sub class="text-gray-500 font-normal text-[10px] ml-1">' + userDisplay + '</sub></div>' +
                            '</div>' +
                            '<div class="flex items-center gap-3">' +
                                '<span class="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ' + typeColor + ' border">' + typeLabel + '</span>' +
                                '<span class="text-xs text-gray-500 shrink-0">' + ${js('crm.requested_label')} + ' ' + time + '</span>' +
                            '</div>' +
                        '</div>' +
                        '<div class="flex items-center gap-2 ml-3 shrink-0">' +
                            '<button onclick="performAction(\\'reject\\', \\'' + idEsc + '\\')" class="w-8 h-8 rounded bg-red-500/10 text-red-400 flex items-center justify-center hover:bg-red-500/20 transition"' + rejectAttr + '><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>' +
                            '<button onclick="performAction(\\'' + actionApprove + '\\', \\'' + idEsc + '\\')" class="w-8 h-8 rounded bg-emerald-500/10 text-emerald-400 flex items-center justify-center hover:bg-emerald-500/20 transition"' + approveAttr + '>' + approveInner + '</button>' +
                        '</div>' +
                    '</div>';
                }).join('');
            } else {
                filterUsers();
            }
        }

        function filterUsers() {
            const query = (document.getElementById('search-users').value || '').toLowerCase();
            const list = document.getElementById('users-list');
            
            let filtered = appData.users;
            
            if (activeTab === 'admins') {
                filtered = filtered.filter(u => u.role === 'admin' || u.role === 'root');
            } else if (activeTab === 'banned') {
                filtered = filtered.filter(u => u.role === 'rejected');
            } else if (activeTab === 'users') {
                filtered = filtered.filter(u => u.role === 'approved');
            }
            
            filtered = filtered.filter(u => u.chat_id.toString().toLowerCase().includes(query) || u.role.toLowerCase().includes(query) || (u.first_name && u.first_name.toLowerCase().includes(query)) || (u.username && u.username.toLowerCase().includes(query)));

            // Client-side sort: active users first (by last_active DESC), then inactive (by created_at DESC)
            if (activeTab === 'users') {
                filtered.sort((a, b) => {
                    const aActive = (a.last_active && a.last_active > 0) ? 1 : 0;
                    const bActive = (b.last_active && b.last_active > 0) ? 1 : 0;
                    if (aActive !== bActive) return bActive - aActive; // active first
                    // Within same group: sort by time desc
                    const aTime = aActive ? a.last_active : (a.created_at || 0);
                    const bTime = bActive ? b.last_active : (b.created_at || 0);
                    return bTime - aTime;
                });
            }

            if (filtered.length === 0) {
                list.innerHTML = '<div class="text-center py-10 text-gray-500 text-sm glass rounded-xl border border-gray-800 border-dashed">' + ${js('crm.no_users_found')} + '</div>';
                return;
            }

            list.innerHTML = filtered.map(u => {
                const roleColors = { 'root': 'text-purple-400 border-purple-400/20 bg-purple-400/10', 'admin': 'text-brand-400 border-brand-400/20 bg-brand-400/10', 'approved': 'text-gray-300 border-gray-700 bg-gray-800', 'rejected': 'text-red-400 border-red-400/20 bg-red-400/10' };
                const roleStyle = roleColors[u.role] || roleColors['rejected'];
                const firstNameEsc = escapeHtml(u.first_name) || 'User';
                const usernameEsc = u.username ? '@' + escapeHtml(u.username) : escapeHtml(String(u.chat_id));
                const chatIdEsc = escapeHtml(String(u.chat_id));
                const rawRole = u.role ? u.role.toLowerCase() : '';
                const roleEsc = rawRole === 'root' ? ${js('crm.role_root')} : (rawRole === 'admin' ? ${js('crm.role_admin')} : escapeHtml(u.role).toUpperCase());
                const firstNameJsEsc = escapeHtml(u.first_name || '').replace(/'/g, "\\'");
                const usernameJsEsc = escapeHtml(u.username || '').replace(/'/g, "\\'");
                const isRoot = u.role === 'root';
                const isAdmin = u.role === 'admin';
                const isApproved = u.role === 'approved';
                const isRejected = u.role === 'rejected';
                const isPrivileged = isAdmin || isRoot;
                const itemLimit = isPrivileged ? '∞' : u.item_limit;
                const joinedDate = new Date(u.created_at).toLocaleDateString('en-GB');

                let activeDaysAgo = (u.last_active && u.last_active > 0) ? (Date.now() - u.last_active) / 86400000 : null;
                let activeColor = activeDaysAgo === null ? 'text-gray-500' : (activeDaysAgo < 7 ? 'text-emerald-500' : (activeDaysAgo < 30 ? 'text-amber-500' : 'text-red-500'));
                let activeDate = (u.last_active && u.last_active > 0) ? new Date(u.last_active).toLocaleDateString('en-GB') : '-';

                let rootGlow = '';
                if (isRoot) rootGlow = '<div class="absolute -right-2 -top-2 w-10 h-10 bg-purple-500/20 blur-xl rounded-full"></div>';

                let roleBadge = '';
                if (isPrivileged) {
                    roleBadge = '<span class="text-[10px] px-2 py-0.5 rounded uppercase font-bold border ' + roleStyle + '">' + roleEsc + '</span>';
                } else {
                    roleBadge = '<div class="w-2 h-2 rounded-full bg-current ' + activeColor + '"></div>';
                }

                let actionBtns = '';
                if (isRejected) {
                    actionBtns += '<button onclick="performAction(\\'unban\\', \\'' + chatIdEsc + '\\')" class="flex-1 py-1.5 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-xs text-emerald-400 font-medium transition text-center border border-emerald-500/20">' + ${js('crm.btn_unban')} + '</button>';
                } else {
                    actionBtns += '<button onclick="messageUser(\\'' + chatIdEsc + '\\')" class="flex-1 py-1.5 rounded bg-brand-500/10 hover:bg-brand-500/20 text-xs text-brand-400 font-medium transition text-center border border-brand-500/20">' + ${js('crm.btn_message')} + '</button>';
                    if (!isPrivileged) actionBtns += '<button onclick="changeLimit(\\'' + chatIdEsc + '\\', ' + u.item_limit + ', \\'' + firstNameJsEsc + '\\', \\'' + usernameJsEsc + '\\')" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 font-medium transition text-center border border-gray-700/50">' + ${js('crm.btn_edit_limit')} + '</button>';
                    if (isApproved) actionBtns += '<button onclick="performAction(\\'promote\\', \\'' + chatIdEsc + '\\')" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-brand-400 font-medium transition text-center border border-brand-500/20">' + ${js('crm.btn_promote')} + '</button>';
                    if (isAdmin) actionBtns += '<button onclick="performAction(\\'demote\\', \\'' + chatIdEsc + '\\')" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-orange-400 font-medium transition text-center border border-orange-500/20">' + ${js('crm.btn_demote_drawer')} + '</button>';
                    if (!isRoot) actionBtns += '<button onclick="performAction(\\'revoke\\', \\'' + chatIdEsc + '\\')" class="w-10 flex items-center justify-center py-1.5 rounded bg-red-500/10 hover:bg-red-500/20 text-xs text-red-400 font-medium transition border border-red-500/20"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>';
                }

                return '<div class="glass rounded-xl p-3 border border-gray-800/50 hover:border-gray-700 transition overflow-hidden relative mb-3">' +
                    rootGlow +
                    '<div class="flex justify-between items-center mb-2 relative z-10">' +
                        '<div class="font-medium text-sm font-semibold truncate flex items-center gap-2">' + roleBadge + firstNameEsc + ' <sub class="text-gray-500 font-normal text-[10px]">' + usernameEsc + '</sub></div>' +
                        '<button onclick="openDrawer(\\'' + chatIdEsc + '\\')" class="px-3 py-1.5 rounded-lg bg-gray-800 text-xs font-medium text-brand-400 hover:bg-gray-700 transition shadow">' + ${js('crm.btn_view_items')} + '</button>' +
                    '</div>' +
                    '<div class="flex items-center gap-2 mb-3 relative z-10">' +
                        '<span class="text-xs text-gray-500">' + u.active_items + ' / ' + itemLimit + ' ' + ${js('crm.items_label')} + '</span>' +
                        '<span class="text-xs text-gray-500">•</span>' +
                        '<span class="text-xs text-gray-500">' + ${js('crm.joined_date')} + ' ' + joinedDate + '</span>' +
                        '<span class="text-xs text-gray-500">•</span>' +
                        '<span class="text-xs font-medium ' + activeColor + '">⚡ ' + activeDate + '</span>' +
                    '</div>' +
                    '<div class="flex gap-2 relative z-10">' + actionBtns + '</div>' +
                '</div>';
            }).join('');
        }

        function messageUser(userId) {
            const msg = prompt(${js('crm.btn_message')} + " — " + userId + ":");
            if (msg) {
                performAction('direct_message', userId, { message: msg });
            }
        }

        async function openDrawer(userId) {
            const drawer = document.getElementById('drawer');
            const content = document.getElementById('drawer-content');
            const itemsCont = document.getElementById('drawer-items');
            
            document.getElementById('drawer-subtitle').innerText = ${js('crm.id_label')} + ' ' + userId;
            itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm"><div class="w-6 h-6 border-2 border-gray-700 border-t-brand-500 rounded-full animate-spin mx-auto mb-2"></div>' + ${js('crm.loading_items')} + '</div>';
            
            drawer.classList.remove('hidden');
            setTimeout(() => {
                content.style.transform = 'translateY(0)';
            }, 10);
            
            const products = await fetchAPI('/user/' + userId + '/products');

            if (!products || products.length === 0) {
                itemsCont.innerHTML = '<div class="text-center py-10 text-gray-500 text-sm glass rounded-xl border border-gray-800 border-dashed">' + ${js('crm.no_saved_products')} + '</div>';
                return;
            }

            const isMasry = document.documentElement.lang === 'masry';
            itemsCont.innerHTML = products.map(p => {
                const isPaused = p.is_paused === 1;
                const statusColor = isPaused ? 'text-orange-400 bg-orange-400/10' : 'text-emerald-400 bg-emerald-400/10';
                const statusText = isPaused ? ${js('crm.user_paused')} : ${js('crm.user_active')};
                const pName = (isMasry && p.name_ar) ? p.name_ar : (p.name || p.asin);
                const rawName = pName ? (pName.length > 35 ? pName.substring(0, 32) + '...' : pName) : p.asin;
                const nameEsc = escapeHtml(rawName);
                const asinEsc = escapeHtml(p.asin);
                const price = p.new_price ? p.new_price + ' ' + ${js('chrome.currency_egp')} : (p.used_price ? ${js('crm.user_used_only')} : ${js('crm.user_out_of_stock')});
                const userIdEsc = escapeHtml(String(userId));
                const actionType = isPaused ? 'resume_product' : 'pause_product';
                const pauseIcon = isPaused ? '▶️' : '⏸️';
                const pauseLabel = isPaused ? ${js('crm.btn_resume')} : ${js('crm.btn_pause_drawer')};
                const hasTarget = !!p.target_price;
                const targetBadge = hasTarget
                    ? '<div class="text-xs text-brand-400 flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg> ' + ${js('crm.audit_target')} + ' ' + p.target_price + '</div>'
                    : '';

                const btnIcon = p.always_track === 1 ? '🟢' : '📡';
                const btnLabel = p.always_track === 1 ? ${js('crm.btn_tracking_global')} : ${js('crm.btn_track_global')};
                const btnClass = p.always_track === 1 
                    ? 'ring-1 ring-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border-transparent' 
                    : 'bg-gray-800 hover:bg-gray-700 text-gray-300 border-gray-700/50';

                return '<div class="glass rounded-xl p-3 border border-gray-800/50 relative overflow-hidden" data-search="' + escapeHtml(p.asin).toLowerCase() + ' ' + escapeHtml(nameEsc).toLowerCase() + '">' +
                    '<div class="flex items-start gap-3 mb-2">' +
                        '<img src="' + (p.image_url ? escapeHtml(p.image_url) : 'https://images-na.ssl-images-amazon.com/images/P/' + asinEsc + '.01.MZZZZZZZ.jpg') + '" class="w-12 h-12 rounded object-cover bg-white shrink-0" onerror="this.src=\\'https://images-na.ssl-images-amazon.com/images/P/' + asinEsc + '.01.MZZZZZZZ.jpg\\'; this.onerror=function(){this.style.display=\\'none\\'};">' +
                        '<div class="flex-1 min-w-0 pe-2">' +
                            '<a href="' + escapeHtml(p.detail_page_url || ('https://www.amazon.eg/dp/' + p.asin)) + '" target="_blank" class="font-medium text-sm text-brand-400 hover:underline block leading-tight truncate">' + nameEsc + '</a>' +
                            '<div class="text-xs text-gray-500 mt-1 font-mono">' + asinEsc + '</div>' +
                        '</div>' +
                        '<span class="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase ' + statusColor + ' whitespace-nowrap shrink-0">' + statusText + '</span>' +
                    '</div>' +
                    '<div class="flex justify-between items-end mb-3">' +
                        '<div class="text-sm font-semibold">' + price + '</div>' +
                        targetBadge +
                    '</div>' +
                    '<div class="grid grid-cols-3 gap-2">' +
                        '<button onclick="performAction(\\'toggle_keep_alive\\', \\'global\\', {asin: \\'' + asinEsc.replace(/'/g, "\\'") + '\\'}, this)" class="py-1.5 rounded text-xs font-medium transition border ' + btnClass + '">' + btnIcon + ' ' + btnLabel + '</button>' +
                        '<button onclick="openChartModal(\\'' + asinEsc.replace(/'/g, "\\'") + '\\')" class="py-1.5 rounded bg-brand-500/10 hover:bg-brand-500/20 text-xs text-brand-400 font-medium transition border border-brand-500/20">📊 ' + ${js('crm.btn_chart')} + '</button>' +
                        '<button onclick="openBroadcastModal(\\'' + asinEsc.replace(/'/g, "\\'") + '\\')" class="py-1.5 rounded bg-brand-500/10 hover:bg-brand-500/20 text-xs text-brand-400 font-medium transition border border-brand-500/20">' + ${js('crm.per_product_broadcast')} + '</button>' +
                    '</div>' +
                '</div>';
            }).join('');
        }

        function closeDrawer() {
            const content = document.getElementById('drawer-content');
            content.style.transform = 'translateY(100%)';
            setTimeout(() => { document.getElementById('drawer').classList.add('hidden'); }, 300);
            const searchInput = document.getElementById('search-drawer-users');
            if (searchInput) { searchInput.value = ''; filterDrawer('', 'drawer-items'); }
        }

        async function openTopChartsDrawer() {
            const drawer = document.getElementById('drawer-top-charts');
            const content = document.getElementById('drawer-top-charts-content');
            const itemsCont = document.getElementById('drawer-top-charts-items');

            itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm"><div class="w-6 h-6 border-2 border-gray-700 border-t-brand-500 rounded-full animate-spin mx-auto mb-2"></div>' + ${js('crm.loading_items')} + '</div>';

            drawer.classList.remove('hidden');
            setTimeout(() => { content.style.transform = 'translateY(0)'; }, 10);

            const data = await fetchAPI('/top-charts');
            if (!data || !data.items || data.items.length === 0) {
                itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm">' + ${js('crm.top_charts_no_data')} + '</div>';
                return;
            }

            const lang = document.documentElement.lang || 'masry';
            let html = '';
            data.items.forEach((item, idx) => {
                const name = lang === 'masry' && item.name_ar ? escapeHtml(item.name_ar) : escapeHtml(item.name || item.asin);
                const price = item.amazon_price || item.new_price;
                const priceStr = price ? ${js('chrome.currency_egp')} + ' ' + parseFloat(price).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '--';
                const sortName = escapeHtml(name).toLowerCase();
                const sortPrice = price || 0;
                html += '<div class="bg-gray-800 rounded-lg p-3 flex items-center gap-3 cursor-pointer hover:bg-gray-700 transition" data-search="' + escapeHtml(item.asin).toLowerCase() + ' ' + sortName + '" data-name="' + sortName + '" data-price="' + sortPrice + '" data-added="" onclick="openChartModal(\\'' + escapeHtml(item.asin) + '\\')">';
                html += '<div class="text-lg font-bold text-gray-600 w-8 text-center">#' + (idx + 1) + '</div>';
                html += '<img src="' + (item.image_url ? escapeHtml(item.image_url) : 'https://images-na.ssl-images-amazon.com/images/P/' + escapeHtml(item.asin) + '.01.MZZZZZZZ.jpg') + '" class="w-12 h-12 rounded object-cover bg-white shrink-0" onerror="this.src=\\'https://images-na.ssl-images-amazon.com/images/P/' + escapeHtml(item.asin) + '.01.MZZZZZZZ.jpg\\'; this.onerror=function(){this.style.display=\\'none\\'};">' ;
                html += '<div class="flex-1 min-w-0">';
                html += '<div class="text-sm font-medium truncate"><a href="' + escapeHtml(item.detail_page_url || ('https://www.amazon.eg/dp/' + item.asin)) + '" target="_blank" class="text-brand-400 hover:text-brand-300 hover:underline transition" onclick="event.stopPropagation()">' + name + '</a></div>';
                html += '<div class="text-xs text-gray-500">' + escapeHtml(item.asin) + ' · ' + priceStr + '</div>';
                html += '</div>';
                html += '<div class="text-right">';
                html += '<div class="text-sm font-bold text-brand-400">' + item.tracker_count + '</div>';
                html += '<div class="text-[10px] text-gray-500 uppercase">' + ${js('crm.top_charts_trackers')} + '</div>';
                html += '</div></div>';
            });
            itemsCont.innerHTML = html;
        }

        function closeTopChartsDrawer() {
            const drawer = document.getElementById('drawer-top-charts');
            const content = document.getElementById('drawer-top-charts-content');
            content.style.transform = 'translateY(100%)';
            setTimeout(() => { drawer.classList.add('hidden'); }, 300);
            const searchInput = document.getElementById('search-drawer-top-charts');
            if (searchInput) { searchInput.value = ''; filterDrawer('', 'drawer-top-charts-items'); }
            resetSortUI('top-charts');
        }


        // ── Drawer Sort ──────────────────────────────────────────────────────────

        const sortByLabel = ${js('crm.sort_by')};

        const sortState = {
            active:      { field: null, dir: 'desc' },
            'top-charts': { field: null, dir: 'desc' },
            paused:      { field: null, dir: 'desc' },
            graveyard:   { field: null, dir: 'desc' },
        };

        function toggleSortDropdown(drawer) {
            const dropdown = document.getElementById('sort-dropdown-' + drawer);
            const isOpen = !dropdown.classList.contains('hidden');
            // Close all sort dropdowns
            document.querySelectorAll('[id^="sort-dropdown-"]').forEach(d => d.classList.add('hidden'));
            if (!isOpen) dropdown.classList.remove('hidden');
        }

        function applySort(drawer, field) {
            const state = sortState[drawer];
            if (state.field === field) {
                state.dir = state.dir === 'desc' ? 'asc' : 'desc';
            } else {
                state.field = field;
                state.dir = (field === 'name') ? 'asc' : 'desc';
            }
            // Update button label
            const labelEl = document.getElementById('sort-label-' + drawer);
            const dirEl = document.getElementById('sort-dir-' + drawer);
            const dropdown = document.getElementById('sort-dropdown-' + drawer);
            const selectedBtn = dropdown ? dropdown.querySelector('[data-sort="' + field + '"]') : null;
            if (labelEl && selectedBtn) labelEl.innerText = selectedBtn.innerText.trim();
            if (dirEl) dirEl.innerText = state.dir === 'desc' ? '▼' : '▲';
            // Close dropdown
            document.getElementById('sort-dropdown-' + drawer).classList.add('hidden');
            // Active drawer: render all remaining items before sorting
            if (drawer === 'active' && typeof activeRenderIndex !== 'undefined' && typeof activeProductsData !== 'undefined' && activeRenderIndex < activeProductsData.length) {
                const lang = document.documentElement.lang || 'masry';
                const isMasry = lang === 'masry';
                const remaining = activeProductsData.slice(activeRenderIndex);
                activeRenderIndex = activeProductsData.length;
                renderActiveProductCards(remaining, lang, isMasry);
            }
            performSort(drawer);
        }

        function performSort(drawer) {
            const state = sortState[drawer];
            if (!state.field) return;
            const containerId = 'drawer-' + drawer + '-items';
            const container = document.getElementById(containerId);
            if (!container) return;
            const items = Array.from(container.querySelectorAll('[data-search]'));
            if (items.length === 0) return;

            const field = state.field;
            const dir = state.dir === 'desc' ? -1 : 1;

            items.sort((a, b) => {
                let valA, valB;
                if (field === 'name') {
                    valA = a.getAttribute('data-name') || '';
                    valB = b.getAttribute('data-name') || '';
                    return dir * valA.localeCompare(valB, 'ar');
                } else if (field === 'price') {
                    valA = parseFloat(a.getAttribute('data-price')) || 0;
                    valB = parseFloat(b.getAttribute('data-price')) || 0;
                    return dir * (valA - valB);
                } else if (field === 'date') {
                    valA = a.getAttribute('data-added') || '';
                    valB = b.getAttribute('data-added') || '';
                    return dir * valA.localeCompare(valB);
                }
                return 0;
            });

            items.forEach(item => container.appendChild(item));
        }

        function resetSortUI(drawer) {
            sortState[drawer] = { field: null, dir: 'desc' };
            const labelEl = document.getElementById('sort-label-' + drawer);
            const dirEl = document.getElementById('sort-dir-' + drawer);
            if (labelEl) labelEl.innerText = sortByLabel;
            if (dirEl) dirEl.innerText = '↕';
        }

        // Close sort dropdowns when clicking outside
        document.addEventListener('click', function(e) {
            if (!e.target.closest('[id^="sort-btn-"]') && !e.target.closest('[id^="sort-dropdown-"]')) {
                document.querySelectorAll('[id^="sort-dropdown-"]').forEach(d => d.classList.add('hidden'));
            }
        });


        function filterDrawer(query, containerId) {
            const q = query.toLowerCase().trim();
            const container = document.getElementById(containerId);
            if (!container) return;

            // Active Products drawer: search against the full data array so that
            // lazy-loaded (not-yet-rendered) items are still findable.
            if (containerId === 'drawer-active-items' && activeProductsData.length > 0) {
                if (!q) {
                    // Query cleared — reset to initial lazy-loaded state
                    activeRenderIndex = 0;
                    container.innerHTML = '';
                    renderMoreActiveProducts();
                    return;
                }
                const lang = document.documentElement.lang || 'masry';
                const isMasry = lang === 'masry';
                const matched = activeProductsData.filter(item => {
                    const name = (isMasry && item.name_ar) ? item.name_ar : (item.name || item.asin);
                    const searchStr = (item.asin + ' ' + name).toLowerCase();
                    return searchStr.includes(q);
                });
                if (matched.length === 0) {
                    container.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm">No matching products found</div>';
                    activeRenderIndex = activeProductsData.length;
                    return;
                }
                container.innerHTML = '';
                activeRenderIndex = activeProductsData.length;
                renderActiveProductCards(matched, lang, isMasry);
                if (sortState.active && sortState.active.field) performSort('active');
                return;
            }

            // Default: DOM-based filtering for other drawers (paused, graveyard, users)
            const items = container.querySelectorAll('[data-search]');
            items.forEach(item => {
                const searchStr = item.getAttribute('data-search') || '';
                if (!q || searchStr.includes(q)) {
                    item.style.display = 'block';
                } else {
                    item.style.display = 'none';
                }
            });

            // Re-apply sort after filtering (for drawers with active sort state)
            const drawerId = containerId.replace('drawer-', '').replace('-items', '');
            if (sortState[drawerId] && sortState[drawerId].field) {
                performSort(drawerId);
            }
        }

        let activeProductsData = [];
        let activeRenderIndex = 0;

        async function openActiveDrawer() {
            const drawer = document.getElementById('drawer-active');
            const content = document.getElementById('drawer-active-content');
            const itemsCont = document.getElementById('drawer-active-items');
            
            itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm"><div class="w-6 h-6 border-2 border-gray-700 border-t-emerald-500 rounded-full animate-spin mx-auto mb-2"></div>Loading...</div>';
            drawer.classList.remove('hidden');
            setTimeout(() => { content.style.transform = 'translateY(0)'; }, 10);

            const data = await fetchAPI('/active-products');
            const isMasry = document.documentElement.lang === 'masry';
            const subsText = ${js('crm.subscriptions_text')};
            if (!data || !data.items || data.items.length === 0) {
                itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm">' + ${js('crm.no_active_products')} + '</div>';
                document.getElementById('drawer-active-count').innerText = '0 ' + subsText;
                return;
            }
            
            document.getElementById('drawer-active-count').innerText = data.items.length + ' ' + subsText;
            activeProductsData = data.items;
            activeRenderIndex = 0;
            itemsCont.innerHTML = '';
            renderMoreActiveProducts();
        }

        function renderActiveProductCards(items, lang, isMasry) {
            const itemsCont = document.getElementById('drawer-active-items');
            const html = items.map((item) => {
                const name = (isMasry && item.name_ar) ? item.name_ar : (item.name || item.asin);
                const userName = escapeHtml(item.first_name || 'User');
                const userDetails = item.username ? \`(@\${item.username})\` : \`(\${item.chat_id})\`;
                const displayUser = \`\${userName} <span class="opacity-70">\${userDetails}</span>\`;
                const price = item.new_price ? item.new_price + ' ' + ${js('chrome.currency_egp')} : (item.used_price ? ${js('crm.user_used_only')} : ${js('crm.user_out_of_stock')});
                const hasTarget = !!item.target_price;
                const targetBadge = hasTarget ? '<div class="text-xs text-brand-400">🎯 Target: ' + item.target_price + '</div>' : '';

                const btnIcon = item.always_track === 1 ? '🟢' : '📡';
                const btnLabel = item.always_track === 1 ? ${js('crm.btn_tracking_global')} : ${js('crm.btn_track_global')};
                const btnClass = item.always_track === 1
                    ? 'ring-1 ring-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border-transparent'
                    : 'bg-gray-800 hover:bg-gray-700 text-gray-300 border-gray-700/50';

                const sortPrice = item.new_price || item.amazon_price || 0;
                const sortAdded = item.added_at || '';
                const sortName = escapeHtml(name).toLowerCase();

                return \`
                <div class="glass rounded-xl p-3 border border-emerald-500/20 relative overflow-hidden" id="active-item-\${item.chat_id}-\${item.asin}" data-search="\${item.asin.toLowerCase()} \${sortName}" data-name="\${sortName}" data-price="\${sortPrice}" data-added="\${sortAdded}">
                    <div class="flex gap-3 mb-2">
                        <img src="\${item.image_url ? escapeHtml(item.image_url) : 'https://images-na.ssl-images-amazon.com/images/P/' + item.asin + '.01.MZZZZZZZ.jpg'}" class="w-12 h-12 rounded object-cover bg-white shrink-0" onerror="this.src='https://images-na.ssl-images-amazon.com/images/P/\${item.asin}.01.MZZZZZZZ.jpg'; this.onerror=function(){this.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'};">
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center justify-between mb-1">
                        <div class="font-medium text-sm truncate max-w-[60%]"><a href="\${escapeHtml(item.detail_page_url || '')}" target="_blank" class="text-brand-400 hover:text-brand-300 hover:underline transition" onclick="event.stopPropagation()">\${escapeHtml(name)}</a></div>
                                <span class="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase text-emerald-400 bg-emerald-400/10">${t('crm.user_active', lang)}</span>
                    </div>
                    <div class="flex items-center justify-between text-xs mb-3">
                        <code class="text-gray-400">\${item.asin}</code>
                        <span class="text-brand-400">\${displayUser}</span>
                            </div>
                        </div>
                    </div>
                    <div class="flex justify-between items-end mb-3">
                        <div class="text-sm font-semibold">\${price}</div>
                        \${targetBadge}
                    </div>
                    <div class="grid grid-cols-3 gap-2">
                        <button onclick="performAction('toggle_keep_alive', 'global', { asin: '\${item.asin}' }, this)" class="py-1.5 rounded-lg text-xs font-bold transition border \${btnClass}">
                            \${btnIcon} \${btnLabel}
                        </button>
                        <button onclick="openChartModal('\${item.asin}')" class="py-1.5 bg-brand-500/10 text-brand-400 rounded-lg text-xs font-bold hover:bg-brand-500/20 transition border border-brand-500/20">
                            📊 ${t('crm.btn_chart', lang)}
                        </button>
                        <button onclick="openBroadcastModal('\${item.asin}')" class="py-1.5 bg-brand-500/10 hover:bg-brand-500/20 text-brand-400 rounded-lg text-xs font-medium transition border border-brand-500/20">
                            ${t('crm.per_product_broadcast', lang)}
                        </button>
                    </div>
                </div>\`;
            }).join('');

            itemsCont.insertAdjacentHTML('beforeend', html);
        }

        function renderMoreActiveProducts() {
            if (activeRenderIndex >= activeProductsData.length) return;
            const chunk = activeProductsData.slice(activeRenderIndex, activeRenderIndex + 50);
            activeRenderIndex += 50;
            const lang = document.documentElement.lang || 'masry';
            const isMasry = lang === 'masry';
            renderActiveProductCards(chunk, lang, isMasry);
        }

        function handleActiveScroll() {
            const cont = document.getElementById('drawer-active-items');
            if (cont.scrollTop + cont.clientHeight >= cont.scrollHeight - 100) {
                renderMoreActiveProducts();
            }
        }

        function closeActiveDrawer() {
            const drawer = document.getElementById('drawer-active');
            const content = document.getElementById('drawer-active-content');
            content.style.transform = 'translateY(100%)';
            setTimeout(() => { drawer.classList.add('hidden'); }, 300);
            const searchInput = document.getElementById('search-drawer-active');
            if (searchInput) { searchInput.value = ''; filterDrawer('', 'drawer-active-items'); }
            resetSortUI('active');
        }

        async function openPausedDrawer() {
            const drawer = document.getElementById('drawer-paused');
            const content = document.getElementById('drawer-paused-content');
            const itemsCont = document.getElementById('drawer-paused-items');

            itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm"><div class="w-6 h-6 border-2 border-gray-700 border-t-amber-500 rounded-full animate-spin mx-auto mb-2"></div>' + ${js('crm.loading_items')} + '</div>';

            drawer.classList.remove('hidden');
            setTimeout(() => { content.style.transform = 'translateY(0)'; }, 10);

            const data = await fetchAPI('/paused-products');
            const toolbar = document.getElementById('drawer-paused-toolbar');
            if (!data || !data.items || data.items.length === 0) {
                itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm">' + ${js('crm.empty_paused')} + '</div>';
                if (toolbar) toolbar.style.display = 'none';
                return;
            }

            const lang = document.documentElement.lang || 'masry';
            itemsCont.innerHTML = data.items.map((item) => {
                const isMasry = lang === 'masry';
                const name = (isMasry && item.name_ar) ? item.name_ar : (item.name || item.asin);
                const price = item.new_price ? item.new_price + ' ' + ${js('chrome.currency_egp')} : (item.used_price ? ${js('crm.user_used_only')} : ${js('crm.user_out_of_stock')});
                const tagColor = item.active_subs === 0 && item.paused_subs > 0 ? 'text-amber-400 bg-amber-400/10' : 'text-gray-400 bg-gray-400/10';
                const tagLabel = item.active_subs === 0 && item.paused_subs > 0 ? ${js('crm.tag_asleep')} : ${js('crm.tag_orphaned')};
                
                const btnIcon = item.always_track === 1 ? '🟢' : '📡';
                const btnLabel = item.always_track === 1 ? ${js('crm.btn_tracking_global')} : ${js('crm.btn_track_global')};
                const btnClass = item.always_track === 1 
                    ? 'ring-1 ring-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border-transparent' 
                    : 'bg-gray-800 hover:bg-gray-700 text-gray-300 border-gray-700/50';

                const sortPrice = item.new_price || item.amazon_price || 0;
                const sortName = escapeHtml(name).toLowerCase();

                return \`
                <div class="glass rounded-xl p-3 border border-gray-800/50 relative overflow-hidden paused-card" id="paused-item-\${item.asin}" data-search="\${item.asin.toLowerCase()} \${sortName}" data-name="\${sortName}" data-price="\${sortPrice}" data-added="">
                    <div class="flex items-start gap-3 mb-2">
                        <input type="checkbox" class="paused-checkbox mt-1 w-4 h-4 rounded border-gray-600 bg-gray-800 text-brand-500 focus:ring-brand-500/30 accent-brand-500 cursor-pointer shrink-0" data-asin="\${item.asin}" onchange="updatePausedToolbar()">
                        <img src="\${item.image_url ? escapeHtml(item.image_url) : 'https://images-na.ssl-images-amazon.com/images/P/' + item.asin + '.01.MZZZZZZZ.jpg'}" class="w-12 h-12 rounded object-cover bg-white shrink-0" onerror="this.src='https://images-na.ssl-images-amazon.com/images/P/\${item.asin}.01.MZZZZZZZ.jpg'; this.onerror=function(){this.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'};">
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center justify-between mb-1">
                                <div class="font-medium text-sm truncate max-w-[60%]"><a href="\${escapeHtml(item.detail_page_url || ('https://www.amazon.eg/dp/' + item.asin))}" target="_blank" class="text-brand-400 hover:text-brand-300 hover:underline transition" onclick="event.stopPropagation()">\${escapeHtml(name)}</a></div>
                                <span class="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase \${tagColor}">\${tagLabel}</span>
                            </div>
                            <div class="flex items-center justify-between text-xs mb-3">
                                <code class="text-gray-400">\${item.asin}</code>
                                <div class="mt-2 text-[10px] bg-gray-800/50 rounded-lg py-1 px-2 border border-gray-700 inline-block shadow-inner">
                                    <span class="text-gray-500">0 ${t('crm.user_active', lang)} | \${item.paused_subs} ${t('crm.user_paused', lang)}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="flex justify-between items-end mb-3">
                        <div class="text-sm font-semibold">\${price}</div>
                    </div>
                    <div class="grid grid-cols-3 gap-2">
                        <button onclick="performAction('toggle_keep_alive', 'global', { asin: '\${item.asin}' }, this)" class="py-1.5 rounded-lg text-xs font-bold transition border \${btnClass}">
                            \${btnIcon} \${btnLabel}
                        </button>
                        <button onclick="openChartModal('\${item.asin}')" class="py-1.5 bg-brand-500/10 text-brand-400 rounded-lg text-xs font-bold hover:bg-brand-500/20 transition border border-brand-500/20">
                            📊 ${t('crm.btn_chart', lang)}
                        </button>
                        <button onclick="openBroadcastModal('\${item.asin}')" class="py-1.5 bg-brand-500/10 hover:bg-brand-500/20 text-brand-400 rounded-lg text-xs font-medium transition border border-brand-500/20">
                            ${t('crm.per_product_broadcast', lang)}
                        </button>
                    </div>
                </div>\`;
            }).join('');
        }

        function closePausedDrawer() {
            const drawer = document.getElementById('drawer-paused');
            const content = document.getElementById('drawer-paused-content');
            content.style.transform = 'translateY(100%)';
            setTimeout(() => { drawer.classList.add('hidden'); }, 300);
            const searchInput = document.getElementById('search-drawer-paused');
            if (searchInput) { searchInput.value = ''; filterDrawer('', 'drawer-paused-items'); }
            resetSortUI('paused');
            const selectAll = document.getElementById('paused-select-all');
            if (selectAll) selectAll.checked = false;
            const toolbar = document.getElementById('drawer-paused-toolbar');
            if (toolbar) toolbar.style.display = 'none';
        }

        // ── Paused Products: Bulk Select & Delete ──────────────────────────────────

        function togglePausedSelectAll() {
            const selectAll = document.getElementById('paused-select-all');
            const checkboxes = document.querySelectorAll('.paused-checkbox');
            checkboxes.forEach(cb => { cb.checked = selectAll.checked; });
            updatePausedToolbar();
        }

        function updatePausedToolbar() {
            const checkboxesAll = document.querySelectorAll('.paused-checkbox');
            const checkboxesChecked = document.querySelectorAll('.paused-checkbox:checked');
            const selectAll = document.getElementById('paused-select-all');
            const toolbar = document.getElementById('drawer-paused-toolbar');
            
            if (selectAll && checkboxesAll.length > 0) {
                selectAll.checked = checkboxesChecked.length === checkboxesAll.length;
            }
            
            if (toolbar) {
                if (checkboxesChecked.length > 0) {
                    toolbar.style.display = 'flex';
                } else {
                    toolbar.style.display = 'none';
                }
            }
        }

        async function deleteSelectedPaused() {
            const checkboxes = document.querySelectorAll('.paused-checkbox:checked');
            const asins = Array.from(checkboxes).map(cb => cb.dataset.asin);
            if (asins.length === 0) return;

            const confirmed = await showConfirmDialog(
                ${js('crm.confirm_purge_selected')},
                ${js('crm.confirm_btn_confirm')},
                ${js('crm.confirm_btn_cancel')}
            );
            if (!confirmed) return;

            try {
                const res = await fetchAPI('/paused/bulk-delete', 'POST', { asins });
                if (res.error) {
                    throw new Error(res.error || 'Bulk delete failed');
                }

                if (typeof showToast === 'function') {
                    showToast(${js('crm.graveyard_deleted')}.replace('{count}', asins.length));
                }
                closePausedDrawer();
                refreshData();
            } catch (e) {
                if (typeof showToast === 'function') {
                    showToast(e.message, 'error');
                }
            }
        }

        // ── Graveyard Drawer ─────────────────────────────────────────────────────

        async function openGraveyardDrawer() {
            const drawer = document.getElementById('drawer-graveyard');
            const content = document.getElementById('drawer-graveyard-content');
            const itemsCont = document.getElementById('drawer-graveyard-items');

            itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm"><div class="w-6 h-6 border-2 border-gray-700 border-t-brand-500 rounded-full animate-spin mx-auto mb-2"></div>' + ${js('crm.loading_items')} + '</div>';

            drawer.classList.remove('hidden');
            setTimeout(() => { content.style.transform = 'translateY(0)'; }, 10);

            const data = await fetchAPI('/graveyard');
            if (!data || !data.items || data.items.length === 0) {
                itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm">✅ ' + ${js('crm.graveyard_empty')} + '</div>';
                document.getElementById('drawer-graveyard-count').innerText = '0 ' + ${js('crm.items_label')};
                return;
            }

            document.getElementById('drawer-graveyard-count').innerText = data.items.length + ' ' + ${js('crm.items_label')};

            const lang = document.documentElement.lang || 'masry';
            let html = '';
            data.items.forEach(item => {
                const name = lang === 'masry' && item.name_ar ? escapeHtml(item.name_ar) : escapeHtml(item.name || item.asin);
                const isDelisted = item.delisted === 1;
                const allMissing = item.new_price === null && item.used_price === null && item.amazon_price === null;
                let reasonBadge = '';
                if (isDelisted) {
                    reasonBadge = '<span class="text-[10px] bg-red-900/30 text-red-400 px-1.5 py-0.5 rounded border border-red-800/50">' + ${js('crm.graveyard_delisted')} + '</span>';
                } else if (allMissing) {
                    reasonBadge = '<span class="text-[10px] bg-red-900/30 text-red-400 px-1.5 py-0.5 rounded border border-red-800/50">' + ${js('crm.graveyard_all_missing')} + '</span>';
                }
                const subsText = '<bdi>' + item.active_subs + '</bdi> ' + ${js('crm.graveyard_subs')};

                const sortName = escapeHtml(name).toLowerCase();
                const sortAdded = item.last_updated || '';
                html += '<div class="bg-gray-800 rounded-lg p-3 flex items-start gap-3 cursor-pointer hover:bg-gray-700 transition" data-search="' + escapeHtml(item.asin).toLowerCase() + ' ' + sortName + '" data-name="' + sortName + '" data-price="0" data-added="' + sortAdded + '" onclick="openProductSubsDrawer(\\'' + escapeHtml(item.asin) + '\\')">';
                html += '<input type="checkbox" onclick="event.stopPropagation()" onchange="updateGraveyardToolbar()" class="graveyard-checkbox mt-1 rounded bg-gray-700 border-gray-600 text-red-500 focus:ring-red-500" data-asin="' + escapeHtml(item.asin) + '">';
                html += '<img src="' + (item.image_url ? escapeHtml(item.image_url) : 'https://images-na.ssl-images-amazon.com/images/P/' + escapeHtml(item.asin) + '.01.MZZZZZZZ.jpg') + '" class="w-12 h-12 rounded object-cover bg-white shrink-0" onerror="this.src=\\'https://images-na.ssl-images-amazon.com/images/P/' + escapeHtml(item.asin) + '.01.MZZZZZZZ.jpg\\'; this.onerror=function(){this.style.display=\\'none\\'};">' ;
                html += '<div class="flex-1 min-w-0">';
                html += '<div class="text-sm font-medium truncate"><a href="' + escapeHtml(item.detail_page_url || ('https://www.amazon.eg/dp/' + item.asin)) + '" target="_blank" class="text-brand-400 hover:text-brand-300 hover:underline transition" onclick="event.stopPropagation()">' + name + '</a></div>';
                html += '<div class="text-xs text-gray-500 mt-0.5"><bdi>' + escapeHtml(item.asin) + '</bdi> &bull; ' + subsText + '</div>';
                html += '<div class="flex gap-1 mt-1">' + reasonBadge + '</div>';
                html += '</div></div>';
            });
            itemsCont.innerHTML = html;
        }

        function closeGraveyardDrawer() {
            const content = document.getElementById('drawer-graveyard-content');
            content.style.transform = 'translateY(100%)';
            setTimeout(() => { document.getElementById('drawer-graveyard').classList.add('hidden'); }, 300);
            const searchInput = document.getElementById('search-drawer-graveyard');
            if (searchInput) { searchInput.value = ''; filterDrawer('', 'drawer-graveyard-items'); }
            resetSortUI('graveyard');
            document.getElementById('graveyard-select-all').checked = false;
            document.getElementById('drawer-graveyard-toolbar').style.display = 'none';
        }

        async function openGlobalDrawer() {
            const drawer = document.getElementById('drawer-global');
            const content = document.getElementById('drawer-global-content');
            const itemsCont = document.getElementById('drawer-global-items');

            itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm"><div class="w-6 h-6 border-2 border-gray-700 border-t-brand-500 rounded-full animate-spin mx-auto mb-2"></div>' + ${js('crm.loading_items')} + '</div>';

            drawer.classList.remove('hidden');
            setTimeout(() => { content.style.transform = 'translateY(0)'; }, 10);

            const data = await fetchAPI('/global-products');
            if (!data || !data.items || data.items.length === 0) {
                itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm">✅ ' + ${js('crm.global_empty')} + '</div>';
                document.getElementById('drawer-global-count').innerText = '0 ' + ${js('crm.items_label')};
                return;
            }

            document.getElementById('drawer-global-count').innerText = data.items.length + ' ' + ${js('crm.items_label')};

            const lang = document.documentElement.lang || 'masry';
            let html = '';
            data.items.forEach(item => {
                const name = lang === 'masry' && item.name_ar ? escapeHtml(item.name_ar) : escapeHtml(item.name || item.asin);
                const sortName = escapeHtml(name).toLowerCase();
                const sortPrice = item.amazon_price || item.new_price || item.used_price || 0;
                const sortAdded = item.last_updated || '';
                
                const btnClass = 'bg-gray-800 hover:bg-gray-700 text-gray-300 border-gray-700/50';
                const btnLabel = ${js('crm.btn_untrack')};
                const asinEsc = escapeHtml(item.asin);

                const badgeHtml = '<span class="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase text-purple-400 bg-purple-400/10">' + ${js('crm.global_products')} + '</span>';
                
                let priceHtml = '<div class="text-sm font-semibold text-gray-500">--</div>';
                if (item.amazon_price) {
                    priceHtml = '<div class="text-sm font-semibold text-emerald-400"><bdi>' + item.amazon_price.toFixed(2) + '</bdi> <span class="text-[10px] text-emerald-500/70">EGP</span></div>';
                }

                html += '<div class="glass rounded-xl p-3 border border-purple-500/20 relative overflow-hidden global-card" id="global-item-' + escapeHtml(item.asin) + '" data-search="' + escapeHtml(item.asin).toLowerCase() + ' ' + sortName + '" data-name="' + sortName + '" data-price="' + sortPrice + '" data-added="' + sortAdded + '">';
                html += '<div class="flex gap-3 mb-2">';
                html += '<input type="checkbox" class="global-checkbox mt-1 w-4 h-4 rounded border-gray-600 bg-gray-800 text-brand-500 focus:ring-brand-500/30 accent-brand-500 cursor-pointer shrink-0" data-asin="' + asinEsc.replace(/'/g, "\\'") + '" onchange="updateGlobalToolbar()">';
                html += '<img src="' + (item.image_url ? escapeHtml(item.image_url) : 'https://images-na.ssl-images-amazon.com/images/P/' + escapeHtml(item.asin) + '.01.MZZZZZZZ.jpg') + '" class="w-12 h-12 rounded object-cover bg-white shrink-0" onerror="this.src=\\'https://images-na.ssl-images-amazon.com/images/P/' + escapeHtml(item.asin) + '.01.MZZZZZZZ.jpg\\'; this.onerror=function(){this.src=\\'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7\\'};">';
                html += '<div class="flex-1 min-w-0">';
                html += '<div class="flex items-center justify-between mb-1">';
                html += '<div class="font-medium text-sm truncate max-w-[60%]"><a href="' + escapeHtml(item.detail_page_url || ('https://www.amazon.eg/dp/' + item.asin)) + '" target="_blank" class="text-brand-400 hover:text-brand-300 hover:underline transition" onclick="event.stopPropagation()">' + name + '</a></div>';
                html += badgeHtml;
                html += '</div>';
                html += '<div class="flex items-center justify-between text-xs mb-3">';
                html += '<code class="text-gray-400">' + escapeHtml(item.asin) + '</code>';
                html += '</div></div></div>';
                html += '<div class="flex justify-between items-end mb-3">';
                html += priceHtml;
                html += '</div>';
                html += '<div class="grid grid-cols-3 gap-2">';
                html += '<button onclick="untrackGlobalProduct(\\'' + asinEsc.replace(/'/g, "\\\\'") + '\\', this)" class="py-1.5 rounded-lg text-xs font-bold transition border ' + btnClass + '">' + btnLabel + '</button>';
                html += '<button onclick="openChartModal(\\'' + asinEsc.replace(/'/g, "\\\\'") + '\\')" class="py-1.5 bg-brand-500/10 text-brand-400 rounded-lg text-xs font-bold hover:bg-brand-500/20 transition border border-brand-500/20">📊 ' + ${js('crm.btn_chart')} + '</button>';
                html += '<button onclick="openBroadcastModal(\\'' + asinEsc.replace(/'/g, "\\\\'") + '\\')" class="py-1.5 bg-brand-500/10 hover:bg-brand-500/20 text-brand-400 rounded-lg text-xs font-medium transition border border-brand-500/20">' + ${js('crm.per_product_broadcast')} + '</button>';
                html += '</div></div>';
            });
            itemsCont.innerHTML = html;
        }

        function closeGlobalDrawer() {
            const content = document.getElementById('drawer-global-content');
            content.style.transform = 'translateY(100%)';
            setTimeout(() => { document.getElementById('drawer-global').classList.add('hidden'); }, 300);
            const searchInput = document.getElementById('search-drawer-global');
            if (searchInput) { searchInput.value = ''; filterDrawer('', 'drawer-global-items'); }
            resetSortUI('global');
            document.getElementById('global-select-all').checked = false;
            document.getElementById('drawer-global-toolbar').style.display = 'none';
        }

        function toggleGlobalSelectAll() {
            const checked = document.getElementById('global-select-all').checked;
            document.querySelectorAll('.global-card:not([style*="display: none"]) .global-checkbox').forEach(cb => { 
                cb.checked = checked; 
            });
            updateGlobalToolbar();
        }

        function updateGlobalToolbar() {
            const checkboxes = document.querySelectorAll('.global-checkbox:checked');
            const toolbar = document.getElementById('drawer-global-toolbar');
            if (checkboxes.length > 0) {
                toolbar.style.display = 'flex';
            } else {
                toolbar.style.display = 'none';
            }
        }

        async function deleteSelectedGlobal() {
            const checkboxes = document.querySelectorAll('.global-checkbox:checked');
            const asins = Array.from(checkboxes).map(cb => cb.dataset.asin);
            if (asins.length === 0) return;

            const confirmed = await showConfirmDialog(
                ${js('crm.graveyard_purge_confirm')},
                ${js('crm.confirm_btn_confirm')},
                ${js('crm.confirm_btn_cancel')}
            );
            if (!confirmed) return;

            try {
                const res = await fetchAPI('/paused/bulk-delete', 'POST', { asins });
                if (res.error) {
                    throw new Error(res.error || 'Bulk delete failed');
                }

                if (typeof showToast === 'function') {
                    showToast(${js('crm.graveyard_deleted')}.replace('{count}', asins.length));
                }
                closeGlobalDrawer();
                refreshData();
            } catch (e) {
                if (typeof showToast === 'function') {
                    showToast(e.message, 'error');
                }
            }
        }

        async function untrackGlobalProduct(asin, btn) {
            const ok = await showConfirmDialog(${js('crm.confirm_untrack')}, ${js('crm.confirm_btn_confirm')}, ${js('crm.confirm_btn_cancel')});
            if (!ok) return;
            
            // The auto-removal IIFE in performAction triggers the 'Tracking turned OFF' branch 
            // only if tracking was previously ON (indicated by the 'bg-emerald' class).
            btn.classList.add('bg-emerald');
            await performAction('toggle_keep_alive', 'global', { asin }, btn);
        }

        function extractAsinsFromText(text) {
            const tokens = text.split(/[\\s,;\\n]+/).filter(Boolean);
            const valid = new Set();
            const invalid = [];
            
            function extractAsin(token) {
                if (/^https?:\\/\\/(?:www\\.)?(?:amazon\\.[a-z\\.]+|amzn\\.(?:to|eu)|a\\.co)/i.test(token)) {
                    return token;
                }
                const direct = token.match(/^([a-zA-Z0-9]{10})$/);
                if (direct) return direct[1].toUpperCase();
                const fromUrl = token.match(/\\/(?:dp|gp\\/product|product)\\/([a-zA-Z0-9]{10})/i);
                if (fromUrl) return fromUrl[1].toUpperCase();
                const fallback = token.match(/([a-zA-Z0-9]{10})/);
                if (fallback) return fallback[1].toUpperCase();
                return null;
            }

            tokens.forEach(token => {
                const extracted = extractAsin(token.trim());
                if (extracted && (/^[A-Z0-9]{10}$/.test(extracted) || /^https?:\\/\\//i.test(extracted))) {
                    valid.add(extracted);
                } else {
                    invalid.push(token);
                }
            });
            return { valid: Array.from(valid), invalid };
        }

        let bulkAddState = 'input';
        let bulkAddFinalAsins = [];

        function resetBulkAddModal() {
            bulkAddState = 'input';
            bulkAddFinalAsins = [];
            
            const btn = document.getElementById('bulk-add-submit-btn');
            if (btn) {
                btn.innerHTML = '<span id="bulk-add-btn-text">' + ${js('crm.bulk_add_preview')} + '</span>';
                btn.disabled = false;
            }

            const inputEl = document.getElementById('bulk-add-input');
            if (inputEl) {
                inputEl.disabled = false;
                inputEl.classList.remove('opacity-50');
                inputEl.removeAttribute('dir');
            }
            document.getElementById('bulk-add-preview').classList.add('hidden');
        }

        function openBulkAddModal() {
            document.getElementById('bulk-add-modal').classList.remove('hidden');
            setTimeout(() => { document.getElementById('bulk-add-modal-content').style.transform = 'translateY(0)'; }, 10);
            document.getElementById('bulk-add-input').value = '';
            resetBulkAddModal();
        }

        let bulkAddController = null;
        function closeBulkAddModal() {
            if (bulkAddController) {
                bulkAddController.abort();
                bulkAddController = null;
            }
            document.getElementById('bulk-add-modal-content').style.transform = 'translateY(100%)';
            setTimeout(() => { 
                document.getElementById('bulk-add-modal').classList.add('hidden'); 
                resetBulkAddModal();
            }, 300);
        }

        async function submitBulkAdd() {
            const inputEl = document.getElementById('bulk-add-input');
            const btn = document.getElementById('bulk-add-submit-btn');
            const originalHtml = btn.innerHTML;

            if (bulkAddState === 'input') {
                const input = inputEl.value;
                const { valid, invalid } = extractAsinsFromText(input);
                
                if (valid.length === 0) {
                    showToast(${js('crm.bulk_add_no_valid')}, "error");
                    return;
                }
                if (invalid.length > 0) {
                    showToast(${js('crm.bulk_add_invalid_list')}.replace('{invalid}', invalid.length), "error");
                }

                btn.innerHTML = '<div class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>';
                btn.disabled = true;
                inputEl.disabled = true;
                inputEl.classList.add('opacity-50');

                bulkAddController = new AbortController();
                try {
                    const data = await fetchAPI('/bulk-add-products', 'POST', { asins: valid, preview: true }, { signal: bulkAddController.signal });
                    bulkAddController = null;

                    if (data.invalid > 0) {
                        showToast(${js('crm.bulk_add_invalid_list')}.replace('{invalid}', data.invalid), "warning");
                    }

                    document.getElementById('bulk-add-preview').classList.remove('hidden');
                    document.getElementById('bulk-add-summary-text').innerText = 
                        ${js('crm.bulk_summary')}
                        .replace('{added}', data.added)
                        .replace('{upgraded}', data.upgraded)
                        .replace('{skipped}', data.already_global);
                    
                    bulkAddFinalAsins = data.valid_asins || [];
                    
                    if (data.details && data.details.length > 0) {
                        const lang = document.documentElement.lang || 'masry';
                        const formattedText = data.details.map(item => {
                            let icon = '❌';
                            if (item.status === 'added') icon = '🆕';
                            else if (item.status === 'upgraded') icon = '♻️';
                            else if (item.status === 'already_global') icon = '⚠️';
                            
                            let name = '...';
                            if (item.asin) {
                                name = (lang === 'masry' && item.name_ar) ? item.name_ar : (item.name || 'Fetching name...');
                            } else {
                                name = 'N/A';
                            }
                            
                            return icon + ' ' + item.input + ' | ' + (item.asin || 'N/A') + ' | ' + name;
                        }).join('\\n');
                        inputEl.value = formattedText;
                        inputEl.setAttribute('dir', 'ltr');
                    }
                    
                    bulkAddState = 'confirm';
                    btn.innerHTML = '<span id="bulk-add-btn-text">' + ${js('crm.btn_add_products')} + '</span>';
                } catch (err) {
                    bulkAddController = null;
                    inputEl.disabled = false;
                    inputEl.classList.remove('opacity-50');
                    if (err.name === 'AbortError') return; // Cancelled by user
                    let msg = err.message;
                    if (msg === 'bulk_add_no_valid') msg = ${js('crm.bulk_add_no_valid')};
                    else if (msg === 'invalid_input') msg = ${js('crm.toast_network_error')};
                    showToast(msg || ${js('crm.toast_network_error')}, "error");
                    btn.innerHTML = originalHtml;
                } finally {
                    btn.disabled = false;
                }
            } else if (bulkAddState === 'confirm') {
                if (!bulkAddFinalAsins || bulkAddFinalAsins.length === 0) return;
                
                btn.innerHTML = '<div class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>';
                btn.disabled = true;

                bulkAddController = new AbortController();
                try {
                    const data = await fetchAPI('/bulk-add-products', 'POST', { asins: bulkAddFinalAsins, preview: false }, { signal: bulkAddController.signal });
                    bulkAddController = null;

                    const summaryHtml = ${js('crm.bulk_summary')}
                        .replace('{added}', data.added)
                        .replace('{upgraded}', data.upgraded)
                        .replace('{skipped}', data.already_global);
                    showToast(summaryHtml, "success");
                    
                    refreshData();
                    const globalDrawer = document.getElementById('drawer-global');
                    if (globalDrawer && !globalDrawer.classList.contains('hidden')) {
                        openGlobalDrawer();
                    }
                    
                    setTimeout(() => {
                        closeBulkAddModal();
                    }, 1500); // Wait 1.5s then auto-close
                } catch (err) {
                    bulkAddController = null;
                    if (err.name === 'AbortError') return; // Cancelled by user
                    showToast(err.message || ${js('crm.toast_network_error')}, "error");
                    btn.innerHTML = originalHtml;
                    btn.disabled = false;
                }
            }
        }


        async function openProductSubsDrawer(asin) {
            const drawer = document.getElementById('drawer-product-subs');
            const content = document.getElementById('drawer-product-subs-content');
            const itemsCont = document.getElementById('drawer-product-subs-items');
            
            const subsForTemplate = ${js('crm.subscribers_for')};
            document.getElementById('drawer-product-subs-title').innerText = subsForTemplate.replace("{asin}", asin);
            document.getElementById('drawer-product-subs-count').innerText = '--';
            itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm"><div class="w-6 h-6 border-2 border-gray-700 border-t-amber-500 rounded-full animate-spin mx-auto mb-2"></div>' + ${js('crm.loading_items')} + '</div>';

            drawer.classList.remove('hidden');
            setTimeout(() => { content.style.transform = 'translateY(0)'; }, 10);

            const data = await fetchAPI('/product-subs/' + asin);
            if (!data || !data.items || data.items.length === 0) {
                itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm">' + ${js('crm.no_subscribers')} + '</div>';
                document.getElementById('drawer-product-subs-count').innerText = '0 ' + ${js('crm.items_label')};
                return;
            }

            document.getElementById('drawer-product-subs-count').innerText = data.items.length + ' ' + ${js('crm.items_label')};
            const lang = document.documentElement.lang || 'masry';
            
            itemsCont.innerHTML = data.items.map((item) => {
                const isMasry = lang === 'masry';
                const name = (lang === 'masry' && item.name_ar) ? escapeHtml(item.name_ar) : escapeHtml(item.name || item.asin);
                const userName = escapeHtml(item.first_name || 'User');
                const userDetails = item.username ? \`(@\${item.username})\` : \`(\${item.chat_id})\`;
                const displayUser = \`\${userName} <span class="opacity-70">\${userDetails}</span>\`;
                const price = item.new_price ? item.new_price + ' ' + ${js('chrome.currency_egp')} : (item.used_price ? ${js('crm.user_used_only')} : ${js('crm.user_out_of_stock')});
                const hasTarget = !!item.target_price;
                const targetBadge = hasTarget ? '<div class="text-xs text-brand-400">🎯 Target: ' + item.target_price + '</div>' : '';
                
                const btnIcon = item.always_track === 1 ? '🟢' : '📡';
                const btnLabel = item.always_track === 1 ? ${js('crm.btn_tracking_global')} : ${js('crm.btn_track_global')};
                const btnClass = item.always_track === 1 
                    ? 'ring-1 ring-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border-transparent' 
                    : 'bg-gray-800 hover:bg-gray-700 text-gray-300 border-gray-700/50';

                return \`
                <div class="glass rounded-xl p-3 border \${item.is_paused === 1 ? 'border-amber-500/20' : 'border-emerald-500/20'} relative overflow-hidden" id="product-sub-item-\${item.chat_id}-\${item.asin}">
                    <div class="flex gap-3 mb-2">
                        <img src="\${item.image_url || 'https://images-na.ssl-images-amazon.com/images/P/' + item.asin + '.01.MZZZZZZZ.jpg'}" class="w-12 h-12 rounded object-cover bg-white shrink-0" onerror="this.style.display=\'none\'">
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center justify-between mb-1">
                                <div class="font-medium text-sm truncate max-w-[60%]"><a href="\${escapeHtml(item.detail_page_url || ('https://www.amazon.eg/dp/' + item.asin))}" target="_blank" class="text-brand-400 hover:text-brand-300 hover:underline transition" onclick="event.stopPropagation()">\${escapeHtml(name)}</a></div>
                                \${item.is_paused === 1 ? '<span class="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase text-amber-400 bg-amber-400/10">${t('crm.user_paused', lang)}</span>' : '<span class="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase text-emerald-400 bg-emerald-400/10">${t('crm.user_active', lang)}</span>'}
                            </div>
                            <div class="flex items-center justify-between text-xs mb-3">
                                <code class="text-gray-400">\${item.asin}</code>
                                <span class="text-brand-400">\${displayUser}</span>
                            </div>
                        </div>
                    </div>
                    <div class="flex justify-between items-end mb-3">
                        <div class="text-sm font-semibold">\${price}</div>
                        \${targetBadge}
                    </div>
                    <div class="grid grid-cols-3 gap-2">
                        <button onclick="performAction('toggle_keep_alive', 'global', { asin: '\${item.asin}' }, this)" class="py-1.5 rounded-lg text-xs font-bold transition border \${btnClass}">
                            \${btnIcon} \${btnLabel}
                        </button>
                        <button onclick="openChartModal('\${item.asin}')" class="py-1.5 bg-brand-500/10 text-brand-400 rounded-lg text-xs font-bold hover:bg-brand-500/20 transition border border-brand-500/20">
                            📊 ${t('crm.btn_chart', lang)}
                        </button>
                        <button onclick="openBroadcastModal('\${item.asin}')" class="py-1.5 bg-brand-500/10 hover:bg-brand-500/20 text-brand-400 rounded-lg text-xs font-medium transition border border-brand-500/20">
                            ${t('crm.per_product_broadcast', lang)}
                        </button>
                    </div>
                </div>\`;
            }).join('');
        }

        function closeProductSubsDrawer() {
            const content = document.getElementById('drawer-product-subs-content');
            content.style.transform = 'translateY(100%)';
            setTimeout(() => { document.getElementById('drawer-product-subs').classList.add('hidden'); }, 300);
        }

        function toggleGraveyardSelectAll() {
            const checked = document.getElementById('graveyard-select-all').checked;
            document.querySelectorAll('.graveyard-checkbox').forEach(cb => { cb.checked = checked; });
            updateGraveyardToolbar();
        }

        function updateGraveyardToolbar() {
            const checkboxes = document.querySelectorAll('.graveyard-checkbox:checked');
            const toolbar = document.getElementById('drawer-graveyard-toolbar');
            if (checkboxes.length > 0) {
                toolbar.style.display = 'flex';
            } else {
                toolbar.style.display = 'none';
            }
        }

        async function purgeSelectedGhosts() {
            const checkboxes = document.querySelectorAll('.graveyard-checkbox:checked');
            if (checkboxes.length === 0) return showToast(${js('crm.graveyard_select_purge')}, 'error');

            const asins = Array.from(checkboxes).map(cb => cb.dataset.asin);

            if (!await showConfirmDialog(${js('crm.graveyard_purge_confirm')}, ${js('crm.confirm_btn_confirm')}, ${js('crm.confirm_btn_cancel')})) return;

            showLoader();
            const res = await fetchAPI('/graveyard/purge', 'POST', { asins });
            hideLoader();

            if (res && res.success) {
                showToast(${js('crm.graveyard_purged_ok', { count: 'REPLACE_COUNT' })}.replace('REPLACE_COUNT', res.purged), 'success');
                closeGraveyardDrawer();
                refreshData();
            } else {
                showToast(${js('crm.graveyard_purge_failed')}.replace('{err}', ((res && res.error) || 'Unknown error')), 'error');
            }
        }

        let crmChartInstance = null;
        let activeChartData = null;

        function closeChartModal() {
            document.getElementById('chart-modal').classList.add('hidden');
            if (crmChartInstance) {
                crmChartInstance.destroy();
                crmChartInstance = null;
            }
        }

        async function openChartModal(asin) {
            document.getElementById('chart-modal').classList.remove('hidden');
            document.getElementById('chart-loading').style.display = 'block';
            document.getElementById('crmPriceChart').style.display = 'none';
            document.getElementById('chart-metrics').style.display = 'none';
            document.getElementById('chart-intervals').style.display = 'none';
            document.getElementById('chart-loading').innerText = ${js('crm.chart_loading')};
            
            const data = await fetchAPI('/history/' + asin); // This actually maps to /api/crm/history/ASIN due to fetchAPI prefix
            document.getElementById('chart-loading').style.display = 'none';
            
            if (!data || data.length === 0) {
                document.getElementById('chart-loading').innerText = ${js('crm.no_price_history')};
                document.getElementById('chart-loading').style.display = 'block';
                return;
            }
            
            const currentUnix = Math.floor(Date.now() / 1000);
            const lastPoint = data[data.length - 1];
            const lastTime = lastPoint.t !== undefined ? lastPoint.t : lastPoint.timestamp;
            if (lastTime < currentUnix - 60) {
                data.push({ ...lastPoint, t: currentUnix });
            }

            activeChartData = data;
            document.getElementById('chart-intervals').style.display = 'flex';
            document.getElementById('crmPriceChart').style.display = 'block';
            
            renderChartInterval('ALL');
        }

        function renderChartInterval(interval) {
            if (!activeChartData || activeChartData.length === 0) return;

            const buttons = document.getElementById('chart-intervals').querySelectorAll('button');
            buttons.forEach(btn => {
                if (btn.dataset.interval === interval) {
                    btn.className = 'flex-1 py-1 bg-brand-500/20 text-brand-400 text-xs rounded-full border border-brand-500/50 transition whitespace-nowrap';
                } else {
                    btn.className = 'flex-1 py-1 bg-gray-800 text-gray-400 text-xs rounded-full border border-gray-700 hover:text-white hover:border-gray-500 transition whitespace-nowrap';
                }
            });

            const currentUnix = Math.floor(Date.now() / 1000);
            let cutoff = 0;
            if (interval === '1W') cutoff = currentUnix - (7 * 86400);
            if (interval === '1M') cutoff = currentUnix - (30 * 86400);
            if (interval === '3M') cutoff = currentUnix - (90 * 86400);
            if (interval === '6M') cutoff = currentUnix - (180 * 86400);

            let data = activeChartData.filter(p => {
                const t = p.t !== undefined ? p.t : p.timestamp;
                return t >= cutoff;
            });

            if (data.length === 0) data = activeChartData;

            let xMin = undefined;
            if (cutoff > 0) {
                xMin = cutoff;
            } else if (data.length > 0) {
                const firstP = data[0];
                xMin = firstP.t !== undefined ? firstP.t : firstP.timestamp;
            }

            const locale = document.documentElement.lang === 'masry' ? 'ar-EG' : 'en-GB';
            
            const newPrices = data.map(point => {
                const t = point.t !== undefined ? point.t : point.timestamp;
                const n = point.n !== undefined ? point.n : (point.p !== undefined ? point.p : null);
                return { x: t, y: n };
            });
            const usedPrices = data.map(point => {
                const t = point.t !== undefined ? point.t : point.timestamp;
                const u = point.u !== undefined ? point.u : null;
                return { x: t, y: u };
            });

            let validPrices = newPrices.filter(p => p.y !== null).map(p => p.y);
            if (validPrices.length === 0) validPrices = usedPrices.filter(p => p.y !== null).map(p => p.y);

            if (validPrices.length > 0) {
                const ath = Math.max(...validPrices);
                const atl = Math.min(...validPrices);
                const avg = Math.round(validPrices.reduce((sum, val) => sum + val, 0) / validPrices.length);
                
                document.getElementById('chart-ath').innerText = ath.toLocaleString() + ' ' + ${js('chrome.currency_egp')};
                document.getElementById('chart-atl').innerText = atl.toLocaleString() + ' ' + ${js('chrome.currency_egp')};
                document.getElementById('chart-avg').innerText = avg.toLocaleString() + ' ' + ${js('chrome.currency_egp')};
            } else {
                document.getElementById('chart-ath').innerText = '--';
                document.getElementById('chart-atl').innerText = '--';
                document.getElementById('chart-avg').innerText = '--';
            }
            document.getElementById('chart-metrics').style.display = 'flex';

            const ctx = document.getElementById('crmPriceChart').getContext('2d');
            const lineColor = '#38bdf8';
            
            Chart.defaults.font.family = '${isMasry ? "Cairo, sans-serif" : "Inter, sans-serif"}';

            if (crmChartInstance) {
                crmChartInstance.destroy();
            }

            crmChartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                    datasets: [
                        {
                            label: ${js('crm.new_price')},
                            data: newPrices,
                            borderColor: lineColor,
                            backgroundColor: lineColor + '20',
                            borderWidth: 2,
                            pointBackgroundColor: lineColor,
                            pointRadius: function(ctx) {
                                const index = ctx.dataIndex;
                                const data = ctx.dataset.data;
                                if (data[index].y === null) return 0;
                                const prev = index > 0 ? data[index - 1].y : null;
                                const next = index < data.length - 1 ? data[index + 1].y : null;
                                return (prev === null || next === null) ? 4 : 0;
                            },
                            stepped: true,
                            spanGaps: false,
                            fill: true
                        },
                        {
                            label: ${js('crm.used_price')},
                            data: usedPrices,
                            borderColor: '#4caf50',
                            borderDash: [5, 5],
                            borderWidth: 2,
                            pointBackgroundColor: '#4caf50',
                            pointRadius: function(ctx) {
                                const index = ctx.dataIndex;
                                const data = ctx.dataset.data;
                                if (data[index].y === null) return 0;
                                const prev = index > 0 ? data[index - 1].y : null;
                                const next = index < data.length - 1 ? data[index + 1].y : null;
                                return (prev === null || next === null) ? 4 : 0;
                            },
                            stepped: true,
                            spanGaps: false,
                            fill: false
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: { labels: { color: '#f3f4f6' } },
                        tooltip: { 
                            backgroundColor: 'rgba(31, 41, 55, 0.9)', 
                            titleColor: '#fff', 
                            bodyColor: '#fff', 
                            textDirection: locale === 'ar-EG' ? 'rtl' : 'ltr',
                            callbacks: {
                                title: function(context) {
                                    if (!context.length) return '';
                                    const t = context[0].parsed.x;
                                    const date = new Date(t * 1000);
                                    return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' }) + ' ' + 
                                           date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
                                },
                                label: function(context) {
                                    let label = context.dataset.label || '';
                                    if (label) {
                                        label += ': ';
                                    }
                                    if (context.parsed.y !== null) {
                                        label += context.parsed.y.toLocaleString(locale) + ' ' + ${js('chrome.currency_egp')};
                                    }
                                    return label;
                                }
                            }
                        }
                    },
                    scales: {
                        x: { 
                            type: 'linear',
                            min: xMin,
                            max: currentUnix,
                            display: true, 
                            grid: { display: false, drawBorder: false },
                            ticks: { 
                                color: '#6b7280', 
                                maxTicksLimit: 5, 
                                maxRotation: 0,
                                callback: function(value) {
                                    const date = new Date(value * 1000);
                                    return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
                                }
                            }
                        },
                        y: { 
                            grid: { color: '#374151', drawBorder: false },
                            ticks: { color: '#9ca3af', callback: function(value) { return value.toLocaleString(); } }
                        }
                    }
                }
            });
        }

        async function triggerSync(btn) {
            const ok = await showConfirmDialog(${js('crm.env_sync_confirm')}, ${js('crm.confirm_btn_confirm')}, ${js('crm.confirm_btn_cancel')});
            if (!ok) return;
            const originalContent = btn.innerHTML;
            btn.innerHTML = '<div class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>';
            btn.disabled = true;
            try {
                const json = await fetchAPI('/sync-env', 'POST');
                if (!json) return;
                if (json.error) {
                    showToast(json.error, 'error');
                } else {
                    showToast(${js('crm.toast_sync_started')}, 'success');
                }
            } catch (err) {
                showToast(${js('crm.toast_sync_failed')}.replace('{err}', err.message), 'error');
            } finally {
                btn.innerHTML = originalContent;
                btn.disabled = false;
            }
        }

        async function performAction(action, targetId, data = null, btn = null) {
            if (!targetId) targetId = "global";

            if (action === 'delete_product') {
                // DEPRECATED: Delete product buttons removed from all card UIs
                showToast(${js('crm.action_unavailable')}, 'error');
                return;
            }

            // Sensitive actions: require custom confirmation dialog
            const sensitiveActions = ['ban', 'unban', 'revoke', 'approve', 'reject', 'promote', 'demote'];
            if (sensitiveActions.includes(action)) {
                const confirmTranslations = {
                    'ban': ${js('crm.confirm_ban')},
                    'unban': ${js('crm.confirm_unban')},
                    'revoke': ${js('crm.confirm_revoke_access')},
                    'promote': ${js('crm.confirm_promote')},
                    'demote': ${js('crm.confirm_demote')},
                    'generic': ${js('crm.confirm_generic')}
                };
                let confirmText = confirmTranslations.generic;
                if (action === 'ban') confirmText = confirmTranslations.ban;
                else if (action === 'unban') confirmText = confirmTranslations.unban;
                else if (action === 'revoke') confirmText = confirmTranslations.revoke;
                else if (action === 'promote') confirmText = confirmTranslations.promote;
                else if (action === 'demote') confirmText = confirmTranslations.demote;

                if (!await showConfirmDialog(confirmText, ${js('crm.confirm_btn_confirm')}, ${js('crm.confirm_btn_cancel')})) {
                    return;
                }
            }

            if (btn) {
                btn.disabled = true;
                const origHtml = btn.innerHTML;
                btn.innerHTML = '<div class="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin inline-block align-middle"></div>';
                btn.dataset.origHtml = origHtml;
            } else {
                showLoader();
            }

            const res = await fetchAPI('/action', 'POST', { action, targetId, data });
            
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = btn.dataset.origHtml;
            } else {
                hideLoader();
            }
            
            if (res) {
                if (res.status === 'queued') {
                    showToast(${js('crm.toast_action_queued')}, "success");
                } else if (res.error === 'already_handled' || res.error === 'not_found') {
                    showToast(res.message || 'Product no longer exists or was already modified.', 'warning');
                    refreshData(); // Auto-refresh to remove stale item
                } else {
                    showToast(${js('crm.toast_success')}, "success");

                    if (action === 'toggle_mute_queue' && btn) {
                        const isMuted = btn.classList.contains('bg-brand-500');
                        if (isMuted) {
                            btn.classList.add('bg-gray-600');
                            btn.classList.remove('bg-brand-500');
                            btn.firstElementChild.style.transform = 'translateX(0)';
                        } else {
                            btn.classList.add('bg-brand-500');
                            btn.classList.remove('bg-gray-600');
                            btn.firstElementChild.style.transform = 'translateX(1.5rem)';
                        }
                    } else if (btn && (action === 'pause_product' || action === 'resume_product' || action === 'toggle_keep_alive')) {
                        const isMasry = (document.documentElement.lang || 'masry') === 'masry';
                        if (action === 'toggle_keep_alive') {
                            const wasOn = btn.className.includes('bg-emerald');
                            const isOn = !wasOn;
                            btn.className = isOn ? 'flex-1 py-1.5 rounded-lg text-xs font-bold transition border bg-emerald-600 hover:bg-emerald-500 text-white shadow-[0_0_10px_rgba(5,150,105,0.5)] border-emerald-500' 
                                                 : 'flex-1 py-1.5 rounded-lg text-xs font-bold transition border bg-gray-700 hover:bg-gray-600 text-gray-300 border-gray-600';
                            btn.innerHTML = isOn ? ('🟢 ' + ${js('crm.btn_tracking_global')}) 
                                                 : ('📡 ' + ${js('crm.btn_track_global')});
                            btn.dataset.origHtml = btn.innerHTML;

                            // Auto-remove card from drawers where the product no longer belongs
                            (function(cardBtn) {
                                var card = null;
                                var drawerId = null;
                                var countId = null;
                                var itemsId = null;
                                var emptyMsg = null;

                                if (isOn) {
                                    // Tracking turned ON: remove from Paused drawer
                                    card = cardBtn.closest('.paused-card');
                                    if (card) {
                                        drawerId = 'drawer-paused';
                                        countId = 'drawer-paused-count';
                                        itemsId = 'drawer-paused-items';
                                        emptyMsg = '✅ ' + ${js('crm.empty_paused')};
                                    }
                                } else {
                                    // Tracking turned OFF: remove from Globally Tracked drawer
                                    card = cardBtn.closest('[id^="global-item-"]');
                                    if (card) {
                                        drawerId = 'drawer-global';
                                        countId = 'drawer-global-count';
                                        itemsId = 'drawer-global-items';
                                        emptyMsg = '✅ ' + ${js('crm.global_empty')};
                                    }
                                }

                                if (card) {
                                    card.style.transition = 'opacity 0.3s, transform 0.3s, max-height 0.3s, margin 0.3s, padding 0.3s';
                                    card.style.opacity = '0';
                                    card.style.transform = 'translateX(-20px)';
                                    card.style.maxHeight = '0';
                                    card.style.margin = '0';
                                    card.style.padding = '0';
                                    card.style.overflow = 'hidden';
                                    setTimeout(function() {
                                        card.remove();
                                        // Decrement drawer count
                                        var countEl = document.getElementById(countId);
                                        if (countEl) {
                                            var m = countEl.innerText.match(/^(\d+)/);
                                            if (m) {
                                                var newCount = Math.max(0, parseInt(m[1]) - 1);
                                                countEl.innerText = newCount + ' ' + ${js('crm.items_label')};
                                            }
                                        }
                                        // Show empty state if no items left
                                        var itemsCont = document.getElementById(itemsId);
                                        if (itemsCont && itemsCont.children.length === 0) {
                                            itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm">' + emptyMsg + '</div>';
                                        }
                                    }, 300);
                                }
                            })(btn);
                        }
                    } else if (action.includes('_product') && !btn) {
                        openDrawer(targetId); // legacy refresh
                    }

                    if (action === 'delete_product' && btn) {
                        // DEPRECATED: No-op — delete buttons removed from UI
                    }

                    refreshData();
                }
            }
        }

        async function triggerGlobalScrape() {
            const ok = await showConfirmDialog(${js('crm.force_check')} + "${lang === 'masry' ? '؟' : '?'}", ${js('crm.confirm_btn_confirm')}, ${js('crm.confirm_btn_cancel')});
            if(ok) performAction("force_scrape", null);
        }

        async function sendBroadcast() {
            const msg = document.getElementById('broadcast-msg').value.trim();
            if(!msg) return showToast(${js('crm.toast_msg_empty')}, "error");
            const ok = await showConfirmDialog(${js('crm.send_broadcast')} + "?", ${js('crm.confirm_btn_confirm')}, ${js('crm.confirm_btn_cancel')});
            if(ok) {
                performAction("broadcast", null, { message: msg });
                document.getElementById('broadcast-msg').value = '';
            }
        }

        function changeLimit(userId, currentLimit, firstName, username) {
            // Build a descriptive label: "Firstname (@username)" or fall back to userId
            const userLabel = firstName
                ? (username ? firstName + ' (@' + username + ')' : firstName)
                : userId;
            // Static i18n strings baked at render time; dynamic values appended at runtime
            const promptMsg = ${js('crm.edit_limit_prompt')} + " " + userLabel + " (" + ${js('crm.current_label')} + " " + currentLimit + "):";
            const limit = prompt(promptMsg, currentLimit);
            if (limit !== null && limit !== "" && !isNaN(limit) && limit > 0) {
                performAction('set_limit', userId, { limit: parseInt(limit) });
                // Show confirmation toast using pre-rendered i18n template
                const successTemplate = ${js('crm.edit_limit_success')};
                const successMsg = successTemplate.replace("{limit}", parseInt(limit)).replace("{user}", userLabel);
                showToast(successMsg, "success");
            }
        }

        function changeTarget(userId, asin) {
            const target = prompt(${js('crm.btn_edit')} + " (" + ${js('crm.new_price')} + ") — " + asin + ":");
            if (target !== null && target !== "" && !isNaN(target) && target > 0) {
                performAction('set_target', userId, { asin, target: parseFloat(target) });
            }
        }

        async function confirmRevoke(userId) {
            const ok = await showConfirmDialog(${js('crm.confirm_revoke_access')} + " — " + userId, ${js('crm.confirm_btn_confirm')}, ${js('crm.confirm_btn_cancel')});
            if(ok) performAction('revoke', userId);
        }

        // --- Helpers ---
        function showLoader(text = ${js('crm.toast_processing')}) {
            const overlay = document.getElementById('overlay');
            document.getElementById('overlay-text').innerText = text;
            if (loaderTimeout) clearTimeout(loaderTimeout);
            overlay.classList.remove('hidden');
            // Trigger reflow
            void overlay.offsetWidth;
            overlay.classList.remove('opacity-0');
        }

        let loaderTimeout = null;
        function hideLoader() {
            const overlay = document.getElementById('overlay');
            overlay.classList.add('opacity-0');
            if (loaderTimeout) clearTimeout(loaderTimeout);
            loaderTimeout = setTimeout(() => { overlay.classList.add('hidden'); }, 300);
        }

        function showToast(message, type = "info") {
            const container = document.getElementById('toast-container');
            const el = document.createElement('div');
            const bg = type === 'error' ? 'bg-red-500/90 border-red-500'
                : type === 'success' ? 'bg-green-500/90 border-green-500'
                : 'bg-gray-800 border-gray-700';
            const icon = type === 'error' ? '❌' : '✅';
            
            el.className = 'glass rounded-lg px-4 py-3 flex items-center gap-3 text-sm font-medium shadow-2xl border toast toast-enter ' + bg;
            el.innerHTML = '<span>' + icon + '</span> <span>' + escapeHtml(message) + '</span>';
            
            container.appendChild(el);
            
            // Trigger reflow
            void el.offsetWidth;
            el.classList.remove('toast-enter');
            el.classList.add('toast-enter-active');
            
            setTimeout(() => {
                el.classList.remove('toast-enter-active');
                el.classList.add('toast-leave');
                // Trigger reflow
                void el.offsetWidth;
                el.classList.remove('toast-leave');
                el.classList.add('toast-leave-active');
                setTimeout(() => el.remove(), 300);
            }, 3000);
        }

        // ===== CUSTOM CONFIRM DIALOG =============================================
        // Returns a Promise that resolves to true (confirmed) or false (cancelled).
        // Replaces native confirm() with a styled modal matching the CRM theme.
        function showConfirmDialog(message, confirmText = '✅ Confirm', cancelText = '❌ Cancel') {
            if (document.getElementById('custom-confirm-dialog')) return Promise.resolve(false);
            return new Promise((resolve) => {
                const overlay = document.createElement('div');
                overlay.id = 'custom-confirm-dialog';
                overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center';
                overlay.innerHTML = \`
                    <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" id="custom-confirm-backdrop"></div>
                    <div class="relative bg-gray-900 border border-gray-700 rounded-2xl p-6 shadow-2xl max-w-sm w-full mx-4 transform transition-all">
                        <p class="text-sm text-gray-200 mb-5 leading-relaxed" id="custom-confirm-message"></p>
                        <div class="flex gap-3 justify-between" id="custom-confirm-buttons">
                            <button id="custom-confirm-cancel" class="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg text-sm font-medium transition border border-red-500/20"></button>
                            <button id="custom-confirm-ok" class="px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 rounded-lg text-sm font-medium transition border border-emerald-500/20"></button>
                        </div>
                    </div>
                \`;
                document.body.appendChild(overlay);

                document.getElementById('custom-confirm-message').textContent = message;
                document.getElementById('custom-confirm-cancel').textContent = cancelText;
                document.getElementById('custom-confirm-ok').textContent = confirmText;

                // LTR/RTL button placement: cancel on start side, confirm on end side
                const isRTL = document.documentElement.dir === 'rtl';
                const btnContainer = document.getElementById('custom-confirm-buttons');
                btnContainer.style.flexDirection = isRTL ? 'row-reverse' : 'row';

                // Keyboard support: Enter = confirm, Escape = cancel
                const keyHandler = (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); cleanup(); resolve(true); }
                    if (e.key === 'Escape') { e.preventDefault(); cleanup(); resolve(false); }
                };
                document.addEventListener('keydown', keyHandler);

                function cleanup() { document.removeEventListener('keydown', keyHandler); overlay.remove(); }

                document.getElementById('custom-confirm-cancel').onclick = () => { cleanup(); resolve(false); };
                document.getElementById('custom-confirm-backdrop').onclick = () => { cleanup(); resolve(false); };
                document.getElementById('custom-confirm-ok').onclick = () => { cleanup(); resolve(true); };
            });
        }

        // ===== BROADCAST DEALS SECTION =====
        let broadcastDealsData = null;

        async function fetchBroadcastDealsPreview() {
            const input = document.getElementById('broadcast-deals-input').value.trim();
            if (!input) return;
            const asin = input;
            const lang = document.documentElement.lang || 'masry';
            document.getElementById('broadcast-deals-loading').classList.remove('hidden');
            document.getElementById('broadcast-deals-options').classList.add('hidden');
            document.getElementById('broadcast-deals-composer').classList.add('hidden');
            document.getElementById('broadcast-deals-error').classList.add('hidden');
            try {
                const data = await fetchAPI('/live-price', 'POST', { asin, fetch_options: true, lang });
                if (!data) throw new Error('Failed to load data');
                broadcastDealsData = data;
                document.getElementById('broadcast-deals-loading').classList.add('hidden');
                if (data.options && data.options.length > 0) {
                    renderBroadcastDealsOptionPicker(data.options, data.product);
                } else {
                    loadBroadcastDealsComposer(data.broadcast_text);
                }
            } catch (e) {
                document.getElementById('broadcast-deals-loading').classList.add('hidden');
                showBroadcastDealsError(e.message);
            }
        }

        function renderBroadcastDealsOptionPicker(options, product) {
            const container = document.getElementById('broadcast-deals-options-list');
            container.innerHTML = '';
            const lang = document.documentElement.lang || 'masry';
            const isRtl = lang === 'masry';
            const dirVal = isRtl ? 'rtl' : 'ltr';
            
            const parentBtn = document.createElement('button');
            parentBtn.type = 'button';
            parentBtn.dir = dirVal;
            parentBtn.className = 'w-full text-start px-3 py-2 rounded-lg bg-gray-800/50 hover:bg-brand-500/10 border border-gray-700 hover:border-brand-500/30 transition text-xs flex items-center gap-3';
            const parentPriceText = product.price ? ' <span class="text-gray-500 mx-1">|</span> <span class="text-brand-400 whitespace-nowrap" dir="ltr">' + escapeHtml(product.price) + '</span>' : '';
            parentBtn.innerHTML = '<span dir="auto" class="font-medium text-white font-arabic flex-1 min-w-0 break-words">' + escapeHtml(product.name_ar || product.name || product.asin) + parentPriceText + '</span><span class="text-gray-500 shrink-0 whitespace-nowrap">' + ${js('crm.broadcast_original')} + '</span>';
            parentBtn.onclick = () => selectBroadcastDealsOption(null);
            container.appendChild(parentBtn);
            
            for (const opt of options) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.dir = dirVal;
                btn.className = 'w-full text-start px-3 py-2 rounded-lg bg-gray-800/50 hover:bg-brand-500/10 border border-gray-700 hover:border-brand-500/30 transition text-xs flex items-center gap-3';
                const priceText = opt.price ? ' <span class="text-gray-500 mx-1">|</span> <span class="text-brand-400 whitespace-nowrap" dir="ltr">' + escapeHtml(opt.price) + '</span>' : '';
                btn.innerHTML = '<span dir="auto" class="font-medium text-white font-arabic flex-1 min-w-0 break-words">' + escapeHtml(opt.name || opt.asin) + priceText + '</span><span class="text-brand-400 shrink-0 whitespace-nowrap">' + ${js('crm.broadcast_option')} + '</span>';
                btn.onclick = () => selectBroadcastDealsOption(opt);
                container.appendChild(btn);
            }
            document.getElementById('broadcast-deals-options').classList.remove('hidden');
        }

        function selectBroadcastDealsOption(option) {
            broadcastDealsData.selectedOption = option;
            document.getElementById('broadcast-deals-options').classList.add('hidden');
            if (option && option.asin) {
                document.getElementById('broadcast-deals-loading').classList.remove('hidden');
                fetchBroadcastOptionText(option);
            } else {
                loadBroadcastDealsComposer(broadcastDealsData.broadcast_text);
            }
        }

        async function fetchBroadcastOptionText(option) {
            try {
                const data = await fetchAPI('/generate-text', 'POST', option);
                if (!data || data.error) throw new Error('Failed');
                broadcastDealsData.inline_keyboard = data.inline_keyboard;
                loadBroadcastDealsComposer(data.broadcast_text);
            } catch (e) {
                showBroadcastDealsError('Failed to load variation data.');
            }
        }

        function loadBroadcastDealsComposer(broadcastText) {
            document.getElementById('broadcast-deals-loading').classList.add('hidden');
            const lines = broadcastText.split('\\n');
            document.getElementById('broadcast-deals-title').value = lines[0] || '';
            document.getElementById('broadcast-deals-body').value = lines.slice(1).join('\\n');
            document.getElementById('broadcast-deals-composer').classList.remove('hidden');
            
            const backBtn = document.getElementById('broadcast-deals-back-btn');
            const closeBtn = document.getElementById('broadcast-deals-close-btn');
            if (broadcastDealsData && broadcastDealsData.options && broadcastDealsData.options.length > 0) {
                backBtn.classList.remove('hidden');
                closeBtn.classList.add('hidden');
            } else {
                backBtn.classList.add('hidden');
                closeBtn.classList.remove('hidden');
            }
        }

        function goBackToBroadcastDealsOptions() {
            document.getElementById('broadcast-deals-composer').classList.add('hidden');
            document.getElementById('broadcast-deals-options').classList.remove('hidden');
            document.getElementById('broadcast-deals-back-btn').classList.add('hidden');
            document.getElementById('broadcast-deals-close-btn').classList.remove('hidden');
        }

        function closeBroadcastDealsComposer() {
            document.getElementById('broadcast-deals-composer').classList.add('hidden');
            document.getElementById('broadcast-deals-options').classList.add('hidden');
            document.getElementById('broadcast-deals-input').value = '';
        }

        function showBroadcastDealsError(msg) {
            document.getElementById('broadcast-deals-error-text').textContent = msg;
            document.getElementById('broadcast-deals-error').classList.remove('hidden');
        }

        async function confirmBroadcastDeals() {
            const title = document.getElementById('broadcast-deals-title').value.trim();
            const body = document.getElementById('broadcast-deals-body').value.trim();
            if (!title || !body) return;
            const fullText = title + '\\n\\n' + body;
            const asin = (broadcastDealsData && broadcastDealsData.selectedOption && broadcastDealsData.selectedOption.asin) || (broadcastDealsData && broadcastDealsData.product && broadcastDealsData.product.asin) || '';
            const inlineKeyboard = broadcastDealsData && broadcastDealsData.inline_keyboard;
            const lang = document.documentElement.lang || 'masry';
            if (!await showConfirmDialog(${js('crm.confirm_broadcast_send')}, ${js('crm.confirm_btn_confirm')}, ${js('crm.confirm_btn_cancel')})) return;
            const btn = document.getElementById('broadcast-deals-confirm-btn');
            btn.disabled = true;
            btn.textContent = '...';
            try {
                await fetchAPI('/action', 'POST', {
                    action: 'broadcast',
                    data: {
                        message: fullText,
                        broadcast_type: 'product_broadcast',
                        asin: asin,
                        inline_keyboard: inlineKeyboard
                    }
                });
                document.getElementById('broadcast-deals-composer').classList.add('hidden');
                document.getElementById('broadcast-deals-input').value = '';
                broadcastDealsData = null;
                if (typeof showToast === 'function') {
                    showToast(${js('crm.broadcast_sent')});
                }
            } catch (e) {
                showBroadcastDealsError(e.message);
            } finally {
                btn.disabled = false;
                btn.textContent = ${js('crm.broadcast_confirm_send')};
            }
        }

        // ===== PER-PRODUCT BROADCAST MODAL =====
        let broadcastModalData = null;
        let broadcastModalAsin = null;

        function openBroadcastModal(asin) {
            if (!asin) return;
            broadcastModalAsin = asin;
            broadcastModalData = null;
            document.getElementById('broadcast-modal-loading').classList.remove('hidden');
            document.getElementById('broadcast-modal-options').classList.add('hidden');
            document.getElementById('broadcast-modal-composer').classList.add('hidden');
            document.getElementById('broadcast-modal-error').classList.add('hidden');
            document.getElementById('broadcast-modal').classList.remove('hidden');
            fetchBroadcastModalData(asin);
        }

        function closeBroadcastModal() {
            document.getElementById('broadcast-modal').classList.add('hidden');
            broadcastModalData = null;
            broadcastModalAsin = null;
        }

        async function fetchBroadcastModalData(asin) {
            try {
                const lang = document.documentElement.lang || 'masry';
                const data = await fetchAPI('/live-price', 'POST', { asin, fetch_options: true, lang });
                if (!data) throw new Error('Failed to load data');
                broadcastModalData = data;
                document.getElementById('broadcast-modal-loading').classList.add('hidden');
                if (data.options && data.options.length > 0) {
                    renderBroadcastModalOptions(data.options, data.product);
                } else {
                    loadBroadcastModalComposer(data.broadcast_text);
                }
            } catch (e) {
                document.getElementById('broadcast-modal-loading').classList.add('hidden');
                showBroadcastModalError(e.message);
            }
        }

        function renderBroadcastModalOptions(options, product) {
            const container = document.getElementById('broadcast-modal-options-list');
            container.innerHTML = '';
            const lang = document.documentElement.lang || 'masry';
            const isRtl = lang === 'masry';
            const dirVal = isRtl ? 'rtl' : 'ltr';
            
            const parentBtn = document.createElement('button');
            parentBtn.type = 'button';
            parentBtn.dir = dirVal;
            parentBtn.className = 'w-full text-start px-3 py-2 rounded-lg bg-gray-800/50 hover:bg-brand-500/10 border border-gray-700 hover:border-brand-500/30 transition text-xs flex items-center gap-3';
            const parentPriceText = product.price ? ' <span class="text-gray-500 mx-1">|</span> <span class="text-brand-400 whitespace-nowrap" dir="ltr">' + escapeHtml(product.price) + '</span>' : '';
            parentBtn.innerHTML = '<span dir="auto" class="font-medium text-white font-arabic flex-1 min-w-0 break-words">' + escapeHtml(product.name_ar || product.name || product.asin) + parentPriceText + '</span><span class="text-gray-500 shrink-0 whitespace-nowrap">' + ${js('crm.broadcast_original')} + '</span>';
            parentBtn.onclick = () => selectBroadcastModalOption(null);
            container.appendChild(parentBtn);
            
            for (const opt of options) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.dir = dirVal;
                btn.className = 'w-full text-start px-3 py-2 rounded-lg bg-gray-800/50 hover:bg-brand-500/10 border border-gray-700 hover:border-brand-500/30 transition text-xs flex items-center gap-3';
                const priceText = opt.price ? ' <span class="text-gray-500 mx-1">|</span> <span class="text-brand-400 whitespace-nowrap" dir="ltr">' + escapeHtml(opt.price) + '</span>' : '';
                btn.innerHTML = '<span dir="auto" class="font-medium text-white font-arabic flex-1 min-w-0 break-words">' + escapeHtml(opt.name || opt.asin) + priceText + '</span><span class="text-brand-400 shrink-0 whitespace-nowrap">' + ${js('crm.broadcast_option')} + '</span>';
                btn.onclick = () => selectBroadcastModalOption(opt);
                container.appendChild(btn);
            }
            document.getElementById('broadcast-modal-options').classList.remove('hidden');
        }

        function selectBroadcastModalOption(option) {
            broadcastModalData.selectedOption = option;
            document.getElementById('broadcast-modal-options').classList.add('hidden');
            if (option && option.asin) {
                fetchBroadcastModalOptionText(option);
            } else {
                loadBroadcastModalComposer(broadcastModalData.broadcast_text);
            }
        }

        async function fetchBroadcastModalOptionText(option) {
            try {
                const data = await fetchAPI('/generate-text', 'POST', option);
                if (!data || data.error) throw new Error('Failed');
                broadcastModalData.inline_keyboard = data.inline_keyboard;
                loadBroadcastModalComposer(data.broadcast_text);
            } catch (e) {
                loadBroadcastModalComposer(broadcastModalData.broadcast_text);
            }
        }

        function loadBroadcastModalComposer(broadcastText) {
            document.getElementById('broadcast-modal-loading').classList.add('hidden');
            const lines = broadcastText.split('\\n');
            document.getElementById('broadcast-modal-title').value = lines[0] || '';
            document.getElementById('broadcast-modal-body').value = lines.slice(1).join('\\n');
            document.getElementById('broadcast-modal-composer').classList.remove('hidden');
            
            const backBtn = document.getElementById('broadcast-modal-back-btn');
            const closeBtn = document.getElementById('broadcast-modal-close-btn');
            if (broadcastModalData && broadcastModalData.options && broadcastModalData.options.length > 0) {
                backBtn.classList.remove('hidden');
                closeBtn.classList.add('hidden');
            } else {
                backBtn.classList.add('hidden');
                closeBtn.classList.remove('hidden');
            }
        }

        function goBackToBroadcastModalOptions() {
            document.getElementById('broadcast-modal-composer').classList.add('hidden');
            document.getElementById('broadcast-modal-options').classList.remove('hidden');
            document.getElementById('broadcast-modal-back-btn').classList.add('hidden');
            document.getElementById('broadcast-modal-close-btn').classList.remove('hidden');
        }

        function showBroadcastModalError(msg) {
            document.getElementById('broadcast-modal-error-text').textContent = msg;
            document.getElementById('broadcast-modal-error').classList.remove('hidden');
        }

        async function confirmBroadcastModal() {
            const title = document.getElementById('broadcast-modal-title').value.trim();
            const body = document.getElementById('broadcast-modal-body').value.trim();
            if (!title || !body) return;
            const fullText = title + '\\n\\n' + body;
            const asin = (broadcastModalData && broadcastModalData.selectedOption && broadcastModalData.selectedOption.asin) || (broadcastModalData && broadcastModalData.product && broadcastModalData.product.asin) || broadcastModalAsin || '';
            const inlineKeyboard = broadcastModalData && broadcastModalData.inline_keyboard;
            const lang = document.documentElement.lang || 'masry';
            if (!await showConfirmDialog(${js('crm.confirm_broadcast_send')}, ${js('crm.confirm_btn_confirm')}, ${js('crm.confirm_btn_cancel')})) return;
            const btn = document.getElementById('broadcast-modal-confirm-btn');
            btn.disabled = true;
            btn.textContent = '...';
            try {
                await fetchAPI('/action', 'POST', {
                    action: 'broadcast',
                    data: {
                        message: fullText,
                        broadcast_type: 'product_broadcast',
                        asin: asin,
                        inline_keyboard: inlineKeyboard
                    }
                });
                closeBroadcastModal();
                if (typeof showToast === 'function') {
                    showToast(${js('crm.broadcast_sent')});
                }
            } catch (e) {
                showBroadcastModalError(e.message);
            } finally {
                btn.disabled = false;
                btn.textContent = ${js('crm.broadcast_confirm_send')};
            }
        }

        // Init
        refreshData();
    </script>
</body>
</html>`;
}
