import { getUserRoles, logAudit, resolveUserProfile } from '../core/db.js';

export async function handleTelegramWebhook(request, env, ctx) {
  const url = new URL(request.url);
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

async function handleMessage(message, env, baseUrl, ctx) {
  let text = message.text.trim();
  if (typeof convertHindiToArabic === 'function') text = convertHindiToArabic(text);
  const chatId = message.chat.id.toString();
  const messageId = message.message_id;

  const { isRootAdmin, isAdmin, isApproved, isRejected, rootAdmins, admins, approvedUsers } = await getUserRoles(chatId, env, ctx);
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
  const activeState = await env.DB.prepare("SELECT value FROM Bot_States WHERE key = ?").bind(stateKey).first('value');
  
  // --- OVERRIDE BLOCK ---
  if (text === "/start" || text === "/manage") {
    if (activeState) await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(stateKey).run();
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
    if (activeState) await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(stateKey).run();
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

    await env.DB.prepare("UPDATE User_Subscriptions SET target_price = ?, alert_sent_new = 0, alert_sent_used = 0 WHERE chat_id = ? AND asin = ?").bind(num, chatId, pid).run();
    
    await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(stateKey).run();
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
      await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(`state:${chatId}`).run();
      await renderMainMenu(env, chatId, messageId, isAdmin, baseUrl);
    }
    else if (data.startsWith("list_products_")) {
      await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(`state:${chatId}`).run();
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
      await env.DB.prepare("INSERT OR REPLACE INTO Bot_States (key, value, expires_at) VALUES (?, ?, ?)").bind(`state:${chatId}`, pid, Date.now() + 300000).run();
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
      await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(`state:${chatId}`).run();
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
            p.amazon_price, p.used_price, p.new_price, p.last_updated,
            p.new_seller, p.new_mid, p.used_seller, p.used_mid,
            p.amazon_seller, p.amazon_mid, p.seen_amazon_eg_at, p.seen_resale_at
     FROM User_Subscriptions s 
     JOIN Global_Products p ON s.asin = p.asin 
     WHERE s.chat_id = ? AND s.asin = ?`
  ).bind(chatId, pid).first();

  if (!product) return;
  const prices = { [pid]: {
    new_price: product.new_price,
    used_price: product.used_price,
    amazon_price: product.amazon_price,
    name: product.name,
    new_seller: product.new_seller,
    new_mid: product.new_mid,
    used_seller: product.used_seller,
    used_mid: product.used_mid,
    amazon_seller: product.amazon_seller,
    amazon_mid: product.amazon_mid,
    seen_amazon_eg_at: product.seen_amazon_eg_at,
    seen_resale_at: product.seen_resale_at
  } };

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
        // Gap 9.8 fix: show used price + used seller when new stock is unavailable
        const usedSeller = pData.used_seller;
        lastPrice = `${usedPrice.toLocaleString()} EGP <i>(Used)</i>`;
        if (usedSeller) sellerInfo = `\n🏬 <b>Seller:</b> <i>${escapeHtml(usedSeller)}</i>`;
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
  const partnerTag = env.AMAZON_PARTNER_TAG;
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
      [
        { text: product.paused ? "▶️ Resume Checking" : "⏸️ Pause Checking", callback_data: `${product.paused ? "resume" : "pause"}_${pid}` },
        targetBtn
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
  const partnerTag = env.AMAZON_PARTNER_TAG;
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
  const oldMsgStr = await env.DB.prepare("SELECT value FROM Bot_States WHERE key = ?").bind(key).first('value');
  if (oldMsgStr) {
    await deleteTelegramMessage(env, chatId, parseInt(oldMsgStr, 10));
  }
  const res = await sendTelegram(env, chatId, text, replyMarkup);
  if (res?.result?.message_id) {
    await env.DB.prepare("INSERT OR REPLACE INTO Bot_States (key, value, expires_at) VALUES (?, ?, ?)").bind(key, res.result.message_id.toString(), Date.now() + 172800000).run();
  }
  return res;
}
