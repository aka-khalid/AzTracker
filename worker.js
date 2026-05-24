// AzTracker Cloudflare ChatOps Router - GHOST INPUT INLINE GUI PRO
// Features: Auto-Deleting Text Inputs, Zero-Trace Callbacks, and Inline UI Editing

//const GITHUB_BRANCH = "feature/chatops-interactive-bot";
//const GITHUB_BRANCH = "feature/randomized-scheduler";
const GITHUB_BRANCH = "main";


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Hidden scheduler endpoint for cron-job.org
    if (url.pathname === "/scheduler") {
      return await handleScheduler(request, env);
    }

        // ── MILESTONE 2: HISTORY API ENDPOINT ──
    if (url.pathname.startsWith("/api/history/") && request.method === "GET") {
      const asin = url.pathname.split("/").pop();
      if (!asin || asin.length < 10) {
        return new Response(JSON.stringify({ error: "Invalid ASIN" }), { status: 400 });
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

    // ── MILESTONE 3: WEB APP CHART HTML ──
    if (url.pathname.startsWith("/chart/") && request.method === "GET") {
      const asin = url.pathname.split("/").pop();
      const html = renderChartHTML(asin);
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }
    // ─────────────────────────────────────

    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    // ── ZERO-TRUST WEBHOOK VALIDATION ──
    if (env.TELEGRAM_WEBHOOK_SECRET) {
      const secretToken = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secretToken !== env.TELEGRAM_WEBHOOK_SECRET) {
        console.warn("Unauthorized webhook attempt intercepted.");
        return new Response("Unauthorized", { status: 401 });
      }
    }

    try {
      const payload = await request.json();
      const baseUrl = url.origin; // ⬅️ We capture the worker's domain here
      
      if (payload.callback_query) {
        await handleCallback(payload.callback_query, env, baseUrl); // ⬅️ Pass it down
      } else if (payload.message && payload.message.text) {
        await handleMessage(payload.message, env);
      }
      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error(err);
      return new Response("OK", { status: 200 });
    }
  }
};

// ── Interceptors ────────────────────────────────────────────────────────────

async function handleMessage(message, env) {
  // 🌍 LOCALIZATION INTERCEPTOR: Normalize numerals before any logic runs
  const text = convertHindiToArabic(message.text).trim();
  const chatId = message.chat.id.toString();
  const messageId = message.message_id;

  // ── ROLE-BASED SECURITY BOUNCER ───────────────────────────────────────────
  const rootAdmins = (env.TELEGRAM_ROOT_ADMIN_IDS || "").split(",");
  const isRootAdmin = rootAdmins.includes(chatId);
  const admins = await env.AZTRACKER_DB.get("global:admins", "json") || [];
  const isAdmin = isRootAdmin || admins.includes(chatId);
  const approvedUsers = await env.AZTRACKER_DB.get("global:approved_users", "json") || [];
  const isApproved = isAdmin || approvedUsers.includes(chatId);

  if (!isApproved) {
    await sendAppMessage(env, chatId, `⛔ <b>Access Denied</b>\n\nThis is a private tracking server. You are not authorized to use it.\n\nIf you know an admin, send them this ID to get approved:\n<code>${chatId}</code>`);
    return;
  }
  // ──────────────────────────────────────────────────────────────────────────

  // 🎯 TARGET PRICE STATE INTERCEPTOR
  const stateKey = `state:${chatId}`;
  const activeState = await env.AZTRACKER_DB.get(stateKey);
  
  // 📢 BROADCAST STATE INTERCEPTOR
  if (activeState === 'broadcast' && isRootAdmin) {
    await env.AZTRACKER_DB.delete(stateKey);
    await deleteTelegramMessage(env, chatId, messageId); // Vaporize the input text
    
    const sentMsg = await sendAppMessage(env, chatId, `⏳ <b>Broadcasting...</b>`);
    
    let successCount = 0;
    for (const userId of approvedUsers) {
      try {
        await sendTelegram(env, userId, `📢 <b>System Update</b>\n\n${text}`);
        successCount++;
      } catch (e) {
        console.error(`Broadcast failed for ${userId}`);
      }
    }
    
    await editTelegramMessage(env, chatId, sentMsg.result.message_id, `✅ <b>Broadcast Complete!</b>\nDelivered to ${successCount} user(s).`, {
      inline_keyboard: [[{ text: "⬅️ Back to Admin Panel", callback_data: "admin_panel" }]]
    });
    return;
  }
  
  if (activeState) {
    const pid = activeState;
    const num = parseFloat(text);
    
    if (isNaN(num) || num <= 0) {
      await deleteTelegramMessage(env, chatId, messageId);
      await sendAppMessage(env, chatId, "⚠️ <b>Invalid amount.</b> Please enter a valid number.", {
        inline_keyboard: [[{ text: "⬅️ Back", callback_data: `view_${pid}` }]]
      });
      return;
    }

    const userDbKey = `user:${chatId}:products`;
    let products = await env.AZTRACKER_DB.get(userDbKey, "json") || [];
    const pIndex = products.findIndex(p => getAsinFromUrl(p.url) === pid);
    if (pIndex !== -1) {
      products[pIndex].target_price = num;
      products[pIndex].alert_sent = false; // Force a reset so the new target is fresh
      await env.AZTRACKER_DB.put(userDbKey, JSON.stringify(products));
    }
    
    await env.AZTRACKER_DB.delete(stateKey);
    await deleteTelegramMessage(env, chatId, messageId);
    
    await sendAppMessage(env, chatId, `🎯 <b>Target Price Set!</b>\n\nYou will only be notified when ASIN <code>${pid}</code> drops to or below <b>${num.toLocaleString()} EGP</b>.`, {
      inline_keyboard: [[{ text: "⬅️ Back to Product", callback_data: `view_${pid}` }]]
    });
    return;
  }

  // 🧹 GHOST INPUTS: If input is raw data, vaporize the message instantly
  const isNumericId = /^\d{6,15}$/.test(text);
  const isAmazonLink = text.includes("amazon.eg") || text.includes("amzn.to") || text.includes("amzn.eu");

  if (isNumericId || isAmazonLink) {
    await deleteTelegramMessage(env, chatId, messageId);
  }

  // 👑 ADMIN CARD GENERATOR (Triggers when an Admin pastes a numeric User ID)
  if (isAdmin && isNumericId) {
    const targetId = text;
    const isTargetRoot = rootAdmins.includes(targetId);
    const isTargetAdmin = isTargetRoot || admins.includes(targetId);
    const isTargetApproved = isTargetAdmin || approvedUsers.includes(targetId);

    let buttons = [];
    if (isRootAdmin) {
      if (!isTargetApproved) buttons.push([{ text: "✅ Approve User", callback_data: `approve_${targetId}` }]);
      if (isTargetApproved && !isTargetRoot) buttons.push([{ text: "🗑️ Revoke User", callback_data: `revoke_${targetId}` }]);
      if (isTargetApproved && !isTargetAdmin) buttons.push([{ text: "🌟 Promote to Admin", callback_data: `promote_${targetId}` }]);
      if (isTargetAdmin && !isTargetRoot) buttons.push([{ text: "🔽 Demote Admin", callback_data: `demote_${targetId}` }]);
    } else if (isAdmin) {
      if (!isTargetApproved) buttons.push([{ text: "✅ Approve User", callback_data: `approve_${targetId}` }]);
      if (isTargetApproved && !isTargetAdmin) buttons.push([{ text: "🗑️ Revoke User", callback_data: `revoke_${targetId}` }]);
      if (isTargetAdmin) {
        await sendAppMessage(env, chatId, `⚠️ ID <code>${targetId}</code> belongs to an Admin. Interception blocked.`);
        return;
      }
    }

    if (isTargetApproved) {
      buttons.push([{ text: "📦 View User's Products", callback_data: `admProd_${targetId}` }]);
    }

    if (buttons.length > 0) {
      const statusLabel = isTargetRoot ? "👑 Root Admin" : isTargetAdmin ? "🛡️ Admin" : isTargetApproved ? "👤 Approved User" : "🚫 Unapproved Guest";
      const statusMsg = `📋 <b>User Management Card</b>\n\n🆔 <b>ID:</b> <code>${targetId}</code>\n📊 <b>Current Status:</b> ${statusLabel}\n\n<i>Select an action below:</i>`;
      await sendAppMessage(env, chatId, statusMsg, { inline_keyboard: buttons });
    }
    return;
  }

  // 🛒 LINK PASTE HANDLER (Triggers when a user drops an Amazon URL)
  if (isAmazonLink) {
    const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
    const inputUrl = urlMatch ? urlMatch[1] : text;

    const sentMsg = await sendAppMessage(env, chatId, `⏳ <b>Processing Amazon link...</b>`);
    const tempMessageId = sentMsg.result.message_id;

    const expandedUrl = await expandAmazonUrl(inputUrl);
    const pid = getAsinFromUrl(expandedUrl);
    
    if (!pid) {
      await editTelegramMessage(env, chatId, tempMessageId, "❌ <b>Could not parse a valid 10-digit ASIN.</b>", {
        inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "main_menu" }]]
      });
      return;
    }

    const userDbKey = `user:${chatId}:products`;
    let products = await env.AZTRACKER_DB.get(userDbKey, "json") || [];
    
    if (products.some(p => getAsinFromUrl(p.url) === pid)) {
      await editTelegramMessage(env, chatId, tempMessageId, "⚠️ <b>You are already tracking this product!</b>", {
        inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "main_menu" }]]
      });
      return;
    }

    const extractedName = extractNameFromUrl(expandedUrl);
    products.push({ url: `https://www.amazon.eg/dp/${pid}`, paused: false, name: extractedName });
    await env.AZTRACKER_DB.put(userDbKey, JSON.stringify(products));

    const title = extractedName ? extractedName : pid;
    const cleanTitle = title.length > 35 ? title.substring(0, 32) + "..." : title;
    
    const successText = `✅ <b>Product Registered!</b>\n\n` +
                    `📌 <b>${cleanTitle}</b>\n` +
                    `🆔 ASIN: <code>${pid}</code>\n\n` +
                    `<i>The tracker is now aware of this item. It will pull the live price during the next automated check.</i>\n\n` +
                    `🕐 <b>Status:</b> ⏳ Pending initial scan...`;
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
    await renderMainMenu(env, chatId);
    return;
  }


  await deleteTelegramMessage(env, chatId, messageId);
  await sendAppMessage(env, chatId, "⚠️ <b>Invalid Command or Input Structure</b>\n\nPlease use the interactive options below or drop a valid Amazon item link.", {
    inline_keyboard: [[{ text: "🏠 Open Main Menu", callback_data: "main_menu" }]]
  });
}

async function handleCallback(callback, env, baseUrl) {
  const data = callback.data;
  const messageId = callback.message.message_id;
  const chatId = callback.message.chat.id.toString();
  
  const rootAdmins = (env.TELEGRAM_ROOT_ADMIN_IDS || "").split(",");
  const isRootAdmin = rootAdmins.includes(chatId);
  const admins = await env.AZTRACKER_DB.get("global:admins", "json") || [];
  const isAdmin = isRootAdmin || admins.includes(chatId);
  const approvedUsers = await env.AZTRACKER_DB.get("global:approved_users", "json") || [];
  const isApproved = isAdmin || approvedUsers.includes(chatId);

  if (!isApproved) return;

  const userDbKey = `user:${chatId}:products`;

  if (data.startsWith("approve_") && isAdmin) {
    const targetId = data.replace("approve_", "");
    if (!approvedUsers.includes(targetId)) {
      approvedUsers.push(targetId);
      await env.AZTRACKER_DB.put("global:approved_users", JSON.stringify(approvedUsers));
      await editTelegramMessage(env, chatId, messageId, `✅ <b>Approved!</b>\nUser <code>${targetId}</code> can now use the tracking application.`);
      await sendTelegram(env, targetId, `🎉 <b>You have been approved!</b>\nAn admin has granted you access to AzTracker. Run /start to boot your control console.`);
    }
  }
  else if (data.startsWith("revoke_") && isAdmin) {
    const targetId = data.replace("revoke_", "");
    if (rootAdmins.includes(targetId) || admins.includes(targetId)) return;
    
    // 1. Remove them from the approved directory
    const updatedUsers = approvedUsers.filter(id => id !== targetId);
    await env.AZTRACKER_DB.put("global:approved_users", JSON.stringify(updatedUsers));
    
    // 2. TOTAL PURGE: Nuke their product registry AND their active UI state
    await env.AZTRACKER_DB.delete(`user:${targetId}:products`);
    await env.AZTRACKER_DB.delete(`ui:${targetId}`);
    
    await editTelegramMessage(env, chatId, messageId, `🗑️ <b>Revoked & Purged!</b>\nID <code>${targetId}</code> and their entire tracking profile have been permanently erased.`);
  }
  else if (data.startsWith("promote_") && isRootAdmin) {
    const targetId = data.replace("promote_", "");
    if (!admins.includes(targetId)) {
      admins.push(targetId);
      await env.AZTRACKER_DB.put("global:admins", JSON.stringify(admins));
      await editTelegramMessage(env, chatId, messageId, `🌟 <b>Promoted!</b>\nID <code>${targetId}</code> has been elevated to Admin privileges.`);
      await sendTelegram(env, targetId, `🌟 <b>You have been promoted to Admin!</b>\nYou now have authorization to approve users. Run /start to see the admin features.`);
    }
  }
  else if (data.startsWith("demote_") && isRootAdmin) {
    const targetId = data.replace("demote_", "");
    const updatedAdmins = admins.filter(id => id !== targetId);
    await env.AZTRACKER_DB.put("global:admins", JSON.stringify(updatedAdmins));
    await editTelegramMessage(env, chatId, messageId, `🔽 <b>Demoted.</b>\nID <code>${targetId}</code> has returned to standard tracking access tier.`);
  }
  else if (data === "main_menu") {
    await renderMainMenu(env, chatId, messageId);
  }
  else if (data.startsWith("list_products_")) {
    const page = parseInt(data.replace("list_products_", "")) || 0;
    await renderProductList(env, chatId, messageId, page);
  }
  else if (data === "ignore") {
    return;
  }
    else if (data === "admin_panel" && isAdmin) {
    const approvedGuests = approvedUsers.filter(id => !admins.includes(id) && !rootAdmins.includes(id));
    
    // ── System Health Metrics ──
    const globalPrices = await env.AZTRACKER_DB.get("global_prices", "json") || {};
    const uniqueAsins = Object.keys(globalPrices).length;
    
    const lastTrigger = await env.AZTRACKER_DB.get("global:last_trigger");
    let lastRunText = "Pending...";
    if (lastTrigger) {
        const date = new Date(parseInt(lastTrigger));
        // Format to your local Cairo timezone
        lastRunText = date.toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo", hour: '2-digit', minute:'2-digit' });
    }
    
    let text = `👑 <b>Admin Dashboard</b>\n\n` +
           `👥 <b>Approved Guests:</b> ${approvedGuests.length}\n` +
           `🛡️ <b>Admins:</b> ${admins.length + rootAdmins.length}\n` +
           `📦 <b>Unique ASINs Tracked:</b> ${uniqueAsins} / 450\n` +
           `⏱️ <b>Last Auto-Scan:</b> ${lastRunText}\n\n` +
           `💡 <b>Manage access:</b>\nBrowse approved users below, or paste a Telegram ID directly into the chat.`;
    
    // Dynamically build the button array
    let adminButtons = [
      [{ text: "👥 View Approved Users", callback_data: "list_users" }]
    ];
    
    if (isRootAdmin) {
      adminButtons.push([{ text: "📢 Broadcast Message", callback_data: "broadcast_init" }]);
    }
    
    adminButtons.push([{ text: "🏠 Back to Main Menu", callback_data: "main_menu" }]);

    await editTelegramMessage(env, chatId, messageId, text, { inline_keyboard: adminButtons });
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
    const page = parts[2] ? parseInt(parts[2]) : 0; // Supports "list_users" and "list_users_1"
    await renderUserList(env, chatId, messageId, page);
  }
  else if (data.startsWith("manage_user_") && isAdmin) {
    const targetId = data.replace("manage_user_", "");
    const isTargetRoot = rootAdmins.includes(targetId);
    const isTargetAdmin = isTargetRoot || admins.includes(targetId);
    const isTargetApproved = isTargetAdmin || approvedUsers.includes(targetId);

    let buttons = [];
    if (isRootAdmin) {
      if (!isTargetApproved) buttons.push([{ text: "✅ Approve User", callback_data: `approve_${targetId}` }]);
      if (isTargetApproved && !isTargetRoot) buttons.push([{ text: "🗑️ Revoke User", callback_data: `revoke_${targetId}` }]);
      if (isTargetApproved && !isTargetAdmin) buttons.push([{ text: "🌟 Promote to Admin", callback_data: `promote_${targetId}` }]);
      if (isTargetAdmin && !isTargetRoot) buttons.push([{ text: "🔽 Demote Admin", callback_data: `demote_${targetId}` }]);
    } else if (isAdmin) {
      if (!isTargetApproved) buttons.push([{ text: "✅ Approve User", callback_data: `approve_${targetId}` }]);
      if (isTargetApproved && !isTargetAdmin) buttons.push([{ text: "🗑️ Revoke User", callback_data: `revoke_${targetId}` }]);
    }
    
    if (isTargetApproved) {
      buttons.push([{ text: "📦 View User's Products", callback_data: `admProd_${targetId}` }]);
    }
    buttons.push([{ text: "⬅️ Back to Directory", callback_data: "list_users" }]);

    const statusLabel = isTargetRoot ? "👑 Root Admin" : isTargetAdmin ? "🛡️ Admin" : isTargetApproved ? "👤 Approved User" : "🚫 Unapproved Guest";
    const statusMsg = `📋 <b>User Management Card</b>\n\n🆔 <b>ID:</b> <code>${targetId}</code>\n📊 <b>Current Status:</b> ${statusLabel}\n\n<i>Select an action below:</i>`;
    await editTelegramMessage(env, chatId, messageId, statusMsg, { inline_keyboard: buttons });
  }
  else if (data.startsWith("admProd_") && isAdmin) {
    const parts = data.split("_");
    const targetId = parts[1];
    const page = parts[2] ? parseInt(parts[2]) : 0; // Safely defaults to Page 0
    await renderAdminUserProducts(env, chatId, messageId, targetId, page);
  }
  else if (data.startsWith("admView_") && isAdmin) {
    const parts = data.split("_");
    const targetId = parts[1];
    const pid = parts[2];
    await renderAdminProductView(env, chatId, messageId, targetId, pid, baseUrl);
  }
  else if (data.startsWith("admTog_") && isAdmin) {
    const parts = data.split("_");
    const targetId = parts[1];
    const pid = parts[2];
    const targetDbKey = `user:${targetId}:products`;
    let products = await env.AZTRACKER_DB.get(targetDbKey, "json") || [];
    const idx = products.findIndex(p => getAsinFromUrl(p.url) === pid);
    if (idx !== -1) {
      products[idx].paused = !products[idx].paused;
      await env.AZTRACKER_DB.put(targetDbKey, JSON.stringify(products));
    }
    await renderAdminProductView(env, chatId, messageId, targetId, pid, baseUrl);
  }
  // --- USER DELETION CONFIRMATION ---
  else if (data.startsWith("confirmDel_")) {
    const pid = data.replace("confirmDel_", "");
    const text = `⚠️ <b>Confirm Deletion</b>\n\nAre you sure you want to permanently delete ASIN <code>${pid}</code> from your tracking list?\n\n<i>This action cannot be undone.</i>`;
    
    await editTelegramMessage(env, chatId, messageId, text, {
      inline_keyboard: [
        [{ text: "✅ Yes, Delete", callback_data: `remove_${pid}` }],
        [{ text: "❌ Cancel", callback_data: `view_${pid}` }]
      ]
    });
  }
  
  // --- ADMIN DELETION CONFIRMATION ---
  else if (data.startsWith("admConfDel_") && isAdmin) {
    const parts = data.split("_");
    const targetId = parts[1];
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
    const pid = parts[2];
    const targetDbKey = `user:${targetId}:products`;
    let products = await env.AZTRACKER_DB.get(targetDbKey, "json") || [];
    const filtered = products.filter(p => getAsinFromUrl(p.url) !== pid);
    await env.AZTRACKER_DB.put(targetDbKey, JSON.stringify(filtered));
    
    await editTelegramMessage(env, chatId, messageId, `🗑️ <b>Admin Override: Product Deleted</b>\n\nASIN <code>${pid}</code> has been completely removed from user <code>${targetId}</code>'s active register.`, {
      inline_keyboard: [[{ text: "⬅️ Back to User's Products", callback_data: `admProd_${targetId}` }]]
    });
  }
  else if (data === "global_track" && isAdmin) {
    const lastTrigger = await env.AZTRACKER_DB.get("global:last_trigger");
    const now = Date.now();
    const cooldown = 10 * 60 * 1000; // 10 minutes

    if (lastTrigger && (now - parseInt(lastTrigger)) < cooldown) {
        const remaining = Math.ceil((cooldown - (now - parseInt(lastTrigger))) / 60000);
        await editTelegramMessage(env, chatId, messageId,
            `⏳ <b>Cooldown Active</b>\n\nNext check available in <b>${remaining} minute(s)</b>.`, {
            inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "main_menu" }]]
        });
        return;
    }

    await env.AZTRACKER_DB.put("global:last_trigger", now.toString());
    await editTelegramMessage(env, chatId, messageId, "🚀 <b>Triggering GitHub Actions pipeline...</b>");
    try {
      const triggered = await triggerWorkflow(env);
      if (triggered) {
        await editTelegramMessage(env, chatId, messageId, "✅ <b>Workflow successfully triggered!</b>\nChecks are running in the background.", {
          inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "main_menu" }]]
        });
      }
    } catch (error) {
      await editTelegramMessage(env, chatId, messageId, `❌ <b>GitHub API Error:</b>\n<code>${error.message}</code>`, {
        inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "main_menu" }]]
      });
    }
  }
  else if (data === "help_add") {
    const text = `💡 <b>How to Add a Product:</b>\n\nCopy any Amazon.eg product link from your browser or app and paste it directly into this chat box as a message.\n\n📱 <b>Short links shared directly from the mobile app are fully supported!</b>`;
    await editTelegramMessage(env, chatId, messageId, text, {
      inline_keyboard: [[{ text: "⬅️ Back", callback_data: "main_menu" }]]
    });
  }
  else if (data.startsWith("settarget_")) {
    const pid = data.replace("settarget_", "");
    await env.AZTRACKER_DB.put(`state:${chatId}`, pid, { expirationTtl: 300 }); // 5 minute lock
    const text = `🎯 <b>Set Target Price</b>\n\nASIN: <code>${pid}</code>\n\nPlease type your desired maximum price in EGP as a message (e.g., <code>4500</code>).`;
    await editTelegramMessage(env, chatId, messageId, text, {
      inline_keyboard: [[{ text: "❌ Cancel", callback_data: `view_${pid}` }]]
    });
  }
  else if (data.startsWith("cleartarget_")) {
    const pid = data.replace("cleartarget_", "");
    let products = await env.AZTRACKER_DB.get(userDbKey, "json") || [];
    const pIndex = products.findIndex(p => getAsinFromUrl(p.url) === pid);
    if (pIndex !== -1) {
      delete products[pIndex].target_price;
      delete products[pIndex].alert_sent; // Clean up the ghost flag
      await env.AZTRACKER_DB.put(userDbKey, JSON.stringify(products));
    }
    await renderProductView(env, chatId, messageId, pid, baseUrl);
  }
  else if (data.startsWith("view_")) {
    const pid = data.replace("view_", "");
    await env.AZTRACKER_DB.delete(`state:${chatId}`); // Clear any hanging target states
    await renderProductView(env, chatId, messageId, pid, baseUrl);
  }
  else if (data.startsWith("pause_") || data.startsWith("resume_")) {
    const action = data.split("_")[0];
    const pid = data.split("_")[1];

    let products = await env.AZTRACKER_DB.get(userDbKey, "json") || [];
    const idx = products.findIndex(p => getAsinFromUrl(p.url) === pid);
    if (idx !== -1) {
      products[idx].paused = (action === "pause");
      await env.AZTRACKER_DB.put(userDbKey, JSON.stringify(products));
    }
    await renderProductView(env, chatId, messageId, pid, baseUrl);
  }
  else if (data.startsWith("remove_")) {
    const pid = data.replace("remove_", "");
    let products = await env.AZTRACKER_DB.get(userDbKey, "json") || [];
    const filteredProducts = products.filter(p => getAsinFromUrl(p.url) !== pid);
    await env.AZTRACKER_DB.put(userDbKey, JSON.stringify(filteredProducts));
    
    await editTelegramMessage(env, chatId, messageId, `🗑️ <b>Product Deleted</b>\n\nASIN <code>${pid}</code> has been completely removed from your active register.`, {
      inline_keyboard: [[{ text: "⬅️ Back to Products", callback_data: "list_products_0" }]]
    });
  }
}

// ── UI Renderers ────────────────────────────────────────────────────────────

async function renderAdminUserProducts(env, chatId, messageId, targetId, page = 0) {
  const targetDbKey = `user:${targetId}:products`;
  const products = await env.AZTRACKER_DB.get(targetDbKey, "json") || [];
  const prices = await env.AZTRACKER_DB.get("global_prices", "json") || {};

  if (products.length === 0) {
    const text = `📦 <b>User Tracking List (ID: <code>${targetId}</code>)</b>\n\nThis user currently has no active or paused products in their database.`;
    const keyboard = { inline_keyboard: [[{ text: "⬅️ Back to User Card", callback_data: `manage_user_${targetId}` }]] };
    await editTelegramMessage(env, chatId, messageId, text, keyboard);
    return;
  }

  // --- Pagination Logic ---
  const ITEMS_PER_PAGE = 5;
  const totalPages = Math.ceil(products.length / ITEMS_PER_PAGE);
  
  // Safety check bounds
  if (page >= totalPages) page = Math.max(0, totalPages - 1);

  const pagedProducts = products.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);
  const keyboard = { inline_keyboard: [] };

  pagedProducts.forEach((p) => {
    const pid = getAsinFromUrl(p.url);
    let name = pid;
    if (prices[pid] && typeof prices[pid] === 'object' && prices[pid].name) {
      name = prices[pid].name;
    } else if (p.name) {
      name = p.name;
    }
    if (name.length > 30) name = name.substring(0, 27) + "...";
    
    const statusIcon = p.paused ? "⏸️" : "✅";
    const targetIcon = p.target_price ? "🎯 " : "";
    keyboard.inline_keyboard.push([{ text: `${statusIcon} ${targetIcon}${name}`, callback_data: `admView_${targetId}_${pid}` }]);
  });

  // --- Navigation Controls ---
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

  const text = `📦 <b>User Tracking List (ID: <code>${targetId}</code>)</b>\nPage ${page + 1} of ${totalPages}\n\n<i>Select an item below to manage it on behalf of the user:</i>`;
  await editTelegramMessage(env, chatId, messageId, text, keyboard);
}

async function renderAdminProductView(env, chatId, messageId, targetId, pid, baseUrl) {
  const targetDbKey = `user:${targetId}:products`;
  const products = await env.AZTRACKER_DB.get(targetDbKey, "json") || [];
  const prices = await env.AZTRACKER_DB.get("global_prices", "json") || {};
  const product = products.find(p => getAsinFromUrl(p.url) === pid);

  if (!product) return;

  const statusStr = product.paused ? "⏸️ Paused" : "✅ Active";
  let lastPrice = "⏳ Waiting for next tracker run...";
  let lastUpdated = ""; 
  let sellerInfo = "";
  let title = product.name ? product.name : "Amazon Product";

  if (prices[pid]) {
    if (typeof prices[pid] === 'object') {
      lastPrice = prices[pid].price.toLocaleString() + " EGP";
      if (prices[pid].seller) sellerInfo = `\n🏬 <b>Seller:</b> <i>${prices[pid].seller}</i>`;
      if (prices[pid].name) title = prices[pid].name;
      if (prices[pid].last_updated) {
        const parts = prices[pid].last_updated.split(' ');
        const checkDate = parts[0]; // e.g., "2026-05-24"
        const checkTime = parts[1]; // e.g., "22:07"
        
        // Get today's date formatted as YYYY-MM-DD in Cairo timezone
        const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());

        if (checkDate === todayStr) {
          lastUpdated = ` <i>(Checked: Today at ${checkTime})</i>`;
        } else {
          lastUpdated = ` <i>(Checked: ${checkDate} ${checkTime})</i>`;
        }
      }
    } else {
      lastPrice = prices[pid].toLocaleString() + " EGP";
    }
  }

  const cleanTitle = title.length > 35 ? title.substring(0, 32) + "..." : title;
  let targetText = product.target_price ? `\n🎯 <b>Target:</b> ${product.target_price.toLocaleString()} EGP` : "";

  let productUrl = product.url;
  if (prices[pid] && prices[pid].merchant_id) {
    productUrl = `https://www.amazon.eg/dp/${pid}?m=${prices[pid].merchant_id}`;
  }

  const text = `🛡️ <b>Admin Product Override</b> (User: <code>${targetId}</code>)\n\n` +
               `📦 <b>${cleanTitle}</b>\n` +
               `└ 🆔 <code>${pid}</code>\n\n` +
               `💰 <b>Price:</b> ${lastPrice}` +
               `${targetText}\n` +
               `${sellerInfo}\n` +
               `📡 <b>Status:</b> ${statusStr}${lastUpdated}\n\n` +
               `🔗 <a href="${productUrl}">Open on Amazon.eg</a>`;

    const keyboard = {
    inline_keyboard: [
      [{ text: product.paused ? "▶️ Force Resume" : "⏸️ Force Pause", callback_data: `admTog_${targetId}_${pid}` }],
      [{ text: "📊 View Stats & History", web_app: { url: `${baseUrl}/chart/${pid}` } }],
      [{ text: "🗑️ Force Delete", callback_data: `admConfDel_${targetId}_${pid}` }],
      [{ text: "⬅️ Back to User's List", callback_data: `admProd_${targetId}_0` }]
    ]
  };

  await editTelegramMessage(env, chatId, messageId, text, keyboard);
}
async function renderUserList(env, chatId, messageId, page = 0) {
  const approvedUsers = await env.AZTRACKER_DB.get("global:approved_users", "json") || [];
  
  if (approvedUsers.length === 0) {
    const text = `👥 <b>Approved Users Directory</b>\n\nNo approved guest profiles exist in the core server database right now.`;
    const keyboard = { inline_keyboard: [[{ text: "⬅️ Back to Dashboard", callback_data: "admin_panel" }]] };
    await editTelegramMessage(env, chatId, messageId, text, keyboard);
    return;
  }

  // --- Pagination Logic ---
  const ITEMS_PER_PAGE = 5;
  const totalPages = Math.ceil(approvedUsers.length / ITEMS_PER_PAGE);
  
  if (page >= totalPages) page = Math.max(0, totalPages - 1);

  // ⚡ API OPTIMIZATION: Slice the array FIRST, so we only fetch 5 profiles from Telegram!
  const pagedUsers = approvedUsers.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);

  // Parallel Fetch: Request profiles for ONLY the current page
  const userPromises = pagedUsers.map(async (id) => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: id })
      });
      const data = await res.json();
      
      if (data.ok && data.result) {
        const profile = data.result;
        const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(" ");
        const formatName = profile.username ? `${fullName} (@${profile.username})` : fullName;
        return { id, label: formatName || id };
      }
    } catch (e) {
      console.error(`Failed to fetch chat profile for ID ${id}:`, e);
    }
    return { id, label: `Unknown User (${id})` }; // Fallback if user blocked bot
  });

  const resolvedUsers = await Promise.all(userPromises);
  const keyboard = { inline_keyboard: [] };
  
  resolvedUsers.forEach((user) => {
    keyboard.inline_keyboard.push([{ text: `👤 ${user.label}`, callback_data: `manage_user_${user.id}` }]);
  });

  // --- Navigation Controls ---
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

  keyboard.inline_keyboard.push([{ text: "⬅️ Back to Dashboard", callback_data: "admin_panel" }]);

  const text = `👥 <b>Approved Users Register</b> (Page ${page + 1} of ${totalPages})\n\nSelect an active profile record below to open its structural permissions card inline:`;
  await editTelegramMessage(env, chatId, messageId, text, keyboard);
}
async function renderMainMenu(env, chatId, messageId = null) {
  const userDbKey = `user:${chatId}:products`;
  const products = await env.AZTRACKER_DB.get(userDbKey, "json") || [];
  
  const rootAdmins = (env.TELEGRAM_ROOT_ADMIN_IDS || "").split(",");
  const isRootAdmin = rootAdmins.includes(chatId);
  const admins = await env.AZTRACKER_DB.get("global:admins", "json") || [];
  const isAdmin = isRootAdmin || admins.includes(chatId);
  
  const total = products.length;
  const active = products.filter(p => !p.paused).length;
  const paused = total - active;

  const text = `🏠 <b>AzTracker Dashboard</b>\n\n📦 <b>Your Tracked Items:</b> ${total}\n⚡ <b>Active:</b> ${active} | ⏸️ <b>Paused:</b> ${paused}\n\n<i>Select an operative option below:</i>`;

  // Standard user keyboard menu configuration
  const keyboard = {
    inline_keyboard: [
      [{ text: "📦 My Products", callback_data: "list_products_0" }],
      [{ text: "➕ How to Add Products", callback_data: "help_add" }]
    ]
  };

  // Restrict operational administrative triggers strictly to verified admin tiers
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
  const userDbKey = `user:${chatId}:products`;
  const products = await env.AZTRACKER_DB.get(userDbKey, "json") || [];
  const prices = await env.AZTRACKER_DB.get("global_prices", "json") || {};
  
  if (products.length === 0) {
    const text = `❌ <b>Your tracking list is empty.</b>\n\nPaste an Amazon.eg link in the chat box to begin tracking!`;
    const keyboard = { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "main_menu" }]] };
    await editTelegramMessage(env, chatId, messageId, text, keyboard);
    return;
  }

  // --- Pagination Logic ---
  const ITEMS_PER_PAGE = 5;
  const totalPages = Math.ceil(products.length / ITEMS_PER_PAGE);
  
  // Safety check: if they delete an item and the current page becomes empty, push them back a page
  if (page >= totalPages) page = Math.max(0, totalPages - 1);

  const pagedProducts = products.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);

  const keyboard = { inline_keyboard: [] };
  
  // Render only the 5 products for this specific page
  pagedProducts.forEach((p) => {
    const pid = getAsinFromUrl(p.url);
    let name = pid;
    if (prices[pid] && typeof prices[pid] === 'object' && prices[pid].name) {
      name = prices[pid].name;
    } else if (p.name) {
      name = p.name;
    }
    if (name.length > 30) name = name.substring(0, 27) + "...";
    
    const statusIcon = p.paused ? "⏸️" : "✅";
    const targetIcon = p.target_price ? "🎯 " : "";
    keyboard.inline_keyboard.push([{ text: `${statusIcon} ${targetIcon}${name}`, callback_data: `view_${pid}` }]);
  });

  // --- Navigation Controls ---
  if (totalPages > 1) {
    let navRow = [];
    if (page > 0) {
      navRow.push({ text: "⬅️ Prev", callback_data: `list_products_${page - 1}` });
    }
    
    // Middle visual indicator (does nothing when clicked)
    navRow.push({ text: `📄 ${page + 1}/${totalPages}`, callback_data: "ignore" });
    
    if (page < totalPages - 1) {
      navRow.push({ text: "Next ➡️", callback_data: `list_products_${page + 1}` });
    }
    keyboard.inline_keyboard.push(navRow);
  }

  keyboard.inline_keyboard.push([{ text: "🏠 Main Menu", callback_data: "main_menu" }]);

  const text = `📦 <b>My Tracked Products</b> (Page ${page + 1} of ${totalPages})\n\n<i>Select an item below to modify its tracking parameters:</i>`;
  await editTelegramMessage(env, chatId, messageId, text, keyboard);
}

async function renderProductView(env, chatId, messageId, pid, baseUrl) {
  const userDbKey = `user:${chatId}:products`;
  const products = await env.AZTRACKER_DB.get(userDbKey, "json") || [];
  const prices = await env.AZTRACKER_DB.get("global_prices", "json") || {};
  const product = products.find(p => getAsinFromUrl(p.url) === pid);

  if (!product) return;

  const statusStr = product.paused ? "⏸️ Paused" : "✅ Active";
  let lastPrice = "⏳ Waiting for next tracker run...";
  let lastUpdated = ""; 
  let sellerInfo = "";
  let title = product.name ? product.name : "Amazon Product";

  if (prices[pid]) {
    if (typeof prices[pid] === 'object') {
      lastPrice = prices[pid].price.toLocaleString() + " EGP";
      if (prices[pid].seller) sellerInfo = `\n🏬 <b>Seller:</b> <i>${prices[pid].seller}</i>`;
      if (prices[pid].name) title = prices[pid].name;
      if (prices[pid].last_updated) {
        const parts = prices[pid].last_updated.split(' ');
        const checkDate = parts[0]; // e.g., "2026-05-24"
        const checkTime = parts[1]; // e.g., "22:07"
        
        // Get today's date formatted as YYYY-MM-DD in Cairo timezone
        const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());

        if (checkDate === todayStr) {
          lastUpdated = ` <i>(Checked: Today at ${checkTime})</i>`;
        } else {
          lastUpdated = ` <i>(Checked: ${checkDate} ${checkTime})</i>`;
        }
      }
    } else {
      lastPrice = prices[pid].toLocaleString() + " EGP";
    }
  }

  const cleanTitle = title.length > 35 ? title.substring(0, 32) + "..." : title;
  let targetText = product.target_price ? `\n🎯 <b>Target:</b> ${product.target_price.toLocaleString()} EGP` : "";

  let productUrl = product.url;
  if (prices[pid] && prices[pid].merchant_id) {
    productUrl = `https://www.amazon.eg/dp/${pid}?m=${prices[pid].merchant_id}`;
  }

  const text = `📦 <b>${cleanTitle}</b>\n` +
               `└ 🆔 <code>${pid}</code>\n\n` +
               `💰 <b>Price:</b> ${lastPrice}` +
               `${targetText}\n` +
               `${sellerInfo}\n` +
               `📡 <b>Status:</b> ${statusStr}${lastUpdated}\n\n` +
               `🔗 <a href="${productUrl}">Open on Amazon.eg</a>`;

  const targetBtn = product.target_price 
    ? { text: "❌ Clear Target", callback_data: `cleartarget_${pid}` }
    : { text: "🎯 Set Target", callback_data: `settarget_${pid}` };

    const keyboard = {
    inline_keyboard: [
      [{ text: product.paused ? "▶️ Resume Tracking" : "⏸️ Pause Tracking", callback_data: `${product.paused ? "resume" : "pause"}_${pid}` }],
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

async function handleScheduler(request, env) {
  const url = new URL(request.url);
  const providedKey = url.searchParams.get("key") || request.headers.get("x-scheduler-key");

  if (!env.CRON_AUTH_KEY || providedKey !== env.CRON_AUTH_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = getCairoParts(new Date());
  const hourKey = `${now.year}-${now.month}-${now.day}-${now.hour}`;
  const currentMinute = parseInt(now.minute, 10);

  const scheduleKey = `schedule:${hourKey}`;
  let slots = await env.AZTRACKER_DB.get(scheduleKey, "json");

  if (!slots) {
    slots = buildHourlySlots();
    await env.AZTRACKER_DB.put(scheduleKey, JSON.stringify(slots), { expirationTtl: 7200 });
    console.log("Generated hourly slots:", slots);
  }

  const lockKey = `runlock:${hourKey}:${currentMinute}`;
  const alreadyRan = await env.AZTRACKER_DB.get(lockKey);
  if (alreadyRan) {
    return new Response("Already executed", { status: 200 });
  }

  if (slots.includes(currentMinute)) {
  try {
    await triggerWorkflow(env);

    await env.AZTRACKER_DB.put(lockKey, "1", {
      expirationTtl: 7200
    });

    return new Response(`Workflow triggered at minute ${currentMinute}`, {
      status: 200
    });

  } catch (e) {
    return new Response(`Trigger failed: ${e.message}`, {
      status: 500
    });
  }
}

  return new Response(`No run this minute (${currentMinute})`, { status: 200 });
}

function buildHourlySlots() {
  // 1. Define the 8 chunks of the hour
  const bounds = [
    [0, 7], [8, 15], [16, 22], [23, 29],
    [30, 37], [38, 44], [45, 52], [53, 59]
  ];
  
  const runMinutes = [];

  for (let i = 0; i < bounds.length; i++) {
    let min = bounds[i][0];
    const max = bounds[i][1];

    // 2. Anti-Clumping: Ensure at least a 3-minute gap from the previous run
    if (i > 0) {
      const prevRun = runMinutes[i - 1];
      if (min - prevRun < 3) {
        min = prevRun + 3; // Push the floor up
      }
    }

    // Failsafe to ensure valid random ranges
    if (min > max) min = max;

    runMinutes.push(randInt(min, max));
  }

  // The array is naturally sorted chronologically by the chunking process
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

function convertHindiToArabic(text) {
  if (!text) return "";
  const hindiToAr = { '٠':'0', '١':'1', '٢':'2', '٣':'3', '٤':'4', '٥':'5', '٦':'6', '٧':'7', '٨':'8', '٩':'9' };
  return text.replace(/[٠-٩]/g, match => hindiToAr[match]);
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
  try {
    if (currentUrl.includes("amzn.to") || currentUrl.includes("amzn.eu") || /amazon\.eg\/d\//.test(currentUrl)) {
      const res = await fetch(currentUrl, { method: "GET", redirect: "manual" });
      const location = res.headers.get("location");
      if (location) currentUrl = location;
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
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GH_WORKFLOW_TOKEN}`,
      "User-Agent": "AzTracker-Bot",
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ref: GITHUB_BRANCH })
  });
  if (!res.ok) {
    let details = "";
    try { const json = await res.json(); details = json.message || JSON.stringify(json); } 
    catch { details = await res.text() || res.statusText; }
    throw new Error(`Status ${res.status} - ${details}`);
  }
  return true;
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
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  // REMOVED REDUNDANT KV WRITE: The message ID does not change on edit!
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

// ── Web App HTML Renderer ───────────────────────────────────────────────────

function renderChartHTML(asin) {
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
    </style>
</head>
<body>
    <div class="header-title">Price Trend</div>
    <div class="header-sub">ASIN: ${asin}</div>
    
    <div id="chart-container">
        <div id="loading" class="loading">Fetching database...</div>
        <canvas id="priceChart" style="display: none;"></canvas>
    </div>

    <script>
        // Initialize Telegram Web App SDK
        const tg = window.Telegram.WebApp;
        tg.ready();
        tg.expand(); 
        tg.setHeaderColor(tg.themeParams.bg_color || '#ffffff');

        async function loadData() {
            try {
                const response = await fetch('/api/history/${asin}');
                const data = await response.json();
                
                document.getElementById('loading').style.display = 'none';
                
                if (!data || data.length === 0) {
                    document.getElementById('chart-container').innerHTML = '<div class="loading">No price history available yet.<br><br>Check back after the next scan!</div>';
                    return;
                }

                // MAGIC TRICK: Duplicate the last data point and set its time to "Right Now"
                // This forces the chart line to extend completely to the right side of the screen
                const currentUnix = Math.floor(Date.now() / 1000);
                const lastPoint = data[data.length - 1];
                if (lastPoint.t < currentUnix - 60) {
                    data.push({ p: lastPoint.p, t: currentUnix });
                }

                document.getElementById('priceChart').style.display = 'block';

                const labels = data.map(point => {
                    const date = new Date(point.t * 1000);
                    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + 
                           date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                });
                
                const prices = data.map(point => point.p);
                const ctx = document.getElementById('priceChart').getContext('2d');
                
                // Smart Theme Integration (Matches the user's Telegram colors)
                const gridColor = tg.themeParams.hint_color ? tg.themeParams.hint_color + '40' : '#cccccc40';
                const textColor = tg.themeParams.text_color || '#000000';
                const lineColor = tg.themeParams.button_color || '#2481cc';

                new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: labels,
                        datasets: [{
                            label: 'Price (EGP)',
                            data: prices,
                            borderColor: lineColor,
                            backgroundColor: lineColor + '20',
                            borderWidth: 2,
                            pointBackgroundColor: lineColor,
                            pointRadius: data.length === 1 ? 4 : 0, // Only show dots if there's just 1 data point
                            stepped: true, // The flat-line delta visualizer
                            fill: true
                        }]
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
                                        return context.parsed.y.toLocaleString() + ' EGP';
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
                document.getElementById('loading').innerText = 'Failed to load chart data.';
            }
        }
        
        loadData();
    </script>
</body>
</html>
  `;
}

