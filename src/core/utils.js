export function escapeHtml(unsafe) {
    if (!unsafe) return "";
    return String(unsafe)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

export function formatEGP(price) {
  if (price === null || price === undefined) return "";
  return price.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Expand Amazon short URLs (amzn.to, amzn.eu, a.co, amazon.eg/d/) to full URLs.
 * Follows up to 3 redirect hops via the Location header.
 */
export async function expandAmazonUrl(url) {
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

/**
 * Extract ASIN from an Amazon product URL (/dp/ASIN or /gp/product/ASIN).
 */
export function getAsinFromUrl(url) {
  if (!url) return null;
  // Require at least one letter to reject garbage like "1231231233"
  const dpMatch = url.match(/\/dp\/((?=[A-Z0-9]{10})(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10})(?=[/?#]|$)/i);
  if (dpMatch) return dpMatch[1].toUpperCase();
  const gpMatch = url.match(/\/gp\/product\/((?=[A-Z0-9]{10})(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10})(?=[/?#]|$)/i);
  if (gpMatch) return gpMatch[1].toUpperCase();
  return null;
}

export function truncateName(name, maxLength = 60) {
  if (!name) return null;
  if (name.length <= maxLength) return name;
  return name.substring(0, maxLength) + "...";
}

export function resolveProductName(item, lang, fallback) {
  if (lang === 'masry' && item.name_ar) return item.name_ar;
  return item.name || item.asin || fallback || "Unknown Product";
}

export function convertHindiToArabic(text) {
  if (!text) return "";
  const hindiToAr = { '٠':'0', '١':'1', '٢':'2', '٣':'3', '٤':'4', '٥':'5', '٦':'6', '٧':'7', '٨':'8', '٩':'9' };
  return text.replace(/[٠-٩]/g, match => hindiToAr[match]);
}

export function getCairoTime(now) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = formatter.formatToParts(new Date(now));
  const p = {};
  parts.forEach(part => { p[part.type] = part.value; });
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} EET`;
}

/**
 * Build a broadcast message for Telegram (organic scraper or CRM).
 * Returns { text, inline_keyboard } ready for queueBatch.
 *
 * @param {object} env - Worker environment (for AMAZON_PARTNER_TAG, BOT_USERNAME)
 * @param {object} deal - Deal object with asin, name, name_ar, price, seller, mid
 * @param {number} now - Timestamp (Date.now())
 * @param {function} t - i18n translation function from i18n.js
 * @returns {{ text: string, inline_keyboard: Array }}
 */
export function buildBroadcastMessage(env, deal, now, t) {
  const lang = 'masry';
  const safeName = escapeHtml(truncateName(deal.name_ar || deal.name || deal.asin) || t('product.unknown_product', lang));
  // Use the canonical affiliate URL from the Creators API (includes tag, marketplace, language)
  const broadcastUrl = deal.detailPageURL || `https://www.amazon.eg/dp/${deal.asin}`;
  const safeSeller = escapeHtml(deal.seller || t('fallback.unknown_seller', lang));
  const deepLink = `https://t.me/${env?.BOT_USERNAME || 'AzTrackerr_bot'}?start=track_${deal.asin}`;
  const disclaimerUrl = 'https://telegra.ph/Pricing-Disclaimer-06-05';
  const timestamp = getCairoTime(now);

  const rle = '\u202B'; // Right-to-Left Embedding
  const pdf = '\u202C'; // Pop Directional Formatting

  // Two-tier header: الحق for wow deals (≥ 2x threshold), عرض for everything else
  const drop = deal.drop_pct || 0;
  const lastPrice = deal.last_price || deal.price || 1;
  let reqDrop = 10.0;
  if (lastPrice <= 1000) reqDrop = 15.0;
  else if (lastPrice <= 5000) reqDrop = 10.0;
  else if (lastPrice <= 20000) reqDrop = 7.0;
  else if (lastPrice <= 50000) reqDrop = 5.0;
  else reqDrop = 3.0;

  const header = drop >= reqDrop * 2.0 ? '🔥 الحق 🔥' : '⚡ عرض ⚡';

  const text =
    `${header}\n\n` +
    `${rle}<b>${safeName}</b>${pdf}\n\n` +
    `${rle}💵 <b>${formatEGP(deal.price)} ج.م</b>${pdf}\n` +
    `${rle}🏬 ${t('broadcast.seller', lang)}: ${safeSeller}${pdf}\n\n` +
    `${rle}👈 <a href="${broadcastUrl}">${t('broadcast.catch_deal', lang)}</a>${pdf}\n\n` +
    `${rle}〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️${pdf}\n` +
    `${rle}🤖 ${t('broadcast.follow_more', lang)}: @${env?.BOT_USERNAME || 'AzTrackerr_bot'}${pdf}\n\n` +
    `${rle}📅 ${t('broadcast.price_as_of', lang, { date: timestamp })}${pdf}\n\n` +
    `${rle}${t('broadcast.ad_disclosure', lang)}${pdf}`;

  const inline_keyboard = [
    [{ text: t('broadcast.buy_here', lang), url: broadcastUrl }],
    [
      { text: t('broadcast.track_deal', lang), url: deepLink },
      { text: t('alert.btn_disclaimer', lang), url: disclaimerUrl }
    ]
  ];

  return { text, inline_keyboard };
}
