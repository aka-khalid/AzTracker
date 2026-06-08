// AzTracker Cloudflare ChatOps Router - GHOST INPUT INLINE GUI PRO
// Features: Auto-Deleting Text Inputs, Zero-Trace Callbacks, and Inline UI Editing


const GITHUB_BRANCH = "main";

const AMAZON_EG_MERCHANT_ID = "A1ZVRGNO5AYLOV";
const AMAZON_RESALE_MERCHANT_ID = "A2N2MP47XAP1MK";

const ALT_SELLER_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const QUEUE_MAX_DEPTH = 25;


import { AmazonEdgeParser, getAmazonAccessToken } from './src/api/amazon';

export default {
  async scheduled(event, env, ctx) {
    console.log("Cron tick:", event.cron);
    try {
      await executeScrapeEngine(env, false);
    } catch (e) {
      console.error("Scheduled execution failed:", e);
    }
  },

  async queue(batch, env, ctx) {
    let rateLimited = false;
    let retryDelay = 5;
    for (const msg of batch.messages) {
      if (rateLimited) {
        msg.retry({ delaySeconds: retryDelay });
        continue;
      }
      try {
        const payload = msg.body;
        if (payload.type === 'telegram_alert') {
          const res = await sendTelegram(env, payload.chatId, payload.text);
          if (res && !res.ok) {
            if (res.error_code === 429) {
              rateLimited = true;
              retryDelay = res.parameters?.retry_after || 5;
              msg.retry({ delaySeconds: retryDelay });
              continue;
            }
            throw new Error(res.description || "Telegram API Error");
          }
        }
        msg.ack();
      } catch (e) {
        console.error("Queue error:", e);
        msg.retry();
      }
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/scheduler") {
      return await handleScheduler(request, env, ctx);
    }
    
    if (url.pathname === "/scheduler/status" && request.method === "GET") {
      const providedKey = request.headers.get("x-scheduler-key");
      if (!env.CRON_AUTH_KEY || providedKey !== env.CRON_AUTH_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }
      
      const now = getCairoParts(new Date());
      const hourKey = `${now.year}-${now.month}-${now.day}-${now.hour}`;
      const scheduleReq = new Request(`${url.origin}/schedule/${hourKey}`);
      const circuitOpenReq = new Request(`${url.origin}/_internal/circuit/open`);
      const circuitAlertedReq = new Request(`${url.origin}/_internal/circuit/alerted`);
      
      const [cachedSchedule, isOpen, isAlerted] = await Promise.all([
        caches.default.match(scheduleReq),
        caches.default.match(circuitOpenReq),
        caches.default.match(circuitAlertedReq)
      ]);
      
      let slots = [];
      if (cachedSchedule) slots = await cachedSchedule.json();
      
      return new Response(JSON.stringify({
        circuit_state: isOpen ? "OPEN" : "CLOSED",
        alerted: !!isAlerted,
        hourly_slots: slots
      }), { status: 200, headers: { "Content-Type": "application/json" }});
    }
    
    if (url.pathname.startsWith("/api/history/") && request.method === "GET") {
      const asin = url.pathname.split("/").pop();
      if (!asin || asin.length < 10) {
        return new Response(JSON.stringify({ error: "Invalid ASIN" }), { status: 400 });
      }

      const exp = url.searchParams.get("exp");
      const sig = url.searchParams.get("sig");
      
      if (!exp || !sig || Date.now() > parseInt(exp)) {
        return new Response(JSON.stringify({ error: "Unauthorized or Expired Token" }), { status: 401 });
      }
      
      const expectedSig = await generateSignature(env.TELEGRAM_WEBHOOK_SECRET, asin, exp);
      if (sig !== expectedSig) {
        return new Response(JSON.stringify({ error: "Invalid Signature" }), { status: 401 });
      }

      const historyData = await env.AZTRACKER_DB.get(`history:${asin}`, "json") || [];
      
      return new Response(JSON.stringify(historyData), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    if (url.pathname.startsWith("/chart/") && request.method === "GET") {
      const asin = url.pathname.split("/").pop();
      if (!asin || !/^[A-Z0-9]{10}$/i.test(asin)) {
        return new Response("Invalid ASIN", { status: 400 });
      }
      const safeAsin = asin.toUpperCase();
      
      const exp = Date.now() + (2 * 60 * 60 * 1000); // 2-hour TTL
      const sig = await generateSignature(env.TELEGRAM_WEBHOOK_SECRET, safeAsin, exp);
      
      const html = renderChartHTML(safeAsin, exp, sig);
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html;charset=UTF-8" }
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

      const html = renderAuditHTML(exp, sig);
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
      return new Response(renderCrmHTML(), {
        status: 200,
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }

    if (url.pathname === "/api/crm/data" && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });

      const cacheUrl = new Request(`${url.origin}/_internal/crm/data`, request);
      const cache = caches.default;
      let response = await cache.match(cacheUrl);
      
      if (!response) {
        const [usersRes, totalProductsRes, lastUpdatedRes] = await Promise.all([
          env.DB.prepare(`
            SELECT u.*, COUNT(s.asin) as active_items 
            FROM Users u 
            LEFT JOIN User_Subscriptions s ON u.chat_id = s.chat_id AND s.is_paused = 0 
            GROUP BY u.chat_id
            ORDER BY u.created_at DESC
          `).all(),
          env.DB.prepare("SELECT COUNT(DISTINCT asin) as activeWatchPool FROM User_Subscriptions WHERE is_paused = 0").first(),
          env.DB.prepare("SELECT MAX(last_updated) as lastRunMs FROM Global_Products").first()
        ]);
        
        const rootAdminsRaw = env.TELEGRAM_ROOT_ADMIN_IDS || env.ROOT_ADMIN_ID || env.TELEGRAM_ADMIN_IDS || "";
        const rootAdmins = rootAdminsRaw.split(",").filter(Boolean).map(String);
        
        let mutableUsers = [];
        if (usersRes.results) {
            mutableUsers = usersRes.results.map(u => {
                const userClone = { ...u };
                const idStr = userClone.chat_id.toString();
                if (rootAdmins.includes(idStr)) {
                    userClone.role = 'root';
                }
                return userClone;
            });
        }
        
        const { results: queueResults } = await env.DB.prepare("SELECT * FROM Join_Queue ORDER BY requested_at DESC").all();
        const joinQueueRes = queueResults.map(q => ({
             id: q.chat_id,
             first_name: q.first_name,
             username: q.username,
             requested_at: q.requested_at,
             admin_messages: q.admin_messages ? JSON.parse(q.admin_messages) : {}
        }));
        
        const data = {
          systemStats: {
            totalUsers: mutableUsers.length,
            activeWatchPool: totalProductsRes ? totalProductsRes.activeWatchPool : 0,
            lastRunMs: lastUpdatedRes ? lastUpdatedRes.lastRunMs : null
          },
          joinQueue: joinQueueRes || [],
          users: mutableUsers
        };
        
        response = new Response(JSON.stringify(data), {
          status: 200,
          headers: { 
            "Content-Type": "application/json",
            "Cache-Control": "s-maxage=60" 
          }
        });
        ctx.waitUntil(cache.put(cacheUrl, response.clone()));
      }
      
      const clone = new Response(response.body, response);
      clone.headers.set("X-Current-User", auth.user.id.toString());
      return clone;
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
      
      if (action === "force_scrape") {
        ctx.waitUntil((async () => {
          try {
            await executeScrapeEngine(env, true);
            await sendTelegram(env, adminId, "✅ <b>Force Scrape Completed</b>\n\nThe background queue has successfully finished processing all items.");
            await logAudit(env, adminId, "FORCE_SCRAPE", "global", "Triggered global price check (Success)");
          } catch (error) {
            console.error("Scrape Engine Error:", error);
            await sendTelegram(env, adminId, `❌ <b>Force Scrape Failed</b>\n\nError: <code>${error.message}</code>`);
            await logAudit(env, adminId, "FORCE_SCRAPE", "global", `Triggered global price check (Failed: ${error.message})`);
          }
        })());
        return new Response(JSON.stringify({ success: true, status: "queued" }), { status: 202 });
      }
      
      if (action === "broadcast") {
        if (!auth.isRootAdmin) return new Response("Forbidden", { status: 403 });
        if (!data || !data.message) return new Response("Missing message", { status: 400 });
        
        ctx.waitUntil((async () => {
          const users = await env.DB.prepare("SELECT chat_id FROM Users WHERE role IN ('approved', 'admin')").all();
          for (const row of users.results) {
            await sendTelegram(env, row.chat_id, `📢 <b>Global Broadcast</b>\n\n${data.message}`);
          }
          await logAudit(env, adminId, "GLOBAL_BROADCAST", "all", "Sent global broadcast");
        })());
        return new Response(JSON.stringify({ success: true, status: "queued" }), { status: 202 });
      }
      
      if (action === "approve") {
        await env.DB.prepare("INSERT OR REPLACE INTO Users (chat_id, role, item_limit, approved_by, created_at) VALUES (?, 'approved', 5, ?, ?)").bind(targetId, adminId, Date.now()).run();
        await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();
        ctx.waitUntil(sendTelegram(env, targetId, "✅ <b>Your access request has been APPROVED!</b>\n\nYou can now use AzTracker. Send /start to begin."));
        ctx.waitUntil(logAudit(env, adminId, "APPROVE_USER", targetId, "Approved join request"));
          ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
          ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
        } else if (action === "reject") {
        await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();
        ctx.waitUntil(sendTelegram(env, targetId, "❌ <b>Your access request was REJECTED.</b>"));
        ctx.waitUntil(logAudit(env, adminId, "REJECT_USER", targetId, "Rejected join request"));
          ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
          ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
        } else if (action === "revoke") {
        if (targetId === adminId) return new Response("Cannot revoke yourself", { status: 400 });
        await env.DB.batch([
          env.DB.prepare("DELETE FROM User_Subscriptions WHERE chat_id = ?").bind(targetId),
          env.DB.prepare("UPDATE Users SET role = 'rejected' WHERE chat_id = ?").bind(targetId)
        ]);
        ctx.waitUntil(sendTelegram(env, targetId, "⛔ <b>Your access has been REVOKED.</b>"));
        ctx.waitUntil(logAudit(env, adminId, "REVOKE_USER", targetId, "Revoked user access and deleted subscriptions"));
      } else if (action === "unban") {
        await env.DB.prepare("UPDATE Users SET role = 'approved' WHERE chat_id = ?").bind(targetId).run();
        ctx.waitUntil(sendTelegram(env, targetId, "✅ <b>Your access has been RESTORED.</b>"));
        ctx.waitUntil(logAudit(env, adminId, "UNBAN_USER", targetId, "Unbanned user"));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
          ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
          ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
        } else if (action === "promote") {
        if (!auth.isRootAdmin) return new Response("Forbidden", { status: 403 });
        await env.DB.prepare("UPDATE Users SET role = 'admin' WHERE chat_id = ?").bind(targetId).run();
        ctx.waitUntil(sendTelegram(env, targetId, "👑 <b>You have been PROMOTED to Admin!</b>"));
        ctx.waitUntil(logAudit(env, adminId, "PROMOTE_ADMIN", targetId, "Promoted user to Admin"));
          ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
          ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
        } else if (action === "demote") {
        if (!auth.isRootAdmin) return new Response("Forbidden", { status: 403 });
        if (targetId === adminId) return new Response("Cannot demote yourself", { status: 400 });
        await env.DB.prepare("UPDATE Users SET role = 'approved' WHERE chat_id = ?").bind(targetId).run();
        ctx.waitUntil(sendTelegram(env, targetId, "🔽 <b>You have been DEMOTED to standard user.</b>"));
        ctx.waitUntil(logAudit(env, adminId, "DEMOTE_ADMIN", targetId, "Demoted Admin to standard user"));
          ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
          ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
        } else if (action === "set_limit") {
        const newLimit = parseInt(data.limit);
        if (isNaN(newLimit) || newLimit < 1) return new Response("Invalid limit", { status: 400 });
        await env.DB.prepare("UPDATE Users SET item_limit = ? WHERE chat_id = ?").bind(newLimit, targetId).run();
        ctx.waitUntil(sendTelegram(env, targetId, `📈 <b>Your tracking limit has been updated to ${newLimit} items.</b>`));
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
        await env.DB.prepare("UPDATE User_Subscriptions SET target_price = ? WHERE chat_id = ? AND asin = ?").bind(target, targetId, asin).run();
        ctx.waitUntil(logAudit(env, adminId, "SET_TARGET", targetId, `Set target price for ${asin} to ${target}`));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "direct_message") {
        if (!data || !data.message) return new Response("Missing message", { status: 400 });
        ctx.waitUntil(sendTelegram(env, targetId, `💬 <b>Message from Admin:</b>\n\n${data.message}`));
        ctx.waitUntil(logAudit(env, adminId, "DIRECT_MESSAGE", targetId, "Sent direct message"));
      } else {
        return new Response("Unknown action", { status: 400 });
      }
      
      ctx.waitUntil(caches.default.delete(new Request(`${url.origin}/_internal/crm/data`)));
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // ------------------------------------

    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    if (env.TELEGRAM_WEBHOOK_SECRET) {
      const secretToken = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secretToken !== env.TELEGRAM_WEBHOOK_SECRET) {
        console.warn("Unauthorized webhook attempt intercepted.");
        return new Response("Unauthorized", { status: 401 });
      }
    }

    try {
      const payload = await request.json();
      const baseUrl = url.origin; 
      
      if (payload.callback_query) {
        ctx.waitUntil(handleCallback(payload.callback_query, env, baseUrl, ctx)); 
      } else if (payload.message && payload.message.text) {
        ctx.waitUntil(handleMessage(payload.message, env, baseUrl, ctx));
      }
      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error(err);
      return new Response("OK", { status: 200 });
    }
  }
};

// ── Interceptors ────────────────────────────────────────────────────────────

async function executeScrapeEngine(env, force = false) {
  const query = force 
    ? "SELECT DISTINCT g.* FROM Global_Products g INNER JOIN User_Subscriptions u ON g.asin = u.asin WHERE u.is_paused = 0"
    : "SELECT DISTINCT g.* FROM Global_Products g INNER JOIN User_Subscriptions u ON g.asin = u.asin WHERE g.last_updated < ? AND u.is_paused = 0";
  const bindParams = force ? [] : [Date.now() - 300000];
  
  const { results: staleProducts } = await env.DB.prepare(query).bind(...bindParams).all();
  if (!staleProducts || staleProducts.length === 0) return;

  const clientId = env.AMAZON_CLIENT_ID || env.AMZN_CREATORS_ACCESS_KEY || env.AWS_ACCESS_KEY_ID;
  const clientSecret = env.AMAZON_CLIENT_SECRET || env.AMZN_CREATORS_SECRET_KEY || env.AWS_SECRET_ACCESS_KEY;
  
  let accessToken = await env.AZTRACKER_DB.get('amazon_access_token');
  if (!accessToken) {
    try {
      accessToken = await getAmazonAccessToken(clientId, clientSecret);
      await env.AZTRACKER_DB.put('amazon_access_token', accessToken, { expirationTtl: 3300 }); // 55 minutes
    } catch (e) {
      console.error("Failed to acquire Amazon Access Token:", e);
      if (force) throw e;
      return;
    }
  }

  const parser = new AmazonEdgeParser(accessToken, env.AMZN_ASSOCIATES_TAG);
  const asins = staleProducts.map(p => p.asin);
  
  let liveItems;
  try {
    liveItems = await parser.getItems(asins);
  } catch (error) {
    console.error("Creators API error in executeScrapeEngine:", error);
    if (force) throw error;
    return;
  }

  const d1Batch = [];
  const kvPromises = [];
  const queueBatch = [];
  const now = Date.now();
  
  // Pass 1: Handle Dead ASINs (404 Hole Fix)
  const liveAsins = new Set(liveItems.map(i => i.asin));
  const deadAsins = staleProducts.filter(p => !liveAsins.has(p.asin));
  for (const dead of deadAsins) {
      if (!dead.new_missing_since) dead.new_missing_since = now;
      if (!dead.used_missing_since) dead.used_missing_since = now;
      if (!dead.amazon_missing_since) dead.amazon_missing_since = now;
      
      const MS_24_HOURS = 86400000;
      if ((now - dead.new_missing_since > MS_24_HOURS) && 
          (now - dead.used_missing_since > MS_24_HOURS) && 
          (now - dead.amazon_missing_since > MS_24_HOURS)) {
        
        d1Batch.push(env.DB.prepare("UPDATE Global_Products SET delisted = 1, last_updated = ? WHERE asin = ?").bind(now, dead.asin));
        const { results: subs } = await env.DB.prepare("SELECT chat_id FROM User_Subscriptions WHERE asin = ? AND is_paused = 0").bind(dead.asin).all();
        d1Batch.push(env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 1 WHERE asin = ?").bind(dead.asin));
        for (const sub of subs) {
          queueBatch.push({
            type: 'telegram_alert',
            chatId: sub.chat_id,
            text: `🚨 <b>Item Missing!</b>\nASIN <code>${dead.asin}</code> has been Out of Stock for > 24 hours. Tracking paused automatically.`
          });
        }
      } else {
        d1Batch.push(env.DB.prepare("UPDATE Global_Products SET last_updated = ?, new_missing_since = ?, used_missing_since = ?, amazon_missing_since = ? WHERE asin = ?")
          .bind(now, dead.new_missing_since, dead.used_missing_since, dead.amazon_missing_since, dead.asin));
      }
  }

  // Pass 2: Handle Live Items
  for (const liveItem of liveItems) {
    const oldItem = staleProducts.find(p => p.asin === liveItem.asin);
    if (!oldItem) continue;

    let newMissingSince = oldItem.new_missing_since;
    let usedMissingSince = oldItem.used_missing_since;
    let amazonMissingSince = oldItem.amazon_missing_since;
    
    // Anti-Flap Timers (Fix: Only start if previously had a price)
    if (liveItem.newPrice === undefined || liveItem.newPrice === null) {
      if (!newMissingSince && oldItem.new_price !== null) newMissingSince = now;
    } else newMissingSince = null;
    
    if (liveItem.usedPrice === undefined || liveItem.usedPrice === null) {
      if (!usedMissingSince && oldItem.used_price !== null) usedMissingSince = now;
    } else usedMissingSince = null;

    if (liveItem.amazonPrice === undefined || liveItem.amazonPrice === null) {
      if (!amazonMissingSince && oldItem.amazon_price !== null) amazonMissingSince = now;
    } else amazonMissingSince = null;

    const MS_2_5_HOURS = 9000000;
    const MS_1_HOUR = 3600000;
    
    let finalNewPrice = (newMissingSince && (now - newMissingSince < MS_2_5_HOURS)) ? oldItem.new_price : (liveItem.newPrice ?? null);
    let finalUsedPrice = (usedMissingSince && (now - usedMissingSince < MS_2_5_HOURS)) ? oldItem.used_price : (liveItem.usedPrice ?? null);
    let finalAmazonPrice = (amazonMissingSince && (now - amazonMissingSince < MS_1_HOUR)) ? oldItem.amazon_price : (liveItem.amazonPrice ?? null);
    
    let finalNewSeller = (newMissingSince && (now - newMissingSince < MS_2_5_HOURS)) ? oldItem.new_seller : (liveItem.newSeller ?? null);
    let finalNewMid = (newMissingSince && (now - newMissingSince < MS_2_5_HOURS)) ? oldItem.new_mid : (liveItem.newMid ?? null);
    let finalUsedSeller = (usedMissingSince && (now - usedMissingSince < MS_2_5_HOURS)) ? oldItem.used_seller : (liveItem.usedSeller ?? null);
    let finalUsedMid = (usedMissingSince && (now - usedMissingSince < MS_2_5_HOURS)) ? oldItem.used_mid : (liveItem.usedMid ?? null);
    let finalAmazonSeller = (amazonMissingSince && (now - amazonMissingSince < MS_1_HOUR)) ? oldItem.amazon_seller : (liveItem.amazonSeller ?? null);
    let finalAmazonMid = (amazonMissingSince && (now - amazonMissingSince < MS_1_HOUR)) ? oldItem.amazon_mid : (liveItem.amazonMid ?? null);
    let finalAmazonIsBuybox = (amazonMissingSince && (now - amazonMissingSince < MS_1_HOUR)) ? oldItem.amazon_is_buybox : (liveItem.amazonIsBuybox ? 1 : 0);

    const MS_24_HOURS = 86400000;
    if (newMissingSince && (now - newMissingSince > MS_24_HOURS) && 
        usedMissingSince && (now - usedMissingSince > MS_24_HOURS) && 
        amazonMissingSince && (now - amazonMissingSince > MS_24_HOURS)) {
      d1Batch.push(env.DB.prepare("UPDATE Global_Products SET delisted = 1, last_updated = ? WHERE asin = ?").bind(now, liveItem.asin));
      
      const { results: subs } = await env.DB.prepare("SELECT chat_id FROM User_Subscriptions WHERE asin = ? AND is_paused = 0").bind(liveItem.asin).all();
      d1Batch.push(env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 1 WHERE asin = ?").bind(liveItem.asin));
      for (const sub of subs) {
        queueBatch.push({
          type: 'telegram_alert',
          chatId: sub.chat_id,
          text: `🚨 <b>Item Missing!</b>\nASIN <code>${liveItem.asin}</code> has been Out of Stock for > 24 hours. Tracking paused automatically.`
        });
      }
      continue;
    }

    const { results: subs } = await env.DB.prepare(
      "SELECT chat_id, target_price, alert_sent_new, alert_sent_used, added_at FROM User_Subscriptions WHERE asin = ? AND is_paused = 0"
    ).bind(liveItem.asin).all();

    let targetBypass = false;
    for (const sub of subs) {
      if (sub.target_price) {
        if (finalNewPrice !== null && oldItem.new_price !== null && oldItem.new_price > sub.target_price && finalNewPrice <= sub.target_price) targetBypass = true;
        if (finalUsedPrice !== null && oldItem.used_price !== null && oldItem.used_price > sub.target_price && finalUsedPrice <= sub.target_price) targetBypass = true;
        if (finalAmazonPrice !== null && oldItem.amazon_price !== null && oldItem.amazon_price > sub.target_price && finalAmazonPrice <= sub.target_price) targetBypass = true;
      }
    }

    // Debounce & Infinite Alert Loop Fix
    let amznChanged = oldItem.amazon_price === null || finalAmazonPrice === null 
      ? oldItem.amazon_price !== finalAmazonPrice 
      : Math.abs(oldItem.amazon_price - finalAmazonPrice) >= 1;

    let usedChanged = oldItem.used_price === null || finalUsedPrice === null 
      ? oldItem.used_price !== finalUsedPrice 
      : Math.abs(oldItem.used_price - finalUsedPrice) >= 1;

    let newChanged = oldItem.new_price === null || finalNewPrice === null 
      ? oldItem.new_price !== finalNewPrice 
      : Math.abs(oldItem.new_price - finalNewPrice) >= 1;

    if (!targetBypass) {
        if (!amznChanged && finalAmazonPrice !== null) finalAmazonPrice = oldItem.amazon_price;
        if (!usedChanged && finalUsedPrice !== null) finalUsedPrice = oldItem.used_price;
        if (!newChanged && finalNewPrice !== null) finalNewPrice = oldItem.new_price;
    } else {
        amznChanged = oldItem.amazon_price !== finalAmazonPrice;
        usedChanged = oldItem.used_price !== finalUsedPrice;
        newChanged = oldItem.new_price !== finalNewPrice;
    }

    const priceDelta = force || amznChanged || usedChanged || newChanged;

    let histMean = oldItem.hist_mean || 0;
    let histStdev = oldItem.hist_stdev || 0;
    let isAtlNew = oldItem.is_atl_new || 0;

    let vFlag = 0;
    if (finalNewPrice && histMean > 0) {
      // Math Denominator Fix
      const displayLastPrice = oldItem.new_price || histMean;
      const dropPct = ((displayLastPrice - finalNewPrice) / displayLastPrice) * 100;
      let zScore = 0;
      if (histStdev > 0) zScore = (finalNewPrice - histMean) / histStdev;
      else if (finalNewPrice <= histMean * 0.85) zScore = -1.5;
      
      const isStandardDeal = (zScore <= -1.5) && (dropPct >= 15.0);
      const isAtlDeal = isAtlNew && (zScore <= -1.0) && (dropPct >= 10.0);
      if (isStandardDeal || isAtlDeal) vFlag = 1;
      
      if (vFlag === 1 && env.TELEGRAM_PUBLIC_CHANNEL_ID) {
        const lastTime = oldItem.last_broadcast_time_ms || 0;
        const lastPrice = oldItem.last_broadcast_price || 0;
        const lockExpired = now - lastTime > 86400000;
        
        if (lockExpired || (lastPrice > 0 && finalNewPrice <= lastPrice * 0.90)) {
           queueBatch.push({
             type: 'telegram_alert',
             chatId: env.TELEGRAM_PUBLIC_CHANNEL_ID,
             text: `🔥 <b>DEAL ALERT!</b>\n📦 <b>${liveItem.name || liveItem.asin}</b>\n\n💰 Now: <b>${finalNewPrice} EGP</b> (🔽 ${dropPct.toFixed(1)}%)\n📉 Average: ${histMean.toFixed(1)} EGP\n\n🔗 <a href="https://www.amazon.eg/dp/${liveItem.asin}?tag=${env.AMAZON_PARTNER_TAG || env.AMZN_ASSOCIATES_TAG}">View on Amazon</a>`
           });
           
           d1Batch.push(env.DB.prepare("UPDATE Global_Products SET last_broadcast_time_ms = ?, last_broadcast_price = ? WHERE asin = ?").bind(now, finalNewPrice, liveItem.asin));
        }
      }
    }

    let seenAmazonEgAt = oldItem.seen_amazon_eg_at;
    let seenResaleAt = oldItem.seen_resale_at;
    if (finalAmazonPrice !== null) seenAmazonEgAt = now;
    if (finalUsedPrice !== null) seenResaleAt = now;

    let dbNeedsUpdate = false;

    if (priceDelta || targetBypass || newMissingSince !== oldItem.new_missing_since || usedMissingSince !== oldItem.used_missing_since || amazonMissingSince !== oldItem.amazon_missing_since) {
      d1Batch.push(
        env.DB.prepare(`
          UPDATE Global_Products 
          SET amazon_price = ?, used_price = ?, new_price = ?, last_updated = ?, 
              new_missing_since = ?, used_missing_since = ?, amazon_missing_since = ?,
              seen_amazon_eg_at = ?, seen_resale_at = ?,
              new_seller = ?, new_mid = ?, used_seller = ?, used_mid = ?,
              amazon_seller = ?, amazon_mid = ?, amazon_is_buybox = ?,
              hist_mean = ?, hist_stdev = ?, is_atl_new = ?
          WHERE asin = ?
        `).bind(
          finalAmazonPrice, finalUsedPrice, finalNewPrice, now, 
          newMissingSince, usedMissingSince, amazonMissingSince,
          seenAmazonEgAt, seenResaleAt,
          finalNewSeller, finalNewMid, finalUsedSeller, finalUsedMid,
          finalAmazonSeller, finalAmazonMid, finalAmazonIsBuybox,
          histMean, histStdev, isAtlNew,
          liveItem.asin
        )
      );
      dbNeedsUpdate = true;
    } else {
      d1Batch.push(
        env.DB.prepare(`
          UPDATE Global_Products SET last_updated = ? WHERE asin = ?
        `).bind(now, liveItem.asin)
      );
    }
      
    if (dbNeedsUpdate && (amznChanged || newChanged || usedChanged)) {
      const historyKey = `history:${liveItem.asin}`;
      let history = await env.AZTRACKER_DB.get(historyKey, "json") || [];
      
      const nPrice = finalAmazonPrice !== null ? finalAmazonPrice : finalNewPrice;
      history.push({ t: Math.floor(now / 1000), n: nPrice, u: finalUsedPrice });
      
      if (history.length > 500) history = history.slice(-500);
      kvPromises.push(env.AZTRACKER_DB.put(historyKey, JSON.stringify(history)));

      const globalKey = "global:history_all_new";
      let globalHist = await env.AZTRACKER_DB.get(globalKey, "json") || [];
      const currentMatrix = {};
      if (finalNewPrice !== null) currentMatrix[liveItem.asin] = [finalNewPrice, vFlag];
      
      if (Object.keys(currentMatrix).length > 0) {
          globalHist.push({t: Math.floor(now / 1000), p: currentMatrix});
          if (globalHist.length > 150) globalHist = globalHist.slice(-150);
          kvPromises.push(env.AZTRACKER_DB.put(globalKey, JSON.stringify(globalHist)));
      }
      
      // Update Z-Score Math in background loosely 
      if (history.length >= 10) {
         const newPrices = history.map(h => h.n).filter(n => n !== null);
         if (newPrices.length > 0) {
             const sum = newPrices.reduce((a, b) => a + b, 0);
             const mean = sum / newPrices.length;
             const variance = newPrices.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / newPrices.length;
             const stdev = Math.sqrt(variance);
             const atl = Math.min(...newPrices);
             histMean = mean;
             histStdev = stdev;
             isAtlNew = (finalNewPrice && finalNewPrice <= atl) ? 1 : 0;
             // Push an extra delayed update for the statistics
             d1Batch.push(env.DB.prepare("UPDATE Global_Products SET hist_mean = ?, hist_stdev = ?, is_atl_new = ? WHERE asin = ?").bind(histMean, histStdev, isAtlNew, liveItem.asin));
         }
      }
    }
      
    const MS_90_DAYS = 7776000000; // 90 * 24 * 60 * 60 * 1000
    for (const sub of subs) {
      if (sub.added_at && (now - sub.added_at > MS_90_DAYS)) {
        d1Batch.push(env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 1 WHERE chat_id = ? AND asin = ?").bind(sub.chat_id, liveItem.asin));
        queueBatch.push({ type: 'telegram_alert', chatId: sub.chat_id, text: `⏰ <b>Tracking Expired</b>\nASIN <code>${liveItem.asin}</code> has been tracked for over 90 days. Tracking paused automatically to save limits.\n\nSend /manage to review your items.` });
        continue;
      }

      let alertSentNew = sub.alert_sent_new;
      let alertSentUsed = sub.alert_sent_used;
      
      const isNewDrop = finalNewPrice !== null && (sub.target_price ? finalNewPrice <= sub.target_price : (oldItem.new_price === null || finalNewPrice < oldItem.new_price));
      const isUsedDrop = finalUsedPrice !== null && (sub.target_price ? finalUsedPrice <= sub.target_price : (oldItem.used_price === null || finalUsedPrice < oldItem.used_price));
      const isAmznDrop = finalAmazonPrice !== null && (sub.target_price ? finalAmazonPrice <= sub.target_price : (oldItem.amazon_price === null || finalAmazonPrice < oldItem.amazon_price));

      if (isNewDrop || isAmznDrop) {
        if (!alertSentNew || oldItem.new_price === null || finalNewPrice < oldItem.new_price) {
          alertSentNew = 1;
          const dropPct = oldItem.new_price ? Math.round(((oldItem.new_price - finalNewPrice) / oldItem.new_price) * 100) : 0;
          const pctStr = dropPct > 0 ? ` (🔽 ${dropPct}%)` : '';
          let text = `🚨 <b>Price Drop!</b>\n📦 <b>${liveItem.name || liveItem.asin}</b>\n\n`;
          text += `💰 Now: <b>${finalNewPrice} EGP</b>${pctStr}\n`;
          if (oldItem.new_price) text += `📉 Was: ${oldItem.new_price} EGP\n`;
          if (finalAmazonPrice !== null) text += `🛡️ Condition: New (Amazon)\n`;
          else text += `⭐ Condition: New (3rd Party)\n`;
          
          let otherOptions = [];
          if (finalUsedPrice !== null) otherOptions.push(`└ 📦 Amazon Resale: <b>${finalUsedPrice} EGP</b> (Used)`);
          else if (seenResaleAt && (now - seenResaleAt < 1209600000)) otherOptions.push(`└ 📦 Amazon Resale <i>(Check Stock)</i>`);
          
          if (otherOptions.length > 0) text += `\n💡 <b>Other Options:</b>\n` + otherOptions.join('\n');

          queueBatch.push({ type: 'telegram_alert', chatId: sub.chat_id, text });
        }
      } else if (finalNewPrice && sub.target_price && finalNewPrice > sub.target_price) {
        alertSentNew = 0;
      }

      if (isUsedDrop) {
        if (!alertSentUsed || oldItem.used_price === null || finalUsedPrice < oldItem.used_price) {
          alertSentUsed = 1;
          const dropPct = oldItem.used_price ? Math.round(((oldItem.used_price - finalUsedPrice) / oldItem.used_price) * 100) : 0;
          const pctStr = dropPct > 0 ? ` (🔽 ${dropPct}%)` : '';
          let text = `🚨 <b>Used Price Drop!</b>\n📦 <b>${liveItem.name || liveItem.asin}</b>\n\n`;
          text += `💰 Now: <b>${finalUsedPrice} EGP</b>${pctStr}\n`;
          if (oldItem.used_price) text += `📉 Was: ${oldItem.used_price} EGP\n`;
          text += `⭐ Condition: Used\n`;
          
          let otherOptions = [];
          if (finalAmazonPrice !== null) otherOptions.push(`└ 🛡️ Amazon.eg: <b>${finalAmazonPrice} EGP</b>`);
          else if (seenAmazonEgAt && (now - seenAmazonEgAt < 1209600000)) otherOptions.push(`└ 🛡️ Amazon.eg <i>(Check Stock)</i>`);
          else if (finalNewPrice !== null) otherOptions.push(`└ ⭐ New (3rd Party): <b>${finalNewPrice} EGP</b>`);
          
          if (otherOptions.length > 0) text += `\n💡 <b>Other Options:</b>\n` + otherOptions.join('\n');

          queueBatch.push({ type: 'telegram_alert', chatId: sub.chat_id, text });
        }
      } else if (finalUsedPrice && sub.target_price && finalUsedPrice > sub.target_price) {
        alertSentUsed = 0;
      }

      if (alertSentNew !== sub.alert_sent_new || alertSentUsed !== sub.alert_sent_used) {
        d1Batch.push(env.DB.prepare("UPDATE User_Subscriptions SET alert_sent_new = ?, alert_sent_used = ? WHERE chat_id = ? AND asin = ?").bind(alertSentNew, alertSentUsed, sub.chat_id, liveItem.asin));
      }
    }
  }

  if (d1Batch.length > 0) {
    for (let i = 0; i < d1Batch.length; i += 100) {
      await env.DB.batch(d1Batch.slice(i, i + 100));
    }
  }
  if (kvPromises.length > 0) {
    await Promise.all(kvPromises);
  }
  
  if (queueBatch.length > 0) {
    const userMessages = {};
    for (const msg of queueBatch) {
      if (!userMessages[msg.chatId]) userMessages[msg.chatId] = [];
      userMessages[msg.chatId].push(msg.text);
    }

    const consolidatedBatch = [];
    for (const chatId in userMessages) {
      let combinedText = userMessages[chatId][0];
      for (let i = 1; i < userMessages[chatId].length; i++) {
        const nextText = userMessages[chatId][i];
        if (combinedText.length + nextText.length + 4 > 4000) {
          consolidatedBatch.push({ type: 'telegram_alert', chatId, text: combinedText });
          combinedText = nextText;
        } else {
          combinedText += "\n\n" + nextText;
        }
      }
      if (combinedText) {
        consolidatedBatch.push({ type: 'telegram_alert', chatId, text: combinedText });
      }
    }

    for (let i = 0; i < consolidatedBatch.length; i += 100) {
      const batchBody = consolidatedBatch.slice(i, i + 100).map(b => ({ body: b }));
      await env.MESSAGE_QUEUE.sendBatch(batchBody);
    }
  }
}

async function handleMessage(message, env, baseUrl, ctx) {
  const text = convertHindiToArabic(message.text).trim();
  const chatId = message.chat.id.toString();
  const messageId = message.message_id;

  const { isRootAdmin, isAdmin, isApproved, isRejected, rootAdmins, admins, approvedUsers } = await getUserRoles(chatId, env, ctx);
  if (ctx && ctx.waitUntil) ctx.waitUntil(syncUserNames(env, chatId, message.from, baseUrl));

  if (!isApproved) {
    if (isRejected) {
      await sendAppMessage(env, chatId, `⛔ <b>Access Denied</b>\n\nYour request to join this server has been explicitly rejected by an administrator.`);
      return;
    }
    const inQueue = await env.DB.prepare("SELECT 1 FROM Join_Queue WHERE chat_id = ?").bind(chatId).first() !== null;

    if (inQueue) {
      await sendAppMessage(env, chatId, `⏳ <b>Request Pending</b>\n\nYour application is currently under review by an administrator. Please wait.`);
      return;
    }
    
    if (text === "/start") {
      await sendAppMessage(env, chatId, `⛔ <b>Access Denied</b>\n\nThis is a private Amazon deals server. You are not authorized to use it.`, {
        inline_keyboard: [[{ text: "✋ Request Access", callback_data: `request_access_${chatId}` }]]
      });
    } else {
      await sendAppMessage(env, chatId, `⛔ <b>Access Denied</b>\n\nThis is a private Amazon deals server. You are not authorized to use it.\n\nSend /start to request access.`);
    }
    return;
  }

  const stateKey = `state:${chatId}`;
  const activeState = await env.AZTRACKER_DB.get(stateKey);
  
  // --- OVERRIDE BLOCK ---
  if (text === "/start" || text === "/manage") {
    if (activeState) await env.AZTRACKER_DB.delete(stateKey);
    await deleteTelegramMessage(env, chatId, messageId);
    
    if (text === "/manage" && isAdmin) {
      await sendAppMessage(env, chatId, `👑 <b>AzTracker Command Center</b>\n\nClick below to launch the secure Serverless Web App.`, {
        inline_keyboard: [
          [{ text: "🚀 Launch Command Center", web_app: { url: `${baseUrl}/crm` } }],
          [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
        ]
      });
      return;
    }
    
    await renderMainMenu(env, chatId, null, isAdmin, baseUrl);
    return;
  } else if (text.startsWith('/')) {
    if (activeState) await env.AZTRACKER_DB.delete(stateKey);
    await deleteTelegramMessage(env, chatId, messageId);
    return;
  }

  // -------------------------------


  
  if (activeState) {    const pid = activeState;
    const num = parseFloat(text);
    
    if (isNaN(num) || num <= 0) {
      await deleteTelegramMessage(env, chatId, messageId);
      await sendAppMessage(env, chatId, "⚠️ <b>Invalid amount.</b> Please enter a valid number.", {
        inline_keyboard: [[{ text: "⬅️ Back", callback_data: `view_${pid}` }]]
      });
      return;
    }

    await env.DB.prepare("UPDATE User_Subscriptions SET target_price = ? WHERE chat_id = ? AND asin = ?").bind(num, chatId, pid).run();
    
    await env.AZTRACKER_DB.delete(stateKey);
    await deleteTelegramMessage(env, chatId, messageId);
    
    await sendAppMessage(env, chatId, `🎯 <b>Target Price Set!</b>\n\nYou will only be notified when ASIN <code>${pid}</code> drops to or below <b>${num.toLocaleString()} EGP</b>.`, {
      inline_keyboard: [[{ text: "⬅️ Back to Product", callback_data: `view_${pid}` }]]
    });
    return;
  }

  const isNumericId = /^\d{6,15}$/.test(text);
  const isAmazonLink = text.includes("amazon.") || text.includes("amzn.");

  if (isNumericId || isAmazonLink) {
    await deleteTelegramMessage(env, chatId, messageId);
  }



  if (isAmazonLink) {
    // Isolate the link from surrounding text and auto-prepend protocol if missing
    let inputUrl = text.split(/\s+/).find(w => w.includes("amazon.") || w.includes("amzn.")) || text;
    if (!/^https?:\/\//i.test(inputUrl)) {
      inputUrl = "https://" + inputUrl;
    }

    const sentMsg = await sendAppMessage(env, chatId, `⏳ <b>Processing Amazon link...</b>`);
    const tempMessageId = sentMsg.result.message_id;

    const expandedUrl = await expandAmazonUrl(inputUrl);
    
    const domainMatch = expandedUrl.match(/https?:\/\/(?:www\.)?(amazon\.[a-z\.]+)/i);
    const productDomain = domainMatch ? domainMatch[1].toLowerCase() : null;
    const SUPPORTED_REGIONS = ['amazon.eg'];

    if (!productDomain || !SUPPORTED_REGIONS.includes(productDomain)) {
      await editTelegramMessage(env, chatId, tempMessageId, `❌ <b>Region Not Supported</b>\n\nCurrently, we only support <code>amazon.eg</code>.`, {
        inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "main_menu" }]]
      });
      return;
    }

    const pid = getAsinFromUrl(expandedUrl);
    
    if (!pid) {
      await editTelegramMessage(env, chatId, tempMessageId, "❌ <b>Could not parse a valid 10-digit ASIN.</b>", {
        inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "main_menu" }]]
      });
      return;
    }
    
    const user = await env.DB.prepare("SELECT item_limit FROM Users WHERE chat_id = ?").bind(chatId).first();
    const defaultLimit = parseInt(env.DEFAULT_USER_PRODUCT_LIMIT);
    const userLimit = user && user.item_limit !== null ? parseInt(user.item_limit) : defaultLimit;

    const { results: existingProducts } = await env.DB.prepare("SELECT asin FROM User_Subscriptions WHERE chat_id = ?").bind(chatId).all();

    if (!isAdmin) {
      if (isNaN(defaultLimit)) {
        await editTelegramMessage(env, chatId, tempMessageId, `⚠️ <b>System Error:</b> Global item limit is unconfigured. Please contact an admin.`, {
          inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "main_menu" }]]
        });
        return;
      }

      if (existingProducts && existingProducts.length >= userLimit) {
        await editTelegramMessage(env, chatId, tempMessageId, `⛔ <b>Limit Reached</b>\n\nYou have saved ${existingProducts.length} items, but your current limit is ${userLimit}.\n\nPlease delete some products to free up space before adding new ones.`, {
          inline_keyboard: [
            [{ text: "📦 Manage My Products", callback_data: "list_products_0" }],
            [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
          ]
        });
        return;
      }
    }
    
    if (existingProducts && existingProducts.some(p => p.asin === pid)) {
      await editTelegramMessage(env, chatId, tempMessageId, "⚠️ <b>You have already saved this product!</b>", {
        inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "main_menu" }]]
      });
      return;
    }

    const extractedName = extractNameFromUrl(expandedUrl);
    
    // Insert into Global_Products to track price globally
    await env.DB.prepare(`
      INSERT INTO Global_Products (asin, name, last_updated)
      VALUES (?, ?, 0)
      ON CONFLICT(asin) DO UPDATE SET name = excluded.name
    `).bind(pid, extractedName || pid).run();

    // Insert into User_Subscriptions
    await env.DB.prepare(`
      INSERT INTO User_Subscriptions (chat_id, asin, added_at)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_id, asin) DO NOTHING
    `).bind(chatId, pid, Date.now()).run();
    if (ctx && ctx.waitUntil) ctx.waitUntil(logAudit(env, chatId, "ADD_PRODUCT", chatId, `Added product ${pid}`));
    if (ctx && ctx.waitUntil) ctx.waitUntil(logAudit(env, chatId, "ADD_PRODUCT", chatId, `Added product ${pid}`));


    const title = extractedName ? extractedName : pid;
    const cleanTitle = escapeHtml(title.length > 35 ? title.substring(0, 32) + "..." : title);
    
    const successText = `✅ <b>Product Registered!</b>\n\n` +
                    `📌 <b>${cleanTitle}</b>\n` +
                    `🆔 ASIN: <code>${pid}</code>\n\n` +
                    `<i>This item is now saved. It will pull the live price during the next automated check.</i>\n\n` +
                    `🕐 <b>Status:</b> ⏳ Pending initial scan...\n\n#ad`;
    await editTelegramMessage(env, chatId, tempMessageId, successText, {
      inline_keyboard: [
        [{ text: "📦 View My Products", callback_data: "list_products_0" }],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    });
    return;
  }


  await deleteTelegramMessage(env, chatId, messageId);
  await sendAppMessage(env, chatId, "⚠️ <b>Invalid Command or Input Structure</b>\n\nPlease use the interactive options below or drop a valid Amazon item link.", {
    inline_keyboard: [[{ text: "🏠 Open Main Menu", callback_data: "main_menu" }]]
  });
}

async function handleCallback(callback, env, baseUrl, ctx) {
  const data = callback.data;
  const message = callback.message;
  const chatId = message.chat.id.toString();
  const messageId = message.message_id;

  const { isRootAdmin, isAdmin, isApproved, rootAdmins, admins, approvedUsers } = await getUserRoles(chatId, env, ctx);
  if (ctx && ctx.waitUntil) ctx.waitUntil(syncUserNames(env, chatId, callback.from, baseUrl));

  if (!isApproved && !data.startsWith("request_access_")) return;



  try {
    if (data.startsWith("request_access_")) {
      const targetId = data.replace("request_access_", "");
      if (targetId !== chatId) return; 

      const inQueue = await env.DB.prepare("SELECT 1 FROM Join_Queue WHERE chat_id = ?").bind(chatId).first() !== null;
      if (inQueue) {
        await editTelegramMessage(env, chatId, messageId, `⏳ <b>Request Sent.</b>\n\nPlease wait for an administrator to review your application.`);
        return; // SEVERS THE BROADCAST LOOP FOR DUPLICATE CLICKS
      }

      const countRow = await env.DB.prepare("SELECT COUNT(*) as count FROM Join_Queue").first();
      if (countRow.count >= QUEUE_MAX_DEPTH) {
        await editTelegramMessage(env, chatId, messageId, `⚠️ <b>Queue Full</b>\n\nThe access queue is currently full. Please try again in 24 hours.`);
        return;
      }

      await editTelegramMessage(env, chatId, messageId, `⏳ <b>Request Sent.</b>\n\nPlease wait for an administrator to review your application.`);

      const { label } = await resolveUserProfile(env, chatId, ctx);
      const adminMsg = `🔔 <b>New Access Request</b>\n\n👤 <b>Name:</b> ${escapeHtml(label)}\n🆔 <b>ID:</b> <code>${chatId}</code>\n\n<i>This user is requesting authorization to access the server.</i>`;
      const adminButtons = {
        inline_keyboard: [
          [{ text: "✅ Approve", callback_data: `queueApprove_${chatId}` }, { text: "❌ Reject", callback_data: `queueReject_${chatId}` }]
        ]
      };

      const allAdmins = [...new Set([...admins, ...rootAdmins])];
      let admin_messages = {};
      for (const adminId of allAdmins) {
        try {
          const sent = await sendTelegram(env, adminId, adminMsg, adminButtons);
          if (sent && sent.ok && sent.result) {
              admin_messages[adminId] = sent.result.message_id;
          }
        } catch(e) { console.error("Failed to notify admin", adminId); }
      }

      await env.DB.prepare("INSERT INTO Join_Queue (chat_id, first_name, username, requested_at, admin_messages) VALUES (?, ?, ?, ?, ?)").bind(
          chatId, 
          callback.from ? callback.from.first_name : '', 
          callback.from ? callback.from.username : '', 
          Date.now(), 
          JSON.stringify(admin_messages)
      ).run();
    }
    else if (data.startsWith("queueReject_") && isAdmin) {
      const targetId = data.replace("queueReject_", "");
      let queueObj = await env.DB.prepare("SELECT * FROM Join_Queue WHERE chat_id = ?").bind(targetId).first();
      if (!queueObj) {
        await editTelegramMessage(env, chatId, messageId, `⚠️ <b>Request Expired or Handled</b>\nThis application is no longer in the pending queue.`);
        return;
      }
      if (typeof queueObj.admin_messages === 'string') {
        try { queueObj.admin_messages = JSON.parse(queueObj.admin_messages); } catch(e) { queueObj.admin_messages = {}; }
      }
      await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();
      
      const { label: adminName } = await resolveUserProfile(env, chatId, ctx);
      await editTelegramMessage(env, chatId, messageId, `🚫 <b>Request Rejected</b>\nUser <code>${targetId}</code> has been denied access by ${escapeHtml(adminName)}.`);
      
      if (queueObj && queueObj.admin_messages) {
          for (const [admId, msgId] of Object.entries(queueObj.admin_messages)) {
              if (admId !== chatId) {
                 ctx.waitUntil(editTelegramMessage(env, admId, msgId, `🚫 <b>Request Handled</b>\nUser <code>${targetId}</code> was rejected by ${escapeHtml(adminName)}.`, { inline_keyboard: [] }));
              }
          }
      }
      
      await env.DB.prepare(`
         INSERT INTO Users (chat_id, first_name, username, role, approved_by, item_limit, created_at)
         VALUES (?, ?, ?, 'rejected', ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET role = 'rejected'
      `).bind(
        targetId, 
        queueObj ? (queueObj.first_name || '') : '', 
        queueObj ? (queueObj.username || '') : '', 
        chatId, 
        env.DEFAULT_USER_PRODUCT_LIMIT || "3", 
        Date.now()
      ).run();
      ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));

      await sendTelegram(env, targetId, `⛔ <b>Access Request Denied</b>\n\nYour request to join the server has been declined by an administrator.`);
      
      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "REJECT_USER", targetId, "Rejected via Join Queue"));
    }
    else if (data.startsWith("queueApprove_") && isAdmin) {
      const targetId = data.replace("queueApprove_", "");
      let queueObj = await env.DB.prepare("SELECT * FROM Join_Queue WHERE chat_id = ?").bind(targetId).first();
      if (!queueObj) {
        await editTelegramMessage(env, chatId, messageId, `⚠️ <b>Request Expired or Handled</b>\nThis application is no longer in the pending queue.`);
        return;
      }
      if (typeof queueObj.admin_messages === 'string') {
        try { queueObj.admin_messages = JSON.parse(queueObj.admin_messages); } catch(e) { queueObj.admin_messages = {}; }
      }
      await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();
      
      await env.DB.prepare(`
         INSERT INTO Users (chat_id, first_name, username, role, approved_by, item_limit, created_at)
         VALUES (?, ?, ?, 'approved', ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET role = 'approved', approved_by = excluded.approved_by
      `).bind(
        targetId, 
        queueObj ? (queueObj.first_name || '') : '', 
        queueObj ? (queueObj.username || '') : '', 
        chatId, 
        env.DEFAULT_USER_PRODUCT_LIMIT || "3", 
        Date.now()
      ).run();
      ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      
      const { label: adminName } = await resolveUserProfile(env, chatId, ctx);
      await editTelegramMessage(env, chatId, messageId, `✅ <b>Approved!</b>\nUser <code>${targetId}</code> was approved by ${escapeHtml(adminName)}.`);

      if (queueObj && queueObj.admin_messages) {
          for (const [admId, msgId] of Object.entries(queueObj.admin_messages)) {
              if (admId !== chatId) {
                 ctx.waitUntil(editTelegramMessage(env, admId, msgId, `✅ <b>Request Handled</b>\nUser <code>${targetId}</code> was approved by ${escapeHtml(adminName)}.`, { inline_keyboard: [] }));
              }
          }
      }
      
      const defaultLimit = env.DEFAULT_USER_PRODUCT_LIMIT || "3";
      const welcomeMessage = `🎉 <b>You have been approved! Welcome!</b>\n\nHere is a quick step-by-step guide on how to let the bot do the heavy lifting for your Amazon.eg shopping.\n\n<b>1️⃣ Find your item</b>\nOpen the Amazon app or website and find the product you want to buy.\n\n<b>2️⃣ Share the link</b>\nThe easiest way: In the Amazon app, hit the <b>Share</b> button, select Telegram, and send it directly to this bot! (You can also just copy and paste the link into the chat).\n\n<b>3️⃣ Set a Target Price (Optional)</b>\nIf you only want alerts for a specific price, click the <i>🎯 Set Target</i> button after adding your item. The bot will stay quiet until the price drops to or below your exact target!\n\n<b>4️⃣ Relax & Wait</b>\nThe bot will continuously monitor the market in the background. It will automatically notify you of major price drops, restocks, and even cheaper Amazon Resale (Used) alternatives.\n\n<b>5️⃣ The Item Limit</b>\nTo keep the servers from catching fire, everyone starts with a limit of <b>${defaultLimit}</b> saved items. If you desperately need to save more, you'll have to secretly bribe whichever admin invited you (coffee and a good shawarma usually do the trick 😉).\n\n<i>💡 Pro-Tip: You can always click "📦 My Products" from the Main Menu to view beautiful price history charts for your items or pause checking on things you've already bought.</i>\n\nHappy shopping! 🛒\n\n<i>"As an Amazon Associate I earn from qualifying purchases."</i>`;
      
      await sendTelegram(env, targetId, welcomeMessage);
      
      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "APPROVE_USER", targetId, "Approved via Join Queue"));
    }
    else if (data.startsWith("confRevoke_") && isAdmin) {
      const targetId = data.replace("confRevoke_", "");
      if (rootAdmins.includes(targetId) || (admins.includes(targetId) && !isRootAdmin)) return;
      const text = `⚠️ <b>Confirm Revocation</b>\n\nAre you sure you want to permanently revoke ID <code>${targetId}</code>?\n\n<i>Their entire saved list will be erased. This cannot be undone.</i>`;
      await editTelegramMessage(env, chatId, messageId, text, {
        inline_keyboard: [
          [{ text: "✅ Yes, Revoke", callback_data: `revoke_${targetId}` }],
          [{ text: "❌ Cancel", callback_data: `manage_user_${targetId}` }]
        ]
      });
    }
    else if (data.startsWith("confDemote_") && isRootAdmin) {
      const targetId = data.replace("confDemote_", "");
      const text = `⚠️ <b>Confirm Demotion</b>\n\nAre you sure you want to strip Admin privileges from ID <code>${targetId}</code>?`;
      await editTelegramMessage(env, chatId, messageId, text, {
        inline_keyboard: [
          [{ text: "✅ Yes, Demote", callback_data: `demote_${targetId}` }],
          [{ text: "❌ Cancel", callback_data: `manage_user_${targetId}` }]
        ]
      });
    }
    else if (data.startsWith("confPromote_") && isRootAdmin) {
      const targetId = data.replace("confPromote_", "");
      const text = `⚠️ <b>Confirm Promotion</b>\n\nAre you sure you want to grant full Admin privileges to ID <code>${targetId}</code>?`;
      await editTelegramMessage(env, chatId, messageId, text, {
        inline_keyboard: [
          [{ text: "✅ Yes, Promote", callback_data: `promote_${targetId}` }],
          [{ text: "❌ Cancel", callback_data: `manage_user_${targetId}` }]
        ]
      });
    }
    else if (data.startsWith("confClearTgt_")) {
      const pid = data.replace("confClearTgt_", "");
      const text = `⚠️ <b>Confirm Target Removal</b>\n\nAre you sure you want to clear the target price for ASIN <code>${pid}</code>?`;
      await editTelegramMessage(env, chatId, messageId, text, {
        inline_keyboard: [
          [{ text: "✅ Yes, Clear Target", callback_data: `cleartarget_${pid}` }],
          [{ text: "❌ Cancel", callback_data: `view_${pid}` }]
        ]
      });
    }
    else if (data.startsWith("reject_") && isAdmin) {
      const targetId = data.replace("reject_", "");
      
      await env.DB.prepare(`
         INSERT INTO Users (chat_id, role, approved_by, item_limit, created_at)
         VALUES (?, 'rejected', ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET role = 'rejected'
      `).bind(targetId, chatId, env.DEFAULT_USER_PRODUCT_LIMIT || "3", Date.now()).run();
      ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      
      await editTelegramMessage(env, chatId, messageId, `🚫 <b>Request Rejected</b>\nUser <code>${targetId}</code> has been explicitly denied access.`);
      await sendTelegram(env, targetId, `⛔ <b>Access Request Denied</b>\n\nYour request to join the server has been declined by an administrator.`);
      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "REJECT_USER", targetId, "Manually rejected access"));
    }
    else if (data.startsWith("unban_") && isAdmin) {
      const targetId = data.replace("unban_", "");
      
      await env.DB.prepare("DELETE FROM Users WHERE chat_id = ? AND role = 'rejected'").bind(targetId).run();
      ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      
      await editTelegramMessage(env, chatId, messageId, `🔄 <b>User Unbanned</b>\nUser <code>${targetId}</code> has been removed from the Banned Directory. They can now send /start to request access again if they wish.`, {
        inline_keyboard: [[{ text: "⬅️ Back to Directory", callback_data: "admin_panel" }]]
      });
      
      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "UNBAN_USER", targetId, "Removed from banned directory"));
    }
    else if (data.startsWith("approve_") && isAdmin) {
      const targetId = data.replace("approve_", "");
      await env.DB.prepare("INSERT INTO Users (chat_id, role, approved_by, item_limit, created_at) VALUES (?, 'approved', ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET role = 'approved', approved_by = excluded.approved_by").bind(targetId, chatId, env.DEFAULT_USER_PRODUCT_LIMIT || "3", Date.now()).run();
      ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      await editTelegramMessage(env, chatId, messageId, `✅ <b>Approved!</b>\nUser <code>${targetId}</code> can now use the Amazon deals application.`);
      
      const defaultLimit = env.DEFAULT_USER_PRODUCT_LIMIT || "3";
      const welcomeMessage = `🎉 <b>You have been approved! Welcome!</b>\n\nHere is a quick step-by-step guide on how to let the bot do the heavy lifting for your Amazon.eg shopping.\n\n<b>1️⃣ Find your item</b>\nOpen the Amazon app or website and find the product you want to buy.\n\n<b>2️⃣ Share the link</b>\nThe easiest way: In the Amazon app, hit the <b>Share</b> button, select Telegram, and send it directly to this bot! (You can also just copy and paste the link into the chat).\n\n<b>3️⃣ Set a Target Price (Optional)</b>\nIf you only want alerts for a specific price, click the <i>🎯 Set Target</i> button after adding your item. The bot will stay quiet until the price drops to or below your exact target!\n\n<b>4️⃣ Relax & Wait</b>\nThe bot will continuously monitor the market in the background. It will automatically notify you of major price drops, restocks, and even cheaper Amazon Resale (Used) alternatives.\n\n<b>5️⃣ The Item Limit</b>\nTo keep the servers from catching fire, everyone starts with a limit of <b>${defaultLimit}</b> saved items. If you desperately need to save more, you'll have to secretly bribe whichever admin invited you (coffee and a good shawarma usually do the trick 😉).\n\n<i>💡 Pro-Tip: You can always click "📦 My Products" from the Main Menu to view beautiful price history charts for your items or pause checking on things you've already bought.</i>\n\nHappy shopping! 🛒\n\n<i>"As an Amazon Associate I earn from qualifying purchases."</i>`;
      
      await sendTelegram(env, targetId, welcomeMessage);
      
      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "APPROVE_USER", targetId, "Manually approved"));
    }
    else if (data.startsWith("revoke_") && isAdmin) {
      const targetId = data.replace("revoke_", "");
      
      // Security Boundary 1: Prevent revoking immutable Root Admins
      if (rootAdmins.includes(targetId)) return;
      
      // Security Boundary 2: Standard Admins cannot revoke other Admins
      const targetRoles = await getUserRoles(targetId, env, ctx);
        if (targetRoles.isRootAdmin || (targetRoles.isAdmin && !isRootAdmin)) return;


      
      await env.DB.prepare("DELETE FROM Users WHERE chat_id = ?").bind(targetId).run();
      ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      
      await editTelegramMessage(env, chatId, messageId, `🗑️ <b>Revoked & Purged!</b>\nID <code>${targetId}</code> and their entire saved list have been permanently erased.`);
      
      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "REVOKE_USER", targetId, "Revoked access and purged profile"));
    }
    else if (data.startsWith("promote_") && isRootAdmin) {
      const targetId = data.replace("promote_", "");
      await env.DB.prepare("UPDATE Users SET role = 'admin' WHERE chat_id = ?").bind(targetId).run();
      
      // CRITICAL FIX: Bust the edge cache for both the caller and the target
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${chatId}`)));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      }
      
      await editTelegramMessage(env, chatId, messageId, `🌟 <b>Promoted!</b>\nID <code>${targetId}</code> has been elevated to Admin privileges.`, {
        inline_keyboard: [[{ text: "⬅️ Back to Directory", callback_data: "admin_panel" }]]
      });
      await sendTelegram(env, targetId, `🌟 <b>You have been promoted to Admin!</b>\nYou now have authorization to approve users. Run /start to see the admin features.`);
      
      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "PROMOTE_ADMIN", targetId, "Elevated to full Admin privileges"));
    }
    else if (data.startsWith("demote_") && isRootAdmin) {
      const targetId = data.replace("demote_", "");
      await env.DB.prepare("UPDATE Users SET role = 'approved' WHERE chat_id = ?").bind(targetId).run();
      
      // CRITICAL FIX: Bust the edge cache for both the caller and the target
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${chatId}`)));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      }
      
      await editTelegramMessage(env, chatId, messageId, `🔽 <b>Demoted.</b>\nID <code>${targetId}</code> has returned to standard access tier.`, {
        inline_keyboard: [[{ text: "⬅️ Back to Directory", callback_data: "admin_panel" }]]
      });
      
      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "DEMOTE_ADMIN", targetId, "Demoted to standard access tier"));
    }
    else if (data === "main_menu") {
      await env.AZTRACKER_DB.delete(`state:${chatId}`);
      await renderMainMenu(env, chatId, messageId, isAdmin, baseUrl);
    }
    else if (data.startsWith("list_products_")) {
      await env.AZTRACKER_DB.delete(`state:${chatId}`);
      const page = parseInt(data.replace("list_products_", "")) || 0;
      await renderProductList(env, chatId, messageId, page);
    }
    else if (data === "ignore") {
      return;
    }


    else if (data === "help_add") {
      const text = `💡 <b>How to Add a Product:</b>\n\nCopy any Amazon.eg product link from your browser or app and paste it directly into this chat box as a message.\n\n📱 <b>Short links shared directly from the mobile app are fully supported!</b>`;
      await editTelegramMessage(env, chatId, messageId, text, {
        inline_keyboard: [[{ text: "⬅️ Back", callback_data: "main_menu" }]]
      });
    }
    else if (data.startsWith("settarget_")) {
      const pid = data.replace("settarget_", "");
      await env.AZTRACKER_DB.put(`state:${chatId}`, pid, { expirationTtl: 300 });
      const text = `🎯 <b>Set Target Price</b>\n\nASIN: <code>${pid}</code>\n\nPlease type your desired maximum price in EGP as a message (e.g., <code>4500</code>).`;
      await editTelegramMessage(env, chatId, messageId, text, {
        inline_keyboard: [[{ text: "❌ Cancel", callback_data: `view_${pid}` }]]
      });
    }
    else if (data.startsWith("cleartarget_")) {
      const pid = data.replace("cleartarget_", "");
      await env.DB.prepare("UPDATE User_Subscriptions SET target_price = NULL WHERE chat_id = ? AND asin = ?").bind(chatId, pid).run();
      if (ctx && ctx.waitUntil) ctx.waitUntil(logAudit(env, chatId, "CLEAR_TARGET", chatId, `Cleared target price for ${pid}`));
      await renderProductView(env, chatId, messageId, pid, baseUrl);
    }
    else if (data.startsWith("view_")) {
      const pid = data.replace("view_", "");
      await env.AZTRACKER_DB.delete(`state:${chatId}`); 
      await renderProductView(env, chatId, messageId, pid, baseUrl);
    }
    else if (data.startsWith("pause_") || data.startsWith("resume_")) {
      const action = data.split("_")[0];
      const pid = data.split("_")[1];

      const isPaused = action === "pause" ? 1 : 0;
      await env.DB.prepare("UPDATE User_Subscriptions SET is_paused = ? WHERE chat_id = ? AND asin = ?").bind(isPaused, chatId, pid).run();

      await renderProductView(env, chatId, messageId, pid, baseUrl);
    }
    else if (data.startsWith("confirmDel_")) {
      const pid = data.replace("confirmDel_", "");
      const text = `⚠️ <b>Confirm Deletion</b>\n\nAre you sure you want to permanently delete ASIN <code>${pid}</code> from your saved list?\n\n<i>This action cannot be undone.</i>`;
      
      await editTelegramMessage(env, chatId, messageId, text, {
        inline_keyboard: [
          [{ text: "✅ Yes, Delete", callback_data: `remove_${pid}` }],
          [{ text: "❌ Cancel", callback_data: `view_${pid}` }]
        ]
      });
    }
    else if (data.startsWith("confirmDel_")) {
      const pid = data.replace("confirmDel_", "");
      const text = `⚠️ <b>Confirm Deletion</b>\\n\\nAre you sure you want to permanently delete ASIN <code>${pid}</code> from your saved list?\\n\\n<i>This action cannot be undone.</i>`;
      
      await editTelegramMessage(env, chatId, messageId, text, {
        inline_keyboard: [
          [{ text: "✅ Yes, Delete", callback_data: `remove_${pid}` }],
          [{ text: "❌ Cancel", callback_data: `view_${pid}` }]
        ]
      });
    }
    else if (data.startsWith("remove_")) {
      const pid = data.replace("remove_", "");
      
      await env.DB.prepare("DELETE FROM User_Subscriptions WHERE chat_id = ? AND asin = ?").bind(chatId, pid).run();
      if (ctx && ctx.waitUntil) ctx.waitUntil(logAudit(env, chatId, "DELETE_PRODUCT", chatId, `Deleted product ${pid}`));
      
      await editTelegramMessage(env, chatId, messageId, `🗑️ <b>Product Deleted</b>\n\nASIN <code>${pid}</code> has been completely removed from your active register.`, {
        inline_keyboard: [[{ text: "⬅️ Back to Products", callback_data: "list_products_0" }]]
      });
    }
  } finally {
    // Global Callback Resolution: Deferred to the end to maintain biological UI locking (spinner)
    ctx.waitUntil(
      fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callback.id })
      }).catch(e => console.error("answerCallbackQuery failed", e))
    );
  }
}

// ── UI Renderers ────────────────────────────────────────────────────────────



async function renderMainMenu(env, chatId, messageId = null, isAdmin = false, baseUrl = "") {

  const [stats, userRow] = await Promise.all([
      env.DB.prepare(`
        SELECT COUNT(*) as total, SUM(CASE WHEN is_paused = 0 THEN 1 ELSE 0 END) as active 
        FROM User_Subscriptions WHERE chat_id = ?
      `).bind(chatId).first(),
      env.DB.prepare("SELECT item_limit FROM Users WHERE chat_id = ?").bind(chatId).first()
  ]);

  let limitText = "∞";

  if (!isAdmin) {
    const defaultLimit = parseInt(env.DEFAULT_USER_PRODUCT_LIMIT);
    if (!isNaN(defaultLimit)) {
        limitText = userRow && userRow.item_limit !== null ? parseInt(userRow.item_limit) : defaultLimit;
    } else {
        limitText = "⚠️ Error";
    }
  }

  const total = stats?.total || 0;
  const active = stats?.active || 0;
  const paused = total - active;

  const text = `🏠 <b>Deals Dashboard</b>\n\n📦 <b>Your Saved Items:</b> ${total} / ${limitText}\n⚡ <b>Active:</b> ${active} | ⏸️ <b>Paused:</b> ${paused}\n\n<i>Select an operative option below:</i>`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "📦 My Products", callback_data: "list_products_0" }],
      [{ text: "➕ How to Add Products", callback_data: "help_add" }]
    ]
  };

  if (isAdmin) {
    keyboard.inline_keyboard.push([{ text: "👑 Admin Panel", web_app: { url: `${baseUrl}/crm` } }]);
  }

  if (messageId) {
    await editTelegramMessage(env, chatId, messageId, text, keyboard);
  } else {
    await sendAppMessage(env, chatId, text, keyboard);
  }
}

async function renderProductList(env, chatId, messageId, page = 0) {
  const { results: products } = await env.DB.prepare(
    `SELECT s.asin, s.is_paused, s.target_price, p.name 
     FROM User_Subscriptions s 
     JOIN Global_Products p ON s.asin = p.asin 
     WHERE s.chat_id = ?`
  ).bind(chatId).all();
  
  if (!products || products.length === 0) {
    const text = `❌ <b>Your saved list is empty.</b>\n\nPaste an Amazon.eg link in the chat box to add it to your list.`;
    const keyboard = { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "main_menu" }]] };
    await editTelegramMessage(env, chatId, messageId, text, keyboard);
    return;
  }

  const ITEMS_PER_PAGE = 5;
  const totalPages = Math.ceil(products.length / ITEMS_PER_PAGE);
  if (page >= totalPages) page = Math.max(0, totalPages - 1);

  const pagedProducts = products.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);
  
  const keyboard = { inline_keyboard: [] };
  
  pagedProducts.forEach((p) => {
    let name = p.name ? p.name : p.asin;
    if (name.length > 30) name = name.substring(0, 27) + "...";
    
    const statusIcon = p.is_paused ? "⏸️" : "✅";
    const targetIcon = p.target_price ? "🎯 " : "";
    keyboard.inline_keyboard.push([{ text: `${statusIcon} ${targetIcon}${name}`, callback_data: `view_${p.asin}` }]);
  });

  if (totalPages > 1) {
    let navRow = [];
    if (page > 0) {
      navRow.push({ text: "⬅️ Prev", callback_data: `list_products_${page - 1}` });
    }
    navRow.push({ text: `📄 ${page + 1}/${totalPages}`, callback_data: "ignore" });
    if (page < totalPages - 1) {
      navRow.push({ text: "Next ➡️", callback_data: `list_products_${page + 1}` });
    }
    keyboard.inline_keyboard.push(navRow);
  }

  keyboard.inline_keyboard.push([{ text: "🏠 Main Menu", callback_data: "main_menu" }]);

  const text = `📦 <b>My Saved Products</b> (Page ${page + 1} of ${totalPages})\n\n<i>Select an item below to modify its checking parameters:</i>`;
  await editTelegramMessage(env, chatId, messageId, text, keyboard);
}

async function renderProductView(env, chatId, messageId, pid, baseUrl) {
  const product = await env.DB.prepare(
    `SELECT s.asin, s.is_paused as paused, s.target_price, p.name as name, 
            p.amazon_price, p.used_price, p.new_price, p.last_updated 
     FROM User_Subscriptions s 
     JOIN Global_Products p ON s.asin = p.asin 
     WHERE s.chat_id = ? AND s.asin = ?`
  ).bind(chatId, pid).first();

  if (!product) return;
  const prices = { [pid]: { new_price: product.amazon_price, used_price: product.used_price, name: product.name } };

  const statusStr = product.paused ? "⏸️ Paused" : "✅ Active";
  let lastPrice = "⏳ Waiting for next automated check...";
  let lastUpdated = ""; 
  let sellerInfo = "";
  let smartAlts = "";
  let title = product.name ? product.name : "Amazon Product";

  const { last_updated: systemCheckTime } = await env.DB.prepare("SELECT MAX(last_updated) as last_updated FROM Global_Products").first() || { last_updated: null };

  if (prices[pid]) {
    if (typeof prices[pid] === 'object') {
      let pData = prices[pid];
      let newPrice = pData.new_price !== undefined ? pData.new_price : pData.price;
      let newSeller = pData.new_seller || pData.seller;
      let usedPrice = pData.used_price;

      if (newPrice !== undefined && newPrice !== null) {
        lastPrice = newPrice.toLocaleString() + " EGP";
        if (newSeller) sellerInfo = `\n🏬 <b>Seller:</b> <i>${escapeHtml(newSeller)}</i>`;
      } else if (usedPrice !== undefined && usedPrice !== null) {
        lastPrice = "❌ Out of Stock (New)";
        sellerInfo = "";
      } else {
        lastPrice = "❌ Out of Stock";
        sellerInfo = "";
      }

      if (pData.name) title = pData.name;

      smartAlts = buildSmartAlternatives(pData, pid, env);
    } else {
      lastPrice = prices[pid].toLocaleString() + " EGP";
    }
  }

  if (systemCheckTime) {
    const dateObj = new Date(systemCheckTime);
    const checkDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(dateObj); 
    const checkTime = dateObj.toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo", hour: '2-digit', minute:'2-digit' });
    const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());

    if (checkDate === todayStr) {
      lastUpdated = ` <i>(Checked: Today at ${checkTime})</i>`;
    } else {
      lastUpdated = ` <i>(Checked: ${checkDate} ${checkTime})</i>`;
    }
  }

  const cleanTitle = escapeHtml(title.length > 35 ? title.substring(0, 32) + "..." : title);
  let targetText = product.target_price ? `\n🎯 <b>Target:</b> ${product.target_price.toLocaleString()} EGP` : "";

  let productUrl = `https://www.amazon.eg/dp/${pid}`;
  const priceRecord = prices[pid] && typeof prices[pid] === "object" ? prices[pid] : {};
  const recordNewPrice = priceRecord.new_price !== undefined ? priceRecord.new_price : priceRecord.price;
  const hasNewOffer = recordNewPrice !== undefined && recordNewPrice !== null;
  const hasUsedOffer = priceRecord.used_price !== undefined && priceRecord.used_price !== null;
  const callbackMerchant = pid.includes(":") ? pid.split(":")[1] : null;
  const targetMerchant = hasNewOffer
    ? (priceRecord.new_mid || priceRecord.merchant_id || callbackMerchant)
    : hasUsedOffer
      ? (priceRecord.used_mid || callbackMerchant)
      : callbackMerchant;

  const queryParams = new URLSearchParams();
  if (targetMerchant) queryParams.set("m", targetMerchant);
  const partnerTag = env.AMAZON_PARTNER_TAG || env.AMZN_ASSOCIATES_TAG;
  if (partnerTag) queryParams.set("tag", partnerTag);
  const queryString = queryParams.toString();
  if (queryString) productUrl += `?${queryString}`;

  const text = `📦 <b>${cleanTitle}</b>\n` +
               `└ 🆔 <code>${pid}</code>\n\n` +
               `💰 <b>Price:</b> ${lastPrice}` +
               `${targetText}` +
               `${sellerInfo}` +
               `${smartAlts}\n\n` +
               `📡 <b>Status:</b> ${statusStr}${lastUpdated}\n\n#ad`;

  const targetBtn = product.target_price 
    ? { text: "❌ Clear Target", callback_data: `confClearTgt_${pid}` }
    : { text: "🎯 Set Target", callback_data: `settarget_${pid}` };

    const keyboard = {
    inline_keyboard: [
      [{ text: "🛒 Open in Amazon.eg", url: productUrl }],
      [{ text: product.paused ? "▶️ Resume Checking" : "⏸️ Pause Checking", callback_data: `${product.paused ? "resume" : "pause"}_${pid}` }],
      [
        targetBtn,
        { text: "📊 Stats & History", web_app: { url: `${baseUrl}/chart/${pid}` } }
      ],
      [
        { text: "🗑️ Delete Product", callback_data: `confirmDel_${pid}` }
      ],
      [
        { text: "⬅️ Back to Products", callback_data: "list_products_0" },
        { text: "🏠 Main Menu", callback_data: "main_menu" }
      ]
    ]
  };

  await editTelegramMessage(env, chatId, messageId, text, keyboard);
}


// ── Scheduler Endpoint ──────────────────────────────────────────────────────

async function handleScheduler(request, env, ctx) {
  const url = new URL(request.url);
  const providedKey = request.headers.get("x-scheduler-key");

  if (!env.CRON_AUTH_KEY || providedKey !== env.CRON_AUTH_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = getCairoParts(new Date());
  const hourKey = `${now.year}-${now.month}-${now.day}-${now.hour}`;
  const currentMinute = parseInt(now.minute, 10);

  const cache = caches.default;
  const scheduleReq = new Request(`${url.origin}/schedule/${hourKey}`);
  const lockReq = new Request(`${url.origin}/lock/${hourKey}/${currentMinute}`); 
  const circuitOpenReq = new Request(`${url.origin}/_internal/circuit/open`);
  const circuitAlertedReq = new Request(`${url.origin}/_internal/circuit/alerted`);

  if (await cache.match(circuitOpenReq)) {
    return new Response("Circuit OPEN: Temporarily rejecting pings.", { status: 503 });
  }

  if (await cache.match(lockReq)) {
    return new Response("Already executed", { status: 200 });
  }
  let slots = [];
  const cachedSchedule = await cache.match(scheduleReq);
  
  if (cachedSchedule) {
    slots = await cachedSchedule.json();
  } else {
    slots = buildHourlySlots();
    const res = new Response(JSON.stringify(slots), {
      headers: { "Cache-Control": "s-maxage=3600", "Content-Type": "application/json" }
    });
    ctx.waitUntil(cache.put(scheduleReq, res));
  }

  if (slots.includes(currentMinute)) {
    try {
      const runRes = await triggerWorkflow(env);
      
      if (runRes.ok) {
        if (await cache.match(circuitAlertedReq)) {
           const rootAdmin = env.TELEGRAM_ROOT_ADMIN_IDS ? env.TELEGRAM_ROOT_ADMIN_IDS.split(',')[0] : null;
           if (rootAdmin) ctx.waitUntil(sendTelegram(env, rootAdmin, "✅ <b>System Recovered</b>\n\nGitHub Actions API is back online. Circuit closed."));
           ctx.waitUntil(cache.delete(circuitAlertedReq));
        }
        const lockRes = new Response("1", { headers: { "Cache-Control": "s-maxage=3600" } });
        ctx.waitUntil(cache.put(lockReq, lockRes));
        return new Response(`Workflow triggered at minute ${currentMinute}`, { status: 200 });
      } else {
        const openRes = new Response("OPEN", { headers: { "Cache-Control": "s-maxage=900" } }); 
        ctx.waitUntil(cache.put(circuitOpenReq, openRes));
        
        if (!(await cache.match(circuitAlertedReq))) {
           const alertRes = new Response("ALERTED", { headers: { "Cache-Control": "s-maxage=7200" } }); 
           ctx.waitUntil(cache.put(circuitAlertedReq, alertRes));
           const rootAdmin = env.TELEGRAM_ROOT_ADMIN_IDS ? env.TELEGRAM_ROOT_ADMIN_IDS.split(',')[0] : null;
           if (rootAdmin) {
             ctx.waitUntil(sendTelegram(env, rootAdmin, `🚨 <b>GitHub Actions Outage</b>\n\nAPI returned status ${runRes.status}. Circuit breaker is now OPEN for 15 minutes.`));
           }
        }
        return new Response(`Trigger failed: Status ${runRes.status}`, { status: 502 });
      }
    } catch (e) {
      return new Response(`Execution error: ${e.message}`, { status: 500 });
    }
  }
  return new Response(`No run this minute (${currentMinute})`, { status: 200 });
}

function buildHourlySlots() {
  // Sliced into 12 buckets (5 minutes each)
  const bounds = [
    [0, 4], [5, 9], [10, 14], [15, 19],
    [20, 24], [25, 29], [30, 34], [35, 39],
    [40, 44], [45, 49], [50, 54], [55, 59]
  ];
  
  const runMinutes = [];

  for (let i = 0; i < bounds.length; i++) {
    let min = bounds[i][0];
    const max = bounds[i][1];

    if (i > 0) {
      const prevRun = runMinutes[i - 1];
      // 2-minute safety buffer to prevent GH Actions concurrency collisions
      if (min - prevRun < 2) {
        min = prevRun + 2;
      }
    }

    if (min > max) min = max;
    runMinutes.push(randInt(min, max));
  }

  return runMinutes;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getCairoParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }

  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
  };
}

// ── Core Helpers ────────────────────────────────────────────────────────────

function escapeHtml(unsafe) {
    if (!unsafe) return "";
    return String(unsafe).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

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

function toPrice(value) {
  if (value === undefined || value === null || value === "") return null;
  const price = Number(value);
  return Number.isFinite(price) ? price : null;
}

function buildProductUrl(pid, env, merchantId = null) {
  const cleanPid = pid.includes(":") ? pid.split(":")[0] : pid;
  let productUrl = `https://www.amazon.eg/dp/${cleanPid}`;
  const queryParams = new URLSearchParams();
  if (merchantId) queryParams.set("m", merchantId);
  const partnerTag = env.AMAZON_PARTNER_TAG || env.AMZN_ASSOCIATES_TAG;
  if (partnerTag) queryParams.set("tag", partnerTag);
  const queryString = queryParams.toString();
  if (queryString) productUrl += `?${queryString}`;
  return productUrl;
}

function buildSmartAlternatives(pData, pid, env) {
  const now = Date.now();
  const amazonSeenRecently = pData.seen_amazon_eg_at && (now - pData.seen_amazon_eg_at) < ALT_SELLER_TTL_MS;
  const resaleSeenRecently = pData.seen_resale_at && (now - pData.seen_resale_at) < ALT_SELLER_TTL_MS;

  const newMid = pData.new_mid || pData.merchant_id || null;
  const currentSellerIsAmazon = newMid === AMAZON_EG_MERCHANT_ID;
  const currentSellerIsResale = newMid === AMAZON_RESALE_MERCHANT_ID;

  const amazonPrice = toPrice(pData.amazon_price);
  const usedPrice = toPrice(pData.used_price);

  const historicalLinks = [];

  // Amazon.eg Link
  if (!currentSellerIsAmazon) {
    const amazonEgUrl = buildProductUrl(pid, env, AMAZON_EG_MERCHANT_ID);
    if (amazonPrice !== null) {
      historicalLinks.push(`└ 🛡️ <a href="${escapeHtml(amazonEgUrl)}">Amazon.eg</a>: <b>${amazonPrice.toLocaleString()} EGP</b>`);
    } else if (amazonSeenRecently) {
      historicalLinks.push(`└ 🛡️ <a href="${escapeHtml(amazonEgUrl)}">Amazon.eg</a> <i>(Check Stock)</i>`);
    }
  }
  
  // Amazon Resale Link
  if (!currentSellerIsResale) {
    const resaleUrl = buildProductUrl(pid, env, AMAZON_RESALE_MERCHANT_ID);
    if (usedPrice !== null) {
      historicalLinks.push(`└ 📦 <a href="${escapeHtml(resaleUrl)}">Amazon Resale</a>: <b>${usedPrice.toLocaleString()} EGP</b> <i>(Used)</i>`);
    } else if (resaleSeenRecently) {
      historicalLinks.push(`└ 📦 <a href="${escapeHtml(resaleUrl)}">Amazon Resale</a> <i>(Check Stock)</i>`);
    }
  }

  // Render the clean block
  if (historicalLinks.length > 0) {
    return `\n\n💡 <b>Other Options:</b>\n${historicalLinks.join("\n")}`;
  }
  
  return "";
}

function convertHindiToArabic(text) {
  if (!text) return "";
  const hindiToAr = { '٠':'0', '١':'1', '٢':'2', '٣':'3', '٤':'4', '٥':'5', '٦':'6', '٧':'7', '٨':'8', '٩':'9' };
  return text.replace(/[٠-٩]/g, match => hindiToAr[match]);
}

// 💥 THE VULNERABILITY FIX 💥
// Retains monolithic array backwards compatibility to fix UI crashes 
// while introducing Cache-Busting fallback to fix the TOCTOU overwrite race condition.
async function getUserRoles(chatId, env, ctx) {
  const cache = caches.default;
  const cacheReq = new Request(`https://auth.internal/user/${chatId}`);
  
  let roles;
  const cached = await cache.match(cacheReq);
  
  if (cached) {
    roles = await cached.json();
    
    // CACHE BUSTING: Fixes the 60s trap vulnerability.
    if (!roles.isApproved) {
      const user = await env.DB.prepare("SELECT role FROM Users WHERE chat_id = ?").bind(chatId).first();
      if (user) {
        const freshRole = user.role;
        if (freshRole === "admin" || freshRole === "approved") {
          roles.isApproved = true;
          if (freshRole === "admin") roles.isAdmin = true;
        } else if (freshRole === "rejected") {
          roles.isRejected = true;
        }
        
        if (ctx && ctx.waitUntil) {
          ctx.waitUntil(cache.put(cacheReq, new Response(JSON.stringify(roles), {
            headers: { "Cache-Control": "s-maxage=60", "Content-Type": "application/json" }
          })));
        }
      }
    }
  } else {
    const rootAdminsRaw = env.TELEGRAM_ROOT_ADMIN_IDS || env.ROOT_ADMIN_ID || env.TELEGRAM_ADMIN_IDS || "";
    const rootAdmins = rootAdminsRaw.split(",").filter(Boolean);
    let isRootAdmin = rootAdmins.includes(chatId);
    
    // Query D1 instead of KV for global arrays
    const { results: adminRows } = await env.DB.prepare("SELECT chat_id FROM Users WHERE role = 'admin' ORDER BY created_at ASC").all();
    const admins = adminRows.map(r => r.chat_id);
    
    const { results: approvedRows } = await env.DB.prepare("SELECT chat_id FROM Users WHERE role IN ('approved', 'admin')").all();
    const approvedUsers = approvedRows.map(r => r.chat_id);
    
    const user = await env.DB.prepare("SELECT role FROM Users WHERE chat_id = ?").bind(chatId).first();
    let role = user ? user.role : null;
    
    if (!isRootAdmin && rootAdmins.length === 0 && admins.length > 0 && admins[0] === chatId) {
        isRootAdmin = true;
    }

    const isAdmin = isRootAdmin || role === "admin" || admins.includes(chatId);
    const isApproved = isAdmin || role === "approved" || approvedUsers.includes(chatId);
    const isRejected = role === "rejected";

    // Provide exactly the object shape the UI needs, preventing Promise.all array crashes.
    roles = { isRootAdmin, isAdmin, isApproved, isRejected, rootAdmins, admins, approvedUsers };
    
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(cache.put(cacheReq, new Response(JSON.stringify(roles), {
        headers: { "Cache-Control": "s-maxage=60", "Content-Type": "application/json" }
      })));
    }
  }
  
  return roles;
}

async function resolveUserProfile(env, id, ctx) {
  const cache = caches.default;
  // Use a synthetic internal URL as the cache key
  const cacheReq = new Request(`https://profile.internal/user/${id}`);

  const cached = await cache.match(cacheReq);
  if (cached) {
    const data = await cached.json();
    return { id, label: data.label, handle: data.handle };
  }

  try {
    // GET request enables native Cloudflare Edge caching
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChat?chat_id=${id}`);
    const data = await res.json();

    if (data.ok && data.result) {
      const profile = data.result;
      const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(" ");
      const handle = profile.username ? `@${profile.username}` : null;
      const formatName = handle ? `${fullName} (${handle})` : fullName;
      const label = formatName || id;

      // Cache the resolved name for 24 hours (86400 seconds)
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(cache.put(cacheReq, new Response(JSON.stringify({ label, handle }), {
          headers: { "Cache-Control": "s-maxage=86400", "Content-Type": "application/json" }
        })));
      }

      return { id, label, handle };
    }
  } catch (e) {
    console.error(`Failed to fetch chat profile for ID ${id}:`, e);
  }
  return { id, label: `Unknown User (${id})`, handle: null };
}

async function syncUserNames(env, chatId, from, baseUrl) {
  if (!from) return;
  const first = from.first_name || null;
  const user = from.username || null;
  try {
    const res = await env.DB.prepare(`
      UPDATE Users 
      SET first_name = ?, username = ? 
      WHERE chat_id = ? 
      AND (first_name IS NOT ? OR username IS NOT ?)
    `).bind(first, user, chatId, first, user).run();
    
    if (res && res.meta && res.meta.changes > 0) {
       await caches.default.delete(new Request(`https://profile.internal/user/${chatId}`));
       if (baseUrl) {
         await caches.default.delete(new Request(`${baseUrl}/_internal/crm/data`));
       }
    }
  } catch (e) {
    console.error("Name sync error:", e);
  }
}

async function deleteTelegramMessage(env, chatId, messageId) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: parseInt(messageId) })
    });
    
    if (!res.ok) {
      console.error(`Telegram API Error [deleteMessage]: ${res.status} - ${await res.text()}`);
    }
  } catch (e) {
    console.error("deleteTelegramMessage fetch failed:", e);
  }
}

async function expandAmazonUrl(url) {
  let currentUrl = url;
  let hops = 0;
  try {
    while ((currentUrl.includes("amzn.to") || currentUrl.includes("amzn.eu") || currentUrl.includes("a.co") || /amazon\.eg\/d\//.test(currentUrl)) && hops < 3) {
      const res = await fetch(currentUrl, { method: "GET", redirect: "manual", headers: { "User-Agent": "Agent/AzTrackerBot" }, signal: AbortSignal.timeout(5000) });
      const location = res.headers.get("location");
      
      if (location) {
        currentUrl = new URL(location, currentUrl).href;
        hops++;
      } else {
        break;
      }
    }
  } catch (e) {
    console.error("Short link expansion failure:", e);
  }
  return currentUrl;
}

function getAsinFromUrl(url) {
  if (!url) return null;
  const dpMatch = url.match(/\/dp\/([A-Z0-9]{10})(?=[/?#]|$)/i);
  if (dpMatch) return dpMatch[1].toUpperCase();
  const gpMatch = url.match(/\/gp\/product\/([A-Z0-9]{10})(?=[/?#]|$)/i);
  if (gpMatch) return gpMatch[1].toUpperCase();
  return null;
}

async function triggerWorkflow(env) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/price_tracker.yml/dispatches`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GH_WORKFLOW_TOKEN}`,
        "User-Agent": "Agent/AzTrackerBot",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ref: GITHUB_BRANCH })
    });
    return res;
  } catch (e) {
    console.error("GitHub Actions dispatch fetch failed (Timeout/DNS):", e);
    return { ok: false, status: 0 };
  }
}

async function sendTelegram(env, chatId, text, replyMarkup = null) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text: text, parse_mode: "HTML", disable_web_page_preview: true };
  if (replyMarkup) body.reply_markup = replyMarkup;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (e) {
    console.error("sendTelegram fetch failed:", e);
    return { ok: false, error_code: 500, description: e.message };
  }
}

async function editTelegramMessage(env, chatId, messageId, text, replyMarkup = null) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`;
  const body = { chat_id: chatId, message_id: messageId, text: text, parse_mode: "HTML", disable_web_page_preview: true };
  if (replyMarkup) body.reply_markup = replyMarkup;
  
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Telegram API Error [editMessageText]: ${res.status} - ${errText}`);
    }
  } catch (e) {
    console.error("editTelegramMessage fetch failed:", e);
  }
}

function extractNameFromUrl(url) {
  try {
     const clean = url.split("?")[0].replace(/\/$/, "");
     const match = clean.match(/amazon\.eg\/([^\/]+)\/dp\//);
     if (match && match[1]) {
         return decodeURIComponent(match[1]).replace(/-/g, ' ');
     }
  } catch(e) {}
  return null;
}

async function sendAppMessage(env, chatId, text, replyMarkup = null) {
  const key = `ui:${chatId}`;
  const oldMsgId = await env.AZTRACKER_DB.get(key);
  if (oldMsgId) {
    await deleteTelegramMessage(env, chatId, oldMsgId);
  }
  const res = await sendTelegram(env, chatId, text, replyMarkup);
  if (res?.result?.message_id) {
    await env.AZTRACKER_DB.put(key, res.result.message_id.toString(), { expirationTtl: 172800 });
  }
  return res;
}



async function logAudit(env, adminId, action, target, details) {
  try {
    const adminProfile = await resolveUserProfile(env, adminId, null);
    const adminHandle = adminProfile.handle || adminProfile.label;

    let targetHandle = null;
    if (/^\d{6,15}$/.test(target)) {
      const targetProfile = await resolveUserProfile(env, target, null);
      targetHandle = targetProfile.handle || targetProfile.label;
    }

    const timestamp = Date.now();
    await env.DB.prepare(
      "INSERT INTO Audit_Logs (timestamp, actor_id, actor_name, action, target_id, details) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(timestamp, adminId.toString(), adminHandle, action, target ? target.toString() : null, JSON.stringify({ targetHandle, details })).run();
  } catch (e) {
    console.error("Audit log failed to write:", e);
  }
}

// ── Web App HTML Renderer ───────────────────────────────────────────────────

function renderChartHTML(asin, exp, sig) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Price History - ${asin}</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background-color: var(--tg-theme-bg-color, #ffffff);
            color: var(--tg-theme-text-color, #000000);
            margin: 0;
            padding: 20px;
            display: flex;
            flex-direction: column;
            align-items: center;
        }
        #chart-container {
            width: 100%;
            max-width: 600px;
            position: relative;
            margin-top: 20px;
        }
        .loading { text-align: center; margin-top: 50px; font-size: 16px; opacity: 0.7; }
        .header-title { margin-bottom: 5px; text-align: center; font-weight: 600; font-size: 20px; }
        .header-sub { font-size: 14px; opacity: 0.7; margin-bottom: 20px; text-align: center; }
        .metrics-container {
            display: flex;
            justify-content: space-between;
            width: 100%;
            max-width: 600px;
            margin-top: 15px;
            gap: 10px;
        }
        .metric-card {
            flex: 1;
            background-color: var(--tg-theme-secondary-bg-color, #f5f5f5);
            padding: 12px 5px;
            border-radius: 8px;
            text-align: center;
            display: flex;
            flex-direction: column;
            justify-content: center;
        }
        .metric-title {
            font-size: 11px;
            opacity: 0.7;
            text-transform: uppercase;
            font-weight: 600;
            margin-bottom: 4px;
        }
        .metric-value {
            font-size: 14px;
            font-weight: 700;
            color: var(--tg-theme-text-color, #000000);
        }
    </style>
</head>
<body>
    <div class="header-title">Price Trend</div>
    <div class="header-sub">ASIN: ${asin}</div>
    
    <div id="metrics-container" class="metrics-container" style="display: none;">
        <div class="metric-card">
            <div class="metric-title">All-Time High</div>
            <div id="metric-ath" class="metric-value">--</div>
        </div>
        <div class="metric-card">
            <div class="metric-title">Average</div>
            <div id="metric-avg" class="metric-value">--</div>
        </div>
        <div class="metric-card">
            <div class="metric-title">All-Time Low</div>
            <div id="metric-atl" class="metric-value">--</div>
        </div>
    </div>

    <div id="chart-container">
        <div id="loading" class="loading">Fetching database...</div>
        <canvas id="priceChart" style="display: none;"></canvas>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.ready();
        tg.expand(); 
        tg.setHeaderColor(tg.themeParams.bg_color || '#ffffff');

        async function loadData() {
            try {
                // 1. INJECT EXPIRY AND SIGNATURE PARAMS INTO THE FETCH URL
                const response = await fetch('/api/history/${asin}?exp=${exp}&sig=${sig}');
                
                // 2. CATCH UNAUTHORIZED REQUESTS (e.g. expired tokens)
                if (!response.ok) {
                    throw new Error('Authentication failed or token expired.');
                }
                
                const data = await response.json();
                
                document.getElementById('loading').style.display = 'none';
                
                if (!data || data.length === 0) {
                    document.getElementById('chart-container').innerHTML = '<div class="loading">No price history available yet.<br><br>Check back after the next scan!</div>';
                    return;
                }

                const currentUnix = Math.floor(Date.now() / 1000);
                const lastPoint = data[data.length - 1];
                const lastTime = lastPoint.t !== undefined ? lastPoint.t : lastPoint.timestamp;
                if (lastTime < currentUnix - 60) {
                    data.push({ ...lastPoint, t: currentUnix });
                }

                document.getElementById('priceChart').style.display = 'block';

                const labels = data.map(point => {
                    const t = point.t !== undefined ? point.t : point.timestamp;
                    const date = new Date(t * 1000);
                    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + 
                           date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                });
                
                // Normalizes legacy {"p": X} formats into the new structure on the fly
                const newPrices = data.map(point => point.n !== undefined ? point.n : (point.p !== undefined ? point.p : null));
                const usedPrices = data.map(point => point.u !== undefined ? point.u : null);

                const validPrices = newPrices.filter(p => p !== null);
                if (validPrices.length > 0) {
                    const ath = Math.max(...validPrices);
                    const atl = Math.min(...validPrices);
                    const avg = Math.round(validPrices.reduce((sum, val) => sum + val, 0) / validPrices.length);
                    
                    document.getElementById('metric-ath').innerText = ath.toLocaleString() + ' EGP';
                    document.getElementById('metric-atl').innerText = atl.toLocaleString() + ' EGP';
                    document.getElementById('metric-avg').innerText = avg.toLocaleString() + ' EGP';
                    document.getElementById('metrics-container').style.display = 'flex';
                }

                const ctx = document.getElementById('priceChart').getContext('2d');
                
                const gridColor = tg.themeParams.hint_color ? tg.themeParams.hint_color + '40' : '#cccccc40';
                const textColor = tg.themeParams.text_color || '#000000';
                const lineColor = tg.themeParams.button_color || '#2481cc';

                new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: labels,
                        datasets: [
                            {
                                label: 'New (EGP)',
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
                                label: 'Lowest Used Offer (EGP)',
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
                        maintainAspectRatio: true,
                        interaction: {
                            intersect: false,
                            mode: 'index',
                        },
                        plugins: {
                            legend: { display: false },
                            tooltip: {
                                callbacks: {
                                    label: function(context) {
                                        if (context.parsed.y === null) return context.dataset.label + ': Out of Stock';
                                        return context.dataset.label + ': ' + context.parsed.y.toLocaleString() + ' EGP';
                                    }
                                }
                            }
                        },
                        scales: {
                            y: {
                                ticks: { color: textColor },
                                grid: { color: gridColor }
                            },
                            x: {
                                ticks: { color: textColor, maxRotation: 45, minRotation: 45, maxTicksLimit: 6 },
                                grid: { display: false }
                            }
                        }
                    }
                });
            } catch (err) {
                // 3. DISPLAY ERROR TO USER IF TOKEN FAILS
                document.getElementById('loading').innerText = 'Failed to load chart data.';
            }
        }
        
        loadData();
    </script>
</body>
</html>
  `;
}

function renderAuditHTML(exp, sig) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Security Audit Log</title>
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
    <div class="header-title">Security Audit Log</div>
    <div class="header-sub">7-Day Rolling Retention</div>
    
    <div id="loading" class="loading">Compiling forensic ledger...</div>
    <div id="audit-container"></div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.ready();
        tg.expand(); 
        tg.setHeaderColor(tg.themeParams.bg_color || '#ffffff');

        async function loadAudit() {
            try {
                const response = await fetch('/api/audit?exp=${exp}&sig=${sig}');
                if (!response.ok) throw new Error('Auth failed');
                const logs = await response.json();
                
                document.getElementById('loading').style.display = 'none';
                const container = document.getElementById('audit-container');
                
                if (logs.length === 0) {
                    container.innerHTML = '<div class="empty-state">No administrative actions logged in the past 7 days.</div>';
                    return;
                }

                logs.forEach(log => {
                    const date = new Date(log.ts);
                    const timeStr = date.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) + ' ' + 
                                  date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                    
                    const adminDisplay = log.adminHandle 
                        ? \`\${log.adminHandle} <span style="font-size:10px;opacity:0.6;">(\${log.adminId})</span>\` 
                        : \`<code>\${log.adminId}</code>\`;

                    let targetDisplay = \`<code>\${log.target}</code>\`;
                    if (log.targetHandle) {
                        targetDisplay = \`\${log.targetHandle} <span style="font-size:10px;opacity:0.6;">(\${log.target})</span>\`;
                    }

                    const card = document.createElement('div');
                    card.className = 'audit-card';
                    card.innerHTML = \`
                        <div class="audit-header">
                            <span>🕒 \${timeStr}</span>
                            <span>\${adminDisplay}</span>
                        </div>
                        <div class="audit-action">\${log.action}</div>
                        <div class="audit-row">
                            <span class="audit-label">Target:</span>
                            <span class="audit-data">\${targetDisplay}</span>
                        </div>
                            <div class="audit-row">
                                <span class="audit-label">Details:</span>
                                <span class="audit-data">\${log.details}</span>
                            </div>
                        \`;
                        container.appendChild(card);
                    });
                } catch (err) {
                    document.getElementById('loading').innerText = 'Failed to compile audit logs. Invalid or expired token.';
                }
            }
            
            loadAudit();
        </script>
    </body>
    </html>
  `;
}


// ── Web App Frontend ────────────────────────────────────────────────────────
function renderCrmHTML() {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>AzTracker Command Center</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
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
            <h1 class="font-bold text-lg tracking-tight">AzTracker <span class="text-brand-400">Hub</span></h1>
        </div>
        <button onclick="refreshData()" class="p-2 rounded-full hover:bg-gray-800 transition text-gray-400 hover:text-white">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
        </button>
    </header>

    <main class="flex-1 px-4 py-6 pb-24 space-y-6 max-w-2xl mx-auto w-full" id="app-container">
        
        <!-- MAIN TABS -->
        <div class="flex space-x-6 border-b border-gray-800 mb-6" id="main-tabs">
            <button onclick="switchMainTab('users-view')" id="main-tab-users-view" class="pb-3 text-sm font-medium border-b-2 border-brand-400 text-white transition">Users</button>
            <button onclick="switchMainTab('audit-view')" id="main-tab-audit-view" class="pb-3 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition">Audit Log</button>
        </div>

        <div id="users-view-container" class="space-y-6">
            <!-- TELEMETRY -->
            <section>
                <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">System Overview</h2>
                <div class="grid grid-cols-2 gap-3">
                    <div class="glass rounded-xl p-4 flex flex-col justify-center">
                        <div class="text-gray-400 text-sm mb-1">Users</div>
                        <div class="text-2xl font-bold" id="stat-users">--</div>
                    </div>
                    <div class="glass rounded-xl p-4 flex flex-col justify-center">
                        <div class="text-gray-400 text-sm mb-1">Active Tracked Products</div>
                        <div class="text-2xl font-bold text-brand-400" id="stat-pool">--</div>
                    </div>
                </div>
                <div class="mt-3 glass rounded-xl p-4 flex justify-between items-center">
                    <div>
                        <div class="text-gray-400 text-sm">Last Sync</div>
                        <div class="text-sm font-medium" id="stat-sync">--</div>
                    </div>
                    <button onclick="triggerGlobalScrape()" class="bg-gray-800 hover:bg-gray-700 text-white text-xs px-3 py-2 rounded-lg font-medium transition shadow border border-gray-700 flex items-center gap-2">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg> Force Check
                    </button>
                </div>
            </section>

            <!-- BROADCAST -->
            <section>
                <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">System Broadcast</h2>
                <div class="glass rounded-xl p-4">
                    <textarea id="broadcast-msg" rows="2" class="w-full bg-gray-900 border border-gray-700 rounded-lg p-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition" placeholder="Enter message to blast to all approved users... (HTML allowed)"></textarea>
                    <div class="flex justify-end mt-3">
                        <button onclick="sendBroadcast()" class="bg-brand-600 hover:bg-brand-500 text-white text-sm px-4 py-2 rounded-lg font-medium transition shadow-lg shadow-brand-500/20 flex items-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"></path></svg> Send Broadcast
                        </button>
                    </div>
                </div>
            </section>

            <!-- DIRECTORY NAVIGATION -->
            <section>
                <div class="flex border-b border-gray-800 mb-4 overflow-x-auto" style="scrollbar-width: none;">
                    <button onclick="switchTab('users')" id="tab-users" class="px-4 pb-3 text-sm font-medium tab-active transition whitespace-nowrap">Approved</button>
                    <button onclick="switchTab('queue')" id="tab-queue" class="px-4 pb-3 text-sm font-medium tab-inactive transition relative whitespace-nowrap">
                        Pending <span id="badge-queue" class="hidden absolute top-0 right-1 bg-brand-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full"></span>
                    </button>
                    <button onclick="switchTab('banned')" id="tab-banned" class="px-4 pb-3 text-sm font-medium tab-inactive transition whitespace-nowrap text-red-400/80">Banned</button>
                    <button onclick="switchTab('admins')" id="tab-admins" class="px-4 pb-3 text-sm font-medium tab-inactive transition whitespace-nowrap">Admins</button>
                </div>

                <!-- Queue View -->
                <div id="view-queue" class="hidden space-y-3">
                    <div id="queue-list" class="text-center py-8 text-gray-500 text-sm">Loading queue...</div>
                </div>

                <!-- Users View -->
                <div id="view-users" class="space-y-3">
                    <div class="relative">
                        <input type="text" id="search-users" onkeyup="filterUsers()" placeholder="Search Name, @username or ID..." class="w-full bg-gray-900 border border-gray-800 rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:border-gray-700 transition">
                        <svg class="w-4 h-4 text-gray-500 absolute left-3.5 top-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                    </div>
                    <div id="users-list" class="space-y-3">
                        <div class="text-center py-8 text-gray-500 text-sm">Loading directory...</div>
                    </div>
                </div>
            </section>
        </div>

        <div id="audit-view-container" class="hidden space-y-3">
            <div id="audit-list" class="space-y-3">
                <div class="glass rounded-xl p-6 text-center text-gray-400">Loading audit log...</div>
            </div>
        </div>
    </main>

    <!-- Overlay Loader -->
    <div id="overlay" class="fixed inset-0 bg-gray-950/80 backdrop-blur-sm z-50 flex items-center justify-center hidden opacity-0 transition-opacity duration-300">
        <div class="glass rounded-2xl p-6 flex flex-col items-center shadow-2xl border-gray-700">
            <div class="w-10 h-10 border-4 border-gray-700 border-t-brand-500 rounded-full animate-spin mb-4"></div>
            <p class="text-sm font-medium" id="overlay-text">Processing...</p>
        </div>
    </div>

    <!-- Product Drawer -->
    <div id="drawer" class="fixed inset-0 z-50 hidden">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closeDrawer()"></div>
        <div class="absolute bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 rounded-t-2xl transform translate-y-full transition-transform duration-300 ease-out flex flex-col max-h-[85vh]" id="drawer-content">
            <div class="w-12 h-1.5 bg-gray-700 rounded-full mx-auto mt-3 mb-2"></div>
            <div class="px-4 pb-3 border-b border-gray-800 flex justify-between items-center">
                <div>
                    <h3 class="font-bold text-lg" id="drawer-title">User Products</h3>
                    <p class="text-xs text-gray-400" id="drawer-subtitle">ID: --</p>
                </div>
                <button onclick="closeDrawer()" class="p-2 bg-gray-800 rounded-full text-gray-400 hover:text-white">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            <div class="p-4 overflow-y-auto flex-1 space-y-3" id="drawer-items">
                <div class="text-center py-8 text-gray-500 text-sm">Loading items...</div>
            </div>
        </div>
    </div>

    <!-- Toast Container -->
    <div id="toast-container" class="fixed bottom-6 left-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"></div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.expand();
        tg.ready();
        tg.setHeaderColor('#030712');
        tg.setBackgroundColor('#030712');

        const initData = tg.initData || '';
        let appData = { users: [], joinQueue: [] };
        let activeTab = 'users';

        async function fetchAPI(path, method = 'GET', body = null) {
            if(!initData) return showToast("Local mode: Telegram verification bypassed (Read Only)", "error");
            try {
                const opts = {
                    method,
                    headers: { 'Authorization': \`Bearer \${initData}\`, 'Content-Type': 'application/json' }
                };
                if (body) opts.body = JSON.stringify(body);
                
                const res = await fetch(\`/api/crm\${path}\`, opts);
                if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
                
                if (res.status === 202) return { status: 'queued' };
                const json = await res.json();
                const currentUser = res.headers.get("X-Current-User");
                if (currentUser) json._currentUser = currentUser;
                return json;
            } catch (err) {
                console.error(err);
                showToast(\`Network Error: \${err.message}\`, 'error');
                return null;
            }
        }

        async function refreshData() {
            showLoader("Syncing...");
            const data = await fetchAPI('/data');
            hideLoader();
            if (data) {
                appData = data;
                renderTelemetry();
                renderTabs();
                showToast("Data synchronized", "success");
            }
        }

        function renderTelemetry() {
            document.getElementById('stat-users').innerText = appData.systemStats.totalUsers || 0;
            document.getElementById('stat-stat').innerText = appData.systemStats.activeWatchPool || 0;
            const ms = appData.systemStats.lastRunMs;
            document.getElementById('stat-sync').innerText = ms ? new Date(ms).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'Never';
            
            const badge = document.getElementById('badge-queue');
            if(appData.joinQueue.length > 0) {
                badge.innerText = appData.joinQueue.length;
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }
        }

        function switchMainTab(tabId) {
            const tabs = ['users-view', 'audit-view'];
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
        }

        function switchTab(tab) {
            activeTab = tab;
            const tabs = ['users', 'queue', 'banned', 'admins'];
            tabs.forEach(t => {
                const el = document.getElementById(\`tab-\${t}\`);
                if (el) {
                    const isBanned = t === 'banned';
                    el.className = \`px-4 pb-3 text-sm font-medium transition whitespace-nowrap relative \${t === tab ? 'tab-active' : (isBanned ? 'tab-inactive text-red-400/80' : 'tab-inactive')}\`;
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
                    list.innerHTML = '<div class="text-center py-10 text-gray-500 text-sm glass rounded-xl border border-gray-800 border-dashed">No pending requests</div>';
                    return;
                }
                
                list.innerHTML = appData.joinQueue.map(u => {
                    const time = new Date(u.requested_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                    return \`
                    <div class="glass rounded-xl p-3 flex justify-between items-center">
                        <div>
                            <div class="font-medium text-sm truncate max-w-[250px]">\${u.first_name || 'User'} (\${u.username ? '@' + u.username : u.id})</div>
                            <div class="text-xs text-gray-500 mt-0.5">Requested: \${time}</div>
                        </div>
                        <div class="flex gap-2">
                            <button onclick="performAction('reject', '\${u.id}')" class="w-8 h-8 rounded bg-red-500/10 text-red-400 flex items-center justify-center hover:bg-red-500/20 transition"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>
                            <button onclick="performAction('approve', '\${u.id}')" class="w-8 h-8 rounded bg-emerald-500/10 text-emerald-400 flex items-center justify-center hover:bg-emerald-500/20 transition"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg></button>
                        </div>
                    </div>\`;
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
            
            filtered = filtered.filter(u => u.chat_id.toString().toLowerCase().includes(query) || u.role.toLowerCase().includes(query) || (u.first_name && u.first_name.toLowerCase().includes(query)));
            
            if (filtered.length === 0) {
                list.innerHTML = '<div class="text-center py-10 text-gray-500 text-sm glass rounded-xl border border-gray-800 border-dashed">No users found</div>';
                return;
            }
            
            list.innerHTML = filtered.map(u => {
                const roleColors = { 'root': 'text-purple-400 border-purple-400/20 bg-purple-400/10', 'admin': 'text-brand-400 border-brand-400/20 bg-brand-400/10', 'approved': 'text-gray-300 border-gray-700 bg-gray-800', 'rejected': 'text-red-400 border-red-400/20 bg-red-400/10' };
                const roleStyle = roleColors[u.role] || roleColors['rejected'];
                
                return \`
                <div class="glass rounded-xl p-3 border border-gray-800/50 hover:border-gray-700 transition overflow-hidden relative mb-3">
                    \${u.role === 'root' ? '<div class="absolute -right-2 -top-2 w-10 h-10 bg-purple-500/20 blur-xl rounded-full"></div>' : ''}
                    
                    <!-- Top Row: Name and View Items -->
                    <div class="flex justify-between items-center mb-2 relative z-10">
                        <div class="font-medium text-sm font-semibold truncate">
                            \${u.first_name || 'User'} (\${u.username ? '@' + u.username : u.chat_id})
                        </div>
                        <button onclick="openDrawer('\${u.chat_id}')" class="px-3 py-1.5 rounded-lg bg-gray-800 text-xs font-medium text-brand-400 hover:bg-gray-700 transition shadow">View Items</button>
                    </div>

                    <!-- Second Row: Tags & Info -->
                    <div class="flex items-center gap-2 mb-3 relative z-10">
                        \${(u.role === 'admin' || u.role === 'root') ? \`<span class="text-[10px] px-2 py-0.5 rounded uppercase font-bold border \${roleStyle}">\${u.role}</span>\` : ''}
                        <span class="text-xs text-gray-500">\${u.active_items} / \${(u.role === 'admin' || u.role === 'root') ? '∞' : u.item_limit} Items</span>
                        <span class="text-xs text-gray-500">•</span>
                        <span class="text-xs text-gray-500">Joined: \${new Date(u.created_at).toLocaleDateString()}</span>
                    </div>

                    <!-- Third Row: Actions -->
                    <div class="flex gap-2 relative z-10">
                        \${u.role === 'rejected' ? 
                            \`<button onclick="performAction('unban', '\${u.chat_id}')" class="flex-1 py-1.5 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-xs text-emerald-400 font-medium transition text-center border border-emerald-500/20">Unban User</button>\`
                        :
                            \`<button onclick="messageUser('\${u.chat_id}')" class="flex-1 py-1.5 rounded bg-brand-500/10 hover:bg-brand-500/20 text-xs text-brand-400 font-medium transition text-center border border-brand-500/20">Message</button>
                            \${(u.role === 'admin' || u.role === 'root') ? '' : \`<button onclick="changeLimit('\${u.chat_id}', \${u.item_limit})" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 font-medium transition text-center border border-gray-700/50">Edit</button>\`}
                            \${u.role === 'approved' ? \`<button onclick="performAction('promote', '\${u.chat_id}')" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-brand-400 font-medium transition text-center border border-brand-500/20">Promote</button>\` : ''}
                            \${u.role === 'admin' ? \`<button onclick="performAction('demote', '\${u.chat_id}')" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-orange-400 font-medium transition text-center border border-orange-500/20">Demote</button>\` : ''}
                            \${u.role !== 'root' ? \`<button onclick="performAction('ban', '\${u.chat_id}')" class="flex-1 py-1.5 rounded bg-red-500/10 hover:bg-red-500/20 text-xs text-red-400 font-medium transition text-center border border-red-500/20">Delete</button>\` : ''}\`
                        }
                    </div>
                </div>\`;
            }).join('');
        }

        function messageUser(userId) {
            const msg = prompt("Enter message to send to user " + userId + ":");
            if (msg) {
                performAction('direct_message', userId, { message: msg });
            }
        }

        async function openDrawer(userId) {
            const drawer = document.getElementById('drawer');
            const content = document.getElementById('drawer-content');
            const itemsCont = document.getElementById('drawer-items');
            
            document.getElementById('drawer-subtitle').innerText = \`ID: \${userId}\`;
            itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm"><div class="w-6 h-6 border-2 border-gray-700 border-t-brand-500 rounded-full animate-spin mx-auto mb-2"></div>Loading items...</div>';
            
            drawer.classList.remove('hidden');
            setTimeout(() => {
                content.style.transform = 'translateY(0)';
            }, 10);
            
            const products = await fetchAPI(\`/user/\${userId}/products\`);
            
            if (!products || products.length === 0) {
                itemsCont.innerHTML = '<div class="text-center py-10 text-gray-500 text-sm glass rounded-xl border border-gray-800 border-dashed">No saved products</div>';
                return;
            }
            
            itemsCont.innerHTML = products.map(p => {
                const isPaused = p.is_paused === 1;
                const statusColor = isPaused ? 'text-orange-400 bg-orange-400/10' : 'text-emerald-400 bg-emerald-400/10';
                const statusText = isPaused ? 'Paused' : 'Active';
                const name = p.name ? (p.name.length > 35 ? p.name.substring(0, 32) + '...' : p.name) : p.asin;
                const price = p.amazon_price ? \`\${p.amazon_price} EGP\` : (p.used_price ? 'Used Only' : 'Out of Stock');
                
                return \`
                <div class="glass rounded-xl p-3 border border-gray-800/50 relative overflow-hidden">
                    <div class="flex justify-between items-start mb-2">
                        <div class="pr-6">
                            <a href="https://www.amazon.eg/dp/\${p.asin}" target="_blank" class="font-medium text-sm text-brand-400 hover:underline block leading-tight">\${name}</a>
                            <div class="text-xs text-gray-500 mt-1 font-mono">\${p.asin}</div>
                        </div>
                        <span class="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase \${statusColor} whitespace-nowrap">\${statusText}</span>
                    </div>
                    <div class="flex justify-between items-end mb-3">
                        <div class="text-sm font-semibold">\${price}</div>
                        \${p.target_price ? \`<div class="text-xs text-brand-400 flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg> Target: \${p.target_price}</div>\` : ''}
                    </div>
                    <div class="flex gap-2">
                        <button onclick="performAction('\${isPaused ? 'resume_product' : 'pause_product'}', '\${userId}', {asin: '\${p.asin}'})" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 font-medium transition border border-gray-700/50">\${isPaused ? '▶️ Resume' : '⏸️ Pause'}</button>
                        <button onclick="changeTarget('\${userId}', '\${p.asin}')" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 font-medium transition border border-gray-700/50">🎯 Target</button>
                        <button onclick="performAction('delete_product', '\${userId}', {asin: '\${p.asin}'})" class="w-10 py-1.5 rounded bg-red-500/10 hover:bg-red-500/20 text-xs text-red-400 font-medium transition border border-red-500/20 flex items-center justify-center"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>
                    </div>
                </div>\`;
            }).join('');
        }

        function closeDrawer() {
            const content = document.getElementById('drawer-content');
            content.style.transform = 'translateY(100%)';
            setTimeout(() => {
                document.getElementById('drawer').classList.add('hidden');
            }, 300);
        }

        async function performAction(action, targetId, data = null) {
            if (!targetId) targetId = "global";
            showLoader();
            const res = await fetchAPI('/action', 'POST', { action, targetId, data });
            hideLoader();
            
            if (res) {
                if (res.status === 'queued') {
                    showToast("Action queued in background", "success");
                } else {
                    showToast("Success", "success");
                    if(action.includes('_product')) {
                        openDrawer(targetId); // refresh drawer
                    }
                    refreshData(); // refresh background
                }
            }
        }

        function triggerGlobalScrape() {
            tg.showConfirm("Trigger global force check? This will execute the scraper for all active items immediately.", (ok) => {
                if(ok) performAction("force_scrape", null);
            });
        }

        function sendBroadcast() {
            const msg = document.getElementById('broadcast-msg').value.trim();
            if(!msg) return showToast("Message is empty", "error");
            tg.showConfirm("Send this broadcast to all users?", (ok) => {
                if(ok) {
                    performAction("broadcast", null, { message: msg });
                    document.getElementById('broadcast-msg').value = '';
                }
            });
        }

        function changeLimit(userId, currentLimit) {
            // Use native prompt since tg.showPopup doesn't support input fields
            const limit = prompt(\`Enter new limit for \${userId}:\`, currentLimit);
            if (limit !== null && limit !== "" && !isNaN(limit) && limit > 0) {
                performAction('set_limit', userId, { limit: parseInt(limit) });
            }
        }

        function changeTarget(userId, asin) {
            const target = prompt(\`Enter new target price (EGP) for \${asin}:\`);
            if (target !== null && target !== "" && !isNaN(target) && target > 0) {
                performAction('set_target', userId, { asin, target: parseFloat(target) });
            }
        }

        function confirmRevoke(userId) {
            tg.showConfirm(\`Are you sure you want to REVOKE \${userId}? This will delete all their saved products.\`, (ok) => {
                if(ok) performAction('revoke', userId);
            });
        }

        // --- Helpers ---
        function showLoader(text = "Processing...") {
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
            
            el.className = \`glass rounded-lg px-4 py-3 flex items-center gap-3 text-sm font-medium shadow-2xl border toast toast-enter \${bg}\`;
            el.innerHTML = \`<span>\${icon}</span> <span>\${message}</span>\`;
            
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
        document.getElementById('stat-pool').id = 'stat-stat'; // Fix id mapping
        refreshData();
    </script>
</body>
</html>`;
}
