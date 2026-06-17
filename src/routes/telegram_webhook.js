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

const rateLimitCache = new Map();

/**
 * Check whether a chat is rate-limited using in-memory Map (0 KV cost).
 * Returns { allowed, remaining, resetMs }.
 */
async function checkRateLimit(chatId, env) {
  const now = Date.now();
  let data = rateLimitCache.get(chatId);
  
  if (!data || (now - data.windowStart) >= RATE_LIMIT_WINDOW_MS) {
    data = { count: 1, windowStart: now };
    rateLimitCache.set(chatId, data);
    return { allowed: true, remaining: RATE_LIMIT_MAX_MESSAGES - 1, resetMs: RATE_LIMIT_WINDOW_MS };
  }
  
  data.count += 1;
  const elapsed = now - data.windowStart;
  const remaining = Math.max(0, RATE_LIMIT_MAX_MESSAGES - data.count);
  const resetMs = RATE_LIMIT_WINDOW_MS - elapsed;
  
  // Safety valve: prevent memory leak in long-lived isolate
  if (rateLimitCache.size > 10000) rateLimitCache.clear();
  
  return { allowed: data.count <= RATE_LIMIT_MAX_MESSAGES, remaining, resetMs };
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
      || payload.my_chat_member?.chat?.id?.toString()
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
    } else if (payload.message && (payload.message.text || payload.message.web_app_data)) {
      ctx.waitUntil(handleMessage(payload.message, env, baseUrl, ctx));
    } else if (payload.my_chat_member) {
      const chatMember = payload.my_chat_member;
      if (chatMember.chat && chatMember.chat.type === 'private') {
        if (chatMember.new_chat_member?.status === 'kicked') {
          console.warn(`[Bot Blocked] User ${chatMember.chat.id} blocked the bot.`);
          ctx.waitUntil(env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 1 WHERE chat_id = ?").bind(chatMember.chat.id.toString()).run());
        }
      }
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
  let text = message.text ? message.text.trim() : (message.web_app_data?.data || "").trim();
  if (typeof convertHindiToArabic === 'function') text = convertHindiToArabic(text);
  const chatId = message.chat.id.toString();
  const messageId = message.message_id;

  // ── Language Detection ──────────────────────────────────────────────────
  // For approved users: read lang from DB via getUserRoles
  // For unapproved users: detect from Telegram OS language_code
  const { isRootAdmin, isAdmin, isApproved, isRejected, rootAdmins, admins, approvedUsers, lang: dbLang } = await getUserRoles(chatId, env, ctx);

  // ── Dev Bot Lockdown ────────────────────────────────────────────────────
  if (env.ENVIRONMENT === 'dev' && !isRootAdmin && !isAdmin) {
    if (text === "/start") {
      const lang = dbLang || 'masry';
      const lockMsg = t('access.dev_bot_lockdown_head', lang) + "\n\n" + t('access.dev_bot_lockdown', lang);
      await sendAppMessage(env, chatId, lockMsg);
    }
    return new Response("OK", { status: 200 });
  }

  if (isApproved || isAdmin) {
    ctx.waitUntil(env.DB.prepare("UPDATE Users SET last_active = ? WHERE chat_id = ?").bind(Date.now(), chatId).run());
  }
  if (ctx && ctx.waitUntil) ctx.waitUntil(syncUserNames(env, chatId, message.from, baseUrl));
  // Enforce masry for all new users unconditionally instead of checking OS language
  const lang = dbLang || 'masry';

  if (!isApproved) {
    if (isRejected) {
      // Check if user already has a pending unban request in Join_Queue
      const existingUnban = await env.DB.prepare("SELECT 1 FROM Join_Queue WHERE chat_id = ? AND request_type = 'unban'").bind(chatId).first();
      // Check the permanent ban flag on the Users table (single source of truth)
      const userRow = await env.DB.prepare("SELECT unban_rejected FROM Users WHERE chat_id = ?").bind(chatId).first();
      const isPermBanned = userRow && userRow.unban_rejected === 1;
      if (text === "/start") {
        if (isPermBanned) {
          // Permanently banned — unban request was rejected. NO re-request possible.
          // Only recovery: admin uses CRM banned tab → "Unban User"
          await sendAppMessage(env, chatId, t('access.unban_rejected', lang));
        } else if (existingUnban) {
          // Already requested unban — show pending state, not the button again
          await sendAppMessage(env, chatId, t('access.unban_pending', lang));
        } else {
          // Rejected but not permanently banned — show unban request button
          await sendAppMessage(env, chatId, t('access.denied_head', lang) + '\n\n' + t('access.denied_body_private', lang), {
            inline_keyboard: [[{ text: t('access.unban_btn', lang), callback_data: `request_unban_${chatId}` }]]
          });
        }
      } else {
        if (isPermBanned) {
          await sendAppMessage(env, chatId, t('access.unban_rejected', lang));
        } else {
          await sendAppMessage(env, chatId, t('access.denied_head', lang) + '\n\n' + t('access.denied_body_private', lang) + '\n\n' + t('access.denied_hint_start', lang));
        }
      }
      return;
    }

    // Check if user was previously blocked (bot banned/unreachable)
    const blockedUser = await env.DB.prepare("SELECT 1 FROM Users WHERE chat_id = ? AND role = 'blocked'").bind(chatId).first() !== null;

    const inQueue = await env.DB.prepare("SELECT 1 FROM Join_Queue WHERE chat_id = ?").bind(chatId).first() !== null;
    console.error(`[JOIN_QUEUE] /start check: chatId=${chatId}, lang=${lang}, isRejected=${isRejected}, blockedUser=${blockedUser}, inQueue=${inQueue}`);

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
      console.error(`[JOIN_QUEUE] New user /start: chatId=${chatId}, sending Request Access button`);
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
  if (text.startsWith("/start")) {
    if (activeState) await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(stateKey).run();
    await deleteTelegramMessage(env, chatId, messageId);

    // Ensure root admin always exists in Users table (idempotent)
    const __raRaw = env.TELEGRAM_ROOT_ADMIN_IDS || env.ROOT_ADMIN_ID || env.TELEGRAM_ADMIN_IDS || "";
    const __raList = __raRaw.split(",").filter(Boolean).map(s => s.trim());
    if (__raList.includes(String(chatId))) {
      await env.DB.prepare("INSERT OR IGNORE INTO Users (chat_id, role, item_limit, created_at) VALUES (?, 'admin', 0, ?)").bind(String(chatId), Date.now()).run();
    }

    // Only set lang from Telegram OS on first interaction (NULL), never overwrite.
    // Always use masry unconditionally for new users instead of checking OS language
    await env.DB.prepare("UPDATE Users SET lang = ? WHERE chat_id = ? AND lang IS NULL").bind('masry', chatId).run();

    // Re-read lang after potential update: use DB value, fall back to masry
    const freshRoles = await getUserRoles(chatId, env, ctx);
    const effectiveLang = freshRoles.lang || 'masry';

    ctx.waitUntil(setChatMenuButton(env, chatId, baseUrl, effectiveLang, isAdmin));
    const startPayload = text.split(' ')[1];
    if (startPayload && startPayload.startsWith('track_')) {
      const asin = startPayload.replace('track_', '').trim();
      if (asin) {
        text = `https://www.amazon.eg/dp/${asin}`;
        // Fall through to let URL parser handle it natively!
      } else {
        await renderMainMenu(env, chatId, null, isAdmin, baseUrl, effectiveLang);
        return;
      }
    } else {
      await renderMainMenu(env, chatId, null, isAdmin, baseUrl, effectiveLang);
      return;
    }
  } else if (text.startsWith('/')) {
    if (activeState) await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(stateKey).run();
    await deleteTelegramMessage(env, chatId, messageId);
    const freshRoles = await getUserRoles(chatId, env, ctx);
    const effectiveLang = freshRoles.lang || 'masry';
    
    await renderMainMenu(env, chatId, null, isAdmin, baseUrl, effectiveLang);
    return;
  }

  // -------------------------------




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
      await editTelegramMessage(env, chatId, tempMessageId, t('link.region_not_supported_head', lang) + '\n\n' + t('link.region_not_supported_body', lang));
      return;
    }

    const pid = getAsinFromUrl(expandedUrl);

    if (!pid) {
      await editTelegramMessage(env, chatId, tempMessageId, t('link.could_not_parse', lang));
      return;
    }

    const user = await env.DB.prepare("SELECT item_limit FROM Users WHERE chat_id = ?").bind(chatId).first();
    const defaultLimit = parseInt(env.DEFAULT_USER_PRODUCT_LIMIT);
    const userLimit = user && user.item_limit !== null ? parseInt(user.item_limit) : defaultLimit;

    const { results: existingProducts } = await env.DB.prepare("SELECT asin FROM User_Subscriptions WHERE chat_id = ?").bind(chatId).all();

    if (!isAdmin) {
      if (isNaN(defaultLimit)) {
        await editTelegramMessage(env, chatId, tempMessageId, t('link.system_error', lang));
        return;
      }

      if (existingProducts && existingProducts.length >= userLimit) {
        await editTelegramMessage(env, chatId, tempMessageId, t('link.limit_reached_head', lang) + '\n\n' + t('link.limit_reached_body', lang, { used: existingProducts.length, limit: userLimit }));
        return;
      }
    }

    if (existingProducts && existingProducts.some(p => p.asin === pid)) {
      await editTelegramMessage(env, chatId, tempMessageId, t('link.already_exists', lang));
      return;
    }

    let extractedName = extractNameFromUrl(expandedUrl);

    // Fetch Arabic product name (non-blocking — falls back to English only)
    let arabicName = null;
    try {
      const clientId = env.AMAZON_CLIENT_ID || env.AMZN_CREATORS_ACCESS_KEY || env.AWS_ACCESS_KEY_ID;
      const clientSecret = env.AMAZON_CLIENT_SECRET || env.AMZN_CREATORS_SECRET_KEY || env.AWS_SECRET_ACCESS_KEY;
      if (clientId && clientSecret) {
        const token = await getAmazonAccessToken(clientId, clientSecret);
        const parser = new AmazonEdgeParser(token, env.AMAZON_PARTNER_TAG, 'www.amazon.eg', env);
        const arabicMap = await parser.getItemsWithArabic([pid]);
        if (arabicMap.has(pid)) {
          arabicName = arabicMap.get(pid);
        }
        // Fallback: scrape amazon.eg page if API didn't return Arabic
        if (!arabicName) {
          arabicName = await parser.scrapeArabicTitle(pid);
        }
        // Fetch English if URL extraction failed
        if (!extractedName) {
          extractedName = await parser.scrapeEnglishTitle(pid);
        }
      }
    } catch (e) {
      console.warn('[Webhook] Name fetch failed (non-blocking):', e.message);
    }

    // Insert into Global_Products to track price globally
    await env.DB.prepare(`
      INSERT INTO Global_Products (asin, name, name_ar, last_updated)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(asin) DO UPDATE SET 
        name = COALESCE(NULLIF(excluded.name, excluded.asin), name), 
        name_ar = COALESCE(excluded.name_ar, name_ar)
    `).bind(pid, extractedName || pid, arabicName).run();

    await env.DB.prepare(`
      INSERT INTO User_Subscriptions (chat_id, asin, added_at)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_id, asin) DO NOTHING
    `).bind(chatId, pid, Date.now()).run();


    const title = extractedName ? extractedName : pid;
    const cleanTitle = escapeHtml(title.length > 35 ? title.substring(0, 32) + "..." : title);

    const successText = t('link.registered_head', lang) + '\n\n' +
                    `📌 <b>${cleanTitle}</b>\n` +
                    `${t('product.asin_inline', lang, { asin: pid })}\n\n` +
                    t('link.registered_status', lang) + '\n\n' +
                    `🕐 <b>${t('link.status_label', lang)}</b> ${t('link.pending_scan', lang)}\n\n${t('alert.boosted_label', lang)}`;
    await editTelegramMessage(env, chatId, tempMessageId, successText);
    return;
  }


  await deleteTelegramMessage(env, chatId, messageId);
  await sendAppMessage(env, chatId, t('link.invalid_command', lang));
}

async function handleCallback(callback, env, baseUrl, ctx) {
  const data = callback.data;
  const message = callback.message;
  const chatId = message.chat.id.toString();
  const messageId = message.message_id;

  // Validate User & Role Configuration
  const { isRootAdmin, isAdmin, isApproved, isRejected, rootAdmins, admins, approvedUsers, lang: dbLang } = await getUserRoles(chatId, env, ctx);

  // ── Dev Bot Lockdown ────────────────────────────────────────────────────
  if (env.ENVIRONMENT === 'dev' && !isRootAdmin && !isAdmin) {
    await env.DB.prepare(`
      INSERT INTO Outbox (chat_id, payload)
      VALUES (?, ?)
    `).bind(chatId, JSON.stringify({
      method: "answerCallbackQuery",
      callback_query_id: callback.id,
      text: t('access.dev_bot_lockdown_short', dbLang || 'masry'),
      show_alert: true
    })).run();
    return new Response("OK", { status: 200 });
  }

  if (isApproved || isAdmin) {
    ctx.waitUntil(env.DB.prepare("UPDATE Users SET last_active = ? WHERE chat_id = ?").bind(Date.now(), chatId).run());
  }
  const lang = dbLang || 'masry';
  if (ctx && ctx.waitUntil) ctx.waitUntil(syncUserNames(env, chatId, callback.from, baseUrl));

  if (!isApproved && !data.startsWith("request_access_") && !data.startsWith("request_unban_")) return;



  console.log(`[JOIN_QUEUE] handleCallback: data=${data}, chatId=${chatId}, isApproved=${isApproved}, isAdmin=${isAdmin}`);
  try {
    if (data.startsWith("request_access_")) {
      const targetId = data.replace("request_access_", "");
      if (targetId !== chatId) return;

      const countRow = await env.DB.prepare("SELECT COUNT(*) as count FROM Join_Queue").first();
      if (countRow.count >= QUEUE_MAX_DEPTH) {
        await editTelegramMessage(env, chatId, messageId, t('access.queue_full_head', lang) + '\n\n' + t('access.queue_full_body', lang));
        return;
      }

      await editTelegramMessage(env, chatId, messageId, t('access.request_sent', lang));

      // ATOMIC INSERT FIRST — prevents race condition where concurrent clicks
      // send duplicate admin notifications. If row already exists, INSERT affects
      // 0 rows and we bail out.
      console.error(`[JOIN_QUEUE] Attempting INSERT for chatId=${chatId}, first_name=${callback.from?.first_name}, username=${callback.from?.username}`);
      const insertResult = await env.DB.prepare(`
        INSERT OR IGNORE INTO Join_Queue (chat_id, first_name, username, requested_at, admin_messages, request_type, lang)
        VALUES (?, ?, ?, ?, '{}', 'access', ?)
      `).bind(
        chatId,
        callback.from?.first_name || '',
        callback.from?.username || '',
        Date.now(),
        lang
      ).run();
      console.error(`[JOIN_QUEUE] INSERT result: changes=${insertResult.meta.changes}, last_row_id=${insertResult.meta.last_row_id}`);

      if (insertResult.meta.changes === 0) {
        // Already in queue — duplicate click, bail silently
        console.error(`[JOIN_QUEUE] Duplicate request — chatId=${chatId} already in queue`);
        return;
      }

      const { label } = await resolveUserProfile(env, chatId, ctx);

      const allAdmins = [...new Set([...admins, ...rootAdmins])];
      // Fetch each admin's language preference for per-admin localized notifications
      const adminLangMap = {};
      if (allAdmins.length > 0) {
        const placeholders = allAdmins.map(() => '?').join(',');
        const { results: adminRows } = await env.DB.prepare(
          `SELECT chat_id, lang, mute_join_queue FROM Users WHERE chat_id IN (${placeholders})`
        ).bind(...allAdmins).all();
        for (const row of adminRows) {
          if (row.mute_join_queue === 1) {
            allAdmins.splice(allAdmins.indexOf(row.chat_id), 1);
            continue;
          }
          adminLangMap[row.chat_id] = row.lang || 'masry';
        }
      }

      console.error(`[JOIN_QUEUE] Notifying ${allAdmins.length} admins: ${JSON.stringify(allAdmins)}`);
      let admin_messages = {};
      for (const adminId of allAdmins) {
        const adminLang = adminLangMap[adminId] || 'masry';
        const adminMsg = t('access.admin_new_request_head', adminLang) + '\n\n' + t('access.admin_new_request_body', adminLang, { name: escapeHtml(label), id: chatId });
        const adminButtons = {
          inline_keyboard: [
            [{ text: t('access.admin_new_request_btn_approve', adminLang), callback_data: `queueApprove_${chatId}` }, { text: t('access.admin_new_request_btn_reject', adminLang), callback_data: `queueReject_${chatId}` }]
          ]
        };
        try {
          const sent = await sendTelegram(env, adminId, adminMsg, adminButtons);
          console.error(`[JOIN_QUEUE] Admin ${adminId} notify: ok=${sent?.ok}, error=${sent?.description || 'none'}`);
          if (sent && sent.ok && sent.result) {
              admin_messages[adminId] = sent.result.message_id;
          }
        } catch(e) { console.error("Failed to notify admin", adminId, e); }
      }

      // Persist admin message IDs for later "handled" updates
      await env.DB.prepare("UPDATE Join_Queue SET admin_messages = ? WHERE chat_id = ?").bind(
        JSON.stringify(admin_messages),
        chatId
      ).run();
      console.error(`[JOIN_QUEUE] Done. Admin messages persisted: ${JSON.stringify(admin_messages)}`);
    }
    else if (data.startsWith("request_unban_")) {
      const targetId = data.replace("request_unban_", "");
      if (targetId !== chatId) return;

      await editTelegramMessage(env, chatId, messageId, t('access.unban_sent', lang));

      // ATOMIC INSERT FIRST — prevents duplicate unban requests on rapid clicks
      const unbanInsert = await env.DB.prepare(`
        INSERT OR IGNORE INTO Join_Queue (chat_id, first_name, username, requested_at, admin_messages, request_type, lang)
        VALUES (?, ?, ?, ?, '{}', 'unban', ?)
      `).bind(
        chatId,
        callback.from?.first_name || '',
        callback.from?.username || '',
        Date.now(),
        lang
      ).run();

      if (unbanInsert.meta.changes === 0) {
        // Already in queue — duplicate click, bail silently
        return;
      }

      const { label } = await resolveUserProfile(env, chatId, ctx);

      const allAdmins = [...new Set([...admins, ...rootAdmins])];
      // Fetch each admin's language for per-admin localized notifications
      const adminLangMap = {};
      if (allAdmins.length > 0) {
        const placeholders = allAdmins.map(() => '?').join(',');
        const { results: adminRows } = await env.DB.prepare(
          `SELECT chat_id, lang, mute_join_queue FROM Users WHERE chat_id IN (${placeholders})`
        ).bind(...allAdmins).all();
        for (const row of (adminRows || [])) {
          if (row.mute_join_queue === 1) {
            allAdmins.splice(allAdmins.indexOf(row.chat_id), 1);
            continue;
          }
          adminLangMap[row.chat_id] = row.lang || 'masry';
        }
      }

      // Notify ALL admins — plain message, no inline buttons.
      // Admins handle this from the CRM dashboard.
      for (const adminId of allAdmins) {
        const adminLang = adminLangMap[adminId] || 'masry';
        const adminMsg = t('admin.unban_request_head', adminLang) + '\n\n' + t('admin.unban_request_body', adminLang, { name: escapeHtml(label), id: chatId }) + '\n\n' + t('admin.unban_request_dashboard_hint', adminLang);
        try {
          await sendTelegram(env, adminId, adminMsg);
        } catch(e) { console.error("Failed to notify admin", adminId); }
      }
    }
    else if (data.startsWith("show_variations_")) {
      const parentAsin = data.replace("show_variations_", "");
      if (!parentAsin) return;

      // Fetch variations from Amazon API
      let variations = [];
      try {
        let accessToken = await env.AZTRACKER_DB.get('amazon_access_token');
        if (!accessToken) {
          const clientId = env.AMAZON_CLIENT_ID || env.AMZN_CREATORS_ACCESS_KEY || env.AWS_ACCESS_KEY_ID;
          const clientSecret = env.AMAZON_CLIENT_SECRET || env.AMZN_CREATORS_SECRET_KEY || env.AWS_SECRET_ACCESS_KEY;
          accessToken = await getAmazonAccessToken(clientId, clientSecret);
        }
        const parser = new AmazonEdgeParser(accessToken, env.AMAZON_PARTNER_TAG, 'www.amazon.eg', env);
        variations = await parser.getVariations(parentAsin);
      } catch (e) {
        console.warn('[ShowVariations] Failed:', e.message);
      }

      if (variations.length === 0) {
        await sendTelegram(env, chatId, t('alert.no_variations', lang) || 'No options found for this product.');
        return;
      }

      // Check which variations the user already tracks
      const userSubs = await env.DB.prepare(
        "SELECT asin FROM User_Subscriptions WHERE chat_id = ? AND asin IN (" + variations.map(() => '?').join(',') + ")"
      ).bind(chatId, ...variations.map(v => v.asin)).all();
      const trackedAsins = new Set((userSubs.results || []).map(r => r.asin));

      // Build inline keyboard with variation buttons
      const keyboard = variations.map(v => {
        const isTracked = trackedAsins.has(v.asin);
        const label = escapeHtml(v.name || v.asin);
        return [{
          text: isTracked ? `✅ ${label}` : `📦 ${label}`,
          callback_data: isTracked ? `tracked_${v.asin}` : `track_variation_${parentAsin}_${v.asin}_${encodeURIComponent(v.name || '')}`
        }];
      });

      await sendTelegram(env, chatId, t('alert.variations_title', lang) || '📦 Available Options:', { inline_keyboard: keyboard });
    }
    else if (data.startsWith("queueReject_") && isAdmin) {
      const targetId = data.replace("queueReject_", "");
      let queueObj = await env.DB.prepare("SELECT * FROM Join_Queue WHERE chat_id = ?").bind(targetId).first();
      if (!queueObj) {
        // Another admin already handled this — answer callback and update this message
        const expiredText = t('admin.request_expired', lang);
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: callback.id, text: expiredText, show_alert: true })
        }).catch(() => {});
        await editTelegramMessage(env, chatId, messageId, expiredText, { inline_keyboard: [] }).catch(() => {});
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

      // ATOMIC DELETE with change detection — prevents race condition
      // when two admins act on the same queue item simultaneously
      const deleteResult = await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();
      if (deleteResult.meta.changes === 0) {
        // Another admin already deleted the row — update this message + answer callback
        const expiredText = t('admin.request_expired', lang);
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: callback.id, text: expiredText, show_alert: true })
        }).catch(() => {});
        await editTelegramMessage(env, chatId, messageId, expiredText, { inline_keyboard: [] }).catch(() => {});
        return;
      }

      // Build human-readable label from queue row for admin notifications
      const targetLabel = queueObj?.username
        ? `${queueObj.first_name} (@${queueObj.username})`
        : `${queueObj?.first_name || 'Unknown'} (${targetId})`;
      const { label: adminName } = await resolveUserProfile(env, chatId, ctx);
      await editTelegramMessage(env, chatId, messageId, t('access.admin_rejected', lang, { id: targetLabel, admin: escapeHtml(adminName) }));

      // Update ALL other admins' messages in their own language preference
      for (const [admId, msgId] of Object.entries(otherAdminMessages)) {
        try {
          const aLangRow = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(admId).first();
          const aLang = aLangRow?.lang || 'masry';
          await editTelegramMessage(env, admId, msgId, t('access.handled_request', aLang, { id: targetLabel, admin: escapeHtml(adminName) }), { inline_keyboard: [] });
        } catch(e) { console.error(`Failed to update admin ${admId} message:`, e); }
      }

      // Set role and handle unban_rejected flag based on request type
      if (queueObj?.request_type === 'unban') {
        // Rejecting an unban request → permanently ban the user (unban_rejected=1)
        await env.DB.prepare(`
          INSERT INTO Users (chat_id, first_name, username, role, approved_by, item_limit, created_at, lang, unban_rejected)
          VALUES (?, ?, ?, 'rejected', ?, ?, ?, ?, 1)
          ON CONFLICT(chat_id) DO UPDATE SET role = 'rejected', unban_rejected = 1
        `).bind(
          targetId,
          queueObj ? (queueObj.first_name || '') : '',
          queueObj ? (queueObj.username || '') : '',
          chatId,
          env.DEFAULT_USER_PRODUCT_LIMIT || "3",
          Date.now(),
          queueObj?.lang || 'masry'
        ).run();
      } else {
        // Rejecting initial access request → role='rejected', unban_rejected stays 0
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
          queueObj?.lang || 'masry'
        ).run();
      }
      ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));

      // Notify rejected user in their detected language
      const targetLang = queueObj?.lang || 'masry';

      if (queueObj?.request_type === 'unban') {
        await sendTelegram(env, targetId, t('access.unban_rejected', targetLang));
      } else {
        await sendTelegram(env, targetId, t('access.denied_notify', targetLang));
      }

      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "REJECT_USER", targetId, { unban: queueObj?.request_type === 'unban' }));
    }
    else if (data.startsWith("queueApprove_") && isAdmin) {
      const targetId = data.replace("queueApprove_", "");
      let queueObj = await env.DB.prepare("SELECT * FROM Join_Queue WHERE chat_id = ?").bind(targetId).first();
      if (!queueObj) {
        const expiredText = t('admin.request_expired', lang);
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: callback.id, text: expiredText, show_alert: true })
        }).catch(() => {});
        await editTelegramMessage(env, chatId, messageId, expiredText, { inline_keyboard: [] }).catch(() => {});
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

      // ATOMIC DELETE with change detection — prevents race condition
      const deleteResult = await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();
      if (deleteResult.meta.changes === 0) {
        const expiredText = t('admin.request_expired', lang);
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: callback.id, text: expiredText, show_alert: true })
        }).catch(() => {});
        await editTelegramMessage(env, chatId, messageId, expiredText, { inline_keyboard: [] }).catch(() => {});
        return;
      }

      const targetLang = queueObj?.lang || 'masry';
      ctx.waitUntil(setChatMenuButton(env, targetId, baseUrl, targetLang, false));
      const defaultLimit = env.DEFAULT_USER_PRODUCT_LIMIT || "3";

      // Approve user and clear permanent ban flag (if approving an unban request)
      await env.DB.prepare(`
         INSERT INTO Users (chat_id, first_name, username, role, approved_by, item_limit, created_at, lang, unban_rejected)
         VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, 0)
         ON CONFLICT(chat_id) DO UPDATE SET role = 'approved', approved_by = excluded.approved_by, lang = COALESCE(lang, excluded.lang), unban_rejected = 0
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
      await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(`unban_rejected:${targetId}`).run();

      // Unpause subscriptions if this was an unban approval
      if (queueObj?.request_type === 'unban') {
        await env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 0, paused_at = NULL WHERE chat_id = ?").bind(targetId).run();
      }

      // Build human-readable label from queue row for admin notifications
      const targetLabel = queueObj?.username
        ? `${queueObj.first_name} (@${queueObj.username})`
        : `${queueObj?.first_name || 'Unknown'} (${targetId})`;
      const { label: adminName } = await resolveUserProfile(env, chatId, ctx);
      await editTelegramMessage(env, chatId, messageId, t('admin.approved_result', lang, { id: targetLabel, admin: escapeHtml(adminName) }));

      // Update ALL other admins' messages in their own language preference
      for (const [admId, msgId] of Object.entries(otherAdminMessages)) {
        try {
          const aLangRow = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(admId).first();
          const aLang = aLangRow?.lang || 'masry';
          await editTelegramMessage(env, admId, msgId, t('access.handled_approved', aLang, { id: targetLabel, admin: escapeHtml(adminName) }), { inline_keyboard: [] });
        } catch(e) { console.error(`Failed to update admin ${admId} message:`, e); }
      }

      // Send welcome message in the user's detected language
      const welcomeMessage = getWelcomeMessage(targetLang, defaultLimit);
      await sendTelegram(env, targetId, welcomeMessage);

      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "APPROVE_USER", targetId, {}));
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
      else if (data.startsWith("track_variation_")) {
        // Format: track_variation_{parentAsin}_{childAsin}_{encodedName}
        const parts = data.replace("track_variation_", "").split("_");
        if (parts.length < 3) return;
        const childAsin = parts[parts.length - 2];
        const parentAsin = parts.slice(0, -2).join("_");
        const variationName = decodeURIComponent(parts[parts.length - 1]) || childAsin;

        // Upsert into Global_Products (stores variation name by child ASIN)
        await env.DB.prepare(`
          INSERT INTO Global_Products (asin, name, image_url, first_seen, last_checked)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(asin) DO UPDATE SET name = excluded.name, last_checked = excluded.last_checked
        `).bind(childAsin, variationName, null, Date.now(), Date.now()).run();

        // Insert subscription
        await env.DB.prepare(`
          INSERT INTO User_Subscriptions (chat_id, asin, added_at)
          VALUES (?, ?, ?)
          ON CONFLICT(chat_id, asin) DO NOTHING
        `).bind(chatId, childAsin, Date.now()).run();

        // Update button to show tracked state
        try {
          const currentMarkup = message.reply_markup;
          if (currentMarkup?.inline_keyboard) {
            const newKeyboard = currentMarkup.inline_keyboard.map(row =>
              row.map(btn => {
                if (btn.callback_data === data) {
                  return { text: `✅ ${t('alert.tracked', lang)}: ${variationName}`, callback_data: `tracked_${childAsin}` };
                }
                return btn;
              })
            );
            await editTelegramMessage(env, chatId, messageId, message.text || message.caption || '', { inline_keyboard: newKeyboard });
          }
        } catch (e) { console.warn('[VariationTrack] Failed to update button:', e.message); }

        // Notify user
        await sendTelegram(env, chatId, t('alert.now_tracking', lang, { name: variationName }));
      }
      else if (data.startsWith("manage_user_") && isAdmin) {
        await renderMainMenu(env, chatId, messageId, isAdmin, baseUrl, lang);
      }
    else if (data.startsWith("reject_") && isAdmin) {
      const targetId = data.replace("reject_", "");

      // Use target user's existing lang (from DB) if available; don't overwrite with admin's
      const targetUserRow = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(targetId).first();
      const targetLang = targetUserRow?.lang || 'masry';

      await env.DB.prepare(`
         INSERT INTO Users (chat_id, role, approved_by, item_limit, created_at, lang)
         VALUES (?, 'rejected', ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET role = 'rejected'
      `).bind(targetId, chatId, env.DEFAULT_USER_PRODUCT_LIMIT || "3", Date.now(), targetLang).run();
      ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));

      await editTelegramMessage(env, chatId, messageId, t('access.admin_rejected_manual', lang, { id: targetId }));
      await sendTelegram(env, targetId, t('access.denied_notify', targetLang));
      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "REJECT_USER", targetId, {}));
    }
    else if (data.startsWith("unban_") && isAdmin) {
      const targetId = data.replace("unban_", "");

      // Handle both 'rejected' and 'blocked' roles
      const userRow = await env.DB.prepare("SELECT role FROM Users WHERE chat_id = ?").bind(targetId).first();
      if (userRow && (userRow.role === 'rejected' || userRow.role === 'blocked')) {
        // Restore access: set role to 'approved', clear permanent ban flag, unpause subscriptions
        await env.DB.batch([
          env.DB.prepare("UPDATE Users SET role = 'approved', unban_rejected = 0 WHERE chat_id = ?").bind(targetId),
          env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 0 WHERE chat_id = ?").bind(targetId)
        ]);
      }
      ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));

      // Clean up join queue entry if exists
      await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();
      const targetUserRowForUnban = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(targetId).first();
      const targetLangForUnban = targetUserRowForUnban?.lang || 'masry';
      ctx.waitUntil(setChatMenuButton(env, targetId, baseUrl, targetLangForUnban, false));

      await editTelegramMessage(env, chatId, messageId, t('admin.unban_result', lang, { id: targetId }), {
        inline_keyboard: [[{ text: t('admin.back_to_directory', lang), callback_data: "admin_panel" }]]
      });

      // Notify the unbanned user in THEIR language (not the admin's)
      const targetUserRow = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(targetId).first();
      const targetUnbanLang = targetUserRow?.lang || 'masry';
      try {
        await sendTelegram(env, targetId, t('access.unban_notify', targetUnbanLang));
      } catch(e) { /* user may still have bot blocked */ }

      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "UNBAN_USER", targetId, {}));
    }
    else if (data.startsWith("approve_") && isAdmin) {
      const targetId = data.replace("approve_", "");
      const targetUserRow = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(targetId).first();
      const targetLang = targetUserRow?.lang || 'masry';
      await env.DB.prepare("INSERT INTO Users (chat_id, role, approved_by, item_limit, created_at, lang) VALUES (?, 'approved', ?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET role = 'approved', approved_by = excluded.approved_by, lang = COALESCE(lang, excluded.lang)").bind(targetId, chatId, env.DEFAULT_USER_PRODUCT_LIMIT || "3", Date.now(), targetLang).run();
      ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      await editTelegramMessage(env, chatId, messageId, t('admin.approved_manual_result', lang, { id: targetId }));

      const defaultLimit = env.DEFAULT_USER_PRODUCT_LIMIT || "3";
      const welcomeMessage = getWelcomeMessage(targetLang, defaultLimit);
      await sendTelegram(env, targetId, welcomeMessage);

      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "APPROVE_USER", targetId, {}));
    }
    else if (data.startsWith("revoke_") && isAdmin) {
      const targetId = data.replace("revoke_", "");

      // Security Boundary 1: Prevent revoking immutable Root Admins
      if (rootAdmins.includes(targetId)) return;

      // Security Boundary 2: Standard Admins cannot revoke other Admins
      const targetRoles = await getUserRoles(targetId, env, ctx);
        if (targetRoles.isRootAdmin || (targetRoles.isAdmin && !isRootAdmin)) return;



      // Soft revoke: preserve user + subscriptions, pause subs, keep history.
      // User gets their one unban chance (unban_rejected=0).
      await env.DB.batch([
        env.DB.prepare("UPDATE Users SET role = 'rejected', unban_rejected = 0 WHERE chat_id = ?").bind(targetId),
        env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 1 WHERE chat_id = ?").bind(targetId)
      ]);
      ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));

      await editTelegramMessage(env, chatId, messageId, t('admin.revoked_result', lang, { id: targetId }));

      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "REVOKE_USER", targetId, {}));
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
      const targetLang = targetRoles.lang || 'masry';
      await sendTelegram(env, targetId, t('admin.promoted_notify', targetLang));

      // AUDIT LOG
      ctx.waitUntil(logAudit(env, chatId, "PROMOTE_ADMIN", targetId, {}));
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
      ctx.waitUntil(logAudit(env, chatId, "DEMOTE_ADMIN", targetId, {}));
    }
    else if (data === "main_menu") {
      await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(`state:${chatId}`).run();
      await renderMainMenu(env, chatId, messageId, isAdmin, baseUrl, lang);
    }
    else if (data === "ignore") {
      return;
    }
    else if (data === "admin_panel" && isAdmin) {
      await renderMainMenu(env, chatId, messageId, isAdmin, baseUrl, lang);
    }
    else {
      // Legacy fallback: Route all deprecated product callbacks (view_, target_, list_, etc.) to the Main Menu
      await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(`state:${chatId}`).run();
      await renderMainMenu(env, chatId, messageId, isAdmin, baseUrl, lang);
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



export async function renderMainMenu(env, chatId, messageId = null, isAdmin = false, baseUrl = "", lang = 'en') {

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
    t('menu.active', lang) + ` ${active} | ` + t('menu.paused', lang) + ` ${paused}`;

  if (messageId) {
    await editTelegramMessage(env, chatId, messageId, text);
  } else {
    await sendAppMessage(env, chatId, text);
  }
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

export async function setChatMenuButton(env, chatId, baseUrl, lang, isAdmin = false) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setChatMenuButton`;
  const webAppUrl = isAdmin ? `${baseUrl}/crm?lang=${lang}` : `${baseUrl}/user_app?lang=${lang}`;
  const text = isAdmin ? t('menu.btn_admin_panel', lang) : t('menu.btn_my_products', lang);
  
  const body = {
    chat_id: chatId,
    menu_button: {
      type: "web_app",
      text: text,
      web_app: { url: webAppUrl }
    }
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) console.error(`Telegram API Error [setChatMenuButton]: ${res.status} - ${await res.text()}`);
  } catch (e) {
    console.error("setChatMenuButton fetch failed:", e);
  }
}
