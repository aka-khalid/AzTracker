export async function getUserRoles(chatId, env, ctx) {
  const cache = caches.default;
  const cacheReq = new Request(`https://auth.internal/roles/${chatId}`);
  const cached = await cache.match(cacheReq);
  if (cached) {
    return await cached.json();
  }

  const rootAdminsRaw = env.TELEGRAM_ROOT_ADMIN_IDS || env.ROOT_ADMIN_ID || env.TELEGRAM_ADMIN_IDS || "";
  const rootAdmins = rootAdminsRaw.split(",").filter(Boolean);
  let isRootAdmin = rootAdmins.includes(chatId);

  const { results: adminRows } = await env.DB.prepare("SELECT chat_id FROM Users WHERE role = 'admin' ORDER BY created_at ASC").all();
  const admins = adminRows.map(r => r.chat_id);

  const { results: approvedRows } = await env.DB.prepare("SELECT chat_id FROM Users WHERE role IN ('approved', 'admin')").all();
  const approvedUsers = approvedRows.map(r => r.chat_id);

  const user = await env.DB.prepare("SELECT role, lang FROM Users WHERE chat_id = ?").bind(chatId).first();
  let role = user ? user.role : null;

  if (!isRootAdmin && rootAdmins.length === 0 && admins.length > 0 && admins[0] === chatId) {
      isRootAdmin = true;
  }

  const isAdmin = isRootAdmin || role === "admin" || admins.includes(chatId);
  const isApproved = isAdmin || role === "approved" || approvedUsers.includes(chatId);
  const isRejected = role === "rejected";

  const result = { isRootAdmin, isAdmin, isApproved, isRejected, rootAdmins, admins, approvedUsers, lang: user?.lang || 'en' };
  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(cache.put(cacheReq, new Response(JSON.stringify(result), {
      headers: { "Cache-Control": "s-maxage=5", "Content-Type": "application/json" }
    })));
  }
  return result;
}

export async function resolveUserProfile(env, id, ctx) {
  const cache = caches.default;
  const cacheReq = new Request(`https://profile.internal/user/${id}`);

  const cached = await cache.match(cacheReq);
  if (cached) {
    const data = await cached.json();
    return { id, label: data.label, handle: data.handle };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChat?chat_id=${id}`);
    const data = await res.json();

    if (data.ok && data.result) {
      const profile = data.result;
      const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(" ");
      const handle = profile.username ? `@${profile.username}` : null;
      const formatName = handle ? `${fullName} (${handle})` : fullName;
      const label = formatName || id;

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

export async function logAudit(env, adminId, action, target, details) {
  try {
    let adminHandle = adminId.toString();
    const { results: adminRows } = await env.DB.prepare(
      "SELECT first_name, username FROM Users WHERE chat_id = ?"
    ).bind(adminId.toString()).all();
    if (adminRows && adminRows.length > 0) {
      const admin = adminRows[0];
      const fullName = admin.first_name || '';
      const handle = admin.username ? `@${admin.username}` : null;
      adminHandle = handle ? `${fullName} (${handle})` : fullName || adminId.toString();
    }

    let targetHandle = null;
    if (/^\d{6,15}$/.test(target)) {
      const { results: targetRows } = await env.DB.prepare(
        "SELECT first_name, username FROM Users WHERE chat_id = ?"
      ).bind(target.toString()).all();
      if (targetRows && targetRows.length > 0) {
        const tUser = targetRows[0];
        const fullName = tUser.first_name || '';
        const handle = tUser.username ? `@${tUser.username}` : null;
        targetHandle = handle ? `${fullName} (${handle})` : fullName || null;
      }
    }

    const timestamp = Date.now();
    await env.DB.prepare(
      "INSERT INTO Audit_Logs (timestamp, actor_id, actor_name, action, target_id, details) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(timestamp, adminId.toString(), adminHandle, action, target ? target.toString() : null, JSON.stringify({ targetHandle, details })).run();
  } catch (e) {
    console.error("Audit log failed to write:", e);
  }
}

export async function cleanupDatabase(env) {
  const now = Date.now();
  await env.DB.prepare("DELETE FROM Bot_States WHERE expires_at < ?").bind(now).run();
}
