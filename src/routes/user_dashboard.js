import { renderMainMenu } from './telegram_webhook.js';
import { t } from '../core/i18n.js';

export async function fetchUserAPI(request, env, ctx) {
  const url = new URL(request.url);

  // 1. Authenticate API requests
  if (url.pathname.startsWith("/api/user/")) {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response("Unauthorized", { status: 401 });
    }
    const initData = authHeader.substring("Bearer ".length);
    const parsed = new URLSearchParams(initData);
    const hash = parsed.get("hash");
    parsed.delete("hash");

    const keys = Array.from(parsed.keys()).sort();
    const dataCheckString = keys.map(k => `${k}=${parsed.get(k)}`).join("\n");

    const encoder = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
      "raw",
      await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), encoder.encode(env.TELEGRAM_BOT_TOKEN)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const calcHashBuffer = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(dataCheckString));
    const calcHash = Array.from(new Uint8Array(calcHashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    if (calcHash !== hash) {
      return new Response("Unauthorized", { status: 401 });
    }

    const userObj = JSON.parse(parsed.get("user") || "{}");
    const chatId = userObj.id ? String(userObj.id) : null;

    if (!chatId) return new Response("Unauthorized", { status: 401 });

    if (url.pathname === "/api/user/products" && request.method === "GET") {
      const { results } = await env.DB.prepare(`
        SELECT s.asin, s.is_paused as paused, s.target_price, p.name, p.name_ar, 
               p.new_price, p.used_price, p.amazon_price, p.hist_mean, p.is_atl_new,
               p.image_url, p.last_updated, p.new_seller, p.used_seller, p.amazon_seller,
               p.seen_amazon_eg_at, p.seen_resale_at
        FROM User_Subscriptions s
        JOIN Global_Products p ON s.asin = p.asin
        WHERE s.chat_id = ?
      `).bind(chatId).all();

      // Get historical ATL from KV
      for (let prod of results) {
         let historyData = await env.AZTRACKER_DB.get(`history:${prod.asin}`, "json") || [];
         let atl = null;
         if (historyData.length > 0) {
            atl = Math.min(...historyData.map(h => h.price || h.n || h.u || 999999));
         }
         prod.atl = atl;
      }

      return new Response(JSON.stringify(results), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    if (url.pathname === "/api/user/products/update" && request.method === "POST") {
      try {
        const body = await request.json();
        const { asin, target_price, action } = body;
        if (!asin) return new Response("Missing ASIN", { status: 400 });

        if (action === "pause") {
           await env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 1 WHERE chat_id = ? AND asin = ?").bind(chatId, asin).run();
        } else if (action === "resume") {
           await env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 0 WHERE chat_id = ? AND asin = ?").bind(chatId, asin).run();
        } else {
           await env.DB.prepare(
             "UPDATE User_Subscriptions SET target_price = ?, alert_sent_new = 0, alert_sent_used = 0 WHERE chat_id = ? AND asin = ?"
           ).bind(target_price === null ? null : Number(target_price), chatId, asin).run();
        }

        ctx.waitUntil((async () => {
           const userRow = await env.DB.prepare("SELECT lang, role FROM Users WHERE chat_id = ?").bind(chatId).first();
           if(userRow) {
               const lang = userRow.lang || 'en';
               const isAdmin = userRow.role === 'admin';
               const baseUrl = url.origin;
               const state = await env.DB.prepare("SELECT value FROM Bot_States WHERE key = ?").bind(`ui:${chatId}`).first();
               if (state && state.value) {
                   await renderMainMenu(env, chatId, parseInt(state.value), isAdmin, baseUrl, lang);
               }
           }
        })());

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch (e) {
        return new Response("Bad Request", { status: 400 });
      }
    }

    if (url.pathname === "/api/user/products/delete" && request.method === "POST") {
      try {
        const body = await request.json();
        const { asin } = body;
        if (!asin) return new Response("Missing ASIN", { status: 400 });

        await env.DB.prepare(
          "DELETE FROM User_Subscriptions WHERE chat_id = ? AND asin = ?"
        ).bind(chatId, asin).run();

        ctx.waitUntil((async () => {
           const userRow = await env.DB.prepare("SELECT lang, role FROM Users WHERE chat_id = ?").bind(chatId).first();
           if(userRow) {
               const lang = userRow.lang || 'en';
               const isAdmin = userRow.role === 'admin';
               const baseUrl = url.origin;
               const state = await env.DB.prepare("SELECT value FROM Bot_States WHERE key = ?").bind(`ui:${chatId}`).first();
               if (state && state.value) {
                   await renderMainMenu(env, chatId, parseInt(state.value), isAdmin, baseUrl, lang);
               }
           }
        })());

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch (e) {
        return new Response("Bad Request", { status: 400 });
      }
    }

    if (url.pathname === "/api/user/hot_deals" && request.method === "GET") {
      const { results } = await env.DB.prepare(`
        SELECT g.asin, g.name, g.name_ar, g.new_price, g.hist_mean, g.image_url,
               (s.asin IS NOT NULL) AS is_tracked
        FROM Global_Products g
        LEFT JOIN User_Subscriptions s ON g.asin = s.asin AND s.chat_id = ?
        WHERE g.hist_mean > 0 AND g.new_price > 0 AND (
          (g.hist_mean <= 1000 AND g.new_price <= g.hist_mean * 0.90) OR
          (g.hist_mean > 1000 AND g.hist_mean <= 5000 AND g.new_price <= g.hist_mean * 0.93) OR
          (g.hist_mean > 5000 AND g.hist_mean <= 20000 AND g.new_price <= g.hist_mean * 0.95) OR
          (g.hist_mean > 20000 AND g.hist_mean <= 50000 AND g.new_price <= g.hist_mean * 0.97) OR
          (g.hist_mean > 50000 AND g.new_price <= g.hist_mean * 0.99)
        )
        ORDER BY ((g.hist_mean - g.new_price) / g.hist_mean) DESC LIMIT 20
      `).bind(chatId).all();

      return new Response(JSON.stringify(results), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    if (url.pathname === "/api/user/track" && request.method === "POST") {
      try {
        const body = await request.json();
        const { asin } = body;
        if (!asin) return new Response("Missing ASIN", { status: 400 });

        const limitStr = env.DEFAULT_USER_PRODUCT_LIMIT || "3";
        const limit = parseInt(limitStr);

        const userRow = await env.DB.prepare("SELECT role, item_limit, lang FROM Users WHERE chat_id = ?").bind(chatId).first();
        const isFree = !userRow || (userRow.role !== 'admin' && userRow.role !== 'premium');
        const customLimit = userRow && userRow.item_limit > 0 ? userRow.item_limit : limit;

        if (isFree) {
            const countRow = await env.DB.prepare("SELECT count(*) as c FROM User_Subscriptions WHERE chat_id = ?").bind(chatId).first();
            if (countRow && countRow.c >= customLimit) {
                return new Response(JSON.stringify({ error: "LIMIT_REACHED" }), {
                    status: 403,
                    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
                });
            }
        }

        await env.DB.prepare(`
          INSERT INTO User_Subscriptions (chat_id, asin, target_price, is_paused, added_at)
          VALUES (?, ?, NULL, 0, ?)
          ON CONFLICT(chat_id, asin) DO NOTHING
        `).bind(chatId, asin, Date.now()).run();

        await env.DB.prepare(`
          INSERT OR IGNORE INTO Global_Products (asin, name, name_ar, last_updated)
          VALUES (?, ?, ?, 0)
        `).bind(asin, asin, null).run();

        ctx.waitUntil((async () => {
             const state = await env.DB.prepare("SELECT value FROM Bot_States WHERE key = ?").bind(`ui:${chatId}`).first();
             if (state && state.value) {
                 const lang = userRow ? userRow.lang || 'en' : 'en';
                 const isAdmin = userRow ? userRow.role === 'admin' : false;
                 await renderMainMenu(env, chatId, parseInt(state.value), isAdmin, url.origin, lang);
             }
        })());

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch (e) {
        return new Response("Bad Request", { status: 400 });
      }
    }
  }

  // 2. Serve HTML WebApp
  if (url.pathname === "/user_app") {
    const lang = url.searchParams.get("lang") || "en";
    const html = renderUserHTML(lang, env.AMAZON_PARTNER_TAG);
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }

  return null;
}

function renderUserHTML(lang, partnerTag) {
  const isMasry = lang === 'masry';
  const htmlLang = isMasry ? 'ar' : 'en';
  const htmlDir = isMasry ? 'rtl' : 'ltr';
  const pTagStr = partnerTag ? partnerTag : '';

  const ui = {
    my_products: t('dashboard.my_products', lang),
    hot_deals: t('dashboard.hot_deals', lang),
    syncing: t('dashboard.syncing', lang),
    finding_deals: t('dashboard.finding_deals', lang),
    failed_load: t('dashboard.failed_load', lang),
    error: t('dashboard.error', lang),
    no_deals: t('dashboard.no_deals', lang),
    unknown_product: t('dashboard.unknown_product', lang),
    tracked: t('dashboard.tracked', lang),
    track: t('dashboard.track', lang),
    price_now: t('dashboard.price_now', lang),
    price_drop: t('dashboard.price_drop', lang),
    open_amazon: t('dashboard.open_amazon', lang),
    limit_reached: t('dashboard.limit_reached', lang),
    error_tracking: t('dashboard.error_tracking', lang),
    open_in_telegram: t('dashboard.open_in_telegram', lang),
    error_loading_products: t('dashboard.error_loading_products', lang),
    currency_egp: t('chrome.currency_egp', lang),
    no_products_found: t('dashboard.no_products_found', lang),
    last_checked: t('dashboard.last_checked', lang),
    never: t('dashboard.never', lang),
    resume: t('dashboard.resume', lang),
    pause: t('dashboard.pause', lang),
    new_condition: t('dashboard.new_condition', lang),
    amazon_eg: t('dashboard.amazon_eg', lang),
    currently_out_of_stock: t('dashboard.currently_out_of_stock', lang),
    likely_out_of_stock: t('dashboard.likely_out_of_stock', lang),
    check_stock: t('dashboard.check_stock', lang),
    resale: t('dashboard.resale', lang),
    target_price: t('dashboard.target_price', lang),
    none: t('dashboard.none', lang),
    clear: t('dashboard.clear', lang),
    delete: t('dashboard.delete', lang),
    confirm_target_prefix: t('dashboard.confirm_target_prefix', lang),
    confirm_target_suffix: t('dashboard.confirm_target_suffix', lang),
    saved: t('dashboard.saved', lang),
    target_updated: t('dashboard.target_updated', lang),
    cleared: t('dashboard.cleared', lang),
    target_cleared: t('dashboard.target_cleared', lang),
    confirm_stop: t('dashboard.confirm_stop', lang)
  };

  return `<!DOCTYPE html>
<html lang="${htmlLang}" dir="${htmlDir}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>My Products</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Cairo:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-color: var(--tg-theme-bg-color, #121212);
      --text-color: var(--tg-theme-text-color, #ffffff);
      --hint-color: var(--tg-theme-hint-color, #9e9e9e);
      --link-color: var(--tg-theme-link-color, #3390ec);
      --button-color: var(--tg-theme-button-color, #3390ec);
      --button-text-color: var(--tg-theme-button-text-color, #ffffff);
      --secondary-bg-color: var(--tg-theme-secondary-bg-color, #1c1c1d);
      --destructive-color: var(--tg-theme-destructive-text-color, #ff3b30);
      
      --accent: #FF9900;
      --card-bg: rgba(255, 255, 255, 0.05);
      --card-border: rgba(255, 255, 255, 0.1);
      --glow: rgba(255, 153, 0, 0.3);
    }
    body {
      background-color: var(--bg-color);
      color: var(--text-color);
      font-family: ${isMasry ? "'Cairo', sans-serif" : "'Inter', -apple-system, sans-serif"};
      ${isMasry ? 'line-height: 1.3;' : ''}
      margin: 0;
      padding: 16px;
      padding-bottom: 40px;
    }
    .header {
      font-size: 24px;
      font-weight: 700;
      margin-bottom: 20px;
      background: linear-gradient(90deg, var(--text-color), var(--hint-color));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .product-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 16px;
      margin-bottom: 16px;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      box-shadow: 0 4px 15px rgba(0,0,0,0.1);
      transition: transform 0.2s ease;
      position: relative;
      overflow: hidden;
    }
    .product-card.paused {
      opacity: 0.6;
    }
    .product-card.paused::after {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.2);
      pointer-events: none;
    }
    .product-header {
      display: flex;
      gap: 12px;
      margin-bottom: 12px;
    }
    .product-img {
      width: 70px;
      height: 70px;
      border-radius: 8px;
      object-fit: cover;
      background-color: #fff;
      padding: 2px;
      flex-shrink: 0;
    }
    .product-title {
      font-size: 15px;
      font-weight: 600;
      line-height: 1.3;
      margin: 0 0 4px 0;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .product-asin {
      font-size: 12px;
      color: var(--hint-color);
      margin: 0;
    }
    .prices-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin-bottom: 16px;
    }
    .price-box {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 8px;
      padding: 8px;
      text-align: center;
      cursor: pointer;
      transition: background 0.2s, transform 0.2s;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .price-box:hover { background: rgba(255,255,255,0.06); }
    .price-box:active { transform: scale(0.95); }
    .price-label {
      font-size: 11px;
      color: var(--hint-color);
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .price-val {
      font-size: 14px;
      font-weight: 700;
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .price-val.active {
      color: #4ade80;
    }
    .slider-container {
      margin: 16px 0;
      padding: 12px;
      background: rgba(0,0,0,0.2);
      border-radius: 12px;
    }
    .slider-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      font-size: 14px;
    }
    .slider-header span { color: var(--accent); font-weight: 600; }
    input[type=range] {
      -webkit-appearance: none;
      width: 100%;
      background: transparent;
      margin: 8px 0;
    }
    input[type=range]:focus { outline: none; }
    input[type=range]::-webkit-slider-runnable-track {
      width: 100%;
      height: 6px;
      cursor: pointer;
      background: rgba(255,255,255,0.1);
      border-radius: 3px;
    }
    input[type=range]::-webkit-slider-thumb {
      height: 20px;
      width: 20px;
      border-radius: 50%;
      background: var(--accent);
      cursor: pointer;
      -webkit-appearance: none;
      margin-top: -7px;
      box-shadow: 0 0 10px var(--glow);
    }
    .action-row {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }
    button, input, textarea, select {
      font-family: inherit;
      line-height: inherit;
    }
    button {
      flex: 1;
      background-color: rgba(255,255,255,0.1);
      color: var(--text-color);
      border: none;
      border-radius: 8px;
      padding: 10px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:active { transform: scale(0.98); }
    button.primary {
      background-color: var(--button-color);
      color: var(--button-text-color);
    }
    button.danger { color: var(--destructive-color); }
    .last-updated {
      font-size: 11px;
      color: var(--hint-color);
      margin-top: 12px;
    }
    .target-input {
      background: transparent;
      border: 1px solid var(--card-border);
      color: var(--text-color);
      border-radius: 6px;
      padding: 4px 8px;
      width: 70px;
      text-align: center;
      font-weight: 600;
      font-size: 13px;
    }
    .target-input:focus {
      outline: none;
      border-color: var(--accent);
    }
    #loading {
      text-align: center;
      padding: 40px;
      color: var(--hint-color);
    }
  
    .tabs {
      display: flex;
      gap: 16px;
      margin-bottom: 20px;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 8px;
    }
    .tab {
      font-size: 16px;
      font-weight: 600;
      color: var(--hint-color);
      cursor: pointer;
      position: relative;
    }
    .tab.active {
      color: var(--text-color);
    }
    .tab.active::after {
      content: '';
      position: absolute;
      left: 0; right: 0; bottom: -9px;
      height: 2px;
      background: var(--accent);
      border-radius: 2px;
      box-shadow: 0 0 8px var(--glow);
    }
</style>
</head>
<body>
  <div class="tabs">
    <div class="tab active" id="tab-products" onclick="switchTab('products')">${ui.my_products}</div>
    <div class="tab" id="tab-hotdeals" onclick="switchTab('hotdeals')">${ui.hot_deals}</div>
  </div>
  
  <div id="content-products">
    <div id="app"><div id="loading">${ui.syncing}</div></div>
  </div>

  <div id="content-hotdeals" style="display: none;">
    <div id="app-deals"><div id="loading-deals" class="loading">${ui.finding_deals}</div></div>
  </div>

  <script>
    const tg = window.Telegram.WebApp;
    tg.expand();
    tg.ready();
    const initData = tg.initData || '';
    const ui = ${JSON.stringify(ui)};
    const isMasry = ${isMasry};
    const pTag = '${pTagStr}';

    
    let allProducts = [];
    let hotDeals = [];

    function switchTab(tabId) {
      document.getElementById('tab-products').classList.remove('active');
      document.getElementById('tab-hotdeals').classList.remove('active');
      document.getElementById('content-products').style.display = 'none';
      document.getElementById('content-hotdeals').style.display = 'none';

      document.getElementById('tab-' + tabId).classList.add('active');
      document.getElementById('content-' + tabId).style.display = 'block';

      if(tabId === 'hotdeals' && hotDeals.length === 0) {
        loadHotDeals();
      }
    }

    async function loadHotDeals() {
      if(!initData) return;
      try {
        const res = await fetch('/api/user/hot_deals', {
          headers: { 'Authorization': 'Bearer ' + initData }
        });
        if(res.ok) {
          hotDeals = await res.json();
          renderHotDeals();
        } else {
          document.getElementById('app-deals').innerHTML = ui.failed_load;
        }
      } catch(e) {
        document.getElementById('app-deals').innerHTML = ui.error;
      }
    }

    function renderHotDeals() {
      if (hotDeals.length === 0) {
        document.getElementById('app-deals').innerHTML = '<div style="text-align:center;color:var(--hint-color);margin-top:40px;">' + (ui.no_deals) + '</div>';
        return;
      }
      let html = '';
      hotDeals.forEach(p => {
        let name = (isMasry && p.name_ar) ? p.name_ar : p.name;
        if(!name) name = ui.unknown_product;
        const placeholder = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4MCIgaGVpZ2h0PSI4MCI+PHJlY3Qgd2lkdGg9IjgwIiBoZWlnaHQ9IjgwIiBmaWxsPSIjMmMyYzJlIiByeD0iOCIvPjwvc3ZnPg==';
        let img = p.image_url ? p.image_url : placeholder;
        
        let amzUrl = 'https://www.amazon.eg/dp/' + p.asin;
        if(pTag) amzUrl += '?tag=' + pTag;

        let dropPct = Math.round(((p.hist_mean - p.new_price) / p.hist_mean) * 100);

        let trackBtn = p.is_tracked 
          ? '<button disabled style="opacity:0.5; cursor:default; border: 1px solid var(--card-border);">✅ ' + (ui.tracked) + '</button>'
          : '<button class="primary" onclick="trackDeal(\\'' + p.asin + '\\')">🎯 ' + (ui.track) + '</button>';

        html += '<div class="product-card">' +
          '<div class="product-header">' +
            '<img src="' + img + '" class="product-img" />' +
            '<div>' +
               '<h4 class="product-title">' + escapeHtml(name) + '</h4>' +
               '<div class="price-row" style="margin-top:4px;">' +
                 '<div class="price-box new">' +
                   '<div class="price-label">' + (ui.price_now) + '</div>' +
                   '<div class="price-val">' + formatEGP(p.new_price) + '</div>' +
                 '</div>' +
                 '<div class="price-box used" style="background: rgba(255, 59, 48, 0.1); border-color: rgba(255, 59, 48, 0.2);">' +
                   '<div class="price-label" style="color:var(--destructive-color)">' + (ui.price_drop) + '</div>' +
                   '<div class="price-val" style="color:var(--destructive-color)">' + dropPct + '% 🔻</div>' +
                 '</div>' +
               '</div>' +
            '</div>' +
          '</div>' +
          '<div class="action-row">' +
            '<button onclick="window.open(\\''+amzUrl+'\\', \\'_blank\\')">🛒 ' + (ui.open_amazon) + '</button>' +
            trackBtn +
          '</div>' +
        '</div>';
      });
      document.getElementById('app-deals').innerHTML = html;
    }

    async function trackDeal(asin) {
      tg.HapticFeedback.impactOccurred('medium');
      try {
        const res = await fetch('/api/user/track', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + initData, 'Content-Type': 'application/json' },
          body: JSON.stringify({ asin })
        });
        if(res.ok) {
           tg.HapticFeedback.notificationOccurred('success');
           hotDeals = hotDeals.map(d => d.asin === asin ? {...d, is_tracked: true} : d);
           renderHotDeals();
           loadProducts(); // refresh my products list quietly
        } else if(res.status === 403) {
           tg.showAlert(ui.limit_reached);
        } else {
           tg.showAlert(ui.error_tracking);
        }
      } catch(e) {
        tg.showAlert('Error');
      }
    }


    async function loadProducts() {
      if(!initData) {
        document.getElementById('app').innerHTML = ui.open_in_telegram;
        return;
      }
      try {
        const res = await fetch('/api/user/products', {
          headers: { 'Authorization': 'Bearer ' + initData }
        });
        allProducts = await res.json();
        renderProducts();
      } catch (e) {
        document.getElementById('app').innerHTML = ui.error_loading_products;
      }
    }

    function formatEGP(val) {
      if(val === null || val === undefined) return '-';
      return val.toLocaleString() + (' ' + ui.currency_egp);
    }

    function escapeHtml(unsafe) {
      if(!unsafe) return '';
      return unsafe
           .replace(/&/g, "&amp;")
           .replace(/</g, "&lt;")
           .replace(/>/g, "&gt;")
           .replace(/"/g, "&quot;")
           .replace(/'/g, "&#039;");
    }

    function renderProducts() {
      if (allProducts.length === 0) {
        document.getElementById('app').innerHTML = '<div style="text-align:center;color:var(--hint-color);margin-top:40px;">' + (ui.no_products_found) + '</div>';
        return;
      }
      let html = '';
      allProducts.forEach((p, idx) => {
        let name = (isMasry && p.name_ar) ? p.name_ar : p.name;
        if(!name) name = ui.unknown_product;
        const placeholder = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4MCIgaGVpZ2h0PSI4MCI+PHJlY3Qgd2lkdGg9IjgwIiBoZWlnaHQ9IjgwIiBmaWxsPSIjMmMyYzJlIiByeD0iOCIvPjwvc3ZnPg==';
        let img = p.image_url ? p.image_url : placeholder;
        
        let targetSliderVal = p.target_price || p.atl || 0;
        let maxVal = Math.max(p.new_price||0, p.used_price||0, p.amazon_price||0) * 1.2 || 1000;
        if(targetSliderVal > maxVal) maxVal = targetSliderVal * 1.2;

        let lastUpd = p.last_updated ? new Date(p.last_updated).toLocaleString(isMasry ? 'ar-EG' : 'en-US', { hour: 'numeric', minute: 'numeric', day: 'numeric', month: 'numeric', year: 'numeric' }) : (ui.never);

        let amzUrl = 'https://www.amazon.eg/dp/' + p.asin;
        let resaleUrl = 'https://www.amazon.eg/dp/' + p.asin + '?m=A2N2MP47XAP1MK';
        let amazonEgUrl = 'https://www.amazon.eg/dp/' + p.asin + '?m=A1ZVRGNO5AYLOV';

        if(pTag) {
           amzUrl += '?tag=' + pTag;
           resaleUrl += '&tag=' + pTag;
           amazonEgUrl += '&tag=' + pTag;
        }

        let classPaused = p.paused ? 'paused' : '';
        let btnPauseTxt = p.paused ? (ui.resume) : (ui.pause);

        let sellerLabel = p.new_seller ? p.new_seller : (ui.new_condition);
        if(p.new_seller && p.new_seller.toLowerCase() === 'amazon.eg') sellerLabel = ui.amazon_eg;
        let shortSeller = p.new_seller ? p.new_seller.substring(0, 10) + (p.new_seller.length > 10 ? '..' : '') : (ui.new_condition);
        if(p.new_seller && p.new_seller.toLowerCase() === 'amazon.eg') shortSeller = ui.amazon_eg;

        html += '<div class="product-card ' + classPaused + '">' +
          '<div class="product-header">' +
            '<img src="' + img + '" class="product-img" />' +
            '<div>' +
               '<h4 class="product-title">' + name + '</h4>' +
               '<p class="product-asin">' + p.asin + '</p>' +
            '</div>' +
          '</div>';
          
          const isAmzDuplicate = p.new_seller && p.new_seller.toLowerCase() === 'amazon.eg';
          const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
          const now = Date.now();
          const amazonRecentlySeen = p.seen_amazon_eg_at && (now - p.seen_amazon_eg_at) < SEVEN_DAYS;
          const usedRecentlySeen = p.seen_resale_at && (now - p.seen_resale_at) < SEVEN_DAYS;

          const isOutOfStock = !p.new_price && !p.used_price && !p.amazon_price;
          let pricesHtml = '';
          if (isOutOfStock) {
              pricesHtml = '<div style="background: rgba(255, 59, 48, 0.1); border: 1px solid rgba(255, 59, 48, 0.2); color: var(--destructive-color); padding: 12px; border-radius: 8px; display: flex; align-items: center; justify-content: center; gap: 6px; margin: 12px 0; font-weight: 500; font-size: 14px;">' +
                           '<svg style="width: 16px; height: 16px; flex-shrink: 0;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>' +
                           '<span>' + (ui.currently_out_of_stock) + '</span>' +
                           '</div>';
          } else {
              pricesHtml = '<div class="prices-grid" ' + (isAmzDuplicate ? 'style="grid-template-columns: repeat(2, 1fr);"' : '') + '>' +
                '<div class="price-box" title="' + escapeHtml(sellerLabel) + '" onclick="window.open(\\''+amzUrl+'\\', \\'_blank\\')">' +
                  '<div class="price-label">' + escapeHtml(shortSeller) + '</div>' +
                  '<div class="price-val ' + (p.new_price ? 'active' : '') + '">' + (p.new_price ? formatEGP(p.new_price) : ('<span style="font-size:'+(isMasry?'11px':'10px;line-height:1.2;display:inline-block')+';color:var(--destructive-color);">' + ui.likely_out_of_stock + '</span>')) + '</div>' +
                '</div>' +
                '<div class="price-box" title="' + (ui.resale) + '" onclick="window.open(\\''+resaleUrl+'\\', \\'_blank\\')">' +
                  '<div class="price-label">' + (ui.resale) + '</div>' +
                  '<div class="price-val ' + (p.used_price ? 'active' : '') + '">' + (p.used_price ? formatEGP(p.used_price) : (usedRecentlySeen ? ('<span style="font-size:11px;color:#f59e0b;">' + ui.check_stock + '</span>') : ('<span style="font-size:'+(isMasry?'11px':'10px;line-height:1.2;display:inline-block')+';color:var(--destructive-color);">' + ui.likely_out_of_stock + '</span>'))) + '</div>' +
                '</div>' +
                (isAmzDuplicate ? '' : 
                '<div class="price-box" title="' + (ui.amazon_eg) + '" onclick="window.open(\\''+amazonEgUrl+'\\', \\'_blank\\')">' +
                  '<div class="price-label">' + (ui.amazon_eg) + '</div>' +
                  '<div class="price-val ' + (p.amazon_price ? 'active' : '') + '">' + (p.amazon_price ? formatEGP(p.amazon_price) : (amazonRecentlySeen ? ('<span style="font-size:11px;color:#f59e0b;">' + ui.check_stock + '</span>') : ('<span style="font-size:'+(isMasry?'11px':'10px;line-height:1.2;display:inline-block')+';color:var(--destructive-color);">' + ui.likely_out_of_stock + '</span>'))) + '</div>' +
                '</div>') +
              '</div>';
          }

          html += pricesHtml +

          '<div class="slider-container">' +
             '<div class="slider-header">' +
               '<div>' + (ui.target_price) + '</div>' +
               '<div style="display:flex;align-items:center;gap:6px;">' +
                 '<input type="number" id="tgt-input-'+idx+'" class="target-input" min="1" max="'+maxVal+'" value="'+(p.target_price || '')+'" placeholder="'+(ui.none)+'" oninput="document.getElementById(\\'slider-'+idx+'\\').value = this.value" onchange="updateTarget(\\''+p.asin+'\\', this.value ? parseInt(this.value) : null)">' +
                 (p.target_price ? '<a href="#" onclick="clearTarget(\\''+p.asin+'\\'); return false;" style="color:var(--hint-color);font-size:11px;text-decoration:none;">(' + (ui.clear) + ')</a>' : '') +
               '</div>' +
             '</div>' +
             '<input type="range" id="slider-'+idx+'" min="1" max="'+maxVal+'" value="'+targetSliderVal+'" oninput="document.getElementById(\\'tgt-input-'+idx+'\\').value = this.value" onchange="updateTarget(\\''+p.asin+'\\', parseInt(this.value))">' +
          '</div>' +

          '<div class="action-row">' +
            '<button onclick="togglePause(\\''+p.asin+'\\', '+(p.paused?1:0)+')">' + btnPauseTxt + '</button>' +
            '<button class="danger" onclick="deleteProduct(\\''+p.asin+'\\')">🗑 ' + (ui.delete) + '</button>' +
          '</div>' +
          '<div class="action-row">' +
            '<button class="primary" onclick="window.open(\\''+amzUrl+'\\', \\'_blank\\')">🛒 ' + (ui.open_amazon) + '</button>' +
          '</div>' +
          
          '<div class="last-updated">' + (ui.last_checked) + '<span>' + lastUpd + '</span></div>' +
        '</div>';
      });
      document.getElementById('app').innerHTML = html;
    }

    async function apiCall(path, body) {
       return fetch(path, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + initData, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
       });
    }

    async function updateTarget(asin, val) {
      if(val !== null && isNaN(val)) return;
      let msg = ui.confirm_target_prefix + val + ui.confirm_target_suffix;
      tg.showConfirm(msg, async function(ok) {
        if(ok) {
          tg.HapticFeedback.impactOccurred('light');
          await apiCall('/api/user/products/update', { asin, target_price: val });
          tg.showPopup({ title: ui.saved, message: (ui.target_updated) + asin });
          loadProducts();
        } else {
          loadProducts();
        }
      });
    }

    async function clearTarget(asin) {
      tg.HapticFeedback.impactOccurred('light');
      await apiCall('/api/user/products/update', { asin, target_price: null });
      tg.showPopup({ title: ui.cleared, message: (ui.target_cleared) + asin });
      loadProducts();
    }

    async function togglePause(asin, isCurrentlyPaused) {
      tg.HapticFeedback.impactOccurred('medium');
      await apiCall('/api/user/products/update', { asin, action: isCurrentlyPaused ? 'resume' : 'pause' });
      loadProducts();
    }

    async function deleteProduct(asin) {
      tg.HapticFeedback.impactOccurred('heavy');
      tg.showConfirm(ui.confirm_stop, async function(confirm) {
         if(confirm) {
            await apiCall('/api/user/products/delete', { asin });
            loadProducts();
         }
      });
    }

    window.onload = loadProducts;
  </script>
</body>
</html>`;
}
