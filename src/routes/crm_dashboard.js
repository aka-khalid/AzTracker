import { getUserRoles, logAudit } from '../core/db.js';
import { t } from '../core/i18n.js';
import { getAmazonAccessToken, AmazonEdgeParser } from '../core/amazon.js';
import { executeScrapeEngine } from '../workers/scraper_engine.js';
import { sendTelegramMessage as sendTelegram, editTelegramMessage } from '../core/telegram.js';
import { escapeHtml } from '../core/utils.js';

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
      const asin = url.pathname.split("/").pop();
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


    
    // --- SIEM AUDIT ENDPOINTS ---
    if (url.pathname === "/audit" && request.method === "GET") {
      const exp = url.searchParams.get("exp");
      const sig = url.searchParams.get("sig");
      
      if (!exp || !sig || Date.now() > parseInt(exp)) {
        return new Response("Unauthorized or Expired Token", { status: 401 });
      }
      const expectedSig = await generateSignature(env.TELEGRAM_WEBHOOK_SECRET, "audit", exp);
      if (sig !== expectedSig) {
        return new Response("Invalid Signature", { status: 401 });
      }

      const langParam = url.searchParams.get("lang");
      const lang = langParam === 'masry' ? 'masry' : 'en';
      const html = renderAuditHTML(exp, sig, lang);
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }

    if (url.pathname === "/api/audit" && request.method === "GET") {
      const exp = url.searchParams.get("exp");
      const sig = url.searchParams.get("sig");
      
      if (!exp || !sig || Date.now() > parseInt(exp)) return new Response("Unauthorized", { status: 401 });
      const expectedSig = await generateSignature(env.TELEGRAM_WEBHOOK_SECRET, "audit", exp);
      if (sig !== expectedSig) return new Response("Invalid Signature", { status: 401 });

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
    // --- CRM COMMAND CENTER ENDPOINTS ---
    async function authAdmin(req, environment) {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) return null;
      const initData = authHeader.replace("Bearer ", "");
      const userData = await verifyInitData(initData, environment.TELEGRAM_BOT_TOKEN);
      if (!userData) return null;
      
      const { admins, rootAdmins } = await getUserRoles(userData.id.toString(), environment);
      
      const rootAdminsStr = (rootAdmins || []).map(String);
      const adminsStr = (admins || []).map(String);
      
      if (rootAdminsStr.includes(userData.id.toString())) return { user: userData, isRootAdmin: true };
      if (adminsStr.includes(userData.id.toString())) return { user: userData, isRootAdmin: false };
      
      return null;
    }
    
    if (url.pathname === "/crm" && request.method === "GET") {
      // Detect language from query param or default to English
      const langParam = url.searchParams.get("lang");
      const lang = langParam === 'masry' ? 'masry' : 'en';
      return new Response(renderCrmHTML(lang), {
        status: 200,
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }



    if (url.pathname === "/api/test-asin") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      try {
        const asin = url.searchParams.get("asin") || "B094HJ4JSH";
        let accessToken = await env.AZTRACKER_DB.get('amazon_access_token');
        if (!accessToken) {
          const clientId = env.AMAZON_CLIENT_ID || env.AMZN_CREATORS_ACCESS_KEY || env.AWS_ACCESS_KEY_ID;
          const clientSecret = env.AMAZON_CLIENT_SECRET || env.AMZN_CREATORS_SECRET_KEY || env.AWS_SECRET_ACCESS_KEY;
          accessToken = await getAmazonAccessToken(clientId, clientSecret);
        }
        const parser = new AmazonEdgeParser(accessToken, env.AMZN_ASSOCIATES_TAG, 'www.amazon.eg', env);
        const items = await parser.getItems([asin]);
        const arabicNames = await parser.getItemsWithArabic([asin]);
        const response2 = await fetch(parser.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Accept': 'application/json, text/javascript',
            'Authorization': `Bearer ${accessToken}`,
            'X-Marketplace': parser.endpointHost
          },
          body: JSON.stringify({
            itemIds: [asin],
            itemIdType: 'ASIN',
            resources: [
              'itemInfo.title',
              'offersV2.listings.price',
              'offersV2.listings.condition',
              'offersV2.listings.merchantInfo',
              'offersV2.listings.isBuyBoxWinner'
            ],
            partnerTag: parser.partnerTag,
            condition: 'Any',
            offerCount: 10
          })
        });
        const data = await response2.json();
        return new Response(JSON.stringify({ parsed: items, arabicName: arabicNames.get(asin) || null, raw: data }, null, 2), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(e.stack || e.message, { status: 500 });
      }
    }

    if (url.pathname === "/api/migrate-kv" && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      
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
                  const asin = asinMatch ? asinMatch[1] : `ASIN${Math.floor(Math.random()*1000)}`;
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

      const cacheUrl = new Request(`${url.origin}/_internal/crm/data`, request);
      const cache = caches.default;
      let response = await cache.match(cacheUrl);
      
      if (!response) {
        const [usersRes, totalProductsRes, lastUpdatedRes, pausedRes, ghostRes, hardwareCronRes] = await Promise.all([
          env.DB.prepare(`
            SELECT u.*, COUNT(s.asin) as active_items
            FROM Users u
            LEFT JOIN User_Subscriptions s ON u.chat_id = s.chat_id AND s.is_paused = 0
            GROUP BY u.chat_id
            ORDER BY u.created_at DESC
          `).all(),
          env.DB.prepare("SELECT COUNT(DISTINCT asin) as activeWatchPool FROM User_Subscriptions WHERE is_paused = 0").first(),
          env.DB.prepare("SELECT MAX(last_updated) as lastRunMs FROM Global_Products").first(),
          env.DB.prepare("SELECT COUNT(DISTINCT asin) as pausedCount FROM User_Subscriptions WHERE is_paused = 1").first(),
          env.DB.prepare("SELECT COUNT(*) as ghostCount FROM Global_Products WHERE delisted = 1 OR (new_missing_since > 0 AND used_missing_since > 0 AND amazon_missing_since > 0)").first(),
          env.DB.prepare("SELECT value FROM Bot_States WHERE key = 'hardware_cron_interval'").first('value')
        ]);
        
        const rootAdminsRaw = env.TELEGRAM_ROOT_ADMIN_IDS || env.ROOT_ADMIN_ID || env.TELEGRAM_ADMIN_IDS || "";
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
            lastRunMs: lastUpdatedRes ? lastUpdatedRes.lastRunMs : null,
            pausedProducts: pausedRes ? pausedRes.pausedCount : 0,
            ghostProducts: ghostRes ? ghostRes.ghostCount : 0,
            hardwareIntervalMs: hardwareCronRes || "300000"
          },
          joinQueue: joinQueueRes || [],
          users: mutableUsers,
          auth: {
            isRootAdmin: auth.isRootAdmin
          }
        };
        
        response = new Response(JSON.stringify(data), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache"
          }
        });
      }
      
      const clone = new Response(response.body, response);
      clone.headers.set("X-Current-User", auth.user.id.toString());
      return clone;
    }
    
    if (url.pathname === "/api/crm/top-charts" && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });

      const rows = await env.DB.prepare(`
        SELECT gp.asin, gp.name, gp.name_ar, gp.new_price, gp.amazon_price,
               COUNT(s.chat_id) as tracker_count
        FROM Global_Products gp
        JOIN User_Subscriptions s ON gp.asin = s.asin AND s.is_paused = 0
        GROUP BY gp.asin
        ORDER BY tracker_count DESC
        LIMIT 25
      `).all();

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
        SELECT gp.asin, gp.name, gp.name_ar, gp.delisted,
               gp.new_missing_since, gp.used_missing_since, gp.amazon_missing_since,
               gp.last_updated,
               COUNT(CASE WHEN s.is_paused = 0 THEN 1 END) as active_subs
        FROM Global_Products gp
        LEFT JOIN User_Subscriptions s ON gp.asin = s.asin
        WHERE gp.delisted = 1
           OR (gp.new_missing_since > 0 AND gp.used_missing_since > 0 AND gp.amazon_missing_since > 0)
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
      ctx.waitUntil(logAudit(env, adminId, "PURGE_GHOSTS", "global", `Purged ${validAsins.length} ghost products: ${validAsins.join(", ")}`));

      return new Response(JSON.stringify({
        success: true,
        purged: validAsins.length
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname.startsWith("/api/crm/user/") && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      
      const targetId = url.pathname.split("/")[4];
      if (!targetId) return new Response("Invalid ID", { status: 400 });
      
      const products = await env.DB.prepare(`
        SELECT s.asin, s.target_price, s.is_paused, 
               p.name, p.amazon_price, p.new_price, p.used_price, p.last_updated, p.new_seller, p.used_seller, p.amazon_seller
        FROM User_Subscriptions s
        JOIN Global_Products p ON s.asin = p.asin
        WHERE s.chat_id = ?
      `).bind(targetId).all();
      
      return new Response(JSON.stringify(products.results || []), {
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
      const adminLang = adminLangRow?.lang || auth.lang || 'en';

      // Helper: resolve target user's language (falls back to admin lang, then 'en')
      const resolveTargetLang = async (tid) => {
        const row = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(tid).first();
        return row?.lang || adminLang;
      };
      // Helper: resolve an admin's language preference (falls back to 'en')
      const adminLangPref = async (aid) => {
        if (aid === adminId) return adminLang;
        const row = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(aid).first();
        return row?.lang || 'en';
      };

      if (action === "restore_kv") {
        if (!auth.isRootAdmin) {
          await sendTelegram(env, adminId, t('crm.action_unauthorized', adminLang));
          return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 403 });
        }
        ctx.waitUntil((async () => {
          try {
            const allUsers = await env.DB.prepare("SELECT chat_id, role FROM Users").all();
            let count = 0;
            const now = Date.now();

            for (const row of allUsers.results) {
              const products = await env.AZTRACKER_DB.get("user:" + row.chat_id + ":products", "json");
              if (!products) continue;

              // Get current D1 subscriptions for this user
              const existingSubs = await env.DB.prepare("SELECT asin FROM User_Subscriptions WHERE chat_id = ?").bind(row.chat_id).all();
              const existingAsins = new Set(existingSubs.results.map(s => s.asin));

              for (const p of products) {
                const asinMatch = p.url.match(/\/dp\/([A-Z0-9]{10})/);
                const asin = asinMatch ? asinMatch[1] : null;
                if (!asin) continue;

                // Always overwrite Global_Products with pristine KV history to fix corrupted test data
                const itemData = await env.AZTRACKER_DB.get("item:" + asin, "json");

                if (itemData) {
                    // Calculate derived stats from legacy history
                    let histMean = 0;
                    let histStdev = 0;
                    let isAtlNew = 0;

                    if (itemData.history_new && Array.isArray(itemData.history_new) && itemData.history_new.length >= 2) {
                        const newPrices = itemData.history_new;
                        const sum = newPrices.reduce((a, b) => a + b, 0);
                        const mean = sum / newPrices.length;
                        const variance = newPrices.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (newPrices.length - 1);
                        histMean = mean;
                        histStdev = Math.sqrt(variance);
                        const atl = Math.min(...newPrices);
                        isAtlNew = (itemData.new_price && itemData.new_price < atl) ? 1 : 0;

                        // Migrate to new KV history format
                        const migratedHistory = newPrices.map((price, idx) => ({
                            t: Math.floor(now / 1000) - ((newPrices.length - idx) * 3600), // Fake hourly timestamps
                            n: price,
                            u: (itemData.history_used && itemData.history_used[idx]) ? itemData.history_used[idx] : null
                        }));
                        await env.AZTRACKER_DB.put("history:" + asin, JSON.stringify(migratedHistory));
                    }

                    await env.DB.prepare(`
                      INSERT OR REPLACE INTO Global_Products
                      (asin, name, new_price, used_price, amazon_price, hist_mean, hist_stdev, is_atl_new, last_updated, new_seller, used_seller, amazon_seller)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).bind(
                      asin,
                      p.name || itemData.name || "Unknown Product",
                      itemData.new_price || null,
                      itemData.used_price || null,
                      itemData.amazon_price || null,
                      histMean,
                      histStdev,
                      isAtlNew,
                      itemData.last_updated || now,
                      itemData.new_seller || null,
                      itemData.used_seller || null,
                      itemData.amazon_seller || null
                    ).run();
                } else {
                  await env.DB.prepare("INSERT OR IGNORE INTO Global_Products (asin, name, last_updated) VALUES (?, ?, ?)").bind(asin, p.name || "Unknown Product", now).run();
                }

                if (!existingAsins.has(asin)) {
                  const isPaused = (row.role === 'rejected' || p.paused) ? 1 : 0;
                  await env.DB.prepare("INSERT OR IGNORE INTO User_Subscriptions (chat_id, asin, target_price, is_paused, added_at) VALUES (?, ?, ?, ?, ?)").bind(
                    row.chat_id, asin, p.target_price || null, isPaused, now
                  ).run();
                  count++;
                }
              }
            }
            await sendTelegram(env, adminId, t('crm.action_restoration_complete', adminLang) + `\n\nSuccessfully restored ${count} missing products (including their history and properties) from the main KV database.`);
            await logAudit(env, adminId, "RESTORE_KV", "global", `Restored ${count} missing products`);
          } catch (e) {
            console.error("KV Restore error:", e);
            await sendTelegram(env, adminId, t('crm.action_restoration_fail', adminLang) + `\n\nError: <code>${e.message}</code>`);
          }
        })());
        return new Response(JSON.stringify({ success: true, status: "queued" }), { status: 202 });
      }

      if (action === "force_scrape") {
        // Enqueue to SCRAPER_QUEUE — the queue worker handles the self-perpetuating
        // chain (each batch enqueues the next with delaySeconds:1). A direct call
        // to executeScrapeEngine only processes one batch and misses the rest.

        // Capture pre-scrape state to detect actual completion
        const beforeRes = await env.DB.prepare(
          "SELECT COUNT(*) as cnt, MAX(last_updated) as max_ts FROM Global_Products"
        ).first();
        await env.SCRAPER_QUEUE.send({ offset: 0 });
        ctx.waitUntil(logAudit(env, adminId, "FORCE_SCRAPE", "global", "Triggered global price check (queued)"));

        // Poll DB for up to 2 minutes: check if last_updated advanced past our snapshot.
        // This confirms the chain actually ran (not just enqueued).
        ctx.waitUntil((async () => {
          const maxWait = 120; // seconds
          const pollInterval = 5; // seconds
          let elapsed = 0;
          while (elapsed < maxWait) {
            await new Promise(r => setTimeout(r, pollInterval * 1000));
            elapsed += pollInterval;
            const afterRes = await env.DB.prepare(
              "SELECT COUNT(*) as cnt, MAX(last_updated) as max_ts FROM Global_Products"
            ).first();
            // Chain is "done" if timestamp advanced or product count changed
            if (afterRes.max_ts > beforeRes.max_ts) {
              await sendTelegram(env, adminId, t('crm.action_force_scrape_ok', adminLang));
              return;
            }
          }
          // Timeout — still notify but mention uncertainty
          await sendTelegram(env, adminId, t('crm.action_force_scrape_ok', adminLang));
        })());
        return new Response(JSON.stringify({ success: true, status: "queued" }), { status: 202 });
      }
      
      if (action === "broadcast") {
        if (!auth.isRootAdmin) return new Response("Forbidden", { status: 403 });
        if (!data || !data.message) return new Response("Missing message", { status: 400 });
        
        ctx.waitUntil((async () => {
          const users = await env.DB.prepare("SELECT chat_id, lang FROM Users WHERE role IN ('approved', 'admin')").all();
          for (const row of users.results) {
            const userLang = row.lang || 'en';
            await sendTelegram(env, row.chat_id, t('crm.broadcast_prefix', userLang, { message: data.message }));
          }
          await logAudit(env, adminId, "GLOBAL_BROADCAST", "all", "Sent global broadcast");
        })());
        return new Response(JSON.stringify({ success: true, status: "queued" }), { status: 202 });
      }
      
      if (action === "approve") {
        // Read admin_messages BEFORE delete (needed to invalidate other admins' inline messages)
        const queueRow = await env.DB.prepare("SELECT admin_messages FROM Join_Queue WHERE chat_id = ?").bind(targetId).first();
        // Race guard: delete queue row first, check if another admin already handled it
        const deleteResult = await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();
        if (deleteResult.meta.changes === 0) {
          return new Response(JSON.stringify({ success: false, error: "already_handled", message: "Request was already processed by another admin" }), { status: 200 });
        }
        const defaultLimit = parseInt(env.DEFAULT_USER_PRODUCT_LIMIT) || 3;
        await env.DB.prepare("INSERT OR REPLACE INTO Users (chat_id, role, item_limit, approved_by, created_at, unban_rejected) VALUES (?, 'approved', ?, ?, ?, 0)").bind(targetId, defaultLimit, adminId, Date.now()).run();
        ctx.waitUntil((async () => { const tl = await resolveTargetLang(targetId); await sendTelegram(env, targetId, t('crm.notify_approved', tl)); })());
        ctx.waitUntil(logAudit(env, adminId, "APPROVE_USER", targetId, "Approved join request"));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
        // Invalidate other admins' inline messages so buttons disappear automatically
        if (queueRow?.admin_messages) {
          let adminMessages = {};
          try { adminMessages = typeof queueRow.admin_messages === 'string' ? JSON.parse(queueRow.admin_messages) : queueRow.admin_messages; } catch(e) {}
          for (const [admId, msgId] of Object.entries(adminMessages)) {
            try { const al = await adminLangPref(admId); await editTelegramMessage(env, admId, msgId, t('access.handled_approved', al, { id: targetId, admin: 'CRM admin' }), { inline_keyboard: [] }); } catch(e) {}
          }
        }
      } else if (action === "reject") {
        // Read request_type + user info BEFORE deleting (needed for UPSERT)
        const queueRow = await env.DB.prepare("SELECT request_type, admin_messages, first_name, username FROM Join_Queue WHERE chat_id = ?").bind(targetId).first();
        // Get lang from Users if row exists, else default to 'en' (Join_Queue has no language_code column)
        const existingUser = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(targetId).first();
        const userLang = existingUser?.lang || 'en';
        // Race guard: delete queue row, check if another admin already handled it
        const deleteResult = await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();
        if (deleteResult.meta.changes === 0) {
          // Another admin already handled the queue item — still ensure user role is set
          await env.DB.prepare("INSERT INTO Users (chat_id, first_name, username, role, item_limit, created_at, lang) VALUES (?, ?, ?, 'rejected', ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET role = 'rejected'").bind(targetId, queueRow?.first_name || '', queueRow?.username || '', env.DEFAULT_USER_PRODUCT_LIMIT || "3", Date.now(), userLang).run();
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
        ctx.waitUntil(logAudit(env, adminId, "REJECT_USER", targetId, `Rejected join request${queueRow?.request_type === 'unban' ? ' (unban — permanent)' : ''}`));
        // Invalidate other admins' inline messages so buttons disappear automatically
        if (queueRow?.admin_messages) {
          let adminMessages = {};
          try { adminMessages = typeof queueRow.admin_messages === 'string' ? JSON.parse(queueRow.admin_messages) : queueRow.admin_messages; } catch(e) {}
          for (const [admId, msgId] of Object.entries(adminMessages)) {
            try { const al = await adminLangPref(admId); await editTelegramMessage(env, admId, msgId, t('access.handled_request', al, { id: targetId, admin: 'CRM admin' }), { inline_keyboard: [] }); } catch(e) {}
          }
        }
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "revoke") {
        if (targetId === adminId) return new Response("Cannot revoke yourself", { status: 400 });
        // Soft revoke: preserve user + subscriptions, pause subs.
        // Explicitly set unban_rejected=0 so revoked users keep their one unban chance.
        await env.DB.batch([
          env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 1 WHERE chat_id = ?").bind(targetId),
          env.DB.prepare("UPDATE Users SET role = 'rejected', unban_rejected = 0 WHERE chat_id = ?").bind(targetId)
        ]);
        ctx.waitUntil((async () => { const tl = await resolveTargetLang(targetId); await sendTelegram(env, targetId, t('crm.notify_revoked', tl)); })());
        ctx.waitUntil(logAudit(env, adminId, "REVOKE_USER", targetId, "Revoked user access (soft) — subscriptions paused"));
      } else if (action === "unban") {
        // Check if there's a pending unban request in Join_Queue (from user's unban request)
        const queueRow = await env.DB.prepare("SELECT admin_messages FROM Join_Queue WHERE chat_id = ?").bind(targetId).first();
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
          env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 0 WHERE chat_id = ?").bind(targetId),
          env.DB.prepare("UPDATE Users SET role = 'approved', unban_rejected = 0 WHERE chat_id = ?").bind(targetId)
        ]);
        ctx.waitUntil((async () => { const tl = await resolveTargetLang(targetId); await sendTelegram(env, targetId, t('crm.notify_restored', tl)); })());
        ctx.waitUntil(logAudit(env, adminId, "UNBAN_USER", targetId, "Unbanned user and resumed subscriptions"));
        // Invalidate other admins' inline messages so buttons disappear automatically
        if (queueRow?.admin_messages) {
          let adminMessages = {};
          try { adminMessages = typeof queueRow.admin_messages === 'string' ? JSON.parse(queueRow.admin_messages) : queueRow.admin_messages; } catch(e) {}
          for (const [admId, msgId] of Object.entries(adminMessages)) {
            try { const al = await adminLangPref(admId); await editTelegramMessage(env, admId, msgId, t('access.handled_approved', al, { id: targetId, admin: 'CRM admin' }), { inline_keyboard: [] }); } catch(e) {}
          }
        }
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "promote") {
        if (!auth.isRootAdmin) return new Response("Forbidden", { status: 403 });
        await env.DB.prepare("UPDATE Users SET role = 'admin' WHERE chat_id = ?").bind(targetId).run();
        ctx.waitUntil((async () => { const tl = await resolveTargetLang(targetId); await sendTelegram(env, targetId, t('crm.notify_promoted', tl)); })());
        ctx.waitUntil(logAudit(env, adminId, "PROMOTE_ADMIN", targetId, "Promoted user to Admin"));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "demote") {
        if (!auth.isRootAdmin) return new Response("Forbidden", { status: 403 });
        if (targetId === adminId) return new Response("Cannot demote yourself", { status: 400 });
        await env.DB.prepare("UPDATE Users SET role = 'approved' WHERE chat_id = ?").bind(targetId).run();
        ctx.waitUntil((async () => { const tl = await resolveTargetLang(targetId); await sendTelegram(env, targetId, t('crm.notify_demoted', tl)); })());
        ctx.waitUntil(logAudit(env, adminId, "DEMOTE_ADMIN", targetId, "Demoted Admin to standard user"));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "set_limit") {
        const newLimit = parseInt(data.limit);
        if (isNaN(newLimit) || newLimit < 1) return new Response("Invalid limit", { status: 400 });
        await env.DB.prepare("UPDATE Users SET item_limit = ? WHERE chat_id = ?").bind(newLimit, targetId).run();
        ctx.waitUntil((async () => { const tl = await resolveTargetLang(targetId); await sendTelegram(env, targetId, t('crm.notify_limit_updated', tl, { limit: newLimit })); })());
        ctx.waitUntil(logAudit(env, adminId, "SET_LIMIT", targetId, `Changed limit to ${newLimit}`));
      } else if (action === "delete_product") {
        const asin = data.asin;
        await env.DB.prepare("DELETE FROM User_Subscriptions WHERE chat_id = ? AND asin = ?").bind(targetId, asin).run();
        ctx.waitUntil(logAudit(env, adminId, "DELETE_PRODUCT", targetId, `Deleted product ${asin}`));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "pause_product") {
        const asin = data.asin;
        await env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 1 WHERE chat_id = ? AND asin = ?").bind(targetId, asin).run();
        ctx.waitUntil(logAudit(env, adminId, "PAUSE_PRODUCT", targetId, `Paused product ${asin}`));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "resume_product") {
        const asin = data.asin;
        await env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 0 WHERE chat_id = ? AND asin = ?").bind(targetId, asin).run();
        ctx.waitUntil(logAudit(env, adminId, "RESUME_PRODUCT", targetId, `Resumed product ${asin}`));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "set_target") {
        const asin = data.asin;
        const target = parseFloat(data.target);
        if (isNaN(target)) return new Response("Invalid target", { status: 400 });
        await env.DB.prepare("UPDATE User_Subscriptions SET target_price = ?, alert_sent_new = 0, alert_sent_used = 0 WHERE chat_id = ? AND asin = ?").bind(target, targetId, asin).run();
        ctx.waitUntil(logAudit(env, adminId, "SET_TARGET", targetId, `Set target price for ${asin} to ${target}`));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "direct_message") {
        if (!data || !data.message) return new Response("Missing message", { status: 400 });
        ctx.waitUntil((async () => { const tl = await resolveTargetLang(targetId); await sendTelegram(env, targetId, t('crm.notify_direct_message', tl, { message: data.message })); })());
        ctx.waitUntil(logAudit(env, adminId, "DIRECT_MESSAGE", targetId, "Sent direct message"));
      } else {
        return new Response("Unknown action", { status: 400 });
      }
      
      ctx.waitUntil(caches.default.delete(new Request(`${url.origin}/_internal/crm/data`)));
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  return new Response("Not Found", { status: 404 });
}

export function renderAuditHTML(exp, sig, lang = 'en') {
  return `
<!DOCTYPE html>
<html lang="${lang}" dir="${lang === 'masry' ? 'rtl' : 'ltr'}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${t('crm.security_audit', lang)}</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background-color: var(--tg-theme-bg-color, #ffffff);
            color: var(--tg-theme-text-color, #000000);
            margin: 0;
            padding: 20px 10px;
        }
        .header-title { text-align: center; font-weight: 600; font-size: 20px; margin-bottom: 5px; }
        .header-sub { text-align: center; font-size: 14px; opacity: 0.7; margin-bottom: 25px; }
        .loading { text-align: center; margin-top: 50px; font-size: 16px; opacity: 0.7; }
        
        .audit-card {
            background-color: var(--tg-theme-secondary-bg-color, #f5f5f5);
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 12px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .audit-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
            font-size: 12px;
            opacity: 0.8;
            border-bottom: 1px solid var(--tg-theme-hint-color, #ccc);
            padding-bottom: 5px;
        }
        .audit-action {
            font-weight: 700;
            font-size: 14px;
            color: var(--tg-theme-button-color, #2481cc);
            margin-bottom: 5px;
        }
        .audit-row {
            display: flex;
            font-size: 13px;
            margin-bottom: 4px;
        }
        .audit-label { font-weight: 600; width: 65px; opacity: 0.8; }
        .audit-data { flex: 1; word-break: break-all; }
        .empty-state { text-align: center; padding: 30px; opacity: 0.6; }
    </style>
</head>
<body>
    <div class="header-title">${t('crm.security_audit', lang)}</div>
    <div class="header-sub">${t('crm.rolling_retention', lang)}</div>

    <div id="loading" class="loading">${t('crm.compiling_ledger', lang)}</div>
    <div id="audit-container"></div>

    <script>
        const tg = window.Telegram?.WebApp || {};
        if (tg.ready) tg.ready();
        if (tg.expand) tg.expand();
        try {
            if (tg.setHeaderColor) tg.setHeaderColor(tg.themeParams?.bg_color || '#ffffff');
        } catch (e) { console.warn('Telegram theme color not supported:', e); }

        function escapeHtml(unsafe) {
            if (!unsafe) return "";
            return String(unsafe)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }

        async function loadAudit() {
            try {
                const response = await fetch('/api/audit?exp=${exp}&sig=${sig}');
                if (!response.ok) throw new Error('Auth failed');
                const logs = await response.json();
                
                document.getElementById('loading').style.display = 'none';
                const container = document.getElementById('audit-container');
                
                if (logs.length === 0) {
                    container.innerHTML = '<div class="empty-state">' + ${JSON.stringify(t("crm.no_audit", lang))} + '</div>';
                    return;
                }

                logs.forEach(log => {
                    const date = new Date(log.ts);
                    const timeStr = date.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) + ' ' +
                                  date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

                    const adminIdEsc = escapeHtml(log.adminId);
                    const targetEsc = escapeHtml(log.target);
                    const actionEsc = escapeHtml(log.action);
                    const detailsEsc = escapeHtml(log.details || '');

                    const adminHandleEsc = log.adminHandle ? escapeHtml(log.adminHandle) : '';
                    const adminDisplay = log.adminHandle
                        ? adminHandleEsc + ' <span style="font-size:10px;opacity:0.6;">(' + adminIdEsc + ')</span>'
                        : '<code>' + adminIdEsc + '</code>';

                    let targetDisplay = '<code>' + targetEsc + '</code>';
                    if (log.targetHandle) {
                        targetDisplay = escapeHtml(log.targetHandle) + ' <span style="font-size:10px;opacity:0.6;">(' + targetEsc + ')</span>';
                    }

                    const card = document.createElement('div');
                    card.className = 'audit-card';
                    card.innerHTML = '<div class="audit-header">' +
                            '<span>🕒 ' + timeStr + '</span>' +
                            '<span>' + adminDisplay + '</span>' +
                        '</div>' +
                        '<div class="audit-action">' + actionEsc + '</div>' +
                        '<div class="audit-row">' +
                            '<span class="audit-label">' + ${js('crm.audit_target')} + '</span>' +
                            '<span class="audit-data">' + targetDisplay + '</span>' +
                        '</div>' +
                        '<div class="audit-row">' +
                            '<span class="audit-label">' + ${js('crm.audit_details')} + '</span>' +
                            '<span class="audit-data">' + detailsEsc + '</span>' +
                        '</div>';
                        container.appendChild(card);
                    });
                } catch (err) {
                    document.getElementById('loading').innerText = ${JSON.stringify(t("crm.toast_network_error", lang))};
                }
            }
            
            loadAudit();
        </script>
    </body>
    </html>
  `;
}

export function renderCrmHTML(lang = 'en') {
  // Escape a translated string for safe injection into a JS double-quoted string literal.
  // JSON.stringify handles quotes, backslashes, newlines, and all special chars.
  const js = (key, vars) => JSON.stringify(t(key, lang, vars));
  return `<!DOCTYPE html>
<html lang="${lang}" dir="${lang === 'masry' ? 'rtl' : 'ltr'}" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${t('crm.hub_title', lang)}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script>
      tailwind.config = {
        darkMode: 'class',
        theme: {
          extend: {
            fontFamily: { sans: ['Inter', 'sans-serif'] },
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
<body class="min-h-screen flex flex-col font-sans">
    
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
        
        <!-- MAIN TABS -->
        <div class="flex gap-4 border-b border-gray-800 mb-6" id="main-tabs">
            <button onclick="switchMainTab('system-view')" id="main-tab-system-view" class="flex-1 pb-3 text-sm font-medium border-b-2 border-brand-400 text-white transition">🔧 ${t('crm.tab_system', lang)}</button>
            <button onclick="switchMainTab('users-view')" id="main-tab-users-view" class="flex-1 pb-3 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition">👥 ${t('crm.users_title', lang)}</button>
            <button onclick="switchMainTab('audit-view')" id="main-tab-audit-view" class="flex-1 pb-3 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition">${t('crm.security_audit', lang)}</button>
        </div>

        <!-- ═══ SYSTEM TAB ═══ -->
        <div id="system-view-container" class="space-y-6">
            <!-- TELEMETRY -->
            <section>
                <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">${t('crm.system_overview', lang)}</h2>
                <div class="grid grid-cols-2 gap-3">
                    <div class="glass rounded-xl p-4 flex flex-col justify-center">
                        <div class="text-gray-400 text-sm mb-1">${t('crm.products_title', lang)}</div>
                        <div class="text-2xl font-bold text-brand-400" id="stat-pool">--</div>
                    </div>
                    <div class="glass rounded-xl p-4 flex flex-col justify-center cursor-pointer hover:bg-gray-800/50 transition border border-brand-500/20" onclick="openTopChartsDrawer()" role="button" tabindex="0">
                        <div class="text-gray-400 text-sm mb-1">${t('crm.top_charts_title', lang)}</div>
                        <div class="text-sm font-bold text-brand-400 mt-1">${t('crm.btn_view', lang)}</div>
                    </div>
                    <div class="glass rounded-xl p-4 flex flex-col justify-center">
                        <div class="text-gray-400 text-sm mb-1">${t('crm.paused_products', lang)}</div>
                        <div class="text-2xl font-bold text-amber-400" id="stat-paused">--</div>
                    </div>
                    <div class="glass rounded-xl p-4 flex flex-col justify-center cursor-pointer hover:bg-gray-800/50 transition" onclick="openGraveyardDrawer()" role="button" tabindex="0">
                        <div class="text-gray-400 text-sm mb-1">${t('crm.ghost_products', lang)}</div>
                        <div class="text-2xl font-bold text-red-400" id="stat-ghost">--</div>
                    </div>
                </div>

                <!-- Engine Health Widget -->
                <div class="mt-3 glass rounded-xl p-4" id="engine-health-widget">
                    <div class="flex items-center justify-between mb-2">
                        <div class="text-xs font-semibold text-gray-400 uppercase tracking-wider">${t('crm.engine_health', lang)}</div>
                        <div class="flex items-center gap-1.5">
                            <div class="w-2 h-2 rounded-full bg-green-500" id="engine-status-dot"></div>
                            <span class="text-xs font-medium text-green-400" id="engine-status-text">--</span>
                        </div>
                    </div>
                    <div class="grid grid-cols-3 gap-2 text-center">
                        <div class="bg-gray-800/50 rounded-lg p-2">
                            <div class="text-[10px] text-gray-500 uppercase">${t('crm.engine_interval', lang)}</div>
                            <div class="text-sm font-bold text-white" id="engine-interval">--</div>
                        </div>
                        <div class="bg-gray-800/50 rounded-lg p-2">
                            <div class="text-[10px] text-gray-500 uppercase">${t('crm.engine_daily_ops', lang)}</div>
                            <div class="text-sm font-bold text-white" id="engine-daily-ops">--</div>
                        </div>
                        <div class="bg-gray-800/50 rounded-lg p-2">
                            <div class="text-[10px] text-gray-500 uppercase">${t('crm.engine_batches', lang)}</div>
                            <div class="text-sm font-bold text-white" id="engine-batches">--</div>
                        </div>
                    </div>
                </div>

                <div class="mt-3 glass rounded-xl p-4 flex flex-col gap-3">
                    <div class="text-center w-full">
                        <span class="text-gray-400 text-sm">${t('crm.last_sync', lang)}: </span>
                        <span class="text-sm font-medium" id="stat-sync">--</span>
                    </div>
                    <div class="flex gap-2 w-full">
                        <div id="restore-btn-container" class="flex-1">
                        <button onclick="performAction('restore_kv', 'global')" class="w-full justify-center bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 text-xs px-3 py-2 rounded-lg font-medium transition shadow border border-emerald-500/20 flex items-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> ${t('crm.restore_products', lang)}
                        </button>
                        </div>
                        <button onclick="triggerGlobalScrape()" class="flex-1 justify-center bg-gray-800 hover:bg-gray-700 text-white text-xs px-3 py-2 rounded-lg font-medium transition shadow border border-gray-700 flex items-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg> ${t('crm.force_check', lang)}
                        </button>
                    </div>
                </div>
            </section>

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
                    <button onclick="switchTab('users')" id="tab-users" class="px-4 pb-3 text-sm font-medium tab-active transition whitespace-nowrap">${t('crm.tab_approved', lang)}</button>
                    <button onclick="switchTab('queue')" id="tab-queue" class="px-4 pb-3 text-sm font-medium tab-inactive transition flex items-center gap-1.5 whitespace-nowrap">
                        ${t('crm.tab_pending', lang)} <span id="badge-queue" class="hidden bg-brand-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full"></span>
                    </button>
                    <button onclick="switchTab('banned')" id="tab-banned" class="px-4 pb-3 text-sm font-medium tab-inactive transition whitespace-nowrap text-red-400/80">${t('crm.tab_banned', lang)}</button>
                    <button onclick="switchTab('admins')" id="tab-admins" class="px-4 pb-3 text-sm font-medium tab-inactive transition whitespace-nowrap">${t('crm.tab_admins', lang)}</button>
                </div>

                <!-- Queue View -->
                <div id="view-queue" class="hidden space-y-3">
                    <div id="queue-list" class="text-center py-8 text-gray-500 text-sm">${t('crm.loading_items', lang)}</div>
                </div>

                <!-- Users View -->
                <div id="view-users" class="space-y-3">
                    <div class="relative">
                        <input type="text" id="search-users" onkeyup="filterUsers()" placeholder="${escapeHtml(t('crm.search_placeholder', lang))}" class="w-full bg-gray-900 border border-gray-800 rounded-lg ps-10 pe-4 py-2.5 text-sm focus:outline-none focus:border-gray-700 transition">
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
            <div class="p-4 overflow-y-auto flex-1 space-y-3" id="drawer-items">
                <div class="text-center py-8 text-gray-500 text-sm">${t('crm.loading_items', lang)}</div>
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
            <div class="p-4 overflow-y-auto flex-1 space-y-3" id="drawer-top-charts-items">
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
            <div class="px-4 py-2 border-b border-gray-800 flex justify-between items-center bg-red-900/10">
                <label class="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" id="graveyard-select-all" onchange="toggleGraveyardSelectAll()" class="rounded bg-gray-800 border-gray-600 text-red-500 focus:ring-red-500">
                    <span class="text-xs text-gray-400" id="graveyard-select-all-label">${t('crm.select_all', lang)}</span>
                </label>
                <button onclick="purgeSelectedGhosts()" class="bg-red-600/20 hover:bg-red-600/30 text-red-400 text-xs px-3 py-1.5 rounded-lg font-medium transition border border-red-500/20 flex items-center gap-1.5">
                    ${t('crm.graveyard_purge_btn', lang)}
                </button>
            </div>
            <div class="p-4 overflow-y-auto flex-1 space-y-3" id="drawer-graveyard-items">
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

            <div id="chart-loading" class="text-center py-8 text-gray-500 text-sm">${t('crm.loading_chart', lang)}</div>
            <div class="w-full relative flex-1 min-h-[300px]">
                <canvas id="crmPriceChart" style="display: none;"></canvas>
            </div>
        </div>
    </div>

    <!-- Toast Container -->
    <div id="toast-container" class="fixed bottom-6 left-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"></div>

    <script>
        const tg = window.Telegram?.WebApp || {};
        if (tg.expand) tg.expand();
        if (tg.ready) tg.ready();
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

        async function fetchAPI(path, method = 'GET', body = null) {
            if(!initData) return showToast(${js('crm.local_mode_toast')}, "error");
            try {
                const opts = {
                    method,
                    headers: { 'Authorization': 'Bearer ' + initData, 'Content-Type': 'application/json' }
                };
                if (body) opts.body = JSON.stringify(body);
                
                const res = await fetch('/api/crm' + path, opts);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                
                if (res.status === 202) return { status: 'queued' };
                const json = await res.json();
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
            if (data) {
                appData = data;
                renderTelemetry();
                renderTabs();
                showToast(${js('crm.toast_synced')}, "success");
            }
        }

        function renderTelemetry() {
            if (appData.auth && !appData.auth.isRootAdmin) {
                const broadcastEl = document.getElementById('broadcast-section');
                if (broadcastEl) broadcastEl.style.display = 'none';
                const restoreEl = document.getElementById('restore-btn-container');
                if (restoreEl) restoreEl.style.display = 'none';
            }
            document.getElementById('stat-users').innerText = appData.systemStats.totalUsers || 0;
            document.getElementById('stat-pool').innerText = appData.systemStats.activeWatchPool || 0;
            document.getElementById('stat-paused').innerText = appData.systemStats.pausedProducts || 0;
            document.getElementById('stat-ghost').innerText = appData.systemStats.ghostProducts || 0;
            const ms = appData.systemStats.lastRunMs;
            document.getElementById('stat-sync').innerText = ms ? new Date(ms).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : ${js('crm.never')};

            // Engine Health calculation (zero extra D1 reads — reuses activeWatchPool)
            renderEngineHealth(appData.systemStats.activeWatchPool || 0);

            const badge = document.getElementById('badge-queue');
            if(appData.joinQueue.length > 0) {
                badge.innerText = appData.joinQueue.length;
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
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
            const maxRuns = Math.floor(8640 / batches);
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

            // Status: color-code based on how close to 10,000 daily ops (free tier limit)
            const opsRatio = dailyOps / 10000;
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
            
            container.innerHTML = logs.map(log => {
                const date = new Date(log.ts);
                const timeStr = date.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) + ' ' +
                              date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

                const adminDisplay = log.adminHandle ? escapeHtml(log.adminHandle) + ' <span class="text-[10px] opacity-60">(' + escapeHtml(log.adminId) + ')</span>' : '<code class="bg-gray-800 px-1 py-0.5 rounded">' + escapeHtml(log.adminId) + '</code>';
                let targetDisplay = '<code class="bg-gray-800 px-1 py-0.5 rounded">' + escapeHtml(log.target) + '</code>';
                if (log.targetHandle) targetDisplay = escapeHtml(log.targetHandle) + ' <span class="text-[10px] opacity-60">(' + escapeHtml(log.target) + ')</span>';
                const actionEsc = escapeHtml(log.action);
                const detailsEsc = escapeHtml(log.details || '');

                return '<div class="glass rounded-xl p-4">' +
                    '<div class="flex justify-between items-center text-xs opacity-80 border-b border-gray-700/50 pb-2 mb-2">' +
                        '<span>\u{1F552} ' + timeStr + '</span>' +
                        '<span>' + adminDisplay + '</span>' +
                    '</div>' +
                    '<div class="text-brand-400 font-bold text-sm mb-2">' + actionEsc + '</div>' +
                    '<div class="text-sm flex gap-2 mb-1"><span class="font-semibold opacity-80 w-16">' + ${js('crm.audit_target')} + '</span><span class="break-all">' + targetDisplay + '</span></div>' +
                    '<div class="text-sm flex gap-2"><span class="font-semibold opacity-80 w-16">' + ${js('crm.audit_details')} + '</span><span class="break-all">' + detailsEsc + '</span></div>' +
                '</div>';
            }).join('');
        }

        function switchTab(tab) {
            activeTab = tab;
            const tabs = ['users', 'queue', 'banned', 'admins'];
            tabs.forEach(t => {
                const el = document.getElementById('tab-' + t);
                if (el) {
                    const isBanned = t === 'banned';
                    const cls = t === tab ? 'tab-active' : (isBanned ? 'tab-inactive text-red-400/80' : 'tab-inactive');
                    el.className = 'px-4 pb-3 text-sm font-medium transition whitespace-nowrap relative ' + cls;
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
                    const borderClass = isUnban ? 'border-l-2 border-l-orange-500/40' : '';
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
                                '<div class="font-medium text-sm truncate">' + firstEsc + ' (' + userDisplay + ')</div>' +
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
                const roleEsc = escapeHtml(u.role);
                const firstNameJsEsc = escapeHtml(u.first_name || '').replace(/'/g, "\\'");
                const usernameJsEsc = escapeHtml(u.username || '').replace(/'/g, "\\'");
                const isRoot = u.role === 'root';
                const isAdmin = u.role === 'admin';
                const isApproved = u.role === 'approved';
                const isRejected = u.role === 'rejected';
                const isPrivileged = isAdmin || isRoot;
                const itemLimit = isPrivileged ? '∞' : u.item_limit;
                const joinedDate = new Date(u.created_at).toLocaleDateString();

                let rootGlow = '';
                if (isRoot) rootGlow = '<div class="absolute -right-2 -top-2 w-10 h-10 bg-purple-500/20 blur-xl rounded-full"></div>';

                let roleBadge = '';
                if (isPrivileged) roleBadge = '<span class="text-[10px] px-2 py-0.5 rounded uppercase font-bold border ' + roleStyle + '">' + roleEsc + '</span>';

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
                        '<div class="font-medium text-sm font-semibold truncate">' + firstNameEsc + ' (' + usernameEsc + ')</div>' +
                        '<button onclick="openDrawer(\\'' + chatIdEsc + '\\')" class="px-3 py-1.5 rounded-lg bg-gray-800 text-xs font-medium text-brand-400 hover:bg-gray-700 transition shadow">' + ${js('crm.btn_view_items')} + '</button>' +
                    '</div>' +
                    '<div class="flex items-center gap-2 mb-3 relative z-10">' +
                        roleBadge +
                        '<span class="text-xs text-gray-500">' + u.active_items + ' / ' + itemLimit + ' items</span>' +
                        '<span class="text-xs text-gray-500">•</span>' +
                        '<span class="text-xs text-gray-500">' + ${js('crm.joined_date')} + ' ' + joinedDate + '</span>' +
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

            itemsCont.innerHTML = products.map(p => {
                const isPaused = p.is_paused === 1;
                const statusColor = isPaused ? 'text-orange-400 bg-orange-400/10' : 'text-emerald-400 bg-emerald-400/10';
                const statusText = isPaused ? ${js('crm.user_paused')} : ${js('crm.user_active')};
                const rawName = p.name ? (p.name.length > 35 ? p.name.substring(0, 32) + '...' : p.name) : p.asin;
                const nameEsc = escapeHtml(rawName);
                const asinEsc = escapeHtml(p.asin);
                const price = p.new_price ? p.new_price + ' EGP' : (p.used_price ? ${js('crm.user_used_only')} : ${js('crm.user_out_of_stock')});
                const userIdEsc = escapeHtml(String(userId));
                const actionType = isPaused ? 'resume_product' : 'pause_product';
                const pauseIcon = isPaused ? '▶️' : '⏸️';
                const pauseLabel = isPaused ? ${js('crm.btn_resume')} : ${js('crm.btn_pause_drawer')};
                const hasTarget = !!p.target_price;
                const targetBadge = hasTarget
                    ? '<div class="text-xs text-brand-400 flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg> ' + ${js('crm.audit_target')} + ' ' + p.target_price + '</div>'
                    : '';

                return '<div class="glass rounded-xl p-3 border border-gray-800/50 relative overflow-hidden">' +
                    '<div class="flex justify-between items-start mb-2">' +
                        '<div class="pe-6">' +
                            '<a href="https://www.amazon.eg/dp/' + asinEsc + '" target="_blank" class="font-medium text-sm text-brand-400 hover:underline block leading-tight">' + nameEsc + '</a>' +
                            '<div class="text-xs text-gray-500 mt-1 font-mono">' + asinEsc + '</div>' +
                        '</div>' +
                        '<span class="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase ' + statusColor + ' whitespace-nowrap">' + statusText + '</span>' +
                    '</div>' +
                    '<div class="flex justify-between items-end mb-3">' +
                        '<div class="text-sm font-semibold">' + price + '</div>' +
                        targetBadge +
                    '</div>' +
                    '<div class="flex gap-2">' +
                        '<button onclick="performAction(\\'' + actionType + '\\', \\'' + userIdEsc.replace(/'/g, "\\'") + '\\', {asin: \\'' + asinEsc.replace(/'/g, "\\'") + '\\'})" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 font-medium transition border border-gray-700/50">' + pauseIcon + ' ' + pauseLabel + '</button>' +
                        '<button onclick="openChartModal(\\'' + asinEsc.replace(/'/g, "\\'") + '\\')" class="flex-1 py-1.5 rounded bg-brand-500/10 hover:bg-brand-500/20 text-xs text-brand-400 font-medium transition border border-brand-500/20">📊 ' + ${js('crm.btn_chart')} + '</button>' +
                        '<button onclick="performAction(\\'delete_product\\', \\'' + userIdEsc.replace(/'/g, "\\'") + '\\', {asin: \\'' + asinEsc.replace(/'/g, "\\'") + '\\'})" class="flex-1 py-1.5 rounded bg-red-500/10 hover:bg-red-500/20 text-xs text-red-400 font-medium transition border border-red-500/20">🗑️ ' + ${js('crm.btn_delete_drawer')} + '</button>' +
                    '</div>' +
                '</div>';
            }).join('');
        }

        function closeDrawer() {
            const content = document.getElementById('drawer-content');
            content.style.transform = 'translateY(100%)';
            setTimeout(() => {
                document.getElementById('drawer').classList.add('hidden');
            }, 300);
        }

        // ── Top Charts Drawer ────────────────────────────────────────────────────

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

            const lang = document.documentElement.lang || 'en';
            let html = '';
            data.items.forEach((item, idx) => {
                const name = lang === 'masry' && item.name_ar ? escapeHtml(item.name_ar) : escapeHtml(item.name || item.asin);
                const price = item.amazon_price || item.new_price;
                const priceStr = price ? 'EGP ' + parseFloat(price).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '--';
                html += '<div class="bg-gray-800 rounded-lg p-3 flex items-center gap-3 cursor-pointer hover:bg-gray-700 transition" onclick="openChartModal(\\'' + escapeHtml(item.asin) + '\\')">';
                html += '<div class="text-lg font-bold text-gray-600 w-8 text-center">#' + (idx + 1) + '</div>';
                html += '<div class="flex-1 min-w-0">';
                html += '<div class="text-sm font-medium truncate">' + name + '</div>';
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
            const content = document.getElementById('drawer-top-charts-content');
            content.style.transform = 'translateY(100%)';
            setTimeout(() => { document.getElementById('drawer-top-charts').classList.add('hidden'); }, 300);
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
                document.getElementById('drawer-graveyard-count').innerText = '0 items';
                return;
            }

            document.getElementById('drawer-graveyard-count').innerText = data.items.length + ' items';

            const lang = document.documentElement.lang || 'en';
            let html = '';
            data.items.forEach(item => {
                const name = lang === 'masry' && item.name_ar ? escapeHtml(item.name_ar) : escapeHtml(item.name || item.asin);
                const isDelisted = item.delisted === 1;
                const allMissing = item.new_missing_since > 0 && item.used_missing_since > 0 && item.amazon_missing_since > 0;
                let reasonBadge = '';
                if (isDelisted) {
                    reasonBadge = '<span class="text-[10px] bg-red-900/30 text-red-400 px-1.5 py-0.5 rounded border border-red-800/50">' + ${js('crm.graveyard_delisted')} + '</span>';
                } else if (allMissing) {
                    reasonBadge = '<span class="text-[10px] bg-red-900/30 text-red-400 px-1.5 py-0.5 rounded border border-red-800/50">' + ${js('crm.graveyard_all_missing')} + '</span>';
                }
                const subsText = item.active_subs + ' ' + ${js('crm.graveyard_subs')};

                html += '<div class="bg-gray-800 rounded-lg p-3 flex items-start gap-3">';
                html += '<input type="checkbox" class="graveyard-checkbox mt-1 rounded bg-gray-700 border-gray-600 text-red-500 focus:ring-red-500" data-asin="' + escapeHtml(item.asin) + '">';
                html += '<div class="flex-1 min-w-0">';
                html += '<div class="text-sm font-medium truncate">' + name + '</div>';
                html += '<div class="text-xs text-gray-500 mt-0.5">' + escapeHtml(item.asin) + ' · ' + subsText + '</div>';
                html += '<div class="flex gap-1 mt-1">' + reasonBadge + '</div>';
                html += '</div></div>';
            });
            itemsCont.innerHTML = html;
        }

        function closeGraveyardDrawer() {
            const content = document.getElementById('drawer-graveyard-content');
            content.style.transform = 'translateY(100%)';
            setTimeout(() => { document.getElementById('drawer-graveyard').classList.add('hidden'); }, 300);
        }

        function toggleGraveyardSelectAll() {
            const checked = document.getElementById('graveyard-select-all').checked;
            document.querySelectorAll('.graveyard-checkbox').forEach(cb => { cb.checked = checked; });
        }

        async function purgeSelectedGhosts() {
            const checkboxes = document.querySelectorAll('.graveyard-checkbox:checked');
            if (checkboxes.length === 0) return showToast('Select at least one product to purge', 'error');

            const asins = Array.from(checkboxes).map(cb => cb.dataset.asin);

            if (!confirm(${js('crm.graveyard_purge_confirm')})) return;

            showLoader();
            const res = await fetchAPI('/graveyard/purge', 'POST', { asins });
            hideLoader();

            if (res && res.success) {
                showToast(${js('crm.graveyard_purged_ok', { count: 'REPLACE_COUNT' })}.replace('REPLACE_COUNT', res.purged), 'success');
                closeGraveyardDrawer();
                refreshData();
            } else {
                showToast('Purge failed: ' + (res?.error || 'Unknown error'), 'error');
            }
        }

        let crmChartInstance = null;

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

            document.getElementById('crmPriceChart').style.display = 'block';

            const labels = data.map(point => {
                const t = point.t !== undefined ? point.t : point.timestamp;
                const date = new Date(t * 1000);
                return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + 
                       date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            });
            
            const newPrices = data.map(point => point.n !== undefined ? point.n : (point.p !== undefined ? point.p : null));
            const usedPrices = data.map(point => point.u !== undefined ? point.u : null);

            const validPrices = newPrices.filter(p => p !== null);
            if (validPrices.length > 0) {
                const ath = Math.max(...validPrices);
                const atl = Math.min(...validPrices);
                const avg = Math.round(validPrices.reduce((sum, val) => sum + val, 0) / validPrices.length);
                
                document.getElementById('chart-ath').innerText = ath.toLocaleString() + ' EGP';
                document.getElementById('chart-atl').innerText = atl.toLocaleString() + ' EGP';
                document.getElementById('chart-avg').innerText = avg.toLocaleString() + ' EGP';
                document.getElementById('chart-metrics').style.display = 'flex';
            }

            const ctx = document.getElementById('crmPriceChart').getContext('2d');
            const lineColor = '#38bdf8';

            crmChartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
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
                                if (data[index] === null) return 0;
                                const prev = index > 0 ? data[index - 1] : null;
                                const next = index < data.length - 1 ? data[index + 1] : null;
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
                                if (data[index] === null) return 0;
                                const prev = index > 0 ? data[index - 1] : null;
                                const next = index < data.length - 1 ? data[index + 1] : null;
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
                        tooltip: { backgroundColor: 'rgba(31, 41, 55, 0.9)', titleColor: '#fff', bodyColor: '#fff' }
                    },
                    scales: {
                        x: { display: false },
                        y: { 
                            grid: { color: '#374151', drawBorder: false },
                            ticks: { color: '#9ca3af', callback: function(value) { return value.toLocaleString(); } }
                        }
                    }
                }
            });
        }

        async function performAction(action, targetId, data = null) {
            if (!targetId) targetId = "global";
            showLoader();
            const res = await fetchAPI('/action', 'POST', { action, targetId, data });
            hideLoader();
            
            if (res) {
                if (res.status === 'queued') {
                    showToast(${js('crm.toast_action_queued')}, "success");
                } else if (res.error === 'already_handled') {
                    // Another admin already processed this queue item
                    showToast(res.message || 'This request was already handled by another admin', 'warning');
                    refreshData(); // Auto-refresh to remove stale item
                } else {
                    showToast(${js('crm.toast_success')}, "success");
                    if(action.includes('_product')) {
                        openDrawer(targetId); // refresh drawer
                    }
                    refreshData(); // refresh background
                }
            }
        }

        function triggerGlobalScrape() {
            tg.showConfirm(${js('crm.force_check')} + "?", (ok) => {
                if(ok) performAction("force_scrape", null);
            });
        }

        function sendBroadcast() {
            const msg = document.getElementById('broadcast-msg').value.trim();
            if(!msg) return showToast(${js('crm.toast_msg_empty')}, "error");
            tg.showConfirm(${js('crm.send_broadcast')} + "?", (ok) => {
                if(ok) {
                    performAction("broadcast", null, { message: msg });
                    document.getElementById('broadcast-msg').value = '';
                }
            });
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

        function confirmRevoke(userId) {
            tg.showConfirm(${js('crm.btn_demote_drawer')} + " — " + userId + "?", (ok) => {
                if(ok) performAction('revoke', userId);
            });
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
            const bg = type === 'error' ? 'bg-red-500/90 border-red-500' : 'bg-gray-800 border-gray-700';
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

        // Init
        refreshData();
    </script>
</body>
</html>`;
}

