export async function verifyInitData(telegramInitData, botToken) {
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

async function authUser(req, environment) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const initData = authHeader.replace("Bearer ", "");
  const userData = await verifyInitData(initData, environment.TELEGRAM_BOT_TOKEN);
  return userData;
}

export async function fetchUserAPI(request, env, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400"
      }
    });
  }

  const url = new URL(request.url);

  if (url.pathname === "/user_app" && request.method === "GET") {
    // Detect language from query param or default to English
    const langParam = url.searchParams.get("lang");
    const lang = langParam === 'masry' ? 'masry' : 'en';
    return new Response(renderUserHTML(lang), {
      status: 200,
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }

  if (url.pathname.startsWith("/api/user/")) {
    const user = await authUser(request, env);
    if (!user) return new Response("Unauthorized", { status: 401 });

    const chatId = user.id.toString();

    if (url.pathname === "/api/user/products" && request.method === "GET") {
      const { results } = await env.DB.prepare(`
        SELECT s.asin, s.is_paused as paused, s.target_price, p.name, p.name_ar, 
               p.new_price, p.used_price, p.amazon_price, p.hist_mean, p.is_atl_new
        FROM User_Subscriptions s
        JOIN Global_Products p ON s.asin = p.asin
        WHERE s.chat_id = ?
      `).bind(chatId).all();

      // Get historical ATL from KV
      for (let prod of results) {
         let historyData = await env.AZTRACKER_DB.get(`history:${prod.asin}`, "json") || [];
         let atl = null;
         if (historyData.length > 0) {
            atl = Math.min(...historyData.map(h => h.price));
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
        const { asin, target_price } = body;
        if (!asin) return new Response("Missing ASIN", { status: 400 });

        await env.DB.prepare(
          "UPDATE User_Subscriptions SET target_price = ?, alert_sent_new = 0, alert_sent_used = 0 WHERE chat_id = ? AND asin = ?"
        ).bind(target_price === null ? null : Number(target_price), chatId, asin).run();

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

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch (e) {
        return new Response("Bad Request", { status: 400 });
      }
    }
  }

  return null;
}

function renderUserHTML(lang) {
  const isMasry = lang === 'masry';
  const htmlLang = isMasry ? 'ar' : 'en';
  const htmlDir = isMasry ? 'rtl' : 'ltr';

  return `<!DOCTYPE html>
<html lang="${htmlLang}" dir="${htmlDir}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>My Products</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    body {
      background-color: var(--tg-theme-bg-color, #ffffff);
      color: var(--tg-theme-text-color, #000000);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 16px;
    }
    .product-card {
      background-color: var(--tg-theme-secondary-bg-color, #f0f0f0);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
    }
    .price-slider {
      width: 100%;
      margin: 10px 0;
    }
    button {
      background-color: var(--tg-theme-button-color, #3390ec);
      color: var(--tg-theme-button-text-color, #ffffff);
      border: none;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 14px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div id="app">Loading...</div>
  <script>
    const tg = window.Telegram.WebApp;
    tg.expand();
    const initData = tg.initData || '';
    const isMasry = ${isMasry};

    async function loadProducts() {
      if(!initData) {
        document.getElementById('app').innerHTML = "Please open this inside Telegram.";
        return;
      }
      try {
        const res = await fetch('/api/user/products', {
          headers: { 'Authorization': 'Bearer ' + initData }
        });
        const products = await res.json();
        renderProducts(products);
      } catch (e) {
        document.getElementById('app').innerHTML = "Error loading products.";
      }
    }

    function renderProducts(products) {
      if (products.length === 0) {
        document.getElementById('app').innerHTML = "You have no products.";
        return;
      }
      let html = '';
      products.forEach(p => {
        let name = (isMasry && p.name_ar) ? p.name_ar : p.name;
        html += '<div class="product-card">' +
          '<h4>' + name + '</h4>' +
          '<p>Target: ' + (p.target_price || 'None') + '</p>' +
          '<input type="range" class="price-slider" min="' + (p.atl || 0) + '" max="' + Math.max(p.new_price||0, p.used_price||0, p.amazon_price||0) + '" value="' + (p.target_price || p.atl || 0) + '">' +
          '<br><br><button onclick="updateTarget(\\'' + p.asin + '\\')">Update</button> ' +
          '<button onclick="deleteProduct(\\'' + p.asin + '\\')" style="background-color: var(--tg-theme-destructive-text-color, #ff3b30)">Delete</button>' +
        '</div>';
      });
      document.getElementById('app').innerHTML = html;
    }

    async function updateTarget(asin) {
      tg.showPopup({ title: "Update", message: "Updating " + asin });
    }

    async function deleteProduct(asin) {
      tg.showPopup({ title: "Delete", message: "Deleting " + asin });
    }

    window.onload = loadProducts;
  </script>
</body>
</html>`;
}
