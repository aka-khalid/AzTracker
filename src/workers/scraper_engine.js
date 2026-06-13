import { AmazonEdgeParser, getAmazonAccessToken } from '../core/amazon.js';
import { t } from '../core/i18n.js';
import { escapeHtml, formatEGP, getCairoTime, resolveProductName, truncateName } from '../core/utils.js';

const AMAZON_EG_MERCHANT_ID = "A1ZVRGNO5AYLOV";
const AMAZON_RESALE_MERCHANT_ID = "A2N2MP47XAP1MK";
const TELEGRAM_MSG_LIMIT = 4096;

// ── Amazon API Circuit Breaker ──────────────────────────────────────────────
// States: "closed" (normal) | "open" (failing, reject fast) | "half_open" (testing)
const CB_KEY = "amazon_api_circuit_breaker";
const CB_FAILURE_THRESHOLD = 5;   // consecutive failures before opening
const CB_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes cooldown before half-open

async function checkCircuitBreaker(env) {
  try {
    const state = JSON.parse(await env.AZTRACKER_DB.get(CB_KEY) || '{"state":"closed","failures":0}');
    if (state.state === "open") {
      if (Date.now() - (state.openedAt || 0) > CB_COOLDOWN_MS) {
        state.state = "half_open";
        await env.AZTRACKER_DB.put(CB_KEY, JSON.stringify(state));
        return "half_open";
      }
      return "open";
    }
    return state.state; // "closed" or "half_open"
  } catch (e) {
    return "closed"; // KV failure → assume closed (fail open)
  }
}

async function recordCircuitSuccess(env) {
  try {
    await env.AZTRACKER_DB.put(CB_KEY, JSON.stringify({ state: "closed", failures: 0 }));
  } catch (e) { /* non-blocking */ }
}

async function recordCircuitFailure(env) {
  try {
    const state = JSON.parse(await env.AZTRACKER_DB.get(CB_KEY) || '{"state":"closed","failures":0}');
    state.failures = (state.failures || 0) + 1;
    if (state.failures >= CB_FAILURE_THRESHOLD) {
      state.state = "open";
      state.openedAt = Date.now();
      console.error(`[CircuitBreaker] Amazon API circuit OPENED after ${state.failures} failures`);
    }
    await env.AZTRACKER_DB.put(CB_KEY, JSON.stringify(state));
  } catch (e) { /* non-blocking */ }
}

/**
 * Truncate a message to Telegram's 4096-char limit.
 * Cuts at the last newline before the limit to avoid breaking HTML tags mid-way.
 */
function truncateMessage(msg) {
  if (msg.length <= TELEGRAM_MSG_LIMIT) return msg;
  let cut = msg.lastIndexOf('\n', TELEGRAM_MSG_LIMIT - 20);
  if (cut < TELEGRAM_MSG_LIMIT / 2) cut = TELEGRAM_MSG_LIMIT - 20;
  return msg.substring(0, cut) + '\n\n…';
}

export async function executeScrapeEngine(env, offset = 0) {
  // Use stable ordering for pagination. 
  // No need for 'force' or time checks since the Governor handles intervals.
  const query = "SELECT DISTINCT g.* FROM Global_Products g INNER JOIN User_Subscriptions u ON g.asin = u.asin WHERE u.is_paused = 0 ORDER BY g.asin LIMIT 10 OFFSET ?";
  
  const { results: staleProducts } = await env.DB.prepare(query).bind(offset).all();
  if (!staleProducts || staleProducts.length === 0) return false;

  // Check circuit breaker before any Amazon API calls
  const cbState = await checkCircuitBreaker(env);
  if (cbState === "open") {
    console.warn("[CircuitBreaker] Amazon API circuit is OPEN — skipping scrape batch");
    return false;
  }

  const clientId = env.AMAZON_CLIENT_ID || env.AMZN_CREATORS_ACCESS_KEY || env.AWS_ACCESS_KEY_ID;
  const clientSecret = env.AMAZON_CLIENT_SECRET || env.AMZN_CREATORS_SECRET_KEY || env.AWS_SECRET_ACCESS_KEY;

  let accessToken = await env.AZTRACKER_DB.get('amazon_access_token');
  if (!accessToken) {
    try {
      accessToken = await getAmazonAccessToken(clientId, clientSecret);
      await env.AZTRACKER_DB.put('amazon_access_token', accessToken, { expirationTtl: 3300 }); // 55 minutes
    } catch (e) {
      console.error("Failed to acquire Amazon Access Token:", e);
      await recordCircuitFailure(env);
      return false; // Abort chain on auth failure
    }
  }

  const parser = new AmazonEdgeParser(accessToken, env.AMZN_ASSOCIATES_TAG, 'www.amazon.eg', env);
  const asins = staleProducts.map(p => p.asin);

  let liveItems;
  try {
    liveItems = await parser.getItems(asins);
    // Success: reset circuit breaker (unless we're half_open, then let it close on next success)
    if (cbState === "half_open") {
      await recordCircuitSuccess(env);
    }
  } catch (error) {
    console.error("Creators API error in executeScrapeEngine:", error);
    await recordCircuitFailure(env);
    throw error; // Throw so the queue retries this specific offset
  }

  // Fetch Arabic product names (Creators API with languagesOfPreference: ar_AE)
  try {
    const arabicNames = await parser.getItemsWithArabic(asins);
    for (const item of liveItems) {
      if (arabicNames.has(item.asin)) {
        item.name_ar = arabicNames.get(item.asin);
      }
    }
    // For ASINs still missing Arabic names, try scraping amazon.eg pages
    for (const item of liveItems) {
      // If the API gave us an Arabic name in the English field, swap it!
      if (item.name && /[\u0600-\u06FF]/.test(item.name)) {
        if (!item.name_ar) item.name_ar = item.name;
        item.name = null; 
      }

      if (!item.name_ar) {
        const scraped = await parser.scrapeArabicTitle(item.asin);
        if (scraped) item.name_ar = scraped;
        // Small delay to avoid rate-limiting
        await new Promise(r => setTimeout(r, 200));
      }
      if (!item.name) {
        const scraped = await parser.scrapeEnglishTitle(item.asin);
        if (scraped) item.name = scraped;
        // Small delay to avoid rate-limiting
        await new Promise(r => setTimeout(r, 200));
      }
    }
  } catch (e) {
    console.warn('[ScraperEngine] Arabic name enrichment failed (non-blocking):', e.message);
  }

  const d1Batch = [];
  const kvPromises = [];
  const queueBatch = [];
  const now = Date.now();
  
  // Failsafe: Avoid 0-items returned outage trap (any batch size)
  if (staleProducts.length > 0 && liveItems.length === 0) {
    console.log(`Global failsafe: 0 items returned for batch at offset ${offset}. Assuming API Outage. Throwing to retry.`);
    throw new Error("0 items returned from Amazon");
  }
  
  const liveAsins = new Set(liveItems.map(i => i.asin));
  // Note: Dead product detection (24h missing → delisted) has been removed.
  // Products no longer auto-pause or get delisted when absent from a scrape batch.

  let bestDeal = [];
  
  function queueAlert(chatId, lang, condLabel, price, lastPrice, seller, mid, isTarget, targetPrice, liveItem, isAtl, seenAmazonAt, seenResaleAt, amznPrice, usedPrice, newPrice, isUsed) {
      const base_url = `https://www.amazon.eg/dp/${liveItem.asin}`;
      const primary_mid = isUsed ? AMAZON_RESALE_MERCHANT_ID : mid;

      const qParams = new URLSearchParams();
      if (primary_mid) qParams.append("m", primary_mid);
      const pTag = env.AMAZON_PARTNER_TAG;
      if (pTag) qParams.append("tag", pTag);

      const alert_url = qParams.toString() ? `${base_url}?${qParams.toString()}` : base_url;
      const btn_text = isUsed ? t('alert.btn_open_resale', lang) : t('alert.btn_open_new', lang);

      const btn_markup = {
          inline_keyboard: [
              [{ text: btn_text, url: alert_url }],
              [{ text: t('alert.btn_disclaimer', lang), url: "https://telegra.ph/Pricing-Disclaimer-06-05" }]
          ]
      };

      const safe_name = escapeHtml(truncateName(resolveProductName(liveItem, lang)));
      const safe_seller = escapeHtml(seller || t('crm.seller_unknown', lang));
      const sellerLower = (seller || "").toLowerCase();

      let historical_links = [];
      const isAmznSeller = mid === AMAZON_EG_MERCHANT_ID || sellerLower === 'amazon' || sellerLower.includes('amazon.eg');
      const isResaleSeller = mid === AMAZON_RESALE_MERCHANT_ID || sellerLower.includes('resale') || sellerLower.includes('warehouse') || sellerLower.includes('renewed');

      const amazon_seen_recently = seenAmazonAt && (now - seenAmazonAt) < (14 * 24 * 60 * 60 * 1000);
      const resale_seen_recently = seenResaleAt && (now - seenResaleAt) < (14 * 24 * 60 * 60 * 1000);

      if (!isAmznSeller) {
          let amzUrl = `https://www.amazon.eg/dp/${liveItem.asin}?m=${AMAZON_EG_MERCHANT_ID}`;
          if (pTag) amzUrl += `&tag=${pTag}`;
          if (amznPrice !== null) {
              historical_links.push(`┘ 🛡️ <a href="${amzUrl}">${t('product.amazon_eg_label', lang)}</a>: <b>${formatEGP(amznPrice)} ${t('chrome.currency_egp', lang)}</b>`);
          } else if (amazon_seen_recently) {
              historical_links.push(`┘ 🛡️ <a href="${amzUrl}">${t('product.amazon_eg_label', lang)}</a> <i>${t('product.check_stock', lang)}</i>`);
          }
      }

      if (!isResaleSeller) {
          let resUrl = `https://www.amazon.eg/dp/${liveItem.asin}?m=${AMAZON_RESALE_MERCHANT_ID}`;
          if (pTag) resUrl += `&tag=${pTag}`;
          if (usedPrice !== null) {
              historical_links.push(`┘ 📦 <a href="${resUrl}">${t('product.resale_label', lang)}</a>: <b>${formatEGP(usedPrice)} ${t('chrome.currency_egp', lang)}</b> <i>${t('product.used_tag', lang)}</i>`);
          } else if (resale_seen_recently) {
              historical_links.push(`┘ 📦 <a href="${resUrl}">${t('product.resale_label', lang)}</a> <i>${t('product.check_stock', lang)}</i>`);
          }
      }

      let final_smart_alts = "";
      if (historical_links.length > 0) {
          final_smart_alts = `\n\n${t('product.other_options_head', lang)}\n` + historical_links.join("\n");
      }

      const atl_banner = isAtl ? t('broadcast.atl_head', lang) + "\n\n" : "";
      const timeStr = getCairoTime(now);
      const currency = t('chrome.currency_egp', lang);

      let msg = "";
      if (isTarget) {
          const diff = lastPrice ? (lastPrice - price) : 0;
          const down_text = diff > 0 ? ` (${t('alert.price_drop_dropped', lang, { diff: formatEGP(diff) })})` : "";
          msg = `${atl_banner}${t('alert.target_met_head', lang)} ${condLabel}\n\n` +
                `📦 <b>${safe_name}</b>\n` +
                `${t('product.asin_row', lang, { asin: liveItem.asin })}\n\n` +
                `${t('alert.target_met_current', lang, { price: formatEGP(price) })}\n` +
                `${t('alert.target_met_target', lang, { price: formatEGP(targetPrice) })}${down_text}\n` +
                `${t('alert.target_met_seller', lang, { seller: safe_seller })}` +
                `${final_smart_alts}\n\n` +
                `🕐 <i>${timeStr}</i>\n\n#ad`;
      } else {
          if (lastPrice === null) {
              msg = `${atl_banner}${t('alert.restock_head', lang)} ${condLabel}\n\n` +
                    `📦 <b>${safe_name}</b>\n` +
                    `${t('product.asin_row', lang, { asin: liveItem.asin })}\n\n` +
                    `${t('alert.restock_price', lang, { price: formatEGP(price) })}\n` +
                    `${t('alert.restock_seller', lang, { seller: safe_seller })}` +
                    `${final_smart_alts}\n\n` +
                    `🕐 <i>${timeStr}</i>\n\n#ad`;
          } else {
              const diff = lastPrice - price;
              const pct = lastPrice ? (diff / lastPrice * 100) : 0;
              msg = `${atl_banner}${t('alert.price_drop_head', lang)} ${condLabel}\n\n` +
                    `📦 <b>${safe_name}</b>\n` +
                    `${t('product.asin_row', lang, { asin: liveItem.asin })}\n\n` +
                    `${t('alert.price_drop_new', lang, { price: formatEGP(price) })}\n` +
                    `${t('alert.price_drop_dropped', lang, { diff: formatEGP(diff) })} (${pct.toFixed(1)}% off)\n` +
                    `${t('alert.price_drop_was', lang, { price: formatEGP(lastPrice) })}\n` +
                    `${t('alert.price_drop_seller', lang, { seller: safe_seller })}` +
                    `${final_smart_alts}\n\n` +
                    `🕐 <i>${timeStr}</i>\n\n#ad`;
          }
      }

      let alertType = 'telegram_alert';
      if (isTarget) {
          alertType = isUsed ? 'telegram_alert_used' : 'telegram_alert_new';
      }

      queueBatch.push({
          type: alertType,
          asin: liveItem.asin,
          chatId: chatId,
          text: truncateMessage(msg),
          markup: btn_markup
      });
  }

  // Pass 2: Handle Live Items
  for (const liveItem of liveItems) {
    const oldItem = staleProducts.find(p => p.asin === liveItem.asin);
    if (!oldItem) continue;

    // Anti-Flap Timers (persisted to DB)
    let newMissingSince = oldItem.new_missing_since || null;
    let usedMissingSince = oldItem.used_missing_since || null;
    let amazonMissingSince = oldItem.amazon_missing_since || null;

    let timersChanged = false;

    if (liveItem.newPrice === undefined || liveItem.newPrice === null) {
      if (oldItem.new_price !== null && !newMissingSince) { newMissingSince = now; timersChanged = true; }
    } else {
      if (newMissingSince !== null) { newMissingSince = null; timersChanged = true; }
    }
    if (liveItem.usedPrice === undefined || liveItem.usedPrice === null) {
      if (oldItem.used_price !== null && !usedMissingSince) { usedMissingSince = now; timersChanged = true; }
    } else {
      if (usedMissingSince !== null) { usedMissingSince = null; timersChanged = true; }
    }
    if (liveItem.amazonPrice === undefined || liveItem.amazonPrice === null) {
      if (oldItem.amazon_price !== null && !amazonMissingSince) { amazonMissingSince = now; timersChanged = true; }
    } else {
      if (amazonMissingSince !== null) { amazonMissingSince = null; timersChanged = true; }
    }

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

    // Note: 24h missing → delisted check removed. Anti-flap timers above are in-memory only.

    const { results: subs } = await env.DB.prepare(
      "SELECT s.chat_id, s.target_price, s.alert_sent_new, s.alert_sent_used, s.added_at, COALESCE(u.lang, 'en') AS lang FROM User_Subscriptions s LEFT JOIN Users u ON s.chat_id = u.chat_id WHERE s.asin = ? AND s.is_paused = 0"
    ).bind(liveItem.asin).all();

    // Isolated target bypass checks
    let newTargetBypass = false;
    let usedTargetBypass = false;
    let amznTargetBypass = false;
    
    for (const sub of subs) {
      if (sub.target_price) {
        if (finalNewPrice !== null && oldItem.new_price !== null && oldItem.new_price > sub.target_price && finalNewPrice <= sub.target_price) newTargetBypass = true;
        if (finalUsedPrice !== null && oldItem.used_price !== null && oldItem.used_price > sub.target_price && finalUsedPrice <= sub.target_price) usedTargetBypass = true;
        if (finalAmazonPrice !== null && oldItem.amazon_price !== null && oldItem.amazon_price > sub.target_price && finalAmazonPrice <= sub.target_price) amznTargetBypass = true;
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

    // Rollback completely (price AND seller/mid) if change < 1 EGP
    if (amznTargetBypass) amznChanged = oldItem.amazon_price !== finalAmazonPrice;
    if (!amznChanged && finalAmazonPrice !== null) { finalAmazonPrice = oldItem.amazon_price; finalAmazonSeller = oldItem.amazon_seller; finalAmazonMid = oldItem.amazon_mid; finalAmazonIsBuybox = oldItem.amazon_is_buybox; }
    
    if (usedTargetBypass) usedChanged = oldItem.used_price !== finalUsedPrice;
    if (!usedChanged && finalUsedPrice !== null) { finalUsedPrice = oldItem.used_price; finalUsedSeller = oldItem.used_seller; finalUsedMid = oldItem.used_mid; }
    
    if (newTargetBypass) newChanged = oldItem.new_price !== finalNewPrice;
    if (!newChanged && finalNewPrice !== null) { finalNewPrice = oldItem.new_price; finalNewSeller = oldItem.new_seller; finalNewMid = oldItem.new_mid; }

    const priceDelta = amznChanged || usedChanged || newChanged;

    let histMean = oldItem.hist_mean || 0;
    let histStdev = oldItem.hist_stdev || 0;
    let isAtlNew = oldItem.is_atl_new || 0;

    let seenAmazonEgAt = oldItem.seen_amazon_eg_at;
    let seenResaleAt = oldItem.seen_resale_at;
    if (finalAmazonPrice !== null) seenAmazonEgAt = now;
    if (finalUsedPrice !== null) seenResaleAt = now;

    // Stat math calculated BEFORE pushing new price to history (Parity with Python)
    const historyKey = `history:${liveItem.asin}`;
    let history = [];
    if (newChanged || usedChanged) {
       history = await env.AZTRACKER_DB.get(historyKey, "json") || [];
       if (history.length >= 2) {
           const validHistory = history.filter(h => h.n !== null && h.t !== undefined);
           if (validHistory.length >= 2) {
               const nowSec = Math.floor(now / 1000);
               const HALF_LIFE_SEC = 30 * 24 * 60 * 60; // 30 Days
               const DECAY_CONSTANT = Math.LN2 / HALF_LIFE_SEC;
               
               let sumWeights = 0;
               let weightedSum = 0;
               
               validHistory.forEach(h => {
                   const age = Math.max(0, nowSec - h.t);
                   h.weight = Math.exp(-DECAY_CONSTANT * age);
                   sumWeights += h.weight;
                   weightedSum += (h.n * h.weight);
               });
               
               const mean = sumWeights > 0 ? (weightedSum / sumWeights) : 0;
               
               let weightedVarianceSum = 0;
               validHistory.forEach(h => {
                   weightedVarianceSum += h.weight * Math.pow(h.n - mean, 2);
               });
               
               const variance = sumWeights > 0 ? (weightedVarianceSum / sumWeights) : 0;
               const stdev = Math.sqrt(variance);
               
               const atl = Math.min(...validHistory.map(h => h.n));
               
               histMean = mean;
               histStdev = stdev;
               // Fix: ATL must be strictly < to count as a NEW All-Time Low
               isAtlNew = (finalNewPrice && finalNewPrice < atl) ? 1 : 0;
           }
       }
    }

    const MS_90_DAYS = 7776000000;
    for (const sub of subs) {
      if (sub.added_at && (now - sub.added_at > MS_90_DAYS)) {
        d1Batch.push(env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 1 WHERE chat_id = ? AND asin = ?").bind(sub.chat_id, liveItem.asin));
        
        // Gap 9.4: Python-parity rich message — differentiate target-price vs general expiry
        const subLang = sub.lang || 'en';
        const safeProductName = escapeHtml(truncateName(resolveProductName(liveItem, subLang)));
        let expiryMsg;
        if (sub.target_price) {
          expiryMsg =
            t('alert.stale_target_head', subLang) + `\n\n` +
            `📦 <b>${safeProductName}</b>\n` +
            `${t('product.asin_row', subLang, { asin: liveItem.asin })}\n\n` +
            t('alert.stale_target_with_price', subLang, { target: Number(sub.target_price).toLocaleString(), days: 90 });
        } else {
          expiryMsg =
            t('alert.tracking_expired_head', subLang) + `\n\n` +
            `📦 <b>${safeProductName}</b>\n` +
            `${t('product.asin_row', subLang, { asin: liveItem.asin })}\n\n` +
            t('alert.tracking_expired_body', subLang, { asin: liveItem.asin, days: 90 });
        }

        queueBatch.push({ type: 'telegram_alert', asin: liveItem.asin, chatId: sub.chat_id, text: expiryMsg });
        continue;
      }

      let alertSentNew = sub.alert_sent_new;
      let alertSentUsed = sub.alert_sent_used;
      const targetPrice = sub.target_price;
      
      let newAlertSentThisTick = false;
      
      // Decoupled New vs Amazon logic for Alerts
      if (targetPrice) {
          if (finalNewPrice !== null && finalNewPrice > targetPrice) { 
              if (alertSentNew) {
                  alertSentNew = 0;
                  d1Batch.push(env.DB.prepare("UPDATE User_Subscriptions SET alert_sent_new = 0 WHERE chat_id = ? AND asin = ?").bind(sub.chat_id, liveItem.asin));
              }
          }
          if (finalUsedPrice !== null && finalUsedPrice > targetPrice) { 
              if (alertSentUsed) {
                  alertSentUsed = 0;
                  d1Batch.push(env.DB.prepare("UPDATE User_Subscriptions SET alert_sent_used = 0 WHERE chat_id = ? AND asin = ?").bind(sub.chat_id, liveItem.asin));
              }
          }
          
          let targetHitNew = false;
          let targetHitUsed = false;
          
          if (finalNewPrice !== null && finalNewPrice <= targetPrice && !alertSentNew) {
              queueAlert(sub.chat_id, sub.lang, "(New)", finalNewPrice, oldItem.new_price, finalNewSeller, finalNewMid, true, targetPrice, liveItem, isAtlNew, seenAmazonEgAt, seenResaleAt, finalAmazonPrice, finalUsedPrice, finalNewPrice, false);
              targetHitNew = true;
          }
          
          if (finalUsedPrice !== null && finalUsedPrice <= targetPrice && !alertSentUsed) {
              if (targetHitNew) {
                  // Target Grouping (Python Parity): Lock Used flag without spamming second message
                  targetHitUsed = true;
              } else {
                  queueAlert(sub.chat_id, sub.lang, "(Used - Amazon Resale)", finalUsedPrice, oldItem.used_price, finalUsedSeller, finalUsedMid, true, targetPrice, liveItem, false, seenAmazonEgAt, seenResaleAt, finalAmazonPrice, finalUsedPrice, finalNewPrice, true);
                  targetHitUsed = true;
              }
          }
          
          if (targetHitNew) alertSentNew = 1;
          if (targetHitUsed) alertSentUsed = 1;
          
      } else {
          // Drops without target — mirror Python's full no-target evaluation block
          if (finalNewPrice !== null) {
              if (oldItem.new_price === null && oldItem.last_updated) {
                  // Gap 9.5: New restock (already existed)
                  queueAlert(sub.chat_id, sub.lang, "(New - Restocked)", finalNewPrice, null, finalNewSeller, finalNewMid, false, 0, liveItem, false, seenAmazonEgAt, seenResaleAt, finalAmazonPrice, finalUsedPrice, finalNewPrice, false);
              } else if (oldItem.new_price !== null && finalNewPrice < oldItem.new_price) {
                  queueAlert(sub.chat_id, sub.lang, "(New)", finalNewPrice, oldItem.new_price, finalNewSeller, finalNewMid, false, 0, liveItem, isAtlNew, seenAmazonEgAt, seenResaleAt, finalAmazonPrice, finalUsedPrice, finalNewPrice, false);
              }
          }
          
          // Gap 9.5: Used restock alert — fires when used_price appears after being null
          // Gap 9.6: Used drop alert — fires when used_price drops, even with no target set
          if (finalUsedPrice !== null) {
              if (oldItem.used_price === null && oldItem.last_updated) {
                  queueAlert(sub.chat_id, sub.lang, "(Used - Amazon Resale - Restocked)", finalUsedPrice, null, finalUsedSeller, finalUsedMid, false, 0, liveItem, false, seenAmazonEgAt, seenResaleAt, finalAmazonPrice, finalUsedPrice, finalNewPrice, true);
              } else if (oldItem.used_price !== null && finalUsedPrice < oldItem.used_price) {
                  queueAlert(sub.chat_id, sub.lang, "(Used - Amazon Resale)", finalUsedPrice, oldItem.used_price, finalUsedSeller, finalUsedMid, false, 0, liveItem, false, seenAmazonEgAt, seenResaleAt, finalAmazonPrice, finalUsedPrice, finalNewPrice, true);
              }
          }
      }

      // ATOMIC 2PC PATCH: We remove the synchronous D1 update for alert_sent flags here.
      // They will be handled exclusively by queue_worker.js on successful HTTP 200 Telegram delivery.
    }

    let dbNeedsUpdate = false;

    if (priceDelta || newTargetBypass || usedTargetBypass || amznTargetBypass || timersChanged) {
      dbNeedsUpdate = true;
    }

    if (dbNeedsUpdate && (newChanged || usedChanged)) {
      history.push({ t: Math.floor(now / 1000), n: finalNewPrice, u: finalUsedPrice }); // Exclusively tracking NewPrice
      if (history.length > 500) history = history.slice(-500);
      kvPromises.push(env.AZTRACKER_DB.put(historyKey, JSON.stringify(history)));

      const globalKey = "global:history_all_new";
      let globalHist = await env.AZTRACKER_DB.get(globalKey, "json") || [];
      const currentMatrix = {};
      if (finalNewPrice !== null) currentMatrix[liveItem.asin] = [finalNewPrice, 0];
      
      if (Object.keys(currentMatrix).length > 0) {
          globalHist.push({t: Math.floor(now / 1000), p: currentMatrix});
          if (globalHist.length > 150) globalHist = globalHist.slice(-150);
          kvPromises.push(env.AZTRACKER_DB.put(globalKey, JSON.stringify(globalHist)));
      }
    }
    
    // Unified Single UPDATE D1 execution
    if (dbNeedsUpdate) {
      d1Batch.push(
        env.DB.prepare(`
          UPDATE Global_Products
          SET amazon_price = ?, used_price = ?, new_price = ?, last_updated = ?,
              seen_amazon_eg_at = ?, seen_resale_at = ?,
              new_seller = ?, new_mid = ?, used_seller = ?, used_mid = ?,
              amazon_seller = ?, amazon_mid = ?, amazon_is_buybox = ?,
              new_missing_since = ?, used_missing_since = ?, amazon_missing_since = ?,
              hist_mean = ?, hist_stdev = ?, is_atl_new = ?,
              name_ar = COALESCE(?, name_ar),
              name = COALESCE(?, name),
              image_url = COALESCE(?, image_url)
          WHERE asin = ?
        `).bind(
          finalAmazonPrice, finalUsedPrice, finalNewPrice, now,
          seenAmazonEgAt, seenResaleAt,
          finalNewSeller, finalNewMid, finalUsedSeller, finalUsedMid,
          finalAmazonSeller, finalAmazonMid, finalAmazonIsBuybox,
          newMissingSince, usedMissingSince, amazonMissingSince,
          histMean, histStdev, isAtlNew,
          liveItem.name_ar || null,
          liveItem.name || null,
          liveItem.imageUrl || null,
          liveItem.asin
        )
      );
    } else {
      // Always persist name_ar even when no price changed — Arabic name enrichment
      // runs every cycle but was previously skipped when dbNeedsUpdate was false.
      d1Batch.push(
        env.DB.prepare(`
          UPDATE Global_Products SET last_updated = ?,
              name_ar = COALESCE(?, name_ar),
              name = COALESCE(?, name),
              image_url = COALESCE(?, image_url)
          WHERE asin = ?
        `).bind(now, liveItem.name_ar || null, liveItem.name || null, liveItem.imageUrl || null, liveItem.asin)
      );
    }
    
    // Broadcast Collection logic
    const broadcastPrice = finalNewPrice; 
    const lPrice = oldItem.new_price;
    if (env.TELEGRAM_PUBLIC_CHANNEL_ID && broadcastPrice && lPrice && broadcastPrice < lPrice) {
        const last_broadcast_time = oldItem.last_broadcast_time_ms || 0;
        const last_broadcast_price = oldItem.last_broadcast_price || 0;
        
        let proceed = true;
        if ((now - last_broadcast_time) < 86400000) {
             if (last_broadcast_price && broadcastPrice >= last_broadcast_price) {
                 proceed = false;
             }
        }
        
        if (proceed) {
             let zScore = 0.0;
             if (histMean > 0 && histStdev > 0) {
                 zScore = (broadcastPrice - histMean) / histStdev;
             } else if (histMean > 0 && histStdev === 0) {
                 if (broadcastPrice <= histMean * 0.90) zScore = -1.0;
             }
             
             const displayLastPrice = histMean > 0 ? histMean : lPrice;
             const dropPct = ((displayLastPrice - broadcastPrice) / displayLastPrice) * 100;
             
             let reqDrop = 10.0;
             if (displayLastPrice <= 1000) reqDrop = 15.0;
             else if (displayLastPrice <= 5000) reqDrop = 10.0;
             else if (displayLastPrice <= 20000) reqDrop = 7.0;
             else if (displayLastPrice <= 50000) reqDrop = 5.0;
             else reqDrop = 3.0;
             
             const isStandardDeal = (zScore <= -1.0) && (dropPct >= reqDrop);
             const isAtlDeal = isAtlNew && (zScore <= -0.5) && (dropPct >= reqDrop / 2.0);
             const isFlashSale = dropPct >= (reqDrop * 2.0);
             
             if (isStandardDeal || isAtlDeal || isFlashSale) {
                 bestDeal.push({
                     asin: liveItem.asin,
                     name: liveItem.name,
                     name_ar: liveItem.name_ar || null,
                     price: broadcastPrice,
                     last_price: displayLastPrice,
                     drop_pct: dropPct,
                     is_atl: isAtlNew,
                     seller: finalNewSeller,
                     mid: finalNewMid,
                     absZ: isFlashSale ? 999 : Math.abs(zScore)
                 });
             }
        }
    }
  }

  // Final Broadcast (public channel — organic Egyptian Arabic)
  if (bestDeal.length > 0 && env.TELEGRAM_PUBLIC_CHANNEL_ID) {
      // Sort by best score (descending) and take top 3
      bestDeal.sort((a, b) => b.absZ - a.absZ);
      const topDeals = bestDeal.slice(0, 3);

      for (const deal of topDeals) {
          const safe_name = escapeHtml(truncateName(deal.name_ar || deal.name || deal.asin) || t('product.unknown_product', 'masry'));
          const base_url = `https://www.amazon.eg/dp/${deal.asin}`;
          const qParams = new URLSearchParams();
          const pTag = env.AMAZON_PARTNER_TAG;
          if (pTag) qParams.append("tag", pTag);
          const broadcast_url = qParams.toString() ? `${base_url}?${qParams.toString()}` : base_url;

          const safe_broadcast_seller = escapeHtml(deal.seller || t('fallback.unknown_seller', 'masry'));

          const broadcast_msg = `${t('broadcast.snapshot', 'masry')}\n\n` +
              `<b>${safe_name}</b>\n\n` +
              `💵 <b>${formatEGP(deal.price)} ج.م</b>\n` +
              `🏬 ${safe_broadcast_seller}\n\n` +
              `👉 <a href="${broadcast_url}">${t('broadcast.catch_deal', 'masry')}</a>\n\n` +
              `🤖 @AzTrackerr_bot\n\n` +
              `<a href="https://t.me/AzTrackerr_bot?start=ref_broadcast">${t('broadcast.follow_more', 'masry')}</a>\n\n` +
              `${t('broadcast.ad_disclosure', 'masry')}`;

          queueBatch.push({
              type: 'telegram_alert',
              asin: deal.asin,
              chatId: env.TELEGRAM_PUBLIC_CHANNEL_ID,
              text: truncateMessage(broadcast_msg),
              markup: {
                  inline_keyboard: [
                      [
                          { text: t('broadcast.buy_here', 'masry'), url: broadcast_url },
                          { text: '🎯 Track Deal', url: `https://t.me/${env.BOT_USERNAME || 'AzTrackerr_bot'}?start=track_${deal.asin}` }
                      ],
                      [
                          { text: t('alert.btn_disclaimer', 'masry'), url: "https://telegra.ph/Pricing-Disclaimer-06-05" }
                      ]
                  ]
              }
          });
          d1Batch.push(env.DB.prepare("UPDATE Global_Products SET last_broadcast_time_ms = ?, last_broadcast_price = ? WHERE asin = ?").bind(now, deal.price, deal.asin));
      }
  }

  // FIX: Queue Dispatch MUST execute BEFORE DB batch. 
  // If queue fails, it throws an error and the DB is NOT updated, saving the alert for the retry.
  if (queueBatch.length > 0) {
    const consolidatedBatch = [];
    for (const msg of queueBatch) {
        consolidatedBatch.push({
             type: msg.type,
             asin: msg.asin,
             chatId: msg.chatId,
             text: msg.text,
             markup: msg.markup
        });
    }

    for (let i = 0; i < consolidatedBatch.length; i += 100) {
      const batchBody = consolidatedBatch.slice(i, i + 100).map(b => ({ body: b }));
      await env.MESSAGE_QUEUE.sendBatch(batchBody);
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
  
  return staleProducts.length === 10;
}
