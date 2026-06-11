import { getUserRoles, logAudit, resolveUserProfile } from '../core/db.js';
import { t, resolveLanguageCode, getWelcomeMessage } from '../core/i18n.js';
import { getAmazonAccessToken, AmazonEdgeParser } from '../core/amazon.js';
import { escapeHtml, convertHindiToArabic, resolveProductName } from '../core/utils.js';

const QUEUE_MAX_DEPTH = 25;
const AMAZON_EG_MERCHANT_ID = "A1ZVRGNO5AYLOV";
const AMAZON_RESALE_MERCHANT_ID = "A2N2MP47XAP1MK";
const ALT_SELLER_TTL_MS = 86400000;

// ── Rate Limiting ─────────────────────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = 60_000;       // 1-minute window
const RATE_LIMIT_MAX_MESSAGES = 30;        // max messages per window
const RATE_LIMIT_KV_PREFIX = "rl:";         // KV key prefix for rate counters

/**
 * Check whether a chat is rate-limited using KV.
 * Returns { allowed, remaining, resetMs }.
 * Uses a simple counter with TTL = window length.
 */
async function checkRateLimit(chatId, env) {
  const key = `${RATE_LIMIT_KV_PREFIX}${chatId}`;
  try {
    const raw = await env.AZTRACKER_DB.get(key);
    const now = Date.now();
    if (!raw) {
      // First message in a new window — initialize counter
      await env.AZTRACKER_DB.put(key, JSON.stringify({ count: 1, windowStart: now }), {
        expirationTtl: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
      });
      return { allowed: true, remaining: RATE_LIMIT_MAX_MESSAGES - 1, resetMs: RATE_LIMIT_WINDOW_MS };
    }
    const data = JSON.parse(raw);
    const elapsed = now - data.windowStart;
    if (elapsed >= RATE_LIMIT_WINDOW_MS) {
      // Window expired — reset
      await env.AZTRACKER_DB.put(key, JSON.stringify({ count: 1, windowStart: now }), {
        expirationTtl: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
      });
      return { allowed: true, remaining: RATE_LIMIT_MAX_MESSAGES - 1, resetMs: RATE_LIMIT_WINDOW_MS };
    }
    // Within window
    data.count += 1;
    const remaining = Math.max(0, RATE_LIMIT_MAX_MESSAGES - data.count);
    const resetMs = RATE_LIMIT_WINDOW_MS - elapsed;
    if (data.count <= RATE_LIMIT_MAX_MESSAGES) {
      await env.AZTRACKER_DB.put(key, JSON.stringify(data), {
        expirationTtl: Math.ceil(resetMs / 1000) + 1,
      });
    }
    return { allowed: data.count <= RATE_LIMIT_MAX_MESSAGES, remaining, resetMs };
  } catch (e) {
    console.error("Rate limit KV error:", e);
    // Fail open — don't block users if KV is unreachable
    return { allowed: true, remaining: RATE_LIMIT_MAX_MESSAGES, resetMs: 0 };
  }
}

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

    // ── Rate Limiting ──────────────────────────────────────────────────────
    // Extract chat ID from the update for rate-limit check
    const chatId = payload.message?.chat?.id?.toString()
      || payload.callback_query?.message?.chat?.id?.toString()
      || null;
    if (chatId) {
      const rl = await checkRateLimit(chatId, env);
      if (!rl.allowed) {
        console.warn(`[RateLimit] chat ${chatId} exceeded ${RATE_LIMIT_MAX_MESSAGES} msgs/min — dropping update`);
        return new Response("OK", { status: 200 }); // Ack silently so Telegram doesn't retry
      }
    }

    if (payload.callback_query) {
      ctx.waitUntil(handleCallback(payload.callback_query, env, baseUrl, ctx));
    } else if (payload.message && payload.message.text) {
      ctx.waitUntil(handleMessage(payload.message, env, baseUrl, ctx));
    }
    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("Webhook error:", err);
    // Return 500 for parse/validation errors so Telegram retries the update.
    // Return 200 only if we successfully extracted the update but downstream failed.
    const isParseError = err instanceof SyntaxError || err instanceof TypeError;
    return new Response("Error", { status: isParseError ? 500 : 200 });
  }
}

async function handleMessage(message, env, baseUrl, ctx) {
  let text = message.text.trim();
  if (typeof convertHindiToArabic === 'function') text = convertHindiToArabic(text);
  const chatId = message.chat.id.toString();
  const messageId = message.message_id;

  // ── Language Detection ──────────────────────────────────────────────────
  // For approved users: read lang from DB via getUserRoles
  // For unapproved users: detect from Telegram OS language_code
  const { isRootAdmin, isAdmin, isApproved, isRejected, rootAdmins, admins, approvedUsers, lang: dbLang } = await getUserRoles(chatId, env, ctx);
  const osLang = resolveLanguageCode(message.from?.language_code);
  const lang = dbLang || osLang || 'en';

  if (!isApproved) {
    if (isRejected) {
      await sendAppMessage(env, chatId, t('access.denied_head', lang) + '\n\n' + t('access.denied_body_private', lang));
      return;
    }

    // Check if user was previously blocked (bot banned/unreachable)
    const blockedUser = await env.DB.prepare("SELECT 1 FROM Users WHERE chat_id = ? AND role = 'blocked'").bind(chatId).first() !== null;

    const inQueue = await env.DB.prepare("SELECT 1 FROM Join_Queue WHERE chat_id = ?").bind(chatId).first() !== null;

    if (inQueue) {
      await sendAppMessage(env, chatId, t('access.pending_head', lang) + '\n\n' + t('access.pending_body', lang));
      return;
    }

    if (blockedUser) {
      // Blocked user: offer unban request (notifies admins)
      if (text === "/start") {
        await sendAppMessage(env, chatId, t('access.blocked_head', lang) + '\n\n' + t('access.blocked_body', lang), {
          inline_keyboard: [[{ text: t('access.unban_btn', lang), callback_data: `request_unban_${chatId}` }]]
        });
      } else {
        await sendAppMessage(env, chatId, t('access.blocked_head', lang) + '\n\n' + t('access.blocked_body', lang) + '\n\n' + t('access.denied_hint_start', lang));
      }
      return;
    }

    if (text === "/start") {
      await sendAppMessage(env, chatId, t('access.denied_head', lang) + '\n\n' + t('access.denied_body_private', lang), {
        inline_keyboard: [[{ text: t('access.request_btn', lang), callback_data: `request_access_${chatId}` }]]
      });
    } else {
      await sendAppMessage(env, chatId, t('access.denied_head', lang) + '\n\n' + t('access.denied_body_private', lang) + '\n\n' + t('access.denied_hint_start', lang));
    }
    return;
  }

  const stateKey = `state:${chatId}`;
  const activeState = await env.DB.prepare("SELECT value FROM Bot_States WHERE key = ?").bind(stateKey).first('value');

  // --- OVERRIDE BLOCK ---
  if (text === "/start") {
    if (activeState) await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(stateKey).run();
    await deleteTelegramMessage(env, chatId, messageId);

    // Ensure root admin always exists in Users table (idempotent)
    const __raRaw = env.TELEGRAM_ROOT_ADMIN_IDS || env.ROOT_ADMIN_ID || env.TELEGRAM_ADMIN_IDS || "";
    const __raList = __raRaw.split(",").filter(Boolean).map(s => s.trim());
    if (__raList.includes(String(chatId))) {
      await env.DB.prepare("INSERT OR IGNORE INTO Users (chat_id, role, item_limit, created_at) VALUES (?, 'admin', 0, ?)").bind(String(chatId), Date.now()).run();
    }

    // Only set lang from Telegram OS on first interaction (NULL), never overwrite.
    // User must explicitly toggle language via the button — OS language is NOT authoritative.
    await env.DB.prepare("UPDATE Users SET lang = ? WHERE chat_id = ? AND lang IS NULL").bind(osLang, chatId).run();

    // Re-read lang after potential update: use DB value, fall back to OS detection
    const freshRoles = await getUserRoles(chatId, env, ctx);
    const effectiveLang = freshRoles.lang || osLang || 'en';

    await renderMainMenu(env, chatId, null, isAdmin, baseUrl, effectiveLang);
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
      await sendAppMessage(env, chatId, t('target.invalid_amount', lang), {
        inline_keyboard: [[{ text: t('nav.back', lang), callback_data: `view_${pid}` }]]
      });
      return;
    }

    await env.DB.prepare("UPDATE User_Subscriptions SET target_price = ?, alert_sent_new = 0, alert_sent_used = 0 WHERE chat_id = ? AND asin = ?").bind(num, chatId, pid).run();

    await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(stateKey).run();
    await deleteTelegramMessage(env, chatId, messageId);

    const rawPrice = num.toLocaleString();
    await sendAppMessage(env, chatId, t('target.set_confirm_head', lang) + '\n\n' + t('target.set_confirm_body', lang, { asin: pid, price: t('chrome.currency_egp', lang) + ' ' + rawPrice }), {
      inline_keyboard: [[{ text: t('nav.back_to_product', lang), callback_data: `view_${pid}` }]]
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

    const sentMsg = await sendAppMessage(env, chatId, t('link.processing', lang));
    if (!sentMsg?.result?.message_id) {
      console.error("sendAppMessage failed: no message_id", sentMsg);
      return;
    }
    const tempMessageId = sentMsg.result.message_id;

    const expandedUrl = await expandAmazonUrl(inputUrl);

    const domainMatch = expandedUrl.match(/https?:\/\/(?:www\.)?(amazon\.[a-z\.]+)/i);
    const productDomain = domainMatch ? domainMatch[1].toLowerCase() : null;
    const SUPPORTED_REGIONS = ['amazon.eg'];

    if (!productDomain || !SUPPORTED_REGIONS.includes(productDomain)) {
      await editTelegramMessage(env, chatId, tempMessageId, t('link.region_not_supported_head', lang) + '\n\n' + t('link.region_not_supported_body', lang), {
        inline_keyboard: [[{ text: t('nav.main_menu', lang), callback_data: "main_menu" }]]
      });
      return;
    }

    const pid = getAsinFromUrl(expandedUrl);

    if (!pid) {
      await editTelegramMessage(env, chatId, tempMessageId, t('link.could_not_parse', lang), {
        inline_keyboard: [[{ text: t('nav.main_menu', lang), callback_data: "main_menu" }]]
      });
      return;
    }

    const user = await env.DB.prepare("SELECT item_limit FROM Users WHERE chat_id = ?").bind(chatId).first();
    const defaultLimit = parseInt(env.DEFAULT_USER_PRODUCT_LIMIT);
    const userLimit = user && user.item_limit !== null ? parseInt(user.item_limit) : defaultLimit;

    const { results: existingProducts } = await env.DB.prepare("SELECT asin FROM User_Subscriptions WHERE chat_id = ?").bind(chatId).all();

    if (!isAdmin) {
      if (isNaN(defaultLimit)) {
        await editTelegramMessage(env, chatId, tempMessageId, t('link.system_error', lang), {
          inline_keyboard: [[{ text: t('nav.main_menu', lang), callback_data: "main_menu" }]]
        });
        return;
      }

      if (existingProducts && existingProducts.length >= userLimit) {
        await editTelegramMessage(env, chatId, tempMessageId, t('link.limit_reached_head', lang) + '\n\n' + t('link.limit_reached_body', lang, { used: existingProducts.length, limit: userLimit }), {
          inline_keyboard: [
            [{ text: t('link.manage_products', lang), callback_data: "list_products_0" }],
            [{ text: t('nav.main_menu', lang), callback_data: "main_menu" }]
          ]
        });
        return;
      }
    }

    if (existingProducts && existingProducts.some(p => p.asin === pid)) {
      await editTelegramMessage(env, chatId, tempMessageId, t('link.already_exists', lang), {
        inline_keyboard: [[{ text: t('nav.main_menu', lang), callback_data: "main_menu" }]]
      });
      return;
    }

    const extractedName = extractNameFromUrl(expandedUrl);

    // Fetch Arabic product name (non-blocking — falls back to English only)
    let arabicName = null;
    try {
      const clientId = env.AMAZON_CLIENT_ID || env.AMZN_CREATORS_ACCESS_KEY || env.AWS_ACCESS_KEY_ID;
      const clientSecret = env.AMAZON_CLIENT_SECRET || env.AMZN_CREATORS_SECRET_KEY || env.AWS_SECRET_ACCESS_KEY;
      if (clientId && clientSecret) {
        const token = await getAmazonAccessToken(clientId, clientSecret);
        const parser = new AmazonEdgeParser(token, env.AMZN_ASSOCIATES_TAG, 'www.amazon.eg', env);
        const arabicMap = await parser.getItemsWithArabic([pid]);
        if (arabicMap.has(pid)) {
          arabicName = arabicMap.get(pid);
        }
        // Fallback: scrape amazon.eg page if API didn't return Arabic
        if (!arabicName) {
          arabicName = await parser.scrapeArabicTitle(pid);
        }
      }
    } catch (e) {
      console.warn('[Webhook] Arabic name fetch failed (non-blocking):', e.message);
    }

    // Insert into Global_Products to track price globally
    await env.DB.prepare(`
      INSERT INTO Global_Products (asin, name, name_ar, last_updated)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(asin) DO UPDATE SET name = excluded.name, name_ar = COALESCE(excluded.name_ar, name_ar)
    `).bind(pid, extractedName || pid, arabicName).run();

    // Insert into User_Subscriptions
    await env.DB.prepare(`
      INSERT INTO User_Subscriptions (chat_id, asin, added_at)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_id, asin) DO NOTHING
    `).bind(chatId, pid, Date.now()).run();
    if (ctx && ctx.waitUntil) ctx.waitUntil(logAudit(env, chatId, "ADD_PRODUCT", chatId, `Added product ${pid}`));


    const title = extractedName ? extractedName : pid;
    const cleanTitle = escapeHtml(title.length > 35 ? title.substring(0, 32) + "..." : title);

    const successText = t('link.registered_head', lang) + '\n\n' +
                    `📌 <b>${cleanTitle}</b>\n` +
                    `${t('product.asin_inline', lang, { asin: pid })}\n\n` +
                    t('link.registered_status', lang) + '\n\n' +
                    `🕐 <b>${t('link.status_label', lang)}</b> ${t('link.pending_scan', lang)}\n\n${t('alert.boosted_label', lang)}`;
    await editTelegramMessage(env, chatId, tempMessageId, successText, {
      inline_keyboard: [
        [{ text: "📦 View My Products", callback_data: "list_products_0" }],
        [{ text: t('nav.main_menu', lang), callback_data: "main_menu" }]
      ]
    });
    return;
  }


  await deleteTelegramMessage(env, chatId, messageId);
  await sendAppMessage(env, chatId, t('link.invalid_command', lang), {
    inline_keyboard: [[{ text: t('nav.open_menu', lang), callback_data: "main_menu" }]]
  });
}

async function handleCallback(callback, env, baseUrl, ctx) {
  const data = callback.data;
  const message = callback.message;
  const chatId = message.chat.id.toString();
  const messageId = message.message_id;

  const { isRootAdmin, isAdmin, isApproved, rootAdmins, admins, approvedUsers, lang } = await getUserRoles(chatId, env, ctx);
  if (ctx && ctx.waitUntil) ctx.waitUntil(syncUserNames(env, chatId, callback.from, baseUrl));

  if (!isApproved && !data.startsWith("request_access_")) return;



  try {
    if (data.startsWith("request_access_")) {
      const targetId = data.replace("request_access_", "");
      if (targetId !== chatId) return;

      const inQueue = await env.DB.prepare("SELECT 1 FROM Join_Queue WHERE chat_id = ?").bind(chatId).first() !== null;
      if (inQueue) {
        await editTelegramMessage(env, chatId, messageId, t('access.request_sent', lang));
        return; // SEVERS THE BROADCAST LOOP FOR DUPLICATE CLICKS
      }

      const countRow = await env.DB.prepare("SELECT COUNT(*) as count FROM Join_Queue").first();
      if (countRow.count >= QUEUE_MAX_DEPTH) {
        await editTelegramMessage(env, chatId, messageId, t('access.queue_full_head', lang) + '\n\n' + t('access.queue_full_body', lang));
        return;
      }

      await editTelegramMessage(env, chatId, messageId, t('access.request_sent', lang));

      const { label } = await resolveUserProfile(env, chatId, ctx);
      const adminMsg = t('access.admin_new_request_head', lang) + '\n\n' + t('access.admin_new_request_body', lang, { name: escapeHtml(label), id: chatId });
      const adminButtons = {
        inline_keyboard: [
          [{ text: t('access.admin_new_request_btn_approve', lang), callback_data: `queueApprove_${chatId}` }, { text: t('access.admin_new_request_btn_reject', lang), callback_data: `queueReject_${chatId}` }]
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
    else if (data.startsWith("request_unban_")) {
      const targetId = data.replace("request_unban_", "");
      if (targetId !== chatId) return;

      // Prevent duplicate unban requests
      const alreadyRequested = await env.DB.prepare("SELECT 1 FROM Join_Queue WHERE chat_id = ?").bind(chatId).first() !== null;
      if (alreadyRequested) {
        await editTelegramMessage(env, chatId, messageId, t('access.unban_sent', lang));
        return;
      }

      await editTelegramMessage(env, chatId, messageId, t('access.unban_sent', lang));

      const { label } = await resolveUserProfile(env, chatId, ctx);
      const adminMsg = t('admin.unban_request_head', lang) + '\n\n' + t('admin.unban_request_body', lang, { name: escapeHtml(label), id: chatId });
      const adminButtons = {
        inline_keyboard: [
          [{ text: t('admin.unban_request_btn_unban', lang), callback_data: `unban_${chatId}` }]
        ]
      };

      const allAdmins = [...new Set([...admins, ...rootAdmins])];
      for (const adminId of allAdmins) {
        try {
          await sendTelegram(env, adminId, adminMsg, adminButtons);
        } catch(e) { console.error("Failed to notify admin", adminId); }
      }

      // Store in Join_Queue so the unban_ handler can find it
      await env.DB.prepare("INSERT OR IGNORE INTO Join_Queue (chat_id, first_name, username, requested_at, admin_messages) VALUES (?, ?, ?, ?, ?)").bind(
          chatId,
          callback.from ? callback.from.first_name : '',
          callback.from ? callback.from.username : '',
          Date.now(),
          '{}'
      ).run();
    }
    else if (data.startsWith("queueReject_") && isAdmin) {
      const targetId = data.replace("queueReject_", "");
      let queueObj = await env.DB.prepare("SELECT * FROM Join_Queue WHERE chat_id = ?").bind(targetId).first();
      if (!queueObj) {
        await editTelegramMessage(env, chatId, messageId, t('admin.request_expired', lang));
        return;
      }
      if (typeof queueObj.admin_messages === 'string') {
        try { queueObj.admin_messages = JSON.parse(queueObj.admin_messages); } catch(e) { queueObj.admin_messages = {}; }
      }

      // Answer callback FIRST to stop the spinner on the acting admin's button
      ctx.waitUntil(fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callback.id })
      }).catch(() => {}));

      // Capture other admin messages BEFORE deleting the queue row
      const otherAdminMessages = {};
      for (const [admId, msgId] of Object.entries(queueObj.admin_messages || {})) {
        if (admId !== String(chatId)) otherAdminMessages[admId] = msgId;
      }

      await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();

      const { label: adminName } = await resolveUserProfile(env, chatId, ctx);
      await editTelegramMessage(env, chatId, messageId, t('access.admin_rejected', lang, { id: targetId, admin: escapeHtml(adminName) }));

      // Update ALL other admins' messages — sequential with error handling for reliability
      for (const [admId, msgId] of Object.entries(otherAdminMessages)) {
        try {
          await editTelegramMessage(env, admId, msgId, t('access.handled_request', lang, { id: targetId, admin: escapeHtml(adminName) }), { inline_keyboard: [] });
        } catch(e) { console.error(`Failed to update admin ${admId} message:`, e); }
      }

      await env.DB.prepare(`
         INSERT INTO Users (chat_id, first_name, username, role, approved_by, item_limit, created_at, lang)
         VALUES (?, ?, ?, 'rejected', ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET role = 'rejected'
      `).bind(
        targetId,
        queueObj ? (queueObj.first_name || '') : '',
        queueObj ? (queueObj.username || '') : '',
        chatId,
        env.DEFAULT_USER_PRODUCT_LIMIT || "3",
        Date.now(),
        resolveLanguageCode(queueObj?.language_code) || 'en'
      ).run();
      ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));

      // Notify rejected user in their detected language
      const targetLang = resolveLanguageCode(queueObj?.language_code) || 'en';
      await sendTelegram(env, targetId, t('access.denied_notify', targetLang));

      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "REJECT_USER", targetId, "Rejected via Join Queue"));
    }
    else if (data.startsWith("queueApprove_") && isAdmin) {
      const targetId = data.replace("queueApprove_", "");
      let queueObj = await env.DB.prepare("SELECT * FROM Join_Queue WHERE chat_id = ?").bind(targetId).first();
      if (!queueObj) {
        await editTelegramMessage(env, chatId, messageId, t('admin.request_expired', lang));
        return;
      }
      if (typeof queueObj.admin_messages === 'string') {
        try { queueObj.admin_messages = JSON.parse(queueObj.admin_messages); } catch(e) { queueObj.admin_messages = {}; }
      }

      // Capture other admin messages BEFORE deleting the queue row
      const otherAdminMessages = {};
      for (const [admId, msgId] of Object.entries(queueObj.admin_messages || {})) {
        if (admId !== String(chatId)) otherAdminMessages[admId] = msgId;
      }

      await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();

      const targetLang = resolveLanguageCode(queueObj?.language_code) || 'en';
      const defaultLimit = env.DEFAULT_USER_PRODUCT_LIMIT || "3";

      await env.DB.prepare(`
         INSERT INTO Users (chat_id, first_name, username, role, approved_by, item_limit, created_at, lang)
         VALUES (?, ?, ?, 'approved', ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET role = 'approved', approved_by = excluded.approved_by, lang = COALESCE(lang, excluded.lang)
      `).bind(
        targetId,
        queueObj ? (queueObj.first_name || '') : '',
        queueObj ? (queueObj.username || '') : '',
        chatId,
        env.DEFAULT_USER_PRODUCT_LIMIT || "3",
        Date.now(),
        targetLang
      ).run();
      ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));

      const { label: adminName } = await resolveUserProfile(env, chatId, ctx);
      await editTelegramMessage(env, chatId, messageId, t('admin.approved_result', lang, { id: targetId, admin: escapeHtml(adminName) }));

      // Update ALL other admins' messages — sequential with error handling for reliability
      for (const [admId, msgId] of Object.entries(otherAdminMessages)) {
        try {
          await editTelegramMessage(env, admId, msgId, t('access.handled_approved', lang, { id: targetId, admin: escapeHtml(adminName) }), { inline_keyboard: [] });
        } catch(e) { console.error(`Failed to update admin ${admId} message:`, e); }
      }

      // Send welcome message in the user's detected language
      const welcomeMessage = getWelcomeMessage(targetLang, defaultLimit);
      await sendTelegram(env, targetId, welcomeMessage);

      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "APPROVE_USER", targetId, "Approved via Join Queue"));
    }
    else if (data.startsWith("confRevoke_") && isAdmin) {
      const targetId = data.replace("confRevoke_", "");
      if (rootAdmins.includes(targetId) || (admins.includes(targetId) && !isRootAdmin)) return;
      const text = t('admin.confirm_revoke_head', lang) + '\n\n' + t('admin.confirm_revoke_body', lang, { id: targetId });
      await editTelegramMessage(env, chatId, messageId, text, {
        inline_keyboard: [
          [{ text: t('admin.btn_revoke', lang), callback_data: `revoke_${targetId}` }],
          [{ text: t('admin.btn_cancel', lang), callback_data: `manage_user_${targetId}` }]
        ]
      });
    }
    else if (data.startsWith("confDemote_") && isRootAdmin) {
      const targetId = data.replace("confDemote_", "");
      const text = t('admin.confirm_demote_head', lang) + '\n\n' + t('admin.confirm_demote_body', lang, { id: targetId });
      await editTelegramMessage(env, chatId, messageId, text, {
        inline_keyboard: [
          [{ text: t('admin.btn_demote', lang), callback_data: `demote_${targetId}` }],
          [{ text: t('admin.btn_cancel', lang), callback_data: `manage_user_${targetId}` }]
        ]
      });
    }
    else if (data.startsWith("confPromote_") && isRootAdmin) {
      const targetId = data.replace("confPromote_", "");
      const text = t('admin.confirm_promote_head', lang) + '\n\n' + t('admin.confirm_promote_body', lang, { id: targetId });
      await editTelegramMessage(env, chatId, messageId, text, {
        inline_keyboard: [
          [{ text: t('admin.btn_promote', lang), callback_data: `promote_${targetId}` }],
          [{ text: t('admin.btn_cancel', lang), callback_data: `manage_user_${targetId}` }]
        ]
      });
    }
    else if (data.startsWith("confClearTgt_")) {
      const pid = data.replace("confClearTgt_", "");
      const text = t('target.remove_confirm_head', lang) + '\n\n' + t('target.remove_confirm_body', lang, { asin: pid });
      await editTelegramMessage(env, chatId, messageId, text, {
        inline_keyboard: [
          [{ text: t('target.btn_yes_clear', lang), callback_data: `cleartarget_${pid}` }],
          [{ text: t('target.remove_cancelled', lang), callback_data: `view_${pid}` }]
        ]
      });
    }
    else if (data.startsWith("reject_") && isAdmin) {
      const targetId = data.replace("reject_", "");

      // Use target user's existing lang (from DB) if available; don't overwrite with admin's
      const targetUserRow = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(targetId).first();
      const targetLang = targetUserRow?.lang || 'en';

      await env.DB.prepare(`
         INSERT INTO Users (chat_id, role, approved_by, item_limit, created_at, lang)
         VALUES (?, 'rejected', ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET role = 'rejected'
      `).bind(targetId, chatId, env.DEFAULT_USER_PRODUCT_LIMIT || "3", Date.now(), targetLang).run();
      ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));

      await editTelegramMessage(env, chatId, messageId, t('access.admin_rejected_manual', lang, { id: targetId }));
      await sendTelegram(env, targetId, t('access.denied_notify', targetLang));
      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "REJECT_USER", targetId, "Manually rejected access"));
    }
    else if (data.startsWith("unban_") && isAdmin) {
      const targetId = data.replace("unban_", "");

      // Handle both 'rejected' and 'blocked' roles
      const userRow = await env.DB.prepare("SELECT role FROM Users WHERE chat_id = ?").bind(targetId).first();
      if (userRow && (userRow.role === 'rejected' || userRow.role === 'blocked')) {
        // Reset role to 'pending' so user can request access again
        await env.DB.prepare("UPDATE Users SET role = 'pending' WHERE chat_id = ?").bind(targetId).run();
        // Unpause subscriptions if they were blocked
        if (userRow.role === 'blocked') {
          await env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 0 WHERE chat_id = ?").bind(targetId).run();
        }
      }
      ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));

      // Clean up join queue entry if exists
      await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();

      await editTelegramMessage(env, chatId, messageId, t('admin.unban_result', lang, { id: targetId }), {
        inline_keyboard: [[{ text: t('admin.back_to_directory', lang), callback_data: "admin_panel" }]]
      });

      // Notify the unbanned user
      try {
        await sendTelegram(env, targetId, t('access.unban_notify', lang) || "✅ Your account has been unbanned. Send /start to continue.");
      } catch(e) { /* user may still have bot blocked */ }

      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "UNBAN_USER", targetId, `Unbanned (was ${userRow?.role || 'unknown'})`));
    }
    else if (data.startsWith("approve_") && isAdmin) {
      const targetId = data.replace("approve_", "");
      // Default to 'en' — user's Telegram language_code is not available in callback queries.
      // User should send /start (which sets lang from their OS) or use the toggle button.
      const targetLang = 'en';
      await env.DB.prepare("INSERT INTO Users (chat_id, role, approved_by, item_limit, created_at, lang) VALUES (?, 'approved', ?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET role = 'approved', approved_by = excluded.approved_by, lang = COALESCE(lang, excluded.lang)").bind(targetId, chatId, env.DEFAULT_USER_PRODUCT_LIMIT || "3", Date.now(), targetLang).run();
      ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      await editTelegramMessage(env, chatId, messageId, t('admin.approved_manual_result', lang, { id: targetId }));

      const defaultLimit = env.DEFAULT_USER_PRODUCT_LIMIT || "3";
      const welcomeMessage = getWelcomeMessage(targetLang, defaultLimit);
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

      await editTelegramMessage(env, chatId, messageId, t('admin.revoked_result', lang, { id: targetId }));

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

      await editTelegramMessage(env, chatId, messageId, t('admin.promoted_result', lang, { id: targetId }), {
        inline_keyboard: [[{ text: t('admin.back_to_directory', lang), callback_data: "admin_panel" }]]
      });

      // Notify promoted user in their language
      const targetRoles = await getUserRoles(targetId, env, ctx);
      const targetLang = targetRoles.lang || 'en';
      await sendTelegram(env, targetId, t('admin.promoted_notify', targetLang));

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

      await editTelegramMessage(env, chatId, messageId, t('admin.demoted_result', lang, { id: targetId }), {
        inline_keyboard: [[{ text: t('admin.back_to_directory', lang), callback_data: "admin_panel" }]]
      });

      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "DEMOTE_ADMIN", targetId, "Demoted to standard access tier"));
    }
    else if (data === "main_menu") {
      await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(`state:${chatId}`).run();
      await renderMainMenu(env, chatId, messageId, isAdmin, baseUrl, lang);
    }
    else if (data.startsWith("list_products_")) {
      await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(`state:${chatId}`).run();
      const page = parseInt(data.replace("list_products_", "")) || 0;
      await renderProductList(env, chatId, messageId, page, lang);
    }
    else if (data === "ignore") {
      return;
    }


    else if (data === "help_add") {
      const text = t('howto.head', lang) + '\n\n' + t('howto.body', lang) + '\n\n' + t('howto.shortlinks', lang);
      await editTelegramMessage(env, chatId, messageId, text, {
        inline_keyboard: [[{ text: t('nav.back', lang), callback_data: "main_menu" }]]
      });
    }
    else if (data.startsWith("settarget_")) {
      const pid = data.replace("settarget_", "");
      await env.DB.prepare("INSERT OR REPLACE INTO Bot_States (key, value, expires_at) VALUES (?, ?, ?)").bind(`state:${chatId}`, pid, Date.now() + 300000).run();
      const text = t('target.set_head', lang) + '\n\n' + t('target.set_prompt', lang, { asin: pid });
      await editTelegramMessage(env, chatId, messageId, text, {
        inline_keyboard: [[{ text: t('target.cancel', lang), callback_data: `view_${pid}` }]]
      });
    }
    else if (data.startsWith("cleartarget_")) {
      const pid = data.replace("cleartarget_", "");
      await env.DB.prepare("UPDATE User_Subscriptions SET target_price = NULL WHERE chat_id = ? AND asin = ?").bind(chatId, pid).run();
      if (ctx && ctx.waitUntil) ctx.waitUntil(logAudit(env, chatId, "CLEAR_TARGET", chatId, `Cleared target price for ${pid}`));
      await renderProductView(env, chatId, messageId, pid, baseUrl, lang);
    }
    else if (data.startsWith("view_")) {
      const pid = data.replace("view_", "");
      await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(`state:${chatId}`).run();
      await renderProductView(env, chatId, messageId, pid, baseUrl, lang);
    }
    else if (data.startsWith("pause_") || data.startsWith("resume_")) {
      const action = data.split("_")[0];
      const pid = data.split("_")[1];

      const isPaused = action === "pause" ? 1 : 0;
      await env.DB.prepare("UPDATE User_Subscriptions SET is_paused = ? WHERE chat_id = ? AND asin = ?").bind(isPaused, chatId, pid).run();

      await renderProductView(env, chatId, messageId, pid, baseUrl, lang);
    }
    else if (data.startsWith("confirmDel_")) {
      const pid = data.replace("confirmDel_", "");
      const text = t('delete.confirm_head', lang) + '\n\n' + t('delete.confirm_body', lang, { asin: pid });

      await editTelegramMessage(env, chatId, messageId, text, {
        inline_keyboard: [
          [{ text: t('delete.btn_yes_delete', lang), callback_data: `remove_${pid}` }],
          [{ text: t('target.remove_cancelled', lang), callback_data: `view_${pid}` }]
        ]
      });
    }
    else if (data.startsWith("remove_")) {
      const pid = data.replace("remove_", "");

      await env.DB.prepare("DELETE FROM User_Subscriptions WHERE chat_id = ? AND asin = ?").bind(chatId, pid).run();
      if (ctx && ctx.waitUntil) ctx.waitUntil(logAudit(env, chatId, "DELETE_PRODUCT", chatId, `Deleted product ${pid}`));

      await editTelegramMessage(env, chatId, messageId, t('delete.deleted_head', lang) + '\n\n' + t('delete.deleted_body', lang, { asin: pid }), {
        inline_keyboard: [[{ text: t('product.btn.back_to_products', lang), callback_data: "list_products_0" }]]
      });
    }
    // ── Language Toggle ────────────────────────────────────────────────────
    else if (data === "toggle_lang") {
      const newLang = lang === 'en' ? 'ar' : 'en';
      await env.DB.prepare("UPDATE Users SET lang = ? WHERE chat_id = ?").bind(newLang, chatId).run();
      await caches.default.delete(new Request(`https://auth.internal/roles/${chatId}`));
      await editTelegramMessage(env, chatId, messageId, t('lang.changed', newLang));
      // Re-render main menu in new language after a brief pause
      await renderMainMenu(env, chatId, messageId, isAdmin, baseUrl, newLang);
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



async function renderMainMenu(env, chatId, messageId = null, isAdmin = false, baseUrl = "", lang = 'en') {

  const [stats, userRow] = await Promise.all([
      env.DB.prepare(`
        SELECT COUNT(*) as total, SUM(CASE WHEN is_paused = 0 THEN 1 ELSE 0 END) as active
        FROM User_Subscriptions WHERE chat_id = ?
      `).bind(chatId).first(),
      env.DB.prepare("SELECT item_limit FROM Users WHERE chat_id = ?").bind(chatId).first()
  ]);

  let limitText = t('menu.unlimited', lang);

  if (!isAdmin) {
    const defaultLimit = parseInt(env.DEFAULT_USER_PRODUCT_LIMIT);
    if (!isNaN(defaultLimit)) {
        limitText = userRow && userRow.item_limit !== null ? parseInt(userRow.item_limit) : defaultLimit;
    } else {
        limitText = t('menu.error', lang);
    }
  }

  const total = stats?.total || 0;
  const active = stats?.active || 0;
  const paused = total - active;

  const text = t('menu.deals_dashboard', lang) + '\n\n' +
    t('menu.your_saved_items', lang) + ` ${total} / ${limitText}\n` +
    t('menu.active', lang) + ` ${active} | ` + t('menu.paused', lang) + ` ${paused}\n\n` +
    `<i>${t('menu.select_option', lang)}</i>`;

  const keyboard = {
    inline_keyboard: [
      [{ text: t('menu.btn_my_products', lang), callback_data: "list_products_0" }],
      [{ text: t('menu.btn_how_to_add', lang), callback_data: "help_add" }],
      [{ text: t('menu.btn_language', lang), callback_data: "toggle_lang" }]
    ]
  };

  if (isAdmin) {
    keyboard.inline_keyboard.splice(2, 0, [{ text: t('menu.btn_admin_panel', lang), web_app: { url: `${baseUrl}/crm?lang=${lang}` } }]);
  }

  if (messageId) {
    await editTelegramMessage(env, chatId, messageId, text, keyboard);
  } else {
    await sendAppMessage(env, chatId, text, keyboard);
  }
}

async function renderProductList(env, chatId, messageId, page = 0, lang = 'en') {
  const { results: products } = await env.DB.prepare(
    `SELECT s.asin, s.is_paused, s.target_price, p.name, p.name_ar
     FROM User_Subscriptions s
     JOIN Global_Products p ON s.asin = p.asin
     WHERE s.chat_id = ?`
  ).bind(chatId).all();

  if (!products || products.length === 0) {
    const text = t('list.empty_head', lang) + '\n\n' + t('list.empty_hint', lang);
    const keyboard = { inline_keyboard: [[{ text: t('nav.main_menu', lang), callback_data: "main_menu" }]] };
    await editTelegramMessage(env, chatId, messageId, text, keyboard);
    return;
  }

  const ITEMS_PER_PAGE = 5;
  const totalPages = Math.ceil(products.length / ITEMS_PER_PAGE);
  if (page >= totalPages) page = Math.max(0, totalPages - 1);

  const pagedProducts = products.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);

  const keyboard = { inline_keyboard: [] };

  pagedProducts.forEach((p) => {
    const resolved = resolveProductName(p, lang, t('product.unknown_product', lang));
    let name = resolved || p.asin;
    if (name.length > 30) name = name.substring(0, 27) + "...";

    const statusIcon = p.is_paused ? "⏸️" : "✅";
    const targetIcon = p.target_price ? "🎯 " : "";
    keyboard.inline_keyboard.push([{ text: `${statusIcon} ${targetIcon}${name}`, callback_data: `view_${p.asin}` }]);
  });

  if (totalPages > 1) {
    let navRow = [];
    if (page > 0) {
      navRow.push({ text: t('list.prev', lang), callback_data: `list_products_${page - 1}` });
    }
    navRow.push({ text: `📄 ${page + 1}/${totalPages}`, callback_data: "ignore" });
    if (page < totalPages - 1) {
      navRow.push({ text: t('list.next', lang), callback_data: `list_products_${page + 1}` });
    }
    keyboard.inline_keyboard.push(navRow);
  }

  keyboard.inline_keyboard.push([{ text: t('nav.main_menu', lang), callback_data: "main_menu" }]);

  const text = t('list.my_saved_products', lang) + ` (${t('list.page_of', lang, { page: page + 1, total: totalPages })})\n\n<i>${t('list.select_hint', lang)}</i>`;
  await editTelegramMessage(env, chatId, messageId, text, keyboard);
}

async function renderProductView(env, chatId, messageId, pid, baseUrl, lang = 'en') {
  const product = await env.DB.prepare(
    `SELECT s.asin, s.is_paused as paused, s.target_price, p.name as name, p.name_ar,
            p.amazon_price, p.used_price, p.new_price, p.last_updated,
            p.new_seller, p.new_mid, p.used_seller, p.used_mid,
            p.amazon_seller, p.amazon_mid, p.seen_amazon_eg_at, p.seen_resale_at
     FROM User_Subscriptions s
     JOIN Global_Products p ON s.asin = p.asin
     WHERE s.chat_id = ? AND s.asin = ?`
  ).bind(chatId, pid).first();

  if (!product) return;
  const prices = { [pid]: {
    asin: product.asin,
    new_price: product.new_price,
    used_price: product.used_price,
    amazon_price: product.amazon_price,
    name: product.name,
    name_ar: product.name_ar,
    new_seller: product.new_seller,
    new_mid: product.new_mid,
    used_seller: product.used_seller,
    used_mid: product.used_mid,
    amazon_seller: product.amazon_seller,
    amazon_mid: product.amazon_mid,
    seen_amazon_eg_at: product.seen_amazon_eg_at,
    seen_resale_at: product.seen_resale_at
  } };

  const statusStr = product.paused ? t('product.status_paused', lang) : t('product.status_active', lang);
  let lastPrice = t('product.waiting_check', lang);
  let lastUpdated = "";
  let sellerInfo = "";
  let smartAlts = "";
  let title = product.name ? product.name : t('product.amazon_product', lang);

  const { last_updated: systemCheckTime } = await env.DB.prepare("SELECT MAX(last_updated) as last_updated FROM Global_Products").first() || { last_updated: null };

  if (prices[pid]) {
    if (typeof prices[pid] === 'object') {
      let pData = prices[pid];
      let newPrice = pData.new_price !== undefined ? pData.new_price : pData.price;
      let newSeller = pData.new_seller || pData.seller;
      let usedPrice = pData.used_price;

      if (newPrice !== undefined && newPrice !== null) {
        lastPrice = newPrice.toLocaleString() + " " + t('chrome.currency_egp', lang);
        if (newSeller) sellerInfo = '\n' + t('product.seller_label', lang) + ` <i>${escapeHtml(newSeller)}</i>`;
      } else if (usedPrice !== undefined && usedPrice !== null) {
        // Gap 9.8 fix: show used price + used seller when new stock is unavailable
        const usedSeller = pData.used_seller;
        lastPrice = `${usedPrice.toLocaleString()} ${t('chrome.currency_egp', lang)} <i>${t('product.used_tag', lang)}</i>`;
        if (usedSeller) sellerInfo = '\n' + t('product.seller_label', lang) + ` <i>${escapeHtml(usedSeller)}</i>`;
      } else {
        lastPrice = t('product.out_of_stock', lang);
        sellerInfo = "";
      }

      if (pData.name || pData.name_ar) title = resolveProductName(pData, lang, t('product.unknown_product', lang));

      smartAlts = buildSmartAlternatives(pData, pid, env, lang);
    } else {
      lastPrice = prices[pid].toLocaleString() + " " + t('chrome.currency_egp', lang);
    }
  }

  if (systemCheckTime) {
    const dateObj = new Date(systemCheckTime);
    const checkDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(dateObj);
    const checkTime = dateObj.toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo", hour: '2-digit', minute:'2-digit' });
    const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());

    if (checkDate === todayStr) {
      lastUpdated = ` <i>${t('product.checked_today', lang, { time: checkTime })}</i>`;
    } else {
      lastUpdated = ` <i>${t('product.checked_date', lang, { date: checkDate, time: checkTime })}</i>`;
    }
  }

  const cleanTitle = escapeHtml(title.length > 35 ? title.substring(0, 32) + "..." : title);
  let targetText = product.target_price ? '\n' + t('product.target_label', lang) + ` ${product.target_price.toLocaleString()} ${t('chrome.currency_egp', lang)}` : "";

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
               `${t('product.asin_row', lang, { asin: pid })}\n\n` +
               t('product.price_label', lang) + ` ${lastPrice}` +
               targetText +
               sellerInfo +
               smartAlts + '\n\n' +
               t('product.status_label', lang) + ` ${statusStr}${lastUpdated}\n\n${t('alert.boosted_label', lang)}`;

  const targetBtn = product.target_price
    ? { text: t('product.btn.clear_target', lang), callback_data: `confClearTgt_${pid}` }
    : { text: t('product.btn.set_target', lang), callback_data: `settarget_${pid}` };

    const keyboard = {
    inline_keyboard: [
      [{ text: t('product.btn.open_amazon', lang), url: productUrl }],
      [
        { text: product.paused ? t('product.btn.resume', lang) : t('product.btn.pause', lang), callback_data: `${product.paused ? "resume" : "pause"}_${pid}` },
        targetBtn
      ],
      [
        { text: t('product.btn.delete', lang), callback_data: `confirmDel_${pid}` }
      ],
      [
        { text: t('product.btn.back_to_products', lang), callback_data: "list_products_0" },
        { text: t('product.btn.main_menu', lang), callback_data: "main_menu" }
      ]
    ]
  };

  await editTelegramMessage(env, chatId, messageId, text, keyboard);
}




// ── Core Helpers ────────────────────────────────────────────────────────────

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

function buildSmartAlternatives(pData, pid, env, lang = 'en') {
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
      historicalLinks.push(`┘ 🛡️ <a href="${escapeHtml(amazonEgUrl)}">${t('product.amazon_eg_label', lang)}</a>: <b>${amazonPrice.toLocaleString()} ${t('chrome.currency_egp', lang)}</b>`);
    } else if (amazonSeenRecently) {
      historicalLinks.push(`┘ 🛡️ <a href="${escapeHtml(amazonEgUrl)}">${t('product.amazon_eg_label', lang)}</a> <i>${t('product.check_stock', lang)}</i>`);
    }
  }

  // Amazon Resale Link
  if (!currentSellerIsResale) {
    const resaleUrl = buildProductUrl(pid, env, AMAZON_RESALE_MERCHANT_ID);
    if (usedPrice !== null) {
      historicalLinks.push(`┘ 📦 <a href="${escapeHtml(resaleUrl)}">${t('product.resale_label', lang)}</a>: <b>${usedPrice.toLocaleString()} ${t('chrome.currency_egp', lang)}</b> <i>${t('product.used_tag', lang)}</i>`);
    } else if (resaleSeenRecently) {
      historicalLinks.push(`┘ 📦 <a href="${escapeHtml(resaleUrl)}">${t('product.resale_label', lang)}</a> <i>${t('product.check_stock', lang)}</i>`);
    }
  }

  // Render the clean block
  if (historicalLinks.length > 0) {
    return `\n\n${t('product.other_options_head', lang)}\n${historicalLinks.join("\n")}`;
  }

  return "";
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
