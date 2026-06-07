import os

with open("worker.js", "r", encoding="utf-8") as f:
    content = f.read()

# 1. syncUserNames Definition
old_sync = """function syncUserNames(env, chatId, from, ctx) {
  if (!from || !ctx || !ctx.waitUntil) return;
  const first = from.first_name || '';
  const user = from.username || '';
  ctx.waitUntil(
    env.DB.prepare(`
      UPDATE Users 
      SET first_name = ?, username = ? 
      WHERE chat_id = ? 
      AND (COALESCE(first_name, '') != ? OR COALESCE(username, '') != ?)
    `).bind(first, user, chatId, first, user).run().catch(e=>console.error("Name sync error:", e))
  );
}"""

new_sync = """async function syncUserNames(env, chatId, from, baseUrl) {
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
}"""
content = content.replace(old_sync, new_sync)

# 2. Call to syncUserNames
content = content.replace("  syncUserNames(env, chatId, message.from, ctx);", "  if (ctx && ctx.waitUntil) ctx.waitUntil(syncUserNames(env, chatId, message.from, baseUrl));")
content = content.replace("  syncUserNames(env, chatId, callback.from, ctx);", "  if (ctx && ctx.waitUntil) ctx.waitUntil(syncUserNames(env, chatId, callback.from, baseUrl));")


# 3. getUserRoles Optimization
old_roles = """async function getUserRoles(chatIdStr, env, ctx = null) {
  let cacheKey = null;
  if (ctx && ctx.waitUntil) {
    cacheKey = new Request(`https://auth.internal/user/${chatIdStr}`);
    const cached = await caches.default.match(cacheKey);
    if (cached) return await cached.json();
  }

  const rootAdminsRaw = env.TELEGRAM_ROOT_ADMIN_IDS || env.ROOT_ADMIN_ID || env.TELEGRAM_ADMIN_IDS || "";
  const rootAdmins = rootAdminsRaw.split(",").filter(Boolean).map(String);
  const isRootAdmin = rootAdmins.includes(chatIdStr);

  const { results: adminRows } = await env.DB.prepare("SELECT chat_id FROM Users WHERE role = 'admin' ORDER BY created_at ASC").all();
  const dbAdmins = adminRows.map(r => r.chat_id.toString());
  const admins = [...new Set([...dbAdmins, ...rootAdmins])];

  const { results: approvedRows } = await env.DB.prepare("SELECT chat_id FROM Users WHERE role IN ('approved', 'admin')").all();
  const approvedUsers = approvedRows.map(r => r.chat_id.toString());

  const isApproved = isRootAdmin || approvedUsers.includes(chatIdStr);
  const isAdmin = isRootAdmin || admins.includes(chatIdStr);
  const isRejected = false;

  const result = { isRootAdmin, isAdmin, isApproved, isRejected, rootAdmins, admins, approvedUsers };
  if (cacheKey && ctx.waitUntil && isApproved) {
    ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(result), { headers: { "Cache-Control": "s-maxage=60" } })));
  }
  return result;
}"""

new_roles = """async function getUserRoles(chatIdStr, env, ctx = null) {
  let cacheKey = null;
  if (ctx && ctx.waitUntil) {
    cacheKey = new Request(`https://auth.internal/user/${chatIdStr}`);
    const cached = await caches.default.match(cacheKey);
    if (cached) return await cached.json();
  }

  const rootAdminsRaw = env.TELEGRAM_ROOT_ADMIN_IDS || env.ROOT_ADMIN_ID || env.TELEGRAM_ADMIN_IDS || "";
  const rootAdmins = rootAdminsRaw.split(",").filter(Boolean).map(String);
  const isRootAdmin = rootAdmins.includes(chatIdStr);
  
  let role = 'rejected';
  if (isRootAdmin) {
     role = 'root';
  } else {
     const row = await env.DB.prepare("SELECT role FROM Users WHERE chat_id = ?").bind(chatIdStr).first();
     if (row) role = row.role;
  }

  const isApproved = role === 'root' || role === 'admin' || role === 'approved';
  const isAdmin = role === 'root' || role === 'admin';
  const isRejected = role === 'rejected';

  // Backwards compatibility for broadcast lists
  let rootAdminsList = rootAdmins;
  if (!rootAdmins.length) {
      const dynamicRoot = await env.DB.prepare("SELECT chat_id FROM Users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1").first();
      if (dynamicRoot) rootAdminsList = [dynamicRoot.chat_id.toString()];
  }

  const result = { isRootAdmin, isAdmin, isApproved, isRejected, rootAdmins: rootAdminsList };
  if (cacheKey && ctx && ctx.waitUntil && isApproved) {
    ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(result), { headers: { "Cache-Control": "s-maxage=60" } })).catch(e => console.error(e)));
  }
  return result;
}"""

content = content.replace(old_roles, new_roles)

# 4. Security Boundaries
content = content.replace("if (admins.includes(targetId) && !isRootAdmin) return;", "const targetRoles = await getUserRoles(targetId, env, ctx);\n        if (targetRoles.isRootAdmin || (targetRoles.isAdmin && !isRootAdmin)) return;")

# 5. Admin Broadcast list inside handleCallback
old_broadcast = """        let broadcastAdmins = rootAdmins;
        if (!broadcastAdmins || broadcastAdmins.length === 0) {
            broadcastAdmins = admins.slice(0, 1);
        }"""
new_broadcast = """        const { results: adminRows } = await env.DB.prepare("SELECT chat_id FROM Users WHERE role = 'admin'").all();
        const dbAdmins = adminRows.map(r => r.chat_id.toString());
        const allAdmins = [...new Set([...dbAdmins, ...rootAdmins])];
        let broadcastAdmins = rootAdmins;
        if (!broadcastAdmins || broadcastAdmins.length === 0) {
            broadcastAdmins = allAdmins.slice(0, 1);
        }"""
content = content.replace(old_broadcast, new_broadcast)

# 6. CRM API Data Payload (users array mutation)
old_crm_data = """        const rootAdminsRaw = env.TELEGRAM_ROOT_ADMIN_IDS || env.ROOT_ADMIN_ID || env.TELEGRAM_ADMIN_IDS || "";
        const rootAdmins = rootAdminsRaw.split(",").filter(Boolean).map(String);
        
        const kvAdmins = await env.AZTRACKER_DB.get("global:admins", "json") || [];
        const kvBanned = await env.AZTRACKER_DB.get("global:banned_users", "json") || [];
        
        if (usersRes.results) {
            usersRes.results.forEach(u => {
                const idStr = u.chat_id.toString();
                if (rootAdmins.includes(idStr)) {
                    u.role = 'root';
                } else if (u.role !== 'admin' && kvAdmins.includes(idStr)) {
                    u.role = 'admin';
                } else if (u.role !== 'rejected' && kvBanned.includes(idStr)) {
                    u.role = 'rejected';
                }
            });
        }
        
        const data = {
          systemStats: {
            totalUsers: usersRes.results ? usersRes.results.length : 0,
            activeWatchPool: totalProductsRes ? totalProductsRes.activeWatchPool : 0,
            lastRunMs: lastUpdatedRes ? lastUpdatedRes.lastRunMs : null
          },
          joinQueue: joinQueueRes || [],
          users: usersRes.results || []
        };"""

new_crm_data = """        const rootAdminsRaw = env.TELEGRAM_ROOT_ADMIN_IDS || env.ROOT_ADMIN_ID || env.TELEGRAM_ADMIN_IDS || "";
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
        };"""
content = content.replace(old_crm_data, new_crm_data)
content = content.replace('        const joinQueueRes = await env.AZTRACKER_DB.get("global:join_queue", "json") || [];\n', '')


# 7. Force Scrape API
old_scrape = """      if (action === "force_scrape") {
        ctx.waitUntil(executeScrapeEngine(env, true));
        ctx.waitUntil(logAudit(env, adminId, "FORCE_SCRAPE", "global", "Triggered global price check"));
        return new Response(JSON.stringify({ success: true, status: "queued" }), { status: 202 });
      }"""
new_scrape = """      if (action === "force_scrape") {
        ctx.waitUntil((async () => {
          try {
            await executeScrapeEngine(env, true);
            await sendAppMessage(env, adminId, "✅ <b>Force Scrape Completed</b>\\n\\nThe background queue has successfully finished processing all items.");
            await logAudit(env, adminId, "FORCE_SCRAPE", "global", "Triggered global price check (Success)");
          } catch (error) {
            console.error("Scrape Engine Error:", error);
            await sendAppMessage(env, adminId, `❌ <b>Force Scrape Failed</b>\\n\\nError: <code>${error.message}</code>`);
            await logAudit(env, adminId, "FORCE_SCRAPE", "global", `Triggered global price check (Failed: ${error.message})`);
          }
        })());
        return new Response(JSON.stringify({ success: true, status: "queued" }), { status: 202 });
      }"""
content = content.replace(old_scrape, new_scrape)

# 8. CRM Auth Cache Eviction
old_post_crm = """      if (action === "approve" || action === "promote" || action === "demote" || action === "revoke" || action === "reject") {
        ctx.waitUntil(caches.default.delete(new Request(baseUrl + "/_internal/crm/data")));
      }"""
new_post_crm = """      if (action === "approve" || action === "promote" || action === "demote" || action === "revoke" || action === "reject") {
        ctx.waitUntil(caches.default.delete(new Request(baseUrl + "/_internal/crm/data")));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      }"""
content = content.replace(old_post_crm, new_post_crm)

with open("worker.js", "w", encoding="utf-8") as f:
    f.write(content)

print("worker.js backend refactored successfully")
