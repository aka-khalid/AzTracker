// AzTracker Cloudflare ChatOps Router - GHOST INPUT INLINE GUI PRO
// Features: Auto-Deleting Text Inputs, Zero-Trace Callbacks, and Inline UI Editing

//const GITHUB_BRANCH = "feature/chatops-interactive-bot";
//const GITHUB_BRANCH = "feature/randomized-scheduler";

const GITHUB_BRANCH = "main";

const AMAZON_EG_MERCHANT_ID = "A1ZVRGNO5AYLOV";
const AMAZON_RESALE_MERCHANT_ID = "A2N2MP47XAP1MK";

const ALT_SELLER_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const QUEUE_MAX_DEPTH = 25;


import { AmazonEdgeParser } from './src/api/amazon';

export default {
  async scheduled(event, env, ctx) {
    console.log("Cron tick:", event.cron);
    await executeScrapeEngine(env, false);
  },

  async queue(batch, env, ctx) {
    // Native Cloudflare Queue consumer for Telegram Alerts & Broadcasts
    for (const msg of batch.messages) {
      try {
        const payload = msg.body;
        if (payload.type === 'telegram_alert') {
          await sendTelegram(env, payload.chatId, payload.text);
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

      const listRes = await env.AZTRACKER_DB.list({ prefix: "audit:" });
      const logs = [];
      for (const key of listRes.keys) {
        const parts = key.name.split(":");
        const ts = parseInt(parts[1]);
        const adminId = parts[2];
        const data = await env.AZTRACKER_DB.get(key.name, "json");
        if(data) logs.push({ ts, adminId, ...data });
      }
      logs.sort((a, b) => b.ts - a.ts); 
      return new Response(JSON.stringify(logs), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    // ---------------------------

    // --- GLOBAL PRICE MATRIX ENDPOINTS ---
    if (url.pathname === "/chart-all" && request.method === "GET") {
      const exp = url.searchParams.get("exp");
      const sig = url.searchParams.get("sig");
      if (!exp || !sig || Date.now() > parseInt(exp)) return new Response("Unauthorized", { status: 401 });
      const expectedSig = await generateSignature(env.TELEGRAM_WEBHOOK_SECRET, "all_products", exp);
      if (sig !== expectedSig) return new Response("Invalid Signature", { status: 401 });
      const html = renderGlobalChartHTML(exp, sig);
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    if (url.pathname === "/api/admin/history-all" && request.method === "GET") {
      const exp = url.searchParams.get("exp");
      const sig = url.searchParams.get("sig");
      if (!exp || !sig || Date.now() > parseInt(exp)) return new Response("Unauthorized", { status: 401 });
      const expectedSig = await generateSignature(env.TELEGRAM_WEBHOOK_SECRET, "all_products", exp);
      if (sig !== expectedSig) return new Response("Invalid Signature", { status: 401 });
      const data = await env.AZTRACKER_DB.get("global:history_all_new", "json") || [];
      return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }
    // ---------------------------

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
        await handleCallback(payload.callback_query, env, baseUrl, ctx); 
      } else if (payload.message && payload.message.text) {
        await handleMessage(payload.message, env, ctx);
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
  // 1. Fetch products needing updates from D1
  const query = force 
    ? "SELECT asin, amazon_price, used_price, new_price FROM Global_Products"
    : "SELECT asin, amazon_price, used_price, new_price FROM Global_Products WHERE last_updated < ?";
  const bindParams = force ? [] : [Date.now() - 300000];
  
  const { results: staleProducts } = await env.DB.prepare(query).bind(...bindParams).all();
  if (!staleProducts || staleProducts.length === 0) return;

  // 2. Fetch live data using aws4fetch
  const parser = new AmazonEdgeParser(env.AWS_ACCESS_KEY, env.AWS_SECRET_KEY, env.PARTNER_TAG);
  const asins = staleProducts.map(p => p.asin);
  const liveItems = await parser.getItems(asins);

  const dbBatch = [];
  const queueBatch = [];
  
  for (const liveItem of liveItems) {
    const oldItem = staleProducts.find(p => p.asin === liveItem.asin);
    const priceDelta = force || oldItem.amazon_price !== liveItem.amazonPrice || 
                       oldItem.used_price !== liveItem.usedPrice || 
                       oldItem.new_price !== liveItem.newPrice;

    if (priceDelta) {
      dbBatch.push(
        env.DB.prepare(`
          UPDATE Global_Products 
          SET amazon_price = ?, used_price = ?, new_price = ?, last_updated = ?
          WHERE asin = ?
        `).bind(liveItem.amazonPrice, liveItem.usedPrice, liveItem.newPrice, Date.now(), liveItem.asin)
      );
      
      const { results: subs } = await env.DB.prepare(
        "SELECT chat_id, target_price FROM User_Subscriptions WHERE asin = ? AND is_paused = 0"
      ).bind(liveItem.asin).all();
      
      for (const sub of subs) {
        if (sub.target_price >= liveItem.amazonPrice) {
          queueBatch.push({
            type: 'telegram_alert',
            chatId: sub.chat_id,
            text: `🚨 <b>Price Drop!</b>\nASIN ${liveItem.asin} dropped to ${liveItem.amazonPrice} EGP!`
          });
        }
      }
    }
  }

  if (dbBatch.length > 0) {
    await env.DB.batch(dbBatch);
  }
  
  for (const alert of queueBatch) {
    await env.MESSAGE_QUEUE.send(alert);
  }
}



async function handleMessage(message, env, ctx) {
  const text = convertHindiToArabic(message.text).trim();
  const chatId = message.chat.id.toString();
  const messageId = message.message_id;

  const { isRootAdmin, isAdmin, isApproved, isRejected, rootAdmins, admins, approvedUsers } = await getUserRoles(chatId, env, ctx);

  if (!isApproved) {
    if (isRejected) {
      await sendAppMessage(env, chatId, `⛔ <b>Access Denied</b>\n\nYour request to join this server has been explicitly rejected by an administrator.`);
      return;
    }
    const rawQueue = await env.AZTRACKER_DB.get("global:join_queue", "json") || [];
    const now = Date.now();
    const queue = rawQueue
      .map(entry => typeof entry === 'string' ? { id: entry, requested_at: now } : entry)
      .filter(entry => (now - entry.requested_at) < QUEUE_TTL_MS);

    if (queue.some(entry => entry.id === chatId)) {
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
    await renderMainMenu(env, chatId, null, isAdmin);
    return;
  }
  // -------------------------------

  if (activeState === 'broadcast' && isRootAdmin) {
    await env.AZTRACKER_DB.delete(stateKey);
    await deleteTelegramMessage(env, chatId, messageId);
    
    const sentMsg = await sendAppMessage(env, chatId, `⏳ <b>Broadcasting...</b>\nDispatching to queue...`);
    
    let queuedCount = 0;
    // Push the broadcast ops to the Cloudflare Queue to avoid 30s timeout
    for (const userId of approvedUsers) {
      try {
        await env.MESSAGE_QUEUE.send({
          type: 'telegram_alert',
          chatId: userId,
          text: `📢 <b>System Update</b>\n\n${text}`
        });
        queuedCount++;
      } catch (e) {
        console.error(`Queue send failed for ${userId}`);
      }
    }
    
    await editTelegramMessage(env, chatId, sentMsg.result.message_id, `✅ <b>Broadcast Queued!</b>\nSafely dispatched ${queuedCount} messages to the Edge Queue.`, {
      inline_keyboard: [[{ text: "⬅️ Back to Admin Panel", callback_data: "admin_panel" }]]
    });
    
    // AUDIT LOG
    ctx.waitUntil(logAudit(env, chatId, "BROADCAST", "ALL_USERS", `Queued broadcast to ${queuedCount} users`));
    
    return;
  }
  
  if (activeState) {
    if (activeState.startsWith("setlimit_")) {
      const targetId = activeState.replace("setlimit_", "");
      const newLimit = parseInt(text);

      if (isNaN(newLimit) || newLimit < 1) {
        await deleteTelegramMessage(env, chatId, messageId);
        await sendAppMessage(env, chatId, "⚠️ <b>Invalid limit.</b> Please enter a valid positive number.", {
          inline_keyboard: [[{ text: "⬅️ Back", callback_data: `manage_user_${targetId}` }]]
        });
        return;
      }

      await env.DB.prepare("UPDATE Users SET item_limit = ? WHERE chat_id = ?").bind(newLimit, targetId).run();
      await env.AZTRACKER_DB.delete(stateKey);
      await deleteTelegramMessage(env, chatId, messageId);

      await sendAppMessage(env, chatId, `✅ <b>Limit Updated!</b>\n\nUser <code>${targetId}</code> can now save up to <b>${newLimit}</b> items.`, {
        inline_keyboard: [[{ text: "⬅️ Back to User Card", callback_data: `manage_user_${targetId}` }]]
      });
      
      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "SET_LIMIT", targetId, `Changed item saving limit to ${newLimit}`));

      return;
    }

    const pid = activeState;
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

  if (isAdmin && isNumericId) {
    const targetId = text;
    const tgtUser = await env.DB.prepare("SELECT role, item_limit, approved_by FROM Users WHERE chat_id = ?").bind(targetId).first();
    const targetRole = tgtUser ? tgtUser.role : null;
    const isTargetRoot = rootAdmins.includes(targetId);
    const isTargetAdmin = isTargetRoot || targetRole === "admin" || admins.includes(targetId);
    const isTargetApproved = isTargetAdmin || targetRole === "approved" || approvedUsers.includes(targetId);

    const defaultLimit = parseInt(env.DEFAULT_USER_PRODUCT_LIMIT);
    const userLimit = tgtUser && tgtUser.item_limit !== null ? parseInt(tgtUser.item_limit) : (isNaN(defaultLimit) ? "⚠️ Error" : defaultLimit);
    const limitDisplay = isTargetAdmin ? "∞ (Unlimited)" : userLimit;

    const approverId = tgtUser ? tgtUser.approved_by : null;
    let approverText = "Legacy / Auto-Migrated";
    if (approverId) {
      const { label } = await resolveUserProfile(env, approverId, ctx);
      approverText = escapeHtml(label);
    } else if (!isTargetApproved) {
      approverText = "N/A (Not Approved)";
    }

    let buttons = [];
    if (isRootAdmin) {
      if (!isTargetApproved) {
        buttons.push([{ text: "✅ Approve User", callback_data: `approve_${targetId}` }]);
        buttons.push([{ text: "❌ Reject Request", callback_data: `reject_${targetId}` }]);
      }
      if (isTargetApproved && !isTargetRoot) buttons.push([{ text: "🗑️ Revoke User", callback_data: `confRevoke_${targetId}` }]);
      if (isTargetApproved && !isTargetAdmin) buttons.push([{ text: "🌟 Promote to Admin", callback_data: `confPromote_${targetId}` }]);
      if (isTargetAdmin && !isTargetRoot) buttons.push([{ text: "🔽 Demote Admin", callback_data: `confDemote_${targetId}` }]);
    } else if (isAdmin) {
      if (!isTargetApproved) {
        buttons.push([{ text: "✅ Approve User", callback_data: `approve_${targetId}` }]);
        buttons.push([{ text: "❌ Reject Request", callback_data: `reject_${targetId}` }]);
      }
      if (isTargetApproved && !isTargetAdmin) buttons.push([{ text: "🗑️ Revoke User", callback_data: `confRevoke_${targetId}` }]);
    }

    if (isTargetApproved) {
      // VERTICAL PRIVACY LOCK: Normal admins CANNOT view Root Admin products
      if (isRootAdmin || !isTargetRoot) {
         buttons.push([{ text: "📦 View User's Products", callback_data: `admProd_${targetId}` }]);
      }
      if (!isTargetAdmin) {
         buttons.push([{ text: "⚙️ Change Item Limit", callback_data: `set_limit_init_${targetId}` }]);
      }
    }

    if (buttons.length > 0) {
      const statusLabel = isTargetRoot ? "👑 Root Admin" : isTargetAdmin ? "🛡️ Admin" : isTargetApproved ? "👤 Approved User" : (targetRole === "rejected" ? "⛔ Banned User" : "🚫 Unapproved Guest");
      const statusMsg = `📋 <b>User Management Card</b>\n\n🆔 <b>ID:</b> <code>${targetId}</code>\n📊 <b>Current Status:</b> ${statusLabel}\n🛡️ <b>Approved By:</b> ${approverText}\n📦 <b>Product Limit:</b> ${limitDisplay}\n\n<i>Select an action below:</i>`;
      await sendAppMessage(env, chatId, statusMsg, { inline_keyboard: buttons });
    }
    return;
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
    const userLimit = user && user.item_limit !== null ? parseInt(user.item_limit) : parseInt(env.DEFAULT_USER_PRODUCT_LIMIT || "3");

    const { results: existingProducts } = await env.DB.prepare("SELECT asin FROM User_Subscriptions WHERE chat_id = ?").bind(chatId).all();

    if (!isAdmin) {
      if (isNaN(userLimit)) {
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
      INSERT INTO User_Subscriptions (chat_id, asin)
      VALUES (?, ?)
      ON CONFLICT(chat_id, asin) DO NOTHING
    `).bind(chatId, pid).run();


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

  if (text === "/start" || text === "/manage") {
    await deleteTelegramMessage(env, chatId, messageId);
    await renderMainMenu(env, chatId, null, isAdmin);
    return;
  }

  await deleteTelegramMessage(env, chatId, messageId);
  await sendAppMessage(env, chatId, "⚠️ <b>Invalid Command or Input Structure</b>\n\nPlease use the interactive options below or drop a valid Amazon item link.", {
    inline_keyboard: [[{ text: "🏠 Open Main Menu", callback_data: "main_menu" }]]
  });
}

async function handleCallback(callback, env, baseUrl, ctx) {
  const data = callback.data;
  const messageId = callback.message.message_id;
  const chatId = callback.message.chat.id.toString();
  
  const { isRootAdmin, isAdmin, isApproved, rootAdmins, admins, approvedUsers } = await getUserRoles(chatId, env, ctx);



  if (!isApproved && !data.startsWith("request_access_")) return;

  const userDbKey = `user:${chatId}:products`;

  try {
    if (data.startsWith("request_access_")) {
      const targetId = data.replace("request_access_", "");
      if (targetId !== chatId) return; 

      const rawQueue = await env.AZTRACKER_DB.get("global:join_queue", "json") || [];
      const now = Date.now();
      let queue = rawQueue
        .map(entry => typeof entry === 'string' ? { id: entry, requested_at: now } : entry)
        .filter(entry => (now - entry.requested_at) < QUEUE_TTL_MS);
      
      if (queue.some(entry => entry.id === chatId)) {
        await editTelegramMessage(env, chatId, messageId, `⏳ <b>Request Sent.</b>\n\nPlease wait for an administrator to review your application.`);
        return; // SEVERS THE BROADCAST LOOP FOR DUPLICATE CLICKS
      }

      if (queue.length >= QUEUE_MAX_DEPTH) {
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
      
      queue.push({ id: chatId, requested_at: now, admin_messages: admin_messages });
      await env.AZTRACKER_DB.put("global:join_queue", JSON.stringify(queue));
    }
    else if (data.startsWith("queueReject_") && isAdmin) {
      const targetId = data.replace("queueReject_", "");
      const rawQueue = await env.AZTRACKER_DB.get("global:join_queue", "json") || [];
      const now = Date.now();
      let queue = rawQueue
        .map(entry => typeof entry === 'string' ? { id: entry, requested_at: now } : entry)
        .filter(entry => (now - entry.requested_at) < QUEUE_TTL_MS);

      let queueObj = null;
      if (!queue.some(entry => {
          if (entry.id === targetId) { queueObj = entry; return true; }
          return false;
      })) {
        await editTelegramMessage(env, chatId, messageId, `⚠️ <b>Request Expired or Handled</b>\nThis application is no longer in the pending queue.`);
        return;
      }
      queue = queue.filter(entry => entry.id !== targetId);
      await env.AZTRACKER_DB.put("global:join_queue", JSON.stringify(queue));
      
      const { label: adminName } = await resolveUserProfile(env, chatId, ctx);
      await editTelegramMessage(env, chatId, messageId, `🚫 <b>Request Rejected</b>\nUser <code>${targetId}</code> has been denied access by ${escapeHtml(adminName)}.`);
      
      if (queueObj && queueObj.admin_messages) {
          for (const [admId, msgId] of Object.entries(queueObj.admin_messages)) {
              if (admId !== chatId) {
                 ctx.waitUntil(editTelegramMessage(env, admId, msgId, `🚫 <b>Request Handled</b>\nUser <code>${targetId}</code> was rejected by ${escapeHtml(adminName)}.`));
              }
          }
      }
      
      await env.DB.prepare(`
         INSERT INTO Users (chat_id, role, approved_by, item_limit)
         VALUES (?, 'rejected', ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET role = 'rejected'
      `).bind(targetId, chatId, env.DEFAULT_USER_PRODUCT_LIMIT || "3").run();

      await sendTelegram(env, targetId, `⛔ <b>Access Request Denied</b>\n\nYour request to join the server has been declined by an administrator.`);
      
      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "REJECT_USER", targetId, "Rejected via Join Queue"));
    }
    else if (data.startsWith("queueApprove_") && isAdmin) {
      const targetId = data.replace("queueApprove_", "");
      const rawQueue = await env.AZTRACKER_DB.get("global:join_queue", "json") || [];
      const now = Date.now();
      let queue = rawQueue
        .map(entry => typeof entry === 'string' ? { id: entry, requested_at: now } : entry)
        .filter(entry => (now - entry.requested_at) < QUEUE_TTL_MS);

      let queueObj = null;
      if (!queue.some(entry => {
          if (entry.id === targetId) { queueObj = entry; return true; }
          return false;
      })) {
        await editTelegramMessage(env, chatId, messageId, `⚠️ <b>Request Expired or Handled</b>\nThis application is no longer in the pending queue.`);
        return;
      }
      queue = queue.filter(entry => entry.id !== targetId);
      await env.AZTRACKER_DB.put("global:join_queue", JSON.stringify(queue));
      
      await env.DB.prepare(`
         INSERT INTO Users (chat_id, role, approved_by, item_limit)
         VALUES (?, 'approved', ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET role = 'approved', approved_by = excluded.approved_by
      `).bind(targetId, chatId, env.DEFAULT_USER_PRODUCT_LIMIT || "3").run();
      
      const { label: adminName } = await resolveUserProfile(env, chatId, ctx);
      await editTelegramMessage(env, chatId, messageId, `✅ <b>Approved!</b>\nUser <code>${targetId}</code> was approved by ${escapeHtml(adminName)}.`);

      if (queueObj && queueObj.admin_messages) {
          for (const [admId, msgId] of Object.entries(queueObj.admin_messages)) {
              if (admId !== chatId) {
                 ctx.waitUntil(editTelegramMessage(env, admId, msgId, `✅ <b>Request Handled</b>\nUser <code>${targetId}</code> was approved by ${escapeHtml(adminName)}.`));
              }
          }
      }
      
      const defaultLimit = env.DEFAULT_USER_PRODUCT_LIMIT || "5";
      const welcomeMessage = `🎉 <b>You have been approved! Welcome!</b>\n\nHere is a quick step-by-step guide on how to let the bot do the heavy lifting for your Amazon.eg shopping.\n\n<b>1️⃣ Find your item</b>\nOpen the Amazon app or website and find the product you want to buy.\n\n<b>2️⃣ Share the link</b>\nThe easiest way: In the Amazon app, hit the <b>Share</b> button, select Telegram, and send it directly to this bot! (You can also just copy and paste the link into the chat).\n\n<b>3️⃣ Set a Target Price (Optional)</b>\nIf you only want alerts for a specific price, click the <i>🎯 Set Target</i> button after adding your item. The bot will stay quiet until the price drops to or below your exact target!\n\n<b>4️⃣ Relax & Wait</b>\nThe bot will continuously monitor the market in the background. It will automatically notify you of major price drops, restocks, and even cheaper Amazon Resale (Used) alternatives.\n\n<b>5️⃣ The Item Limit</b>\nTo keep the servers from catching fire, everyone starts with a limit of <b>${defaultLimit}</b> saved items. If you desperately need to save more, you'll have to secretly bribe whichever admin invited you (coffee and a good shawarma usually do the trick 😉).\n\n<i>💡 Pro-Tip: You can always click "📦 My Products" from the Main Menu to view beautiful price history charts for your items or pause checking on things you've already bought.</i>\n\nHappy shopping! 🛒\n\n<i>"As an Amazon Associate I earn from qualifying purchases."</i>`;
      
      await sendTelegram(env, targetId, welcomeMessage);
      
      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "APPROVE_USER", targetId, "Approved via Join Queue"));
    }
    else if (data.startsWith("confRevoke_") && isAdmin) {
      const targetId = data.replace("confRevoke_", "");
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
         INSERT INTO Users (chat_id, role, approved_by, item_limit)
         VALUES (?, 'rejected', ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET role = 'rejected'
      `).bind(targetId, chatId, env.DEFAULT_USER_PRODUCT_LIMIT || "3").run();
      
      await editTelegramMessage(env, chatId, messageId, `🚫 <b>Request Rejected</b>\nUser <code>${targetId}</code> has been explicitly denied access.`);
      await sendTelegram(env, targetId, `⛔ <b>Access Request Denied</b>\n\nYour request to join the server has been declined by an administrator.`);
      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "REJECT_USER", targetId, "Manually rejected access"));
    }
    else if (data.startsWith("unban_") && isAdmin) {
      const targetId = data.replace("unban_", "");
      
      await env.DB.prepare("DELETE FROM Users WHERE chat_id = ? AND role = 'rejected'").bind(targetId).run();
      
      await editTelegramMessage(env, chatId, messageId, `🔄 <b>User Unbanned</b>\nUser <code>${targetId}</code> has been removed from the Banned Directory. They can now send /start to request access again if they wish.`, {
        inline_keyboard: [[{ text: "⬅️ Back to Directory", callback_data: "list_banned_0" }]]
      });
      
      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "UNBAN_USER", targetId, "Removed from banned directory"));
    }
    else if (data.startsWith("approve_") && isAdmin) {
      const targetId = data.replace("approve_", "");
      if (!approvedUsers.includes(targetId)) {
        approvedUsers.push(targetId);
        await env.AZTRACKER_DB.put("global:approved_users", JSON.stringify(approvedUsers));
      }
      // Write the authoritative key out-of-band to prevent TOCTOU array overwrites
      await env.AZTRACKER_DB.put(`auth:${targetId}`, "approved");
      await env.AZTRACKER_DB.put(`approved_by:${targetId}`, chatId);
      
      let bannedUsers = await env.AZTRACKER_DB.get("global:banned_users", "json") || [];
      if (bannedUsers.includes(targetId)) {
        bannedUsers = bannedUsers.filter(id => id !== targetId);
        await env.AZTRACKER_DB.put("global:banned_users", JSON.stringify(bannedUsers));
      }
      await editTelegramMessage(env, chatId, messageId, `✅ <b>Approved!</b>\nUser <code>${targetId}</code> can now use the Amazon deals application.`);
      
      const defaultLimit = env.DEFAULT_USER_PRODUCT_LIMIT || "5";
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
      if (admins.includes(targetId) && !isRootAdmin) return;

      // If a Root Admin is revoking an Admin directly, clean the admin array
      if (admins.includes(targetId)) {
        const updatedAdmins = admins.filter(id => id !== targetId);
        await env.AZTRACKER_DB.put("global:admins", JSON.stringify(updatedAdmins));
      }
      
      const updatedUsers = approvedUsers.filter(id => id !== targetId);
      await env.AZTRACKER_DB.put("global:approved_users", JSON.stringify(updatedUsers));
      await env.AZTRACKER_DB.delete(`auth:${targetId}`);
      
      await env.AZTRACKER_DB.delete(`user:${targetId}:products`);
      
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
        inline_keyboard: [[{ text: "⬅️ Back to Directory", callback_data: "list_users" }]]
      });
      await sendTelegram(env, targetId, `🌟 <b>You have been promoted to Admin!</b>\nYou now have authorization to approve users. Run /start to see the admin features.`);
      
      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "PROMOTE_ADMIN", targetId, "Elevated to full Admin privileges"));
    }
    else if (data.startsWith("demote_") && isRootAdmin) {
      const targetId = data.replace("demote_", "");
      const updatedAdmins = admins.filter(id => id !== targetId);
      await env.AZTRACKER_DB.put("global:admins", JSON.stringify(updatedAdmins));
      await env.AZTRACKER_DB.put(`auth:${targetId}`, "approved");
      
      // CRITICAL FIX: Bust the edge cache for both the caller and the target
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${chatId}`)));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      }
      
      await editTelegramMessage(env, chatId, messageId, `🔽 <b>Demoted.</b>\nID <code>${targetId}</code> has returned to standard access tier.`, {
        inline_keyboard: [[{ text: "⬅️ Back to Directory", callback_data: "list_users" }]]
      });
      
      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "DEMOTE_ADMIN", targetId, "Demoted to standard access tier"));
    }
    else if (data === "main_menu") {
      await env.AZTRACKER_DB.delete(`state:${chatId}`);
      await renderMainMenu(env, chatId, messageId, isAdmin);
    }
    else if (data.startsWith("list_products_")) {
      const page = parseInt(data.replace("list_products_", "")) || 0;
      await renderProductList(env, chatId, messageId, page);
    }
    else if (data === "ignore") {
      return;
    }
    else if (data === "admin_panel" && isAdmin) {
      await env.AZTRACKER_DB.delete(`state:${chatId}`);
      const approvedGuests = approvedUsers.filter(id => !admins.includes(id) && !rootAdmins.includes(id));
      const stats = await env.AZTRACKER_DB.get("global:stats", "json") || { active_api_calls: 0, hivemind_size: 0 };
      
      let lastRunText = "Fetching from GitHub...";
      const ghRun = await fetchLastWorkflowRun(env);
      
      if (ghRun && ghRun.updated_at) {
          const date = new Date(ghRun.updated_at);
          const timeStr = date.toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo", hour: '2-digit', minute:'2-digit' });
          const stateTag = ghRun.status === "in_progress" ? " <i>(🔄 Running...)</i>" : "";
          lastRunText = `${timeStr}${stateTag}`;
      }
      
      const globalLimit = env.GLOBAL_POOL_LIMIT || "450";
      
      let text = `👑 <b>Admin Dashboard</b>\n\n` +
             `👥 <b>Approved Guests:</b> ${approvedGuests.length}\n` +
             `🛡️ <b>Admins:</b> ${admins.length + rootAdmins.length}\n\n` +
             `📡 <b>Active Watch Pool:</b> ${stats.active_api_calls} / ${globalLimit}\n` +
             `🗄️ <b>Global Database:</b> ${stats.hivemind_size} ASINs\n` +
             `⏱️ <b>Last Engine Run:</b> ${lastRunText}\n\n` +
             `💡 <b>Manage access:</b>\nBrowse approved users below, or paste a Telegram ID directly into the chat.`;
      

      let adminButtons = [
        [{ text: "👥 Manage Users Directory", callback_data: "admin_users_menu" }]
      ];
      
      if (isRootAdmin) {
        adminButtons.push([{ text: "📢 Broadcast Message", callback_data: "broadcast_init" }]);
        // AUDIT LOG SIEM INJECTION
        const exp = Date.now() + (2 * 60 * 60 * 1000);
        const sig = await generateSignature(env.TELEGRAM_WEBHOOK_SECRET, "audit", exp);
        adminButtons.push([{ text: "🕵️ Security Audit Log", web_app: { url: `${baseUrl}/audit?exp=${exp}&sig=${sig}` } }]);
        
        const sigAll = await generateSignature(env.TELEGRAM_WEBHOOK_SECRET, "all_products", exp);
        adminButtons.push([{ text: "📈 Global Price Matrix", web_app: { url: `${baseUrl}/chart-all?exp=${exp}&sig=${sigAll}` } }]);
      }
      
      adminButtons.push([{ text: "🏠 Back to Main Menu", callback_data: "main_menu" }]);

      await editTelegramMessage(env, chatId, messageId, text, { inline_keyboard: adminButtons });
    }
    else if (data === "admin_users_menu" && isAdmin) {
      await env.AZTRACKER_DB.delete(`state:${chatId}`);
      let text = `👥 <b>User Management Directory</b>\n\nSelect a category below to browse users.`;
      let buttons = [
        [{ text: "⏳ View Pending Requests", callback_data: "list_pending_0" }],
        [{ text: "✅ View Approved Users", callback_data: "list_users_0" }],
        [{ text: "🚫 View Banned Users", callback_data: "list_banned_0" }],
        [{ text: "⬅️ Back to Admin Panel", callback_data: "admin_panel" }]
      ];
      await editTelegramMessage(env, chatId, messageId, text, { inline_keyboard: buttons });
    }
    else if (data === "broadcast_init" && isRootAdmin) {
      await env.AZTRACKER_DB.put(`state:${chatId}`, 'broadcast', { expirationTtl: 300 });
      const text = `📢 <b>Broadcast Mode</b>\n\nPlease type the exact message you want to send to all approved users.\n\n<i>(HTML formatting is supported)</i>`;
      await editTelegramMessage(env, chatId, messageId, text, {
        inline_keyboard: [[{ text: "❌ Cancel", callback_data: "admin_panel" }]]
      });
    }
    else if (data.startsWith("list_users") && isAdmin) {
      const parts = data.split("_");
      const page = parts[2] ? parseInt(parts[2]) : 0; 
      await renderUserList(env, chatId, messageId, page, ctx);
    }
    else if (data.startsWith("list_pending_") && isAdmin) {
      const page = parseInt(data.replace("list_pending_", "")) || 0;
      await renderPendingList(env, chatId, messageId, page, ctx);
    }
    else if (data.startsWith("list_banned_") && isAdmin) {
      const page = parseInt(data.replace("list_banned_", "")) || 0;
      await renderBannedList(env, chatId, messageId, page, ctx);
    }
    else if (data.startsWith("manage_user_") && isAdmin) {
      await env.AZTRACKER_DB.delete(`state:${chatId}`);
      const targetId = data.replace("manage_user_", "");
      const tgtUser = await env.DB.prepare("SELECT role, item_limit, approved_by FROM Users WHERE chat_id = ?").bind(targetId).first();
    const targetRole = tgtUser ? tgtUser.role : null;
    const isTargetRoot = rootAdmins.includes(targetId);
    const isTargetAdmin = isTargetRoot || targetRole === "admin" || admins.includes(targetId);
    const isTargetApproved = isTargetAdmin || targetRole === "approved" || approvedUsers.includes(targetId);

    const defaultLimit = parseInt(env.DEFAULT_USER_PRODUCT_LIMIT);
    const userLimit = tgtUser && tgtUser.item_limit !== null ? parseInt(tgtUser.item_limit) : (isNaN(defaultLimit) ? "⚠️ Error" : defaultLimit);
    const limitDisplay = isTargetAdmin ? "∞ (Unlimited)" : userLimit;

    const approverId = tgtUser ? tgtUser.approved_by : null;
      let approverText = "Legacy / Auto-Migrated";
      if (approverId) {
        const { label } = await resolveUserProfile(env, approverId, ctx);
        approverText = escapeHtml(label);
      } else if (!isTargetApproved) {
        approverText = "N/A (Not Approved)";
      }

      let buttons = [];
      if (isRootAdmin) {
        if (!isTargetApproved) {
          buttons.push([{ text: "✅ Approve User", callback_data: `approve_${targetId}` }]);
          if (targetRole === "rejected") buttons.push([{ text: "🔄 Unban User", callback_data: `unban_${targetId}` }]);
          else buttons.push([{ text: "❌ Reject Request", callback_data: `reject_${targetId}` }]);
        }
        if (isTargetApproved && !isTargetRoot) buttons.push([{ text: "🗑️ Revoke User", callback_data: `confRevoke_${targetId}` }]);
        if (isTargetApproved && !isTargetAdmin) buttons.push([{ text: "🌟 Promote to Admin", callback_data: `confPromote_${targetId}` }]);
        if (isTargetAdmin && !isTargetRoot) buttons.push([{ text: "🔽 Demote Admin", callback_data: `confDemote_${targetId}` }]);
      } else if (isAdmin) {
        if (!isTargetApproved) {
          buttons.push([{ text: "✅ Approve User", callback_data: `approve_${targetId}` }]);
          if (targetRole === "rejected") buttons.push([{ text: "🔄 Unban User", callback_data: `unban_${targetId}` }]);
          else buttons.push([{ text: "❌ Reject Request", callback_data: `reject_${targetId}` }]);
        }
        if (isTargetApproved && !isTargetAdmin) buttons.push([{ text: "🗑️ Revoke User", callback_data: `confRevoke_${targetId}` }]);
      }
      
      if (isTargetApproved) {
        // VERTICAL PRIVACY LOCK: Normal admins CANNOT view Root Admin products
        if (isRootAdmin || !isTargetRoot) {
           buttons.push([{ text: "📦 View User's Products", callback_data: `admProd_${targetId}` }]);
        }
        if (!isTargetAdmin) {
           buttons.push([{ text: "⚙️ Change Item Limit", callback_data: `set_limit_init_${targetId}` }]);
        }
      }
      let backCb = "admin_users_menu";
      if (targetRole === "rejected") backCb = "list_banned_0";
      else if (isTargetApproved) backCb = "list_users_0";
      else backCb = "list_pending_0";
      
      buttons.push([{ text: "⬅️ Back to Directory", callback_data: backCb }]);

      const statusLabel = isTargetRoot ? "👑 Root Admin" : isTargetAdmin ? "🛡️ Admin" : isTargetApproved ? "👤 Approved User" : (targetRole === "rejected" ? "⛔ Banned User" : "🚫 Unapproved Guest");
      const statusMsg = `📋 <b>User Management Card</b>\n\n🆔 <b>ID:</b> <code>${targetId}</code>\n📊 <b>Current Status:</b> ${statusLabel}\n🛡️ <b>Approved By:</b> ${approverText}\n📦 <b>Product Limit:</b> ${limitDisplay}\n\n<i>Select an action below:</i>`;
      await editTelegramMessage(env, chatId, messageId, statusMsg, { inline_keyboard: buttons });
    }
    else if (data.startsWith("set_limit_init_") && isAdmin) {
      const targetId = data.replace("set_limit_init_", "");
      await env.AZTRACKER_DB.put(`state:${chatId}`, `setlimit_${targetId}`, { expirationTtl: 300 });

      const limitRaw = await env.AZTRACKER_DB.get(`limit:${targetId}`);
      const defaultLimit = parseInt(env.DEFAULT_USER_PRODUCT_LIMIT);
      const userLimit = limitRaw !== null ? parseInt(limitRaw) : (isNaN(defaultLimit) ? "⚠️ Error" : defaultLimit);

      const text = `⚙️ <b>Set Item Limit</b>\n\nUser ID: <code>${targetId}</code>\nCurrent Limit: <b>${userLimit}</b>\n\nPlease type the new maximum number of products this user can save.`;
      await editTelegramMessage(env, chatId, messageId, text, {
        inline_keyboard: [[{ text: "❌ Cancel", callback_data: `manage_user_${targetId}` }]]
      });
    }
    else if (data.startsWith("admProd_") && isAdmin) {
      const parts = data.split("_");
      const targetId = parts[1];
      if (!isRootAdmin && rootAdmins.includes(targetId)) return; // IDOR Protection
      const page = parts[2] ? parseInt(parts[2]) : 0; 
      await renderAdminUserProducts(env, chatId, messageId, targetId, page);
    }
    else if (data.startsWith("admView_") && isAdmin) {
      const parts = data.split("_");
      const targetId = parts[1];
      if (!isRootAdmin && rootAdmins.includes(targetId)) return; // IDOR Protection
      const pid = parts[2];
      await renderAdminProductView(env, chatId, messageId, targetId, pid, baseUrl, isRootAdmin, admins, rootAdmins);
    }
    else if (data.startsWith("admTog_") && isAdmin) {
      const parts = data.split("_");
      const targetId = parts[1];
      if (!isRootAdmin && (admins.includes(targetId) || rootAdmins.includes(targetId))) return; // Horizontal Write Protection
      const pid = parts[2];
      const targetDbKey = `user:${targetId}:products`;
      let products = await env.AZTRACKER_DB.get(targetDbKey, "json") || [];
      const idx = products.findIndex(p => getAsinFromUrl(p.url) === pid);
      if (idx !== -1) {
        products[idx].paused = !products[idx].paused;
        await env.AZTRACKER_DB.put(targetDbKey, JSON.stringify(products));
      }
      await renderAdminProductView(env, chatId, messageId, targetId, pid, baseUrl, isRootAdmin, admins, rootAdmins);
      
      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "FORCE_TOGGLE", pid, `Toggled checking status for user ${targetId}`));
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
    else if (data.startsWith("admConfDel_") && isAdmin) {
      const parts = data.split("_");
      const targetId = parts[1];
      if (!isRootAdmin && (admins.includes(targetId) || rootAdmins.includes(targetId))) return; // Horizontal Write Protection
      const pid = parts[2];
      const text = `⚠️ <b>Confirm Admin Deletion</b>\n\nAre you sure you want to force-delete ASIN <code>${pid}</code> from user <code>${targetId}</code>'s registry?\n\n<i>This action cannot be undone.</i>`;
      
      await editTelegramMessage(env, chatId, messageId, text, {
        inline_keyboard: [
          [{ text: "✅ Yes, Force Delete", callback_data: `admDel_${targetId}_${pid}` }],
          [{ text: "❌ Cancel", callback_data: `admView_${targetId}_${pid}` }]
        ]
      });
    }
    else if (data.startsWith("admDel_") && isAdmin) {
      const parts = data.split("_");
      const targetId = parts[1];
      if (!isRootAdmin && (admins.includes(targetId) || rootAdmins.includes(targetId))) return; // Horizontal Write Protection
      const pid = parts[2];
      const targetDbKey = `user:${targetId}:products`;
      let products = await env.AZTRACKER_DB.get(targetDbKey, "json") || [];
      const filtered = products.filter(p => getAsinFromUrl(p.url) !== pid);
      await env.AZTRACKER_DB.put(targetDbKey, JSON.stringify(filtered));
      
      await editTelegramMessage(env, chatId, messageId, `🗑️ <b>Admin Override: Product Deleted</b>\n\nASIN <code>${pid}</code> has been completely removed from user <code>${targetId}</code>'s active register.`, {
        inline_keyboard: [[{ text: "⬅️ Back to User's Products", callback_data: `admProd_${targetId}` }]]
      });
      
      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "FORCE_DELETE_PRODUCT", pid, `Forcefully removed ASIN from user ${targetId}`));
    }
    else if (data === "global_track" && isAdmin) {
      const lastTrigger = await env.AZTRACKER_DB.get("global:last_trigger");
      const now = Date.now();
      const cooldown = 10 * 60 * 1000;

      if (lastTrigger && (now - parseInt(lastTrigger)) < cooldown) {
          const remaining = Math.ceil((cooldown - (now - parseInt(lastTrigger))) / 60000);
          await editTelegramMessage(env, chatId, messageId,
              `⏳ <b>Cooldown Active</b>\n\nNext check available in <b>${remaining} minute(s)</b>.`, {
              inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "main_menu" }]]
          });
          return;
      }
      await env.AZTRACKER_DB.put("global:last_trigger", now.toString(), { expirationTtl: 700 });
      
      await editTelegramMessage(env, chatId, messageId, "⏳ <b>Manual scrape initiated in the background...</b>\nChecking prices across all global products.", {
        inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "main_menu" }]]
      });
      
      ctx.waitUntil(executeScrapeEngine(env, true));
      ctx.waitUntil(logAudit(env, chatId, "FORCE_CHECK", "executeScrapeEngine", "Initiated manual asynchronous Edge scraper"));
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
    else if (data.startsWith("remove_")) {
      const pid = data.replace("remove_", "");
      
      await env.DB.prepare("DELETE FROM User_Subscriptions WHERE chat_id = ? AND asin = ?").bind(chatId, pid).run();
      
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

async function renderAdminUserProducts(env, chatId, messageId, targetId, page = 0) {
  const { results: products } = await env.DB.prepare(
    `SELECT s.asin, s.is_paused, s.target_price, p.name 
     FROM User_Subscriptions s 
     JOIN Global_Products p ON s.asin = p.asin 
     WHERE s.chat_id = ?`
  ).bind(targetId).all();

  if (!products || products.length === 0) {
    const text = `📦 <b>User Items List (ID: <code>${targetId}</code>)</b>\n\nThis user currently has no active or paused products in their database.`;
    const keyboard = { inline_keyboard: [[{ text: "⬅️ Back to User Card", callback_data: `manage_user_${targetId}` }]] };
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
    keyboard.inline_keyboard.push([{ text: `${statusIcon} ${targetIcon}${name}`, callback_data: `admView_${targetId}_${p.asin}` }]);
  });

  if (totalPages > 1) {
    let navRow = [];
    if (page > 0) {
      navRow.push({ text: "⬅️ Prev", callback_data: `admProd_${targetId}_${page - 1}` });
    }
    navRow.push({ text: `📄 ${page + 1}/${totalPages}`, callback_data: "ignore" });
    if (page < totalPages - 1) {
      navRow.push({ text: "Next ➡️", callback_data: `admProd_${targetId}_${page + 1}` });
    }
    keyboard.inline_keyboard.push(navRow);
  }

  keyboard.inline_keyboard.push([{ text: "⬅️ Back to User Card", callback_data: `manage_user_${targetId}` }]);

  const text = `📦 <b>User Items List (ID: <code>${targetId}</code>)</b>\nPage ${page + 1} of ${totalPages}\n\n<i>Select an item below to manage it on behalf of the user:</i>`;
  await editTelegramMessage(env, chatId, messageId, text, keyboard);
}

async function renderAdminProductView(env, chatId, messageId, targetId, pid, baseUrl, isRootAdmin, admins, rootAdmins) {
  const product = await env.DB.prepare(
    `SELECT s.asin, s.is_paused as paused, s.target_price, p.name as name, 
            p.amazon_price, p.used_price, p.new_price, p.last_updated 
     FROM User_Subscriptions s 
     JOIN Global_Products p ON s.asin = p.asin 
     WHERE s.chat_id = ? AND s.asin = ?`
  ).bind(targetId, pid).first();

  if (!product) return;
  const prices = { [pid]: { new_price: product.amazon_price, used_price: product.used_price, name: product.name } };

  const statusStr = product.paused ? "⏸️ Paused" : "✅ Active";
  let lastPrice = "⏳ Waiting for next automated check...";
  let lastUpdated = ""; 
  let sellerInfo = "";
  let smartAlts = "";
  let title = product.name ? product.name : "Amazon Product";

  const stats = await env.AZTRACKER_DB.get("global:stats", "json");
  const systemCheckTime = stats ? stats.last_run_timestamp : null;

  if (prices[pid]) {
    if (typeof prices[pid] === 'object') {
      let pData = prices[pid];
      let newPrice = pData.new_price !== undefined ? pData.new_price : pData.price;
      let newSeller = pData.new_seller || pData.seller;
      let usedPrice = pData.used_price;
      let usedSeller = pData.used_seller;

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
  if (env.AMZN_ASSOCIATES_TAG) queryParams.set("tag", env.AMZN_ASSOCIATES_TAG);
  const queryString = queryParams.toString();
  if (queryString) productUrl += `?${queryString}`;

  const text = `🛡️ <b>Admin Product Override</b> (User: <code>${targetId}</code>)\n\n` +
               `📦 <b>${cleanTitle}</b>\n` +
               `└ 🆔 <code>${pid}</code>\n\n` +
               `💰 <b>Price:</b> ${lastPrice}` +
               `${targetText}` +
               `${sellerInfo}` +
               `${smartAlts}\n\n` +
               `📡 <b>Status:</b> ${statusStr}${lastUpdated}\n\n#ad`;

  // HORIZONTAL READ-ONLY AUDITING: Strip write buttons if caller shouldn't have access
  const isTargetAdmin = admins.includes(targetId) || rootAdmins.includes(targetId);
  const canWrite = isRootAdmin || !isTargetAdmin;

  let inline_keyboard = [
    [{ text: "🛒 Open in Amazon.eg", url: productUrl }]
  ];

  if (canWrite) {
    inline_keyboard.push([{ text: product.paused ? "▶️ Force Resume" : "⏸️ Force Pause", callback_data: `admTog_${targetId}_${pid}` }]);
  }

  inline_keyboard.push([{ text: "📊 View Stats & History", web_app: { url: `${baseUrl}/chart/${pid}` } }]);

  if (canWrite) {
    inline_keyboard.push([{ text: "🗑️ Force Delete", callback_data: `admConfDel_${targetId}_${pid}` }]);
  }

  inline_keyboard.push([{ text: "⬅️ Back to User's List", callback_data: `admProd_${targetId}_0` }]);

  const keyboard = { inline_keyboard };

  await editTelegramMessage(env, chatId, messageId, text, keyboard);
}

async function renderUserList(env, chatId, messageId, page = 0, ctx) {
  // 1. Merge legacy arrays and new atomic keys dynamically
  const legacyApproved = await env.AZTRACKER_DB.get("global:approved_users", "json") || [];
  const bannedUsers = await env.AZTRACKER_DB.get("global:banned_users", "json") || [];
  const listRes = await env.AZTRACKER_DB.list({ prefix: "auth:" });
  const authUsers = listRes.keys.map(k => k.name.replace("auth:", ""));

  // RBAC Directory Scoping: Fetch cached roles
  const { admins, rootAdmins } = await getUserRoles(chatId, env, ctx);

  // CRITICAL FIX: Combine arrays and inject rootAdmins to make them visible
  const allApproved = [...new Set([...legacyApproved, ...authUsers, ...rootAdmins])];

  // CRITICAL FIX: Strip the caller's own card AND explicitly banned users
  const visibleUsers = allApproved.filter(id => id !== chatId && !bannedUsers.includes(id));

  if (visibleUsers.length === 0) {
    const text = `👥 <b>Approved Users Directory</b>\n\nNo other profile records exist in the database right now.`;
    const keyboard = { inline_keyboard: [[{ text: "⬅️ Back to Directory", callback_data: "admin_users_menu" }]] };
    await editTelegramMessage(env, chatId, messageId, text, keyboard);
    return;
  }

  const ITEMS_PER_PAGE = 5;
  const totalPages = Math.ceil(visibleUsers.length / ITEMS_PER_PAGE);
  if (page >= totalPages) page = Math.max(0, totalPages - 1);

  const pagedUsers = visibleUsers.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);

  // 2. EDGE-CACHED RESOLUTION: Parallel fetch wrapped in Cloudflare's cache
  const resolvedUsers = await Promise.all(pagedUsers.map(id => resolveUserProfile(env, id, ctx)));

  const keyboard = { inline_keyboard: [] };

  resolvedUsers.forEach((user) => {
    // Dynamic Identity Badging
    let icon = "👤";
    if (rootAdmins.includes(user.id)) icon = "👑";
    else if (admins.includes(user.id)) icon = "🛡️";

    keyboard.inline_keyboard.push([{ text: `${icon} ${user.label}`, callback_data: `manage_user_${user.id}` }]);
  });

  if (totalPages > 1) {
    let navRow = [];
    if (page > 0) {
      navRow.push({ text: "⬅️ Prev", callback_data: `list_users_${page - 1}` });
    }
    navRow.push({ text: `📄 ${page + 1}/${totalPages}`, callback_data: "ignore" });
    if (page < totalPages - 1) {
      navRow.push({ text: "Next ➡️", callback_data: `list_users_${page + 1}` });
    }
    keyboard.inline_keyboard.push(navRow);
  }

  keyboard.inline_keyboard.push([{ text: "⬅️ Back to Directory", callback_data: "admin_users_menu" }]);

  const text = `👥 <b>Approved Users Register</b> (Page ${page + 1} of ${totalPages})\n\nSelect an active profile record below to open its structural permissions card inline:`;
  await editTelegramMessage(env, chatId, messageId, text, keyboard);
}

async function renderPendingList(env, chatId, messageId, page = 0, ctx) {
  const rawQueue = await env.AZTRACKER_DB.get("global:join_queue", "json") || [];
  const now = Date.now();
  const queue = rawQueue
    .map(entry => typeof entry === 'string' ? { id: entry, requested_at: now } : entry)
    .filter(entry => (now - entry.requested_at) < QUEUE_TTL_MS);

  if (queue.length === 0) {
    const text = `⏳ <b>Pending Requests</b>\n\nThere are no pending join requests right now.`;
    const keyboard = { inline_keyboard: [[{ text: "⬅️ Back to Directory", callback_data: "admin_users_menu" }]] };
    await editTelegramMessage(env, chatId, messageId, text, keyboard);
    return;
  }

  const ITEMS_PER_PAGE = 5;
  const totalPages = Math.ceil(queue.length / ITEMS_PER_PAGE);
  if (page >= totalPages) page = Math.max(0, totalPages - 1);

  const pagedUsers = queue.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);
  const resolvedUsers = await Promise.all(pagedUsers.map(entry => resolveUserProfile(env, entry.id, ctx)));

  const keyboard = { inline_keyboard: [] };
  resolvedUsers.forEach((user) => {
    keyboard.inline_keyboard.push([{ text: `⏳ ${user.label} (${user.id})`, callback_data: `manage_user_${user.id}` }]);
  });

  if (totalPages > 1) {
    let navRow = [];
    if (page > 0) navRow.push({ text: "⬅️ Prev", callback_data: `list_pending_${page - 1}` });
    navRow.push({ text: `📄 ${page + 1}/${totalPages}`, callback_data: "ignore" });
    if (page < totalPages - 1) navRow.push({ text: "Next ➡️", callback_data: `list_pending_${page + 1}` });
    keyboard.inline_keyboard.push(navRow);
  }

  keyboard.inline_keyboard.push([{ text: "⬅️ Back to Directory", callback_data: "admin_users_menu" }]);

  const text = `⏳ <b>Pending Requests</b> (Page ${page + 1} of ${totalPages})\n\nSelect a user below to open their structural permissions card inline:`;
  await editTelegramMessage(env, chatId, messageId, text, keyboard);
}

async function renderBannedList(env, chatId, messageId, page = 0, ctx) {
  const bannedUsers = await env.AZTRACKER_DB.get("global:banned_users", "json") || [];

  if (bannedUsers.length === 0) {
    const text = `🚫 <b>Banned Users Directory</b>\n\nThere are no banned users right now.`;
    const keyboard = { inline_keyboard: [[{ text: "⬅️ Back to Directory", callback_data: "admin_users_menu" }]] };
    await editTelegramMessage(env, chatId, messageId, text, keyboard);
    return;
  }

  const ITEMS_PER_PAGE = 5;
  const totalPages = Math.ceil(bannedUsers.length / ITEMS_PER_PAGE);
  if (page >= totalPages) page = Math.max(0, totalPages - 1);

  const pagedUsers = bannedUsers.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);
  const resolvedUsers = await Promise.all(pagedUsers.map(id => resolveUserProfile(env, id, ctx)));

  const keyboard = { inline_keyboard: [] };
  resolvedUsers.forEach((user) => {
    keyboard.inline_keyboard.push([{ text: `🚫 ${user.label} (${user.id})`, callback_data: `manage_user_${user.id}` }]);
  });

  if (totalPages > 1) {
    let navRow = [];
    if (page > 0) navRow.push({ text: "⬅️ Prev", callback_data: `list_banned_${page - 1}` });
    navRow.push({ text: `📄 ${page + 1}/${totalPages}`, callback_data: "ignore" });
    if (page < totalPages - 1) navRow.push({ text: "Next ➡️", callback_data: `list_banned_${page + 1}` });
    keyboard.inline_keyboard.push(navRow);
  }

  keyboard.inline_keyboard.push([{ text: "⬅️ Back to Directory", callback_data: "admin_users_menu" }]);

  const text = `🚫 <b>Banned Users Directory</b> (Page ${page + 1} of ${totalPages})\n\nSelect a user below to open their structural permissions card inline:`;
  await editTelegramMessage(env, chatId, messageId, text, keyboard);
}

async function renderMainMenu(env, chatId, messageId = null, isAdmin = false) {
  const userDbKey = `user:${chatId}:products`;
  const limitKey = `limit:${chatId}`;

  const [productsRaw, limitRaw] = await Promise.all([
      env.AZTRACKER_DB.get(userDbKey, "json"),
      env.AZTRACKER_DB.get(limitKey)
  ]);

  const products = productsRaw || [];
  let limitText = "∞";

  if (!isAdmin) {
    const defaultLimit = parseInt(env.DEFAULT_USER_PRODUCT_LIMIT);
    if (!isNaN(defaultLimit)) {
        limitText = limitRaw !== null ? parseInt(limitRaw) : defaultLimit;
    } else {
        limitText = "⚠️ Error";
    }
  }

  const total = products.length;
  const active = products.filter(p => !p.paused).length;
  const paused = total - active;

  const text = `🏠 <b>Deals Dashboard</b>\n\n📦 <b>Your Saved Items:</b> ${total} / ${limitText}\n⚡ <b>Active:</b> ${active} | ⏸️ <b>Paused:</b> ${paused}\n\n<i>Select an operative option below:</i>`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "📦 My Products", callback_data: "list_products_0" }],
      [{ text: "➕ How to Add Products", callback_data: "help_add" }]
    ]
  };

  if (isAdmin) {
    keyboard.inline_keyboard.push([{ text: "🚀 Force Price Check", callback_data: "global_track" }]);
    keyboard.inline_keyboard.push([{ text: "👑 Admin Panel", callback_data: "admin_panel" }]);
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

  const stats = await env.AZTRACKER_DB.get("global:stats", "json");
  const systemCheckTime = stats ? stats.last_run_timestamp : null;

  if (prices[pid]) {
    if (typeof prices[pid] === 'object') {
      let pData = prices[pid];
      let newPrice = pData.new_price !== undefined ? pData.new_price : pData.price;
      let newSeller = pData.new_seller || pData.seller;
      let usedPrice = pData.used_price;
      let usedSeller = pData.used_seller;

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
  if (env.AMZN_ASSOCIATES_TAG) queryParams.set("tag", env.AMZN_ASSOCIATES_TAG);
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
  const key = await crypto.subtle.importKey(
    "raw", 
    enc.encode(secret || "fallback_secret"), 
    { name: "HMAC", hash: "SHA-256" }, 
    false, 
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(`${asin}:${exp}`));
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
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
  if (env.AMZN_ASSOCIATES_TAG) queryParams.set("tag", env.AMZN_ASSOCIATES_TAG);
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
    const { results: adminRows } = await env.DB.prepare("SELECT chat_id FROM Users WHERE role = 'admin'").all();
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

async function deleteTelegramMessage(env, chatId, messageId) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId })
  });
}

async function expandAmazonUrl(url) {
  let currentUrl = url;
  let hops = 0;
  try {
    while ((currentUrl.includes("amzn.to") || currentUrl.includes("amzn.eu") || /amazon\.eg\/d\//.test(currentUrl)) && hops < 3) {
      const res = await fetch(currentUrl, { method: "GET", redirect: "manual", headers: { "User-Agent": "Agent/AzTrackerBot" } });
      const location = res.headers.get("location");
      
      if (location) {
        currentUrl = location;
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
  const dpMatch = url.match(/\/dp\/([A-Z0-9]{10})/i);
  if (dpMatch) return dpMatch[1].toUpperCase();
  const gpMatch = url.match(/\/gp\/product\/([A-Z0-9]{10})/i);
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
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function editTelegramMessage(env, chatId, messageId, text, replyMarkup = null) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`;
  const body = { chat_id: chatId, message_id: messageId, text: text, parse_mode: "HTML", disable_web_page_preview: true };
  if (replyMarkup) body.reply_markup = replyMarkup;
  
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  // The Blindness Fix: explicitly catch and log Telegram rejections (429, 400, 403)
  if (!res.ok) {
    const errText = await res.text();
    console.error(`Telegram API Error [editMessageText]: ${res.status} - ${errText}`);
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
  if (res && res.result) {
    await env.AZTRACKER_DB.put(key, res.result.message_id.toString());
  }
  return res;
}

async function fetchLastWorkflowRun(env) {
  try {
    const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/price_tracker.yml/runs?per_page=1`;
    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${env.GH_WORKFLOW_TOKEN}`,
        "User-Agent": "Agent/AzTrackerBot",
        "Accept": "application/vnd.github+json"
      }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.workflow_runs && data.workflow_runs.length > 0) {
        const run = data.workflow_runs[0];
        return { status: run.status, updated_at: run.updated_at };
      }
    }
  } catch (e) { console.error("GitHub API error", e); }
  return null;
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
    const key = `audit:${timestamp}:${adminId}`;
    const payload = { action, target, targetHandle, details, adminHandle };
    // Exact 7-day TTL ensures automatic GC
    await env.AZTRACKER_DB.put(key, JSON.stringify(payload), { expirationTtl: 604800 });
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

function renderGlobalChartHTML(exp, sig) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Global Price Matrix</title>
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
            max-width: 800px;
            position: relative;
            margin-top: 20px;
        }
        .loading { text-align: center; margin-top: 50px; font-size: 16px; opacity: 0.7; }
        .header-title { margin-bottom: 5px; text-align: center; font-weight: 600; font-size: 20px; }
        .header-sub { font-size: 14px; opacity: 0.7; margin-bottom: 20px; text-align: center; }
    </style>
</head>
<body>
    <div class="header-title">Global Price Matrix</div>
    <div class="header-sub">Root Admin View • Top Movers</div>
    
    <div id="chart-container">
        <div id="loading" class="loading">Compiling global index...</div>
        <canvas id="priceChart" style="display: none;"></canvas>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.ready();
        tg.expand(); 
        tg.setHeaderColor(tg.themeParams.bg_color || '#ffffff');

        async function loadData() {
            try {
                const response = await fetch('/api/admin/history-all?exp=${exp}&sig=${sig}');
                if (!response.ok) throw new Error('Auth failed');
                
                const data = await response.json();
                document.getElementById('loading').style.display = 'none';
                
                if (!data || data.length === 0) {
                    document.getElementById('chart-container').innerHTML = '<div class="loading">No global history available yet.<br><br>Awaiting the next engine run!</div>';
                    return;
                }

                document.getElementById('priceChart').style.display = 'block';

                const allAsins = new Set();
                data.forEach(pt => {
                    if (pt.p) Object.keys(pt.p).forEach(a => allAsins.add(a));
                });

                const labels = data.map(pt => {
                    const date = new Date(pt.t * 1000);
                    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + 
                           date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                });

                function getColor(index) {
                    const hue = index * 137.508; 
                    return \`hsl(\${hue % 360}, 70%, 50%)\`;
                }

                const datasets = Array.from(allAsins).map((asin, i) => {
                    const color = getColor(i);
                    let isTopMover = false;
                    for (let j = data.length - 1; j >= 0; j--) {
                        if (data[j].p && data[j].p[asin]) {
                            isTopMover = data[j].p[asin][1] === 1;
                            break;
                        }
                    }
                    
                    return {
                        label: asin,
                        data: data.map(pt => (pt.p && pt.p[asin]) ? pt.p[asin][0] : null),
                        borderColor: color,
                        backgroundColor: color,
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 5,
                        stepped: true,
                        spanGaps: true,
                        hidden: !isTopMover
                    };
                });

                const ctx = document.getElementById('priceChart').getContext('2d');
                const textColor = tg.themeParams.text_color || '#000000';
                const gridColor = tg.themeParams.hint_color ? tg.themeParams.hint_color + '40' : '#cccccc40';

                new Chart(ctx, {
                    type: 'line',
                    data: { labels, datasets },
                    options: {
                        responsive: true,
                        maintainAspectRatio: true,
                        interaction: { mode: 'index', intersect: false },
                        plugins: {
                            legend: { 
                                position: 'top', 
                                labels: { color: textColor, usePointStyle: true, boxWidth: 8 } 
                            },
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
                            y: { ticks: { color: textColor }, grid: { color: gridColor } },
                            x: { ticks: { color: textColor, maxRotation: 45, minRotation: 45, maxTicksLimit: 8 }, grid: { display: false } }
                        }
                    }
                });
            } catch (err) {
                document.getElementById('loading').innerText = 'Failed to load chart data.';
            }
        }
        
        loadData();
    </script>
</body>
</html>
  `;
}
