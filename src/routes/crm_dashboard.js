import { getUserRoles, logAudit } from '../core/db.js';
import { t, resolveLanguageCode } from '../core/i18n.js';
import { getAmazonAccessToken, AmazonEdgeParser } from '../core/amazon.js';

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
      const lang = langParam === 'ar' ? 'ar' : 'en';
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
      const lang = langParam === 'ar' ? 'ar' : 'en';
      return new Response(renderCrmHTML(lang), {
        status: 200,
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }



    if (url.pathname === "/api/test-asin") {
      try {
        const asin = url.searchParams.get("asin") || "B094HJ4JSH";
        let accessToken = await env.AZTRACKER_DB.get('amazon_access_token');
        if (!accessToken) {
          const clientId = env.AMAZON_CLIENT_ID || env.AMZN_CREATORS_ACCESS_KEY || env.AWS_ACCESS_KEY_ID;
          const clientSecret = env.AMAZON_CLIENT_SECRET || env.AMZN_CREATORS_SECRET_KEY || env.AWS_SECRET_ACCESS_KEY;
          accessToken = await getAmazonAccessToken(clientId, clientSecret);
        }
        const parser = new AmazonEdgeParser(accessToken, env.AMZN_ASSOCIATES_TAG);
        const items = await parser.getItems([asin]);
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
        return new Response(JSON.stringify({ parsed: items, raw: data }, null, 2), { headers: { "Content-Type": "application/json" } });
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
        return new Response(`Successfully migrated ${migratedCount} subscriptions and ${allValidUsers.length} users!`, { status: 200 });
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
            totalUsers: mutableUsers.filter(u => u.role !== 'rejected').length,
            activeWatchPool: totalProductsRes ? totalProductsRes.activeWatchPool : 0,
            lastRunMs: lastUpdatedRes ? lastUpdatedRes.lastRunMs : null
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
      
      if (action === "restore_kv") {
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
            await sendTelegram(env, adminId, `✅ <b>Restoration Complete</b>\n\nSuccessfully restored ${count} missing products (including their history and properties) from the main KV database.`);
            await logAudit(env, adminId, "RESTORE_KV", "global", `Restored ${count} missing products`);
          } catch (e) {
            console.error("KV Restore error:", e);
            await sendTelegram(env, adminId, `❌ <b>Restoration Failed</b>\n\nError: <code>${e.message}</code>`);
          }
        })());
        return new Response(JSON.stringify({ success: true, status: "queued" }), { status: 202 });
      }
      
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
      } else if (action === "reject") {
        await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();
        ctx.waitUntil(sendTelegram(env, targetId, "❌ <b>Your access request was REJECTED.</b>"));
        ctx.waitUntil(logAudit(env, adminId, "REJECT_USER", targetId, "Rejected join request"));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "revoke") {
        if (targetId === adminId) return new Response("Cannot revoke yourself", { status: 400 });
        await env.DB.batch([
          env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 1 WHERE chat_id = ?").bind(targetId),
          env.DB.prepare("UPDATE Users SET role = 'rejected' WHERE chat_id = ?").bind(targetId)
        ]);
        ctx.waitUntil(sendTelegram(env, targetId, "⛔ <b>Your access has been REVOKED.</b>"));
        ctx.waitUntil(logAudit(env, adminId, "REVOKE_USER", targetId, "Revoked user access and froze subscriptions"));
      } else if (action === "unban") {
        await env.DB.batch([
          env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 0 WHERE chat_id = ?").bind(targetId),
          env.DB.prepare("UPDATE Users SET role = 'approved' WHERE chat_id = ?").bind(targetId)
        ]);
        ctx.waitUntil(sendTelegram(env, targetId, "✅ <b>Your access has been RESTORED.</b>"));
        ctx.waitUntil(logAudit(env, adminId, "UNBAN_USER", targetId, "Unbanned user and resumed subscriptions"));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "promote") {
        if (!auth.isRootAdmin) return new Response("Forbidden", { status: 403 });
        await env.DB.prepare("UPDATE Users SET role = 'admin' WHERE chat_id = ?").bind(targetId).run();
        ctx.waitUntil(sendTelegram(env, targetId, "👑 <b>You have been PROMOTED to Admin!</b>"));
        ctx.waitUntil(logAudit(env, adminId, "PROMOTE_ADMIN", targetId, "Promoted user to Admin"));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "demote") {
        if (!auth.isRootAdmin) return new Response("Forbidden", { status: 403 });
        if (targetId === adminId) return new Response("Cannot demote yourself", { status: 400 });
        await env.DB.prepare("UPDATE Users SET role = 'approved' WHERE chat_id = ?").bind(targetId).run();
        ctx.waitUntil(sendTelegram(env, targetId, "🔽 <b>You have been DEMOTED to standard user.</b>"));
        ctx.waitUntil(logAudit(env, adminId, "DEMOTE_ADMIN", targetId, "Demoted Admin to standard user"));
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
        await env.DB.prepare("UPDATE User_Subscriptions SET target_price = ?, alert_sent_new = 0, alert_sent_used = 0 WHERE chat_id = ? AND asin = ?").bind(target, targetId, asin).run();
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
  return new Response("Not Found", { status: 404 });
}

export function renderAuditHTML(exp, sig, lang = 'en') {
  return `
<!DOCTYPE html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
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
                    container.innerHTML = '<div class="empty-state">${t("crm.no_audit", lang)}</div>';
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
                    document.getElementById('loading').innerText = '${t("crm.toast_network_error", lang)}';
                }
            }
            
            loadAudit();
        </script>
    </body>
    </html>
  `;
}

export function renderCrmHTML(lang = 'en') {
  return `<!DOCTYPE html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}" class="dark">
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
        <div class="flex gap-6 border-b border-gray-800 mb-6" id="main-tabs">
            <button onclick="switchMainTab('users-view')" id="main-tab-users-view" class="pb-3 text-sm font-medium border-b-2 border-brand-400 text-white transition">${t('crm.users_title', lang)}</button>
            <button onclick="switchMainTab('audit-view')" id="main-tab-audit-view" class="pb-3 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition">${t('crm.security_audit', lang)}</button>
        </div>

        <div id="users-view-container" class="space-y-6">
            <!-- TELEMETRY -->
            <section>
                <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">${t('crm.system_overview', lang)}</h2>
                <div class="grid grid-cols-2 gap-3">
                    <div class="glass rounded-xl p-4 flex flex-col justify-center">
                        <div class="text-gray-400 text-sm mb-1">${t('crm.users_title', lang)}</div>
                        <div class="text-2xl font-bold" id="stat-users">--</div>
                    </div>
                    <div class="glass rounded-xl p-4 flex flex-col justify-center">
                        <div class="text-gray-400 text-sm mb-1">${t('crm.products_title', lang)}</div>
                        <div class="text-2xl font-bold text-brand-400" id="stat-pool">--</div>
                    </div>
                </div>
                <div class="mt-3 glass rounded-xl p-4 flex flex-col gap-3">
                    <div class="text-center w-full">
                        <span class="text-gray-400 text-sm">${t('crm.last_sync', lang)}: </span>
                        <span class="text-sm font-medium" id="stat-sync">--</span>
                    </div>
                    <div class="flex gap-2 w-full">
                        <button onclick="performAction('restore_kv', 'global')" class="flex-1 justify-center bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 text-xs px-3 py-2 rounded-lg font-medium transition shadow border border-emerald-500/20 flex items-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> ${t('crm.restore_products', lang)}
                        </button>
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
                    <textarea id="broadcast-msg" rows="2" class="w-full bg-gray-900 border border-gray-700 rounded-lg p-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition" placeholder="${t('crm.broadcast_placeholder', lang)}"></textarea>
                    <div class="flex justify-end mt-3">
                        <button onclick="sendBroadcast()" class="bg-brand-600 hover:bg-brand-500 text-white text-sm px-4 py-2 rounded-lg font-medium transition shadow-lg shadow-brand-500/20 flex items-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"></path></svg> ${t('crm.send_broadcast', lang)}
                        </button>
                    </div>
                </div>
            </section>

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
                        <input type="text" id="search-users" onkeyup="filterUsers()" placeholder="${t('crm.search_placeholder', lang)}" class="w-full bg-gray-900 border border-gray-800 rounded-lg ps-10 pe-4 py-2.5 text-sm focus:outline-none focus:border-gray-700 transition">
                        <svg class="w-4 h-4 text-gray-500 absolute start-3.5 top-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                    </div>
                    <div id="users-list" class="space-y-3">
                        <div class="text-center py-8 text-gray-500 text-sm">${t('crm.loading_items', lang)}</div>
                    </div>
                </div>
            </section>
        </div>

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
                showToast(\`${t('crm.toast_network_error', lang)}: \${err.message}\`, 'error');
                return null;
            }
        }

        async function refreshData() {
            showLoader("${t('crm.toast_syncing', lang)}");
            const data = await fetchAPI('/data');
            hideLoader();
            if (data) {
                appData = data;
                renderTelemetry();
                renderTabs();
                showToast("${t('crm.toast_synced', lang)}", "success");
            }
        }

        function renderTelemetry() {
            if (appData.auth && !appData.auth.isRootAdmin) {
                const el = document.getElementById('broadcast-section');
                if (el) el.style.display = 'none';
            }
            document.getElementById('stat-users').innerText = appData.systemStats.totalUsers || 0;
            document.getElementById('stat-pool').innerText = appData.systemStats.activeWatchPool || 0;
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
            
            if (tabId === 'audit-view' && !appData.auditLoaded) {
                loadAuditTab();
            }
        }
        
        async function loadAuditTab() {
            const container = document.getElementById('audit-list');
            container.innerHTML = '<div class="glass rounded-xl p-6 text-center text-gray-400">Loading audit log...</div>';
            
            const logs = await fetchAPI('/audit');
            if (!logs) {
                container.innerHTML = '<div class="glass rounded-xl p-6 text-center text-red-400">${t("crm.toast_network_error", lang)}</div>';
                return;
            }
            appData.auditLoaded = true;
            
            if (logs.length === 0) {
                container.innerHTML = '<div class="glass rounded-xl p-6 text-center text-gray-500 border border-gray-800 border-dashed">${t("crm.no_audit", lang)}</div>';
                return;
            }
            
            container.innerHTML = logs.map(log => {
                const date = new Date(log.ts);
                const timeStr = date.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) + ' ' + 
                              date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                
                const adminDisplay = log.adminHandle ? log.adminHandle + ' <span class="text-[10px] opacity-60">(' + log.adminId + ')</span>' : '<code class="bg-gray-800 px-1 py-0.5 rounded">' + log.adminId + '</code>';
                let targetDisplay = '<code class="bg-gray-800 px-1 py-0.5 rounded">' + log.target + '</code>';
                if (log.targetHandle) targetDisplay = log.targetHandle + ' <span class="text-[10px] opacity-60">(' + log.target + ')</span>';
                
                return '<div class="glass rounded-xl p-4">' +
                    '<div class="flex justify-between items-center text-xs opacity-80 border-b border-gray-700/50 pb-2 mb-2">' +
                        '<span>🕒 ' + timeStr + '</span>' +
                        '<span>' + adminDisplay + '</span>' +
                    '</div>' +
                    '<div class="text-brand-400 font-bold text-sm mb-2">' + log.action + '</div>' +
                    '<div class="text-sm flex gap-2 mb-1"><span class="font-semibold opacity-80 w-16">Target:</span><span class="break-all">' + targetDisplay + '</span></div>' +
                    '<div class="text-sm flex gap-2"><span class="font-semibold opacity-80 w-16">Details:</span><span class="break-all">' + log.details + '</span></div>' +
                '</div>';
            }).join('');
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
                    list.innerHTML = '<div class="text-center py-10 text-gray-500 text-sm glass rounded-xl border border-gray-800 border-dashed">${t("crm.no_pending", lang)}</div>';
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
                list.innerHTML = '<div class="text-center py-10 text-gray-500 text-sm glass rounded-xl border border-gray-800 border-dashed">${t("crm.no_users_found", lang)}</div>';
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
                        <button onclick="openDrawer('\${u.chat_id}')" class="px-3 py-1.5 rounded-lg bg-gray-800 text-xs font-medium text-brand-400 hover:bg-gray-700 transition shadow">${t('crm.btn_view_items', lang)}</button>
                    </div>

                    <!-- Second Row: Tags & Info -->
                    <div class="flex items-center gap-2 mb-3 relative z-10">
                        \${(u.role === 'admin' || u.role === 'root') ? \`<span class="text-[10px] px-2 py-0.5 rounded uppercase font-bold border \${roleStyle}">\${u.role}</span>\` : ''}
                        <span class="text-xs text-gray-500">\${u.active_items} / \${(u.role === 'admin' || u.role === 'root') ? '∞' : u.item_limit} items</span>
                        <span class="text-xs text-gray-500">•</span>
                        <span class="text-xs text-gray-500">Joined: \${new Date(u.created_at).toLocaleDateString()}</span>
                    </div>

                    <!-- Third Row: Actions -->
                    <div class="flex gap-2 relative z-10">
                        \${u.role === 'rejected' ? 
                            \`<button onclick="performAction('unban', '\${u.chat_id}')" class="flex-1 py-1.5 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-xs text-emerald-400 font-medium transition text-center border border-emerald-500/20">${t('crm.btn_unban', lang)}</button>\`
                        :
                            \`<button onclick="messageUser('\${u.chat_id}')" class="flex-1 py-1.5 rounded bg-brand-500/10 hover:bg-brand-500/20 text-xs text-brand-400 font-medium transition text-center border border-brand-500/20">${t('crm.btn_message', lang)}</button>
                            \${(u.role === 'admin' || u.role === 'root') ? '' : \`<button onclick="changeLimit('\${u.chat_id}', \${u.item_limit})" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 font-medium transition text-center border border-gray-700/50">${t('crm.btn_edit', lang)}</button>\`}
                            \${u.role === 'approved' ? \`<button onclick="performAction('promote', '\${u.chat_id}')" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-brand-400 font-medium transition text-center border border-brand-500/20">${t('crm.btn_promote', lang)}</button>\` : ''}
                            \${u.role === 'admin' ? \`<button onclick="performAction('demote', '\${u.chat_id}')" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-orange-400 font-medium transition text-center border border-orange-500/20">${t('crm.btn_demote_drawer', lang)}</button>\` : ''}
                            \${u.role !== 'root' ? \`<button onclick="performAction('revoke', '\${u.chat_id}')" class="w-10 flex items-center justify-center py-1.5 rounded bg-red-500/10 hover:bg-red-500/20 text-xs text-red-400 font-medium transition border border-red-500/20"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>\` : ''}\`
                        }
                    </div>
                </div>\`;
            }).join('');
        }

        function messageUser(userId) {
            const msg = prompt("${t('crm.btn_message', lang)} — " + userId + ":");
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
                itemsCont.innerHTML = '<div class="text-center py-10 text-gray-500 text-sm glass rounded-xl border border-gray-800 border-dashed">${t("crm.no_saved_products", lang)}</div>';
                return;
            }
            
            itemsCont.innerHTML = products.map(p => {
                const isPaused = p.is_paused === 1;
                const statusColor = isPaused ? 'text-orange-400 bg-orange-400/10' : 'text-emerald-400 bg-emerald-400/10';
                const statusText = isPaused ? '${t("crm.user_paused", lang)}' : '${t("crm.user_active", lang)}';
                const name = p.name ? (p.name.length > 35 ? p.name.substring(0, 32) + '...' : p.name) : p.asin;
                const price = p.new_price ? \`\${p.new_price} EGP\` : (p.used_price ? '${t("crm.user_used_only", lang)}' : '${t("crm.user_out_of_stock", lang)}');
                
                return \`
                <div class="glass rounded-xl p-3 border border-gray-800/50 relative overflow-hidden">
                    <div class="flex justify-between items-start mb-2">
                        <div class="pe-6">
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
                        <button onclick="performAction('\${isPaused ? 'resume_product' : 'pause_product'}', '\${userId}', {asin: '\${p.asin}'})" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 font-medium transition border border-gray-700/50">\${isPaused ? '▶️ ${t("crm.btn_resume", lang)}' : '⏸️ ${t("crm.btn_pause_drawer", lang)}'}</button>
                        <button onclick="openChartModal('\${p.asin}')" class="flex-1 py-1.5 rounded bg-brand-500/10 hover:bg-brand-500/20 text-xs text-brand-400 font-medium transition border border-brand-500/20">📊 ${t('crm.btn_chart', lang)}</button>
                        <button onclick="performAction('delete_product', '\${userId}', {asin: '\${p.asin}'})" class="flex-1 py-1.5 rounded bg-red-500/10 hover:bg-red-500/20 text-xs text-red-400 font-medium transition border border-red-500/20">🗑️ ${t('crm.btn_delete_drawer', lang)}</button>
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
            document.getElementById('chart-loading').innerText = 'Loading chart data...';
            
            const data = await fetchAPI('/history/' + asin); // This actually maps to /api/crm/history/ASIN due to fetchAPI prefix
            document.getElementById('chart-loading').style.display = 'none';
            
            if (!data || data.length === 0) {
                document.getElementById('chart-loading').innerText = '${t("crm.no_price_history", lang)}';
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
                            label: '${t("crm.new_price", lang)}',
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
                            label: '${t("crm.used_price", lang)}',
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
                    showToast("${t('crm.toast_action_queued', lang)}", "success");
                } else {
                    showToast("${t('crm.toast_success', lang)}", "success");
                    if(action.includes('_product')) {
                        openDrawer(targetId); // refresh drawer
                    }
                    refreshData(); // refresh background
                }
            }
        }

        function triggerGlobalScrape() {
            tg.showConfirm("${t('crm.force_check', lang)}?", (ok) => {
                if(ok) performAction("force_scrape", null);
            });
        }

        function sendBroadcast() {
            const msg = document.getElementById('broadcast-msg').value.trim();
            if(!msg) return showToast("${t('crm.toast_msg_empty', lang)}", "error");
            tg.showConfirm("${t('crm.send_broadcast', lang)}?", (ok) => {
                if(ok) {
                    performAction("broadcast", null, { message: msg });
                    document.getElementById('broadcast-msg').value = '';
                }
            });
        }

        function changeLimit(userId, currentLimit) {
            // Use native prompt since tg.showPopup doesn't support input fields
            const limit = prompt(\`${t('crm.btn_edit', lang)} — \${userId}:\`, currentLimit);
            if (limit !== null && limit !== "" && !isNaN(limit) && limit > 0) {
                performAction('set_limit', userId, { limit: parseInt(limit) });
            }
        }

        function changeTarget(userId, asin) {
            const target = prompt(\`${t('crm.btn_edit', lang)} (${t('crm.new_price', lang)}) — \${asin}:\`);
            if (target !== null && target !== "" && !isNaN(target) && target > 0) {
                performAction('set_target', userId, { asin, target: parseFloat(target) });
            }
        }

        function confirmRevoke(userId) {
            tg.showConfirm(\`${t('crm.btn_demote_drawer', lang)} — \${userId}?\`, (ok) => {
                if(ok) performAction('revoke', userId);
            });
        }

        // --- Helpers ---
        function showLoader(text = "${t('crm.toast_processing', lang)}") {
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
        refreshData();
    </script>
</body>
</html>`;
}

