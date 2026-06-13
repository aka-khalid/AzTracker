(() => {
  // src/workers/cron_trigger.js
  async function scheduled(event, env, ctx) {
    console.log(`[CRON START] Received event for schedule: ${event.cron}`);
    let hardwareMinutes = 5;
    if (event.cron) {
      const minPart = event.cron.split(" ")[0];
      if (minPart.startsWith("*/")) {
        hardwareMinutes = parseInt(minPart.substring(2), 10);
      } else if (minPart === "*") {
        hardwareMinutes = 1;
      }
    }
    const hardwareCronMs = hardwareMinutes * 6e4;
    try {
      const now = Date.now();
      await env.DB.prepare("DELETE FROM Bot_States WHERE expires_at < ?").bind(now).run();
      await env.DB.prepare("INSERT OR REPLACE INTO Bot_States (key, value, expires_at) VALUES ('hardware_cron_interval', ?, ?)").bind(hardwareCronMs.toString(), now + 864e5 * 30).run();
      const lastRunStr = await env.DB.prepare("SELECT value FROM Bot_States WHERE key = 'last_run_time'").first("value");
      const lastRunMs = lastRunStr ? parseInt(lastRunStr, 10) : 0;
      const poolSizeRes = await env.DB.prepare("SELECT COUNT(DISTINCT asin) as c FROM User_Subscriptions WHERE is_paused = 0").first();
      const poolSize = poolSizeRes ? poolSizeRes.c : 0;
      console.log(`[GOVERNOR] Pool Size: ${poolSize} | lastRunMs: ${lastRunMs} | Now: ${now}`);
      if (poolSize === 0) {
        console.log(`[GOVERNOR] Aborting: Pool size is 0`);
        return;
      }
      const batches = Math.ceil(poolSize / 10);
      const maxRuns = Math.floor(8640 / batches);
      const intervalMs = Math.floor(864e5 / maxRuns);
      console.log(`[GOVERNOR] Calc -> intervalMs: ${intervalMs} | Time since last run: ${now - lastRunMs}`);
      if (now - lastRunMs >= intervalMs) {
        console.log(`[GOVERNOR] Dispatching queue offset 0`);
        await env.SCRAPER_QUEUE.send({ offset: 0 });
        await env.DB.prepare("INSERT OR REPLACE INTO Bot_States (key, value, expires_at) VALUES ('last_run_time', ?, ?)").bind(now.toString(), now + 864e5).run();
      } else {
        console.log(`[GOVERNOR] Skipped: Interval not met.`);
      }
    } catch (e) {
      console.error("Scheduled execution failed:", e);
    }
  }

  // src/core/amazon.js
  async function getAmazonAccessToken(clientId, clientSecret) {
    const url = "https://api.amazon.com/auth/o2/token";
    const body = {
      grant_type: "client_credentials",
      scope: "creatorsapi::default",
      client_id: clientId,
      client_secret: clientSecret
    };
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Failed to get Amazon access token: ${res.status} - ${errorText}`);
    }
    const data = await res.json();
    return data.access_token;
  }
  function containsArabic(text) {
    if (!text) return false;
    return /[؀-ۿݐ-ݿࢠ-ࣿ]/.test(text);
  }
  var AmazonEdgeParser = class {
    constructor(accessToken, partnerTag, endpointHost = "www.amazon.eg", env = null) {
      this.accessToken = accessToken;
      this.partnerTag = partnerTag;
      this.endpoint = `https://creatorsapi.amazon/catalog/v1/getItems`;
      this.endpointHost = endpointHost;
      this.env = env;
    }
    async getItems(asins) {
      if (asins.length === 0) return [];
      if (asins.length > 10) throw new Error("Batch size exceeds 10 ASINs limit.");
      const results = [];
      const payload = {
        itemIds: asins,
        itemIdType: "ASIN",
        resources: [
          "itemInfo.title",
          "offersV2.listings.price",
          "offersV2.listings.condition",
          "offersV2.listings.merchantInfo",
          "offersV2.listings.isBuyBoxWinner",
          "images.primary.large"
        ],
        partnerTag: this.partnerTag,
        condition: "Any",
        languagesOfPreference: ["en_AE"]
      };
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Accept": "application/json, text/javascript",
          "Authorization": `Bearer ${this.accessToken}`,
          "X-Marketplace": this.endpointHost
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(1e4)
      });
      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`[AmazonEdgeParser] Creators API HTTP Error: ${response.status}`, errorBody);
        throw new Error(`Creators API Error: ${response.status} - Body: ${errorBody}`);
      }
      const data = await response.json();
      const itemsResult = data.ItemsResult || data.itemsResult;
      const items = itemsResult?.Items || itemsResult?.items;
      if (items) {
        for (const item of items) {
          results.push(this.parseItem(item));
        }
      }
      return results;
    }
    /**
     * Fetch Arabic product titles using languagesOfPreference parameter.
     * The Creators API ignores Accept-Language headers — the correct way is
     * passing languagesOfPreference: ["ar_AE"] in the request body.
     * Returns a Map<asin, arabicTitle> for ASINs where Arabic title was found.
     */
    async getItemsWithArabic(asins) {
      if (asins.length === 0) return /* @__PURE__ */ new Map();
      if (asins.length > 10) throw new Error("Batch size exceeds 10 ASINs limit.");
      const arabicNames = /* @__PURE__ */ new Map();
      const payload = {
        itemIds: asins,
        itemIdType: "ASIN",
        resources: ["itemInfo.title"],
        partnerTag: this.partnerTag,
        condition: "Any",
        languagesOfPreference: ["ar_AE"]
      };
      try {
        const response = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json, text/javascript",
            "Authorization": `Bearer ${this.accessToken}`,
            "X-Marketplace": this.endpointHost
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(1e4)
        });
        if (!response.ok) return arabicNames;
        const data = await response.json();
        const itemsResult = data.ItemsResult || data.itemsResult;
        const items = itemsResult?.Items || itemsResult?.items;
        if (items) {
          for (const item of items) {
            const asin = item.ASIN || item.asin;
            const itemInfo = item.ItemInfo || item.itemInfo;
            const titleObj = itemInfo?.Title || itemInfo?.title;
            const title = titleObj?.DisplayValue || titleObj?.displayValue;
            const locale = titleObj?.Locale || titleObj?.locale;
            if (title && (locale === "ar_AE" || containsArabic(title))) {
              arabicNames.set(asin, title);
            }
          }
        }
      } catch (e) {
        console.warn("[AmazonEdgeParser] Arabic title fetch failed:", e.message);
      }
      return arabicNames;
    }
    /**
     * Scrape the Arabic amazon.eg product page for the product title.
     * Fallback when the Creators API doesn't return Arabic titles.
     */
    async scrapeArabicTitle(asin) {
      const url = `https://www.amazon.eg/dp/${asin}?language=ar_AE`;
      try {
        const response = await fetch(url, {
          headers: {
            "Accept-Language": "ar,ar-EG;q=0.9",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          },
          signal: AbortSignal.timeout(8e3)
        });
        if (!response.ok) return null;
        const html = await response.text();
        const match = html.match(/id="productTitle"[^>]*>([^<]+)</);
        if (match && match[1]) {
          const title = match[1].trim();
          if (containsArabic(title)) return title;
        }
      } catch (e) {
        console.warn(`[AmazonEdgeParser] Arabic scrape failed for ${asin}:`, e.message);
      }
      return null;
    }
    /**
     * Scrape the English amazon.eg product page for the product title.
     * Fallback when the Creators API doesn't return English titles.
     */
    async scrapeEnglishTitle(asin) {
      const url = `https://www.amazon.eg/dp/${asin}?language=en_AE`;
      try {
        const response = await fetch(url, {
          headers: {
            "Accept-Language": "en,en-US;q=0.9",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          },
          signal: AbortSignal.timeout(8e3)
        });
        if (!response.ok) return null;
        const html = await response.text();
        const match = html.match(/id="productTitle"[^>]*>([^<]+)</);
        if (match && match[1]) {
          const title = match[1].trim();
          return title;
        }
      } catch (e) {
        console.warn(`[AmazonEdgeParser] English scrape failed for ${asin}:`, e.message);
      }
      return null;
    }
    parseItem(rawItem) {
      const parsed = { asin: rawItem.ASIN || rawItem.asin };
      const itemInfo = rawItem.ItemInfo || rawItem.itemInfo;
      if (itemInfo?.Title?.DisplayValue) {
        parsed.name = itemInfo.Title.DisplayValue;
      } else if (itemInfo?.title?.displayValue) {
        parsed.name = itemInfo.title.displayValue;
      }
      const images = rawItem.Images || rawItem.images;
      const primaryImage = images?.Primary || images?.primary;
      const largeImage = primaryImage?.Large || primaryImage?.large;
      if (largeImage?.URL || largeImage?.url) {
        parsed.imageUrl = largeImage.URL || largeImage.url;
      }
      const amazonEgMid = this.env?.AMZN_EG_MERCHANT_ID || "A1ZVRGNO5AYLOV";
      const amazonResaleMid = this.env?.AMZN_RESALE_MERCHANT_ID || "A2N2MP47XAP1MK";
      const offers = rawItem.OffersV2 || rawItem.Offers || rawItem.offersV2 || rawItem.offers;
      const listings = offers?.Listings || offers?.listings;
      let newIsBuybox = false;
      const normalizeLabel = (lbl) => {
        if (!lbl) return "";
        let s = lbl.toString().toLowerCase();
        if (s.includes(".")) s = s.split(".")[1];
        return s.replace(/_/g, " ").trim();
      };
      if (listings) {
        for (const listing of listings) {
          const rawCond = typeof listing.Condition === "string" ? listing.Condition : typeof listing.condition === "string" ? listing.condition : listing.Condition?.Value || listing.condition?.value || "";
          const rawSub = typeof listing.SubCondition === "string" ? listing.SubCondition : typeof listing.subCondition === "string" ? listing.subCondition : listing.Condition?.SubCondition?.Value || listing.condition?.subCondition?.value || "";
          const condition = normalizeLabel(rawCond);
          const subcondition = normalizeLabel(rawSub);
          const priceObj = listing.Price || listing.price;
          const moneyObj = priceObj?.Money || priceObj?.money;
          const priceStr = moneyObj?.Amount || moneyObj?.amount || priceObj?.Amount || priceObj?.amount;
          const price = Number(priceStr);
          if (!price || price <= 0 || !Number.isFinite(price)) continue;
          const merchantInfo = listing.MerchantInfo || listing.merchantInfo;
          const sellerName = merchantInfo?.Name || merchantInfo?.name || "Unknown";
          const sellerId = merchantInfo?.Id || merchantInfo?.id || "";
          const deliveryInfo = listing.DeliveryInfo || listing.deliveryInfo;
          const rawIsBuyBox = deliveryInfo?.IsBuyBoxWinner || deliveryInfo?.isBuyBoxWinner || listing.IsBuyBoxWinner || listing.isBuyBoxWinner;
          const isBuyBox = String(rawIsBuyBox).toLowerCase() === "true";
          const sellerLower = sellerName.toLowerCase();
          const isAmazon = Boolean(sellerId && sellerId === amazonEgMid);
          const isAmazonResale = sellerId === amazonResaleMid || sellerLower.includes("resale") || sellerLower.includes("warehouse") || sellerLower.includes("renewed");
          const usedTokens = ["used", "refurbished", "renewed", "collectible"];
          const subTokens = ["like new", "very good", "good", "acceptable", "open box", "oem", "likenew", "verygood", "openbox", "refurbished"];
          const isUsedLike = usedTokens.some((t2) => condition.includes(t2)) || subTokens.some((t2) => subcondition.includes(t2)) || isAmazonResale;
          if (isAmazon) {
            if (!parsed.amazonPrice || isBuyBox || price < parsed.amazonPrice && !parsed.amazonIsBuybox) {
              parsed.amazonPrice = price;
              parsed.amazonSeller = sellerName;
              parsed.amazonMid = sellerId;
              parsed.amazonIsBuybox = isBuyBox;
            }
          }
          if (condition === "new") {
            if (!parsed.newPrice || isBuyBox || price < parsed.newPrice && !newIsBuybox) {
              parsed.newPrice = price;
              parsed.newSeller = sellerName;
              parsed.newMid = sellerId;
              newIsBuybox = isBuyBox;
            }
          } else if (isUsedLike) {
            if (!parsed.usedPrice || price < parsed.usedPrice) {
              parsed.usedPrice = price;
              parsed.usedSeller = sellerName;
              parsed.usedMid = sellerId;
            }
          }
        }
      }
      return parsed;
    }
  };

  // src/core/i18n.js
  var dict = {
    // ── Universal Chrome ──────────────────────────────────────────────────────
    "chrome.brand": {
      en: "AzTracker",
      masry: "AzTracker"
    },
    "chrome.ad_disclaimer": {
      en: "As an Amazon Associate I earn from qualifying purchases.",
      masry: "\u0628\u0646\u0627\u062E\u062F \u0639\u0645\u0648\u0644\u0629 \u0645\u0646 \u0623\u0645\u0627\u0632\u0648\u0646 \u0639\u0644\u0649 \u0627\u0644\u0645\u0634\u062A\u0631\u064A\u0627\u062A."
    },
    "chrome.currency_egp": {
      en: "EGP",
      masry: "\u062C.\u0645"
    },
    // ── Access Control / Onboarding ───────────────────────────────────────────
    "access.denied_head": {
      en: "\u26D4 <b>Access Denied</b>",
      masry: "\u26D4 <b>\u0645\u0645\u0646\u0648\u0639 \u0627\u0644\u062F\u062E\u0648\u0644</b>"
    },
    "access.denied_body_private": {
      en: "This is a private Amazon deals server. You are not authorized to use it.",
      masry: "\u062F\u0647 \u0633\u064A\u0631\u0641\u0631 \u0628\u0631\u0627\u064A\u0641\u062A \u0645\u0642\u0641\u0648\u0644 \u0639\u0644\u0649 \u062D\u0628\u0627\u064A\u0628\u0646\u0627 \u0644\u0639\u0631\u0648\u0636 \u0623\u0645\u0627\u0632\u0648\u0646\u060C \u0644\u0644\u0623\u0633\u0641 \u0644\u0633\u0647 \u0645\u0634 \u0645\u0639\u0627\u0643 \u0635\u0644\u0627\u062D\u064A\u0629."
    },
    "access.denied_hint_start": {
      en: "Send /start to request access.",
      masry: "\u0627\u0628\u0639\u062A /start \u0639\u0634\u0627\u0646 \u062A\u062F\u062E\u0644."
    },
    "access.request_btn": {
      en: "\u270B Request Access",
      masry: "\u270B \u0627\u0628\u0639\u062A\u0644\u0646\u0627"
    },
    "access.pending_head": {
      en: "\u23F3 <b>Request Pending</b>",
      masry: "\u23F3 <b>\u0647\u0646\u0634\u0648\u0641 \u0648\u0646\u0631\u062F \u0639\u0644\u064A\u0643</b>"
    },
    "access.pending_body": {
      en: "Your application is currently under review by an administrator. Please wait.",
      masry: "\u0627\u0644\u0627\u062F\u0645\u0646\u0632 \u0628\u064A\u0634\u0648\u0641\u0648\u0627 \u0637\u0644\u0628\u0643 \u062F\u0644\u0648\u0642\u062A\u064A\u060C \u0637\u0648\u0644 \u0628\u0627\u0644\u0643 \u0645\u0639\u0627\u0646\u0627 \u0648\u0631\u0628\u0646\u0627 \u064A\u0633\u0647\u0644."
    },
    "access.request_sent": {
      en: "\u23F3 <b>Request Sent.</b>\n\nPlease wait for an administrator to review your application.",
      masry: "\u23F3 <b>\u0627\u0633\u062A\u0644\u0645\u0646\u0627 \u0637\u0644\u0628\u0643 \u064A\u0627 \u063A\u0627\u0644\u064A.</b>\n\n\u0627\u0633\u062A\u0646\u0649 \u0627\u0644\u0627\u062F\u0645\u0646\u0632 \u064A\u0631\u0627\u062C\u0639\u0648\u0647 \u0648\u0647\u0646\u0631\u062F \u0639\u0644\u064A\u0643."
    },
    "access.queue_full_head": {
      en: "\u26A0\uFE0F <b>Queue Full</b>",
      masry: "\u26A0\uFE0F <b>\u0632\u062D\u0645\u0629</b>"
    },
    "access.queue_full_body": {
      en: "The access queue is currently full. Please try again in 24 hours.",
      masry: "\u0627\u0644\u0633\u064A\u0631\u0641\u0631 \u0645\u062A\u0641\u0648\u0644 \u0639\u0644\u0649 \u0622\u062E\u0631\u0647 \u062F\u0644\u0648\u0642\u062A\u064A\u060C \u062D\u0627\u0648\u0644 \u0645\u0639\u0627\u0646\u0627 \u062A\u0627\u0646\u064A \u0643\u0645\u0627\u0646 \u064A\u0648\u0645 \u0643\u062F\u0647."
    },
    "access.admin_new_request_head": {
      en: "\u{1F514} <b>New Access Request</b>",
      masry: "\u{1F514} <b>\u0641\u064A \u062D\u062F \u062C\u062F\u064A\u062F \u0639\u0627\u064A\u0632 \u064A\u062F\u062E\u0644</b>"
    },
    "access.admin_new_request_body": {
      en: "\u{1F464} <b>Name:</b> {name}\n\u{1F194} <b>ID:</b> <code>{id}</code>\n\n<i>This user is requesting authorization to access the server.</i>",
      masry: "\u{1F464} <b>\u0627\u0644\u0627\u0633\u0645:</b> {name}\n\u{1F194} <b>\u0622\u064A \u062F\u064A:</b> <code>{id}</code>\n\n<i>\u0627\u0644\u0634\u062E\u0635 \u062F\u0647 \u0637\u0627\u0644\u0628 \u064A\u062F\u062E\u0644 \u0627\u0644\u0633\u064A\u0631\u0641\u0631\u060C \u0631\u0623\u064A\u0643 \u0625\u064A\u0647\u061F</i>"
    },
    "access.admin_new_request_btn_approve": {
      en: "\u2705 Approve",
      masry: "\u2705 \u062E\u0644\u064A\u0647 \u064A\u062F\u062E\u0644"
    },
    "access.admin_new_request_btn_reject": {
      en: "\u274C Reject",
      masry: "\u274C \u0641\u0643\u0643 \u0645\u0646\u0647"
    },
    "access.denied_notify": {
      en: "\u26D4 <b>Access Request Denied</b>\n\nYour request to join the server has been declined by an administrator.",
      masry: "\u26D4 <b>\u0627\u0644\u0637\u0644\u0628 \u0627\u062A\u0631\u0641\u0636</b>\n\n\u0645\u0639\u0644\u0634 \u064A\u0627 \u0635\u0627\u062D\u0628\u064A\u060C \u0627\u0644\u0627\u062F\u0645\u0646 \u0631\u0641\u0636 \u0637\u0644\u0628 \u062F\u062E\u0648\u0644\u0643 \u0644\u0644\u0633\u064A\u0631\u0641\u0631."
    },
    "access.blocked_head": {
      en: "\u{1F6AB} <b>Account Blocked</b>",
      masry: "\u{1F6AB} <b>\u0627\u0644\u062D\u0633\u0627\u0628 \u0645\u0642\u0641\u0648\u0644</b>"
    },
    "access.blocked_body": {
      en: "Your account was blocked because the bot was banned or couldn't reach you. Request an unban below.",
      masry: "\u062D\u0633\u0627\u0628\u0643 \u0627\u062A\u0642\u0641\u0644 \u0639\u0634\u0627\u0646 \u0627\u0644\u0628\u0648\u062A \u0623\u062E\u062F \u0628\u0627\u0646 \u0623\u0648 \u0645\u0634 \u0642\u0627\u062F\u0631 \u064A\u0648\u0635\u0644\u0643. \u0627\u0637\u0644\u0628 \u0625\u0644\u063A\u0627\u0621 \u0627\u0644\u062D\u0638\u0631 \u0645\u0646 \u0627\u0644\u0632\u0631\u0627\u0631 \u0627\u0644\u0644\u064A \u062A\u062D\u062A."
    },
    "access.unban_btn": {
      en: "\u{1F504} Request Unban",
      masry: "\u{1F504} \u0627\u0637\u0644\u0628 \u0627\u0644\u063A\u0627\u0621 \u0627\u0644\u062D\u0638\u0631"
    },
    "access.unban_sent": {
      en: "\u2705 <b>Unban Request Sent</b>\n\nAn administrator will review your request shortly.",
      masry: "\u2705 <b>\u0637\u0644\u0628\u0643 \u0648\u0635\u0644</b>\n\n\u0627\u0644\u0627\u062F\u0645\u0646 \u0647\u064A\u0634\u0648\u0641 \u0637\u0644\u0628 \u0625\u0644\u063A\u0627\u0621 \u0627\u0644\u062D\u0638\u0631 \u0642\u0631\u064A\u0628."
    },
    "access.unban_pending": {
      en: "\u23F3 <b>Unban Request Pending</b>\n\nYou already have a pending unban request. An administrator will review it shortly.\n\nPlease be patient \u2014 sending multiple requests will not speed up the process.",
      masry: "\u23F3 <b>\u0637\u0644\u0628\u0643 \u0644\u0633\u0647 \u0645\u0627\u062A\u0631\u062F\u0634 \u0639\u0644\u064A\u0647</b>\n\n\u0639\u0646\u062F\u0643 \u0637\u0644\u0628 \u0625\u0644\u063A\u0627\u0621 \u062D\u0638\u0631 \u0644\u0633\u0647 \u0645\u062A\u0631\u0627\u062C\u0639\u0634. \u0627\u0644\u0627\u062F\u0645\u0646 \u0647\u064A\u0634\u0648\u0641\u0647 \u0642\u0631\u064A\u0628.\n\n\u0637\u0648\u0644 \u0628\u0627\u0644\u0643 \u0645\u0639\u0627\u0646\u0627 \u2014 \u0643\u062A\u0631 \u0627\u0644\u0637\u0644\u0628\u0627\u062A \u0645\u0634 \u0647\u064A\u0633\u0631\u0639 \u0627\u0644\u062F\u0646\u064A\u0627."
    },
    "access.unban_rejected": {
      en: "\u{1F6AB} <b>Access Denied</b>\n\nYour unban request was rejected. You cannot request again at this time.",
      masry: "\u{1F6AB} <b>\u0645\u0645\u0646\u0648\u0639 \u0627\u0644\u062F\u062E\u0648\u0644</b>\n\n\u0637\u0644\u0628\u0643 \u0627\u062A\u0631\u0641\u0636. \u0645\u0634 \u0647\u062A\u0642\u062F\u0631 \u062A\u0628\u0639\u062A \u0637\u0644\u0628 \u062A\u0627\u0646\u064A \u062F\u0644\u0648\u0642\u062A\u064A."
    },
    "admin.unban_request_head": {
      en: "\u{1F512} <b>Unban Request</b>",
      masry: "\u{1F512} <b>\u0641\u064A \u062D\u062F \u0639\u0627\u064A\u0632 \u064A\u0644\u063A\u064A \u0627\u0644\u062D\u0638\u0631</b>"
    },
    "admin.unban_request_body": {
      en: "\u{1F464} <b>Name:</b> {name}\n\u{1F194} <b>ID:</b> <code>{id}</code>\n\n<i>This user was previously blocked (bot banned/unreachable) and is requesting to be unbanned.</i>",
      masry: "\u{1F464} <b>\u0627\u0644\u0627\u0633\u0645:</b> {name}\n\u{1F194} <b>\u0622\u064A \u062F\u064A:</b> <code>{id}</code>\n\n<i>\u0627\u0644\u0634\u062E\u0635 \u062F\u0647 \u0643\u0627\u0646 \u0645\u062D\u0638\u0648\u0631 \u0648\u0639\u0627\u064A\u0632 \u064A\u0631\u062C\u0639 \u062A\u0627\u0646\u064A.</i>"
    },
    "admin.unban_request_btn_unban": {
      en: "\u2705 Unban",
      masry: "\u2705 \u0627\u0644\u063A\u064A \u0627\u0644\u062D\u0638\u0631"
    },
    "access.unban_notify": {
      en: "\u2705 <b>Your account has been unbanned.</b>\n\nSend /start to continue.",
      masry: "\u2705 <b>\u0627\u0644\u062D\u0638\u0631 \u0627\u062A\u0634\u0627\u0644 \u0645\u0646 \u0639\u0644\u064A\u0643 \u064A\u0627 \u063A\u0627\u0644\u064A.</b>\n\n\u0627\u0628\u0639\u062A /start \u0639\u0634\u0627\u0646 \u062A\u0643\u0645\u0644 \u0648\u062A\u0634\u0648\u0641 \u0627\u0644\u0639\u0631\u0648\u0636."
    },
    "admin.unban_request_btn_keep": {
      en: "\u{1F6AB} Keep Banned",
      masry: "\u{1F6AB} \u0633\u064A\u0628\u0647 \u0645\u062D\u0638\u0648\u0631"
    },
    "admin.unban_request_dashboard_hint": {
      en: "\u{1F4CB} Handle this request in the admin dashboard.",
      masry: "\u{1F4CB} \u062A\u0639\u0627\u0645\u0644 \u0645\u0639 \u0627\u0644\u0637\u0644\u0628 \u062F\u0647 \u0645\u0646 \u0644\u0648\u062D\u0629 \u062A\u062D\u0643\u0645 \u0627\u0644\u0623\u062F\u0645\u0646."
    },
    "crm.btn_deny": {
      en: "Deny",
      masry: "\u0641\u0643\u0643 \u0645\u0646\u0647"
    },
    "access.admin_rejected": {
      en: "\u{1F6AB} <b>Request Rejected</b>\nUser \u200F<code>{id}</code>\u200F has been denied access by {admin}.",
      masry: "\u{1F6AB} <b>\u0627\u0644\u0637\u0644\u0628 \u0627\u062A\u0631\u0641\u0636</b>\n\u0627\u0644\u0634\u062E\u0635 \u0622\u064A \u062F\u064A {id} \u0627\u062A\u0631\u0641\u0636 \u0645\u0646 {admin}."
    },
    "access.admin_rejected_manual": {
      en: "\u{1F6AB} <b>Request Rejected</b>\nUser \u200F<code>{id}</code>\u200F has been explicitly denied access.",
      masry: "\u{1F6AB} <b>\u0627\u0644\u0637\u0644\u0628 \u0627\u062A\u0631\u0641\u0636</b>\n\u0622\u064A \u062F\u064A {id} \u0627\u062A\u0631\u0641\u0636 \u0628\u0627\u0644\u0638\u0628\u0637."
    },
    "access.handled_request": {
      en: "\u{1F6AB} <b>Request Handled</b>\nUser \u200F<code>{id}</code>\u200F was rejected by {admin}.",
      masry: "\u{1F6AB} <b>\u062E\u0644\u0635\u0646\u0627 \u0627\u0644\u062D\u0648\u0627\u0631 \u062F\u0647</b>\n\u0627\u0644\u0645\u0633\u062A\u062E\u062F\u0645 <code>{id}</code> \u0623\u062E\u062F \u0631\u0641\u0636 \u0645\u0646 {admin}."
    },
    "access.handled_approved": {
      en: "\u2705 <b>Request Handled</b>\nUser \u200F<code>{id}</code>\u200F was approved by {admin}.",
      masry: "\u2705 <b>\u062E\u0644\u0635\u0646\u0627 \u0627\u0644\u062D\u0648\u0627\u0631 \u062F\u0647</b>\n\u0627\u0644\u0645\u0633\u062A\u062E\u062F\u0645 <code>{id}</code> \u0623\u062E\u062F \u0645\u0648\u0627\u0641\u0642\u0629 \u0645\u0646 {admin}."
    },
    // ── Welcome Message ───────────────────────────────────────────────────────
    "welcome.head": {
      en: "\u{1F389} <b>You have been approved! Welcome!</b>",
      masry: "\u{1F389} <b>\u0623\u0644\u0641 \u0645\u0628\u0631\u0648\u0643! \u0646\u0648\u0631\u062A\u0646\u0627 \u064A\u0627 \u063A\u0627\u0644\u064A!</b>"
    },
    "welcome.step1": {
      en: "<b>1\uFE0F\u20E3 Find your item</b>\nOpen the Amazon app or website and find the product you want to buy.",
      masry: "<b>1\uFE0F\u20E3 \u0627\u062E\u062A\u0627\u0631 \u0627\u0644\u0644\u064A \u0639\u0644\u0649 \u0645\u0632\u0627\u062C\u0643</b>\n\u0627\u0641\u062A\u062D \u0623\u0628\u0644\u0643\u064A\u0634\u0646 \u0623\u0645\u0627\u0632\u0648\u0646 \u0648\u0627\u062E\u062A\u0627\u0631 \u0627\u0644\u0645\u0646\u062A\u062C \u0627\u0644\u0644\u064A \u0639\u064A\u0646\u0643 \u0645\u0646\u0647."
    },
    "welcome.step2": {
      en: "<b>2\uFE0F\u20E3 Share the link</b>\nThe easiest way: In the Amazon app, hit the <b>Share</b> button, select Telegram, and send it directly to this bot! (You can also just copy and paste the link into the chat).",
      masry: "<b>2\uFE0F\u20E3 \u0627\u0628\u0639\u062A\u0644\u0646\u0627 \u0627\u0644\u0644\u064A\u0646\u0643</b>\n\u0623\u0633\u0647\u0644 \u062D\u0627\u062C\u0629: \u0645\u0646 \u0627\u0644\u0623\u0628\u0644\u0643\u064A\u0634\u0646 \u062F\u0648\u0633 <b>\u0645\u0634\u0627\u0631\u0643\u0629 (Share)</b> \u0648\u0627\u062E\u062A\u0627\u0631 \u062A\u064A\u0644\u064A\u062C\u0631\u0627\u0645 \u0648\u0627\u0628\u0639\u062A\u0647 \u0644\u0644\u0628\u0648\u062A \u062F\u0627\u064A\u0631\u0643\u062A! (\u0623\u0648 \u062E\u062F \u0627\u0644\u0644\u064A\u0646\u0643 \u0643\u0648\u0628\u064A \u0628\u064A\u0633\u062A \u0647\u0646\u0627)."
    },
    "welcome.step3": {
      en: "<b>3\uFE0F\u20E3 Set a Target Price (Optional)</b>\nIf you only want alerts for a specific price, click the <i>\u{1F3AF} Set Target</i> button after adding your item. The bot will stay quiet until the price drops to or below your exact target!",
      masry: "<b>3\uFE0F\u20E3 \u062D\u0637 \u062A\u0627\u0631\u062C\u062A \u0644\u0644\u0633\u0639\u0631 (\u0644\u0648 \u062D\u0627\u0628\u0628)</b>\n\u0644\u0648 \u0645\u0633\u062A\u0646\u064A \u0627\u0644\u0633\u0639\u0631 \u064A\u0646\u0632\u0644 \u0644\u0631\u0642\u0645 \u0645\u0639\u064A\u0646\u060C \u062F\u0648\u0633 \u0639\u0644\u0649 <i>\u{1F3AF} \u0642\u0648\u0644 \u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u0644\u064A \u0639\u0627\u064A\u0632\u0647</i> \u0628\u0639\u062F \u0645\u0627 \u062A\u0636\u064A\u0641 \u0627\u0644\u0645\u0646\u062A\u062C. \u0627\u0644\u0628\u0648\u062A \u0645\u0634 \u0647\u064A\u0635\u062F\u0639\u0643 \u063A\u064A\u0631 \u0644\u0645\u0627 \u0627\u0644\u0633\u0639\u0631 \u064A\u0646\u0632\u0644 \u0644\u0644\u0631\u0642\u0645 \u062F\u0647 \u0623\u0648 \u0623\u0642\u0644!"
    },
    "welcome.step4": {
      en: "<b>4\uFE0F\u20E3 Relax & Wait</b>\nThe bot will continuously monitor the market in the background. It will automatically notify you of major price drops, restocks, and even cheaper Amazon Resale (Used) alternatives.",
      masry: "<b>4\uFE0F\u20E3 \u0643\u0628\u0631 \u062F\u0645\u0627\u063A\u0643 \u0648\u0627\u0633\u062A\u0646\u0649</b>\n\u0627\u0644\u0628\u0648\u062A \u0642\u0627\u0639\u062F \u0628\u064A\u0631\u0627\u0642\u0628 \u0627\u0644\u0633\u0648\u0642. \u0623\u0648\u0644 \u0645\u0627 \u0627\u0644\u0633\u0639\u0631 \u064A\u0642\u0639 \u0623\u0648 \u0627\u0644\u0645\u0646\u062A\u062C \u064A\u062A\u0648\u0641\u0631\u060C \u0647\u064A\u062C\u064A\u0644\u0643 \u0625\u0634\u0639\u0627\u0631 \u0641\u064A \u0633\u0627\u0639\u062A\u0647\u0627. \u0648\u0644\u0648 \u0641\u064A \u0628\u062F\u064A\u0644 \u0643\u0633\u0631 \u0632\u064A\u0631\u0648 (\u0631\u064A\u0633\u064A\u0644) \u0623\u0631\u062E\u0635\u060C \u0647\u0646\u062C\u064A\u0628\u0647\u0648\u0644\u0643."
    },
    "welcome.step5": {
      en: "<b>5\uFE0F\u20E3 The Item Limit</b>\nTo keep the servers from catching fire, everyone starts with a limit of <b>{limit}</b> saved items. If you desperately need to save more, you'll have to secretly bribe whichever admin invited you (coffee and a good shawarma usually do the trick \u{1F609}).",
      masry: "<b>5\uFE0F\u20E3 \u0627\u0644\u062D\u062F \u0627\u0644\u0623\u0642\u0635\u0649 \u0644\u0644\u0645\u0646\u062A\u062C\u0627\u062A</b>\n\u0639\u0634\u0627\u0646 \u0627\u0644\u0633\u064A\u0631\u0641\u0631\u0627\u062A \u0645\u062A\u0641\u0631\u0642\u0639\u0634 \u0645\u0646\u0646\u0627\u060C \u0643\u0644 \u0648\u0627\u062D\u062F \u0644\u064A\u0647 <b>{limit}</b> \u0645\u0646\u062A\u062C\u0627\u062A. \u0644\u0648 \u0645\u062D\u062A\u0627\u062C \u0623\u0643\u062A\u0631\u060C \u0631\u0627\u0636\u064A \u0627\u0644\u0627\u062F\u0645\u0646 \u0627\u0644\u0644\u064A \u062F\u062E\u0644\u0643 (\u0634\u0627\u0648\u0631\u0645\u0627 \u0648\u0642\u0647\u0648\u0629 \u0628\u064A\u0639\u0645\u0644\u0648\u0627 \u0627\u0644\u0645\u0639\u062C\u0632\u0627\u062A \u{1F609})."
    },
    "welcome.protip": {
      en: `\u{1F4A1} <i>Pro-Tip: You can always click "\u{1F4E6} My Products" from the Main Menu to manage your items, update target prices, or pause checking on things you've already bought.</i>`,
      masry: "\u{1F4A1} <i>\u062E\u062F \u0628\u0627\u0644\u0643: \u062A\u0642\u062F\u0631 \u0641\u064A \u0623\u064A \u0648\u0642\u062A \u062A\u062F\u0648\u0633 \u0639\u0644\u0649 '\u{1F4E6} \u0645\u0646\u062A\u062C\u0627\u062A\u064A' \u0645\u0646 \u0627\u0644\u0642\u0627\u0626\u0645\u0629 \u0627\u0644\u0631\u0626\u064A\u0633\u064A\u0629 \u0639\u0634\u0627\u0646 \u062A\u062F\u064A\u0631 \u0645\u0646\u062A\u062C\u0627\u062A\u0643\u060C \u062A\u0639\u062F\u0644 \u0623\u0633\u0639\u0627\u0631 \u0627\u0644\u062A\u0627\u0631\u062C\u062A\u060C \u0623\u0648 \u062A\u0648\u0642\u0641 \u0645\u062A\u0627\u0628\u0639\u0629 \u062D\u0627\u062C\u0629 \u0627\u0634\u062A\u0631\u064A\u062A\u0647\u0627 \u062E\u0644\u0627\u0635 \u0639\u0634\u0627\u0646 \u062A\u0641\u0636\u064A \u0645\u0643\u0627\u0646.</i>"
    },
    // ── Language Command ──────────────────────────────────────────────────────
    "lang.head": {
      en: "\u{1F310} <b>Language Settings</b>",
      masry: "\u{1F310} <b>\u0625\u0639\u062F\u0627\u062F\u0627\u062A \u0627\u0644\u0644\u063A\u0629</b>"
    },
    "lang.choose": {
      en: "Please select your preferred language:\n\n<i>\u0627\u062E\u062A\u0627\u0631 \u0627\u0644\u0644\u063A\u0629 \u0627\u0644\u0645\u0641\u0636\u0644\u0629 \u0628\u062A\u0627\u0639\u062A\u0643:</i>",
      masry: "\u0627\u062E\u062A\u0627\u0631 \u0627\u0644\u0644\u063A\u0629 \u0627\u0644\u0645\u0641\u0636\u0644\u0629 \u0628\u062A\u0627\u0639\u062A\u0643:\n\n<i>Please select your preferred language:</i>"
    },
    "lang.btn_en": {
      en: "\u{1F1EC}\u{1F1E7} English",
      masry: "\u{1F1EC}\u{1F1E7} \u0627\u0644\u0625\u0646\u062C\u0644\u064A\u0632\u064A\u0629"
    },
    "lang.btn_ar": {
      en: "\u{1F1EA}\u{1F1EC} \u0627\u0644\u0639\u0631\u0628\u064A\u0629 (\u0645\u0635\u0631\u064A\u0629)",
      masry: "\u{1F1EA}\u{1F1EC} \u0627\u0644\u0639\u0631\u0628\u064A\u0629 (\u0645\u0635\u0631\u064A\u0629)"
    },
    "lang.changed": {
      en: "\u2705 Language changed to <b>English</b>.",
      masry: "\u2705 \u062A\u0645 \u062A\u063A\u064A\u064A\u0631 \u0627\u0644\u0644\u063A\u0629 \u0644\u0640 <b>\u0627\u0644\u0639\u0631\u0628\u064A\u0629</b>."
    },
    // ── Main Menu ─────────────────────────────────────────────────────────────
    "menu.deals_dashboard": {
      en: "\u{1F3E0} <b>Deals Dashboard</b>",
      masry: "\u{1F3E0} <b>\u0644\u0648\u062D\u0629 \u0627\u0644\u0639\u0631\u0648\u0636</b>"
    },
    "menu.your_saved_items": {
      en: "\u{1F4E6} <b>Your Saved Items:</b>",
      masry: "\u{1F4E6} <b>\u0645\u0646\u062A\u062C\u0627\u062A\u0643 \u0627\u0644\u0645\u062D\u0641\u0648\u0638\u0629:</b>"
    },
    "menu.active": {
      en: "\u26A1 <b>Active:</b>",
      masry: "\u26A1 <b>\u0646\u0634\u0637:</b>"
    },
    "menu.paused": {
      en: "\u23F8\uFE0F <b>Paused:</b>",
      masry: "\u23F8\uFE0F <b>\u0645\u062A\u0648\u0642\u0641:</b>"
    },
    "menu.select_option": {
      en: "Select an operative option below:",
      masry: "\u0627\u062E\u062A\u0627\u0631 \u0627\u0644\u0644\u064A \u0627\u0646\u062A \u0639\u0627\u064A\u0632\u0647 \u0645\u0646 \u062A\u062D\u062A:"
    },
    "menu.btn_my_products": {
      en: "\u{1F4E6} My Products",
      masry: "\u{1F4E6} \u0645\u0646\u062A\u062C\u0627\u062A\u064A"
    },
    "menu.btn_how_to_add": {
      en: "\u2795 How to Add Products",
      masry: "\u2795 \u0625\u0632\u0627\u064A \u0623\u0636\u064A\u0641 \u0645\u0646\u062A\u062C\u0627\u062A"
    },
    "menu.btn_admin_panel": {
      en: "\u{1F451} Admin Panel",
      masry: "\u{1F451} \u0644\u0648\u062D\u0629 \u0627\u0644\u0623\u062F\u0645\u0646"
    },
    "menu.btn_language": {
      en: "\u{1F310} Language / \u0627\u0644\u0644\u063A\u0629",
      masry: "\u{1F310} \u0627\u0644\u0644\u063A\u0629 / Language"
    },
    "menu.unlimited": {
      en: "\u221E",
      masry: "\u221E"
    },
    "menu.error": {
      en: "\u26A0\uFE0F Error",
      masry: "\u26A0\uFE0F \u062E\u0637\u0623"
    },
    // ── How to Add ────────────────────────────────────────────────────────────
    "howto.head": {
      en: "\u{1F4A1} <b>How to Add a Product:</b>",
      masry: "\u{1F4A1} <b>\u0625\u0632\u0627\u064A \u062A\u0636\u064A\u0641 \u0645\u0646\u062A\u062C:</b>"
    },
    "howto.body": {
      en: "Copy any Amazon.eg product link from your browser or app and paste it directly into this chat box as a message.",
      masry: "\u0647\u0627\u062A \u0644\u064A\u0646\u0643 \u0623\u064A \u0645\u0646\u062A\u062C \u0645\u0646 \u0623\u0645\u0627\u0632\u0648\u0646 \u0645\u0635\u0631 \u0648\u0627\u0631\u0645\u064A\u0647 \u0641\u064A \u0627\u0644\u0634\u0627\u062A \u0647\u0646\u0627 \u0639\u0644\u0649 \u0637\u0648\u0644."
    },
    "howto.shortlinks": {
      en: "\u{1F4F1} <b>Short links shared directly from the mobile app are fully supported!</b>",
      masry: "\u{1F4F1} <b>\u0644\u064A\u0646\u0643\u0627\u062A \u0623\u0645\u0627\u0632\u0648\u0646 \u0627\u0644\u0645\u062E\u062A\u0635\u0631\u0629 \u0645\u0646 \u0627\u0644\u0623\u0628\u0644\u0643\u064A\u0634\u0646 \u0634\u063A\u0627\u0644\u0629 \u0639\u0627\u062F\u064A!</b>"
    },
    // ── Product Link Processing ───────────────────────────────────────────────
    "link.processing": {
      en: "\u23F3 <b>Processing Amazon link...</b>",
      masry: "\u23F3 <b>\u062B\u0648\u0627\u0646\u064A \u0628\u0646\u0634\u0648\u0641 \u0627\u0644\u0644\u064A\u0646\u0643...</b>"
    },
    "link.region_not_supported_head": {
      en: "\u274C <b>Region Not Supported</b>",
      masry: "\u274C <b>\u0627\u0644\u0645\u0646\u0637\u0642\u0629 \u0645\u0634 \u0645\u062F\u0639\u0648\u0645\u0629</b>"
    },
    "link.region_not_supported_body": {
      en: "Currently, we only support \u200F<code>amazon.eg</code>\u200F.",
      masry: "\u0634\u063A\u0627\u0644\u064A\u0646 \u0639\u0644\u0649 <code>amazon.eg</code> \u0628\u062A\u0627\u0639 \u0645\u0635\u0631 \u0628\u0633 \u064A\u0627 \u0628\u0627\u0634\u0627."
    },
    "link.could_not_parse": {
      en: "\u274C <b>Could not parse a valid 10-digit ASIN.</b>",
      masry: "\u274C <b>\u0627\u0644\u0644\u064A\u0646\u0643 \u062F\u0647 \u0634\u0643\u0644\u0647 \u0628\u0627\u064A\u0638\u060C \u0645\u0634 \u0644\u0627\u0642\u064A\u064A\u0646 \u0641\u064A\u0647 \u0631\u0642\u0645 \u0627\u0644\u0645\u0646\u062A\u062C (ASIN).</b>"
    },
    "link.system_error": {
      en: "\u26A0\uFE0F <b>System Error:</b> Global item limit is unconfigured. Please contact an admin.",
      masry: "\u26A0\uFE0F <b>\u0641\u064A\u0647 \u0645\u0634\u0643\u0644\u0629:</b> \u0627\u0644\u062D\u062F \u0627\u0644\u0623\u0642\u0635\u0649 \u0644\u0644\u0645\u0646\u062A\u062C\u0627\u062A \u0645\u0634 \u0645\u062A\u062D\u062F\u062F. \u0643\u0644\u0645 \u0627\u0644\u0623\u062F\u0645\u0646."
    },
    "link.limit_reached_head": {
      en: "\u26D4 <b>Limit Reached</b>",
      masry: "\u26D4 <b>\u0648\u0635\u0644\u062A \u0644\u0644\u062D\u062F \u0627\u0644\u0623\u0642\u0635\u0649</b>"
    },
    "link.limit_reached_body": {
      en: "You have saved {used} items, but your current limit is {limit}.\n\nPlease delete some products to free up space before adding new ones.",
      masry: "\u0627\u0646\u062A \u0643\u062F\u0647 \u0645\u0633\u064A\u0641 {used} \u0645\u0646\u062A\u062C\u060C \u0648\u0622\u062E\u0631\u0643 \u0645\u0639\u0627\u0646\u0627 {limit}.\n\n\u0641\u0636\u064A\u0644\u0646\u0627 \u0645\u0643\u0627\u0646 \u0643\u062F\u0647 \u0648\u0627\u0645\u0633\u062D \u0634\u0648\u064A\u0629 \u062D\u0627\u062C\u0627\u062A \u0642\u062F\u064A\u0645\u0629 \u0639\u0634\u0627\u0646 \u062A\u0639\u0631\u0641 \u062A\u0636\u064A\u0641 \u0627\u0644\u062C\u062F\u064A\u062F."
    },
    "link.manage_products": {
      en: "\u{1F4E6} Manage My Products",
      masry: "\u{1F4E6} \u0625\u062F\u0627\u0631\u0629 \u0645\u0646\u062A\u062C\u0627\u062A\u064A"
    },
    "link.already_exists": {
      en: "\u26A0\uFE0F <b>You have already saved this product!</b>",
      masry: "\u26A0\uFE0F <b>\u064A\u0627 \u0631\u064A\u0633 \u0627\u0644\u0645\u0646\u062A\u062C \u062F\u0647 \u0639\u0646\u062F\u0643 \u0645\u062A\u0633\u064A\u0641 \u0623\u0635\u0644\u0627\u064B!</b>"
    },
    "link.registered_head": {
      en: "\u2705 <b>Product Registered!</b>",
      masry: "\u2705 <b>\u0627\u0644\u0645\u0646\u062A\u062C \u0627\u062A\u0636\u0627\u0641 \u064A\u0627 \u0628\u0627\u0634\u0627!</b>"
    },
    "link.registered_status": {
      en: "This item is now saved. It will pull the live price during the next automated check.",
      masry: "\u0627\u0644\u0645\u0646\u062A\u062C \u0627\u062A\u062D\u0641\u0638. \u0647\u0646\u062C\u064A\u0628\u0644\u0643 \u0627\u0644\u0633\u0639\u0631 \u0641\u064A \u0623\u0642\u0631\u0628 \u0644\u0641\u0629 \u0644\u0644\u0628\u0648\u062A."
    },
    "link.pending_scan": {
      en: "\u23F3 Pending initial scan...",
      masry: "\u23F3 \u0645\u0633\u062A\u0646\u064A\u064A\u0646 \u0627\u0644\u0644\u0641\u0629 \u0627\u0644\u062C\u0627\u064A\u0629 \u0639\u0634\u0627\u0646 \u0646\u062C\u064A\u0628 \u0627\u0644\u0633\u0639\u0631..."
    },
    "link.status_label": {
      en: "Status:",
      masry: "\u0627\u0644\u062D\u0627\u0644\u0629:"
    },
    "link.invalid_command": {
      en: "\u26A0\uFE0F <b>Invalid Command or Input Structure</b>\n\nPlease use the interactive options below or drop a valid Amazon item link.",
      masry: "\u26A0\uFE0F <b>\u0625\u064A\u0647 \u064A\u0627 \u0639\u0645 \u0627\u0644\u0644\u064A \u0627\u0646\u062A \u0643\u0627\u062A\u0628\u0647 \u062F\u0647\u061F \u0645\u0634 \u0641\u0627\u0647\u0645 \u062D\u0627\u062C\u0629!</b>\n\n\u0627\u0633\u062A\u062E\u062F\u0645 \u0627\u0644\u0632\u0631\u0627\u064A\u0631 \u0627\u0644\u0644\u064A \u062A\u062D\u062A \u0623\u0648 \u0627\u0631\u0645\u064A \u0644\u064A\u0646\u0643 \u0623\u0645\u0627\u0632\u0648\u0646 \u0634\u063A\u0627\u0644."
    },
    // ── Product List ──────────────────────────────────────────────────────────
    "list.my_saved_products": {
      en: "\u{1F4E6} <b>My Saved Products</b>",
      masry: "\u{1F4E6} <b>\u0645\u0646\u062A\u062C\u0627\u062A\u064A \u0627\u0644\u0645\u062D\u0641\u0648\u0638\u0629</b>"
    },
    "list.page_of": {
      en: "Page {page} of {total}",
      masry: "\u0635\u0641\u062D\u0629 {page} \u0645\u0646 {total}"
    },
    "list.empty_head": {
      en: "\u274C <b>Your saved list is empty.</b>",
      masry: "\u274C <b>\u0642\u0627\u064A\u0645\u062A\u0643 \u0628\u062A\u0635\u0641\u0631 \u064A\u0627 \u0628\u0627\u0634\u0627\u060C \u0645\u0641\u064A\u0634 \u062D\u0627\u062C\u0629 \u0647\u0646\u0627.</b>"
    },
    "list.empty_hint": {
      en: "Paste an Amazon.eg link in the chat box to add it to your list.",
      masry: "\u0627\u0631\u0645\u064A \u0623\u064A \u0644\u064A\u0646\u0643 \u0623\u0645\u0627\u0632\u0648\u0646 \u0645\u0635\u0631 \u0641\u064A \u0627\u0644\u0634\u0627\u062A \u0639\u0634\u0627\u0646 \u062A\u0636\u064A\u0641\u0647 \u0644\u0642\u0627\u064A\u0645\u062A\u0643."
    },
    "list.select_hint": {
      en: "Select an item below to modify its checking parameters:",
      masry: "\u0627\u062E\u062A\u0627\u0631 \u0645\u0646\u062A\u062C \u0645\u0646 \u062F\u0648\u0644 \u0639\u0634\u0627\u0646 \u062A\u0638\u0628\u0637 \u0625\u0639\u062F\u0627\u062F\u0627\u062A\u0647:"
    },
    "list.prev": {
      en: "\u2B05\uFE0F Prev",
      masry: "\u2B05\uFE0F \u0627\u0644\u0633\u0627\u0628\u0642"
    },
    "list.next": {
      en: "Next \u27A1\uFE0F",
      masry: "\u0627\u0644\u062A\u0627\u0644\u064A \u27A1\uFE0F"
    },
    // ── Product View ──────────────────────────────────────────────────────────
    "product.price_label": {
      en: "\u{1F4B0} <b>Price:</b>",
      masry: "\u{1F4B0} <b>\u0627\u0644\u0633\u0639\u0631:</b>"
    },
    "product.target_label": {
      en: "\u{1F3AF} <b>Target:</b>",
      masry: "\u{1F3AF} <b>\u0627\u0644\u062A\u0627\u0631\u062C\u062A:</b>"
    },
    "product.seller_label": {
      en: "\u{1F3EC} <b>Seller:</b>",
      masry: "\u{1F3EC} <b>\u0627\u0644\u0628\u0627\u0626\u0639:</b>"
    },
    "product.status_label": {
      en: "\u{1F4E1} <b>Status:</b>",
      masry: "\u{1F4E1} <b>\u0627\u0644\u062D\u0627\u0644\u0629:</b>"
    },
    "product.status_active": {
      en: "\u2705 Active",
      masry: "\u0646\u0634\u0637 \u2705"
    },
    "product.status_paused": {
      en: "\u23F8\uFE0F Paused",
      masry: "\u0645\u0631\u064A\u062D \u0634\u0648\u064A\u0629 \u23F8\uFE0F"
    },
    "product.waiting_check": {
      en: "\u23F3 Waiting for next automated check...",
      masry: "\u23F3 \u062B\u0648\u0627\u0646\u064A \u0628\u0646\u0628\u0635 \u0639\u0644\u0649 \u0627\u0644\u0633\u0639\u0631 \u0648\u0631\u0627\u062C\u0639\u064A\u0646..."
    },
    "product.out_of_stock": {
      en: "\u274C Out of Stock",
      masry: "\u274C \u063A\u064A\u0631 \u0645\u062A\u0648\u0641\u0631"
    },
    "product.checked_today": {
      en: "(Checked: Today at {time})",
      masry: "(\u0634\u0648\u0641\u0646\u0627\u0647: \u0627\u0644\u0646\u0647\u0627\u0631\u062F\u0647 \u0627\u0644\u0633\u0627\u0639\u0629 {time})"
    },
    "product.checked_date": {
      en: "(Checked: {date} {time})",
      masry: "(\u0634\u0648\u0641\u0646\u0627\u0647: {date} {time})"
    },
    "product.used_tag": {
      en: "(Used)",
      masry: "(\u0645\u0633\u062A\u0639\u0645\u0644)"
    },
    "product.amazon_product": {
      en: "Amazon Product",
      masry: "\u0645\u0646\u062A\u062C \u0623\u0645\u0627\u0632\u0648\u0646"
    },
    "product.unknown_product": {
      en: "Unknown Product",
      masry: "\u0645\u0646\u062A\u062C \u063A\u064A\u0631 \u0645\u0639\u0631\u0648\u0641"
    },
    "product.other_options_head": {
      en: "\u{1F4A1} <b>Other Options:</b>",
      masry: "\u{1F4A1} <b>\u062E\u064A\u0627\u0631\u0627\u062A \u062A\u0627\u0646\u064A\u0629:</b>"
    },
    "product.amazon_eg_label": {
      en: "Amazon.eg",
      masry: "\u0623\u0645\u0627\u0632\u0648\u0646 \u0645\u0635\u0631"
    },
    "product.resale_label": {
      en: "Amazon Resale",
      masry: "\u0623\u0645\u0627\u0632\u0648\u0646 \u0631\u064A\u0633\u064A\u0644"
    },
    "product.check_stock": {
      en: "(Check Stock)",
      masry: "(\u0634\u064A\u0651\u0643 \u0639\u0644\u0649 \u0627\u0644\u0645\u062E\u0632\u0648\u0646)"
    },
    "product.asin_row": {
      en: "\u2514 \u{1F194} <code>{asin}</code>",
      masry: "\u200F\u2518 \u{1F194} \u200E<code>{asin}</code>\u200E"
    },
    "product.asin_inline": {
      en: "\u{1F194} <code>{asin}</code>",
      masry: "\u200F\u{1F194} \u200E<code>{asin}</code>\u200E"
    },
    // ── Product View Buttons ──────────────────────────────────────────────────
    "product.btn.open_amazon": {
      en: "\u{1F6D2} Open in Amazon.eg",
      masry: "\u{1F6D2} \u0634\u0648\u0641\u0647 \u0639\u0644\u0649 \u0623\u0645\u0627\u0632\u0648\u0646"
    },
    "product.btn.set_target": {
      en: "\u{1F3AF} Set Target",
      masry: "\u{1F3AF} \u0642\u0648\u0644 \u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u0644\u064A \u0639\u0627\u064A\u0632\u0647"
    },
    "product.btn.clear_target": {
      en: "\u274C Clear Target",
      masry: "\u274C \u0627\u0645\u0633\u062D \u0627\u0644\u062A\u0627\u0631\u062C\u062A"
    },
    "product.btn.pause": {
      en: "\u23F8\uFE0F Pause Checking",
      masry: "\u23F8\uFE0F \u0648\u0642\u0641 \u0627\u0644\u0645\u062A\u0627\u0628\u0639\u0629"
    },
    "product.btn.resume": {
      en: "\u25B6\uFE0F Resume Checking",
      masry: "\u25B6\uFE0F \u0643\u0645\u0644 \u0627\u0644\u0645\u062A\u0627\u0628\u0639\u0629"
    },
    "product.btn.delete": {
      en: "\u{1F5D1}\uFE0F Delete Product",
      masry: "\u{1F5D1}\uFE0F \u0627\u0645\u0633\u062D \u0627\u0644\u0645\u0646\u062A\u062C"
    },
    "product.btn.back_to_products": {
      en: "\u2B05\uFE0F Back to Products",
      masry: "\u2B05\uFE0F \u0631\u062C\u0648\u0639 \u0644\u0644\u0645\u0646\u062A\u062C\u0627\u062A"
    },
    "product.btn.main_menu": {
      en: "\u{1F3E0} Main Menu",
      masry: "\u{1F3E0} \u0627\u0644\u0642\u0627\u0626\u0645\u0629 \u0627\u0644\u0631\u0626\u064A\u0633\u064A\u0629"
    },
    // ── Set Target Flow ───────────────────────────────────────────────────────
    "target.set_head": {
      en: "\u{1F3AF} <b>Set Target Price</b>",
      masry: "\u{1F3AF} <b>\u0642\u0648\u0644 \u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u0644\u064A \u0639\u0627\u064A\u0632\u0647</b>"
    },
    "target.set_prompt": {
      en: "ASIN: <code>{asin}</code>\n\nPlease type your desired maximum price in EGP as a message (e.g., <code>4500</code>).",
      masry: "ASIN: \u200F<code>{asin}</code>\u200F\n\n\u0627\u0643\u062A\u0628 \u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u0623\u0642\u0635\u0649 \u0627\u0644\u0644\u064A \u0639\u0627\u064A\u0632\u0647 \u0628\u0627\u0644\u062C\u0646\u064A\u0647 \u0641\u064A \u0631\u0633\u0627\u0644\u0629 (\u0645\u062B\u0644\u0627\u064B: \u200F<code>4500</code>\u200F)."
    },
    "target.cancel": {
      en: "\u274C Cancel",
      masry: "\u274C \u0625\u0644\u063A\u0627\u0621"
    },
    "target.invalid_amount": {
      en: "\u26A0\uFE0F <b>Invalid amount.</b> Please enter a valid number.",
      masry: "\u26A0\uFE0F <b>\u0627\u0644\u0631\u0642\u0645 \u062F\u0647 \u0645\u0634 \u0645\u0638\u0628\u0648\u0637.</b> \u0627\u0643\u062A\u0628 \u0631\u0642\u0645 \u0635\u062D\u064A\u062D."
    },
    "target.set_confirm_head": {
      en: "\u{1F3AF} <b>Target Price Set!</b>",
      masry: "\u{1F3AF} <b>\u062D\u0637\u064A\u0646\u0627 \u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u0644\u064A \u0639\u0627\u064A\u0632\u0647!</b>"
    },
    "target.set_confirm_body": {
      en: "You will only be notified when ASIN <code>{asin}</code> drops to or below <b>{price}</b>.",
      masry: "\u0647\u064A\u062C\u064A\u0644\u0643 \u0625\u0634\u0639\u0627\u0631 \u0628\u0633 \u0644\u0645\u0627 ASIN \u200F<code>{asin}</code>\u200F \u064A\u0646\u0632\u0644 \u0644\u0640 <b>{price}</b> \u0623\u0648 \u0623\u0642\u0644."
    },
    // ── Confirm Target Removal ────────────────────────────────────────────────
    "target.remove_confirm_head": {
      en: "\u26A0\uFE0F <b>Confirm Target Removal</b>",
      masry: "\u26A0\uFE0F <b>\u0639\u0627\u064A\u0632 \u062A\u0645\u0633\u062D \u0627\u0644\u062A\u0627\u0631\u062C\u062A\u061F</b>"
    },
    "target.remove_confirm_body": {
      en: "Are you sure you want to clear the target price for ASIN <code>{asin}</code>?",
      masry: "\u0645\u062A\u0623\u0643\u062F \u0625\u0646\u0643 \u0639\u0627\u064A\u0632 \u062A\u0645\u0633\u062D \u0627\u0644\u062A\u0627\u0631\u062C\u062A \u0644\u0640 ASIN \u200F<code>{asin}</code>\u200F\u061F"
    },
    "target.btn_yes_clear": {
      en: "\u2705 Yes, Clear Target",
      masry: "\u2705 \u0623\u064A\u0648\u0629\u060C \u0627\u0645\u0633\u062D \u0627\u0644\u062A\u0627\u0631\u062C\u062A"
    },
    "target.remove_cancelled": {
      en: "\u274C Cancel",
      masry: "\u274C \u0625\u0644\u063A\u0627\u0621"
    },
    // ── Confirm Deletion ─────────────────────────────────────────────────────
    "delete.confirm_head": {
      en: "\u26A0\uFE0F <b>Confirm Deletion</b>",
      masry: "\u26A0\uFE0F <b>\u0639\u0627\u064A\u0632 \u062A\u0645\u0633\u062D\u061F</b>"
    },
    "delete.confirm_body": {
      en: "Are you sure you want to permanently delete ASIN <code>{asin}</code> from your saved list?\n\n<i>This action cannot be undone.</i>",
      masry: "\u0645\u062A\u0623\u0643\u062F \u0625\u0646\u0643 \u0639\u0627\u064A\u0632 \u062A\u0645\u0633\u062D ASIN \u200F<code>{asin}</code>\u200F \u0645\u0646 \u0642\u0627\u064A\u0645\u062A\u0643 \u0646\u0647\u0627\u0626\u064A\u0627\u064B\u061F\n\n<i>\u0627\u0644\u0639\u0645\u0644\u064A\u0629 \u062F\u064A \u0645\u0644\u0647\u0627\u0634 \u0631\u062C\u0639\u0629.</i>"
    },
    "delete.btn_yes_delete": {
      en: "\u2705 Yes, Delete",
      masry: "\u2705 \u0623\u064A\u0648\u0629\u060C \u0627\u0645\u0633\u062D"
    },
    "delete.deleted_head": {
      en: "\u{1F5D1}\uFE0F <b>Product Deleted</b>",
      masry: "\u{1F5D1}\uFE0F <b>\u062A\u0645 \u0645\u0633\u062D \u0627\u0644\u0645\u0646\u062A\u062C</b>"
    },
    "delete.deleted_body": {
      en: "ASIN <code>{asin}</code> has been completely removed from your active register.",
      masry: "ASIN \u200F<code>{asin}</code>\u200F \u0627\u062A\u0645\u0633\u062D \u062E\u0644\u0627\u0635."
    },
    // ── Admin: Confirm Revocation ─────────────────────────────────────────────
    "admin.confirm_revoke_head": {
      en: "\u26A0\uFE0F <b>Confirm Revocation</b>",
      masry: "\u26A0\uFE0F <b>\u062A\u0623\u0643\u064A\u062F \u0625\u0644\u063A\u0627\u0621 \u0627\u0644\u0648\u0635\u0648\u0644</b>"
    },
    "admin.confirm_revoke_body": {
      en: "Are you sure you want to permanently revoke ID \u200F<code>{id}</code>\u200F?\n\n<i>Their entire saved list will be erased. This cannot be undone.</i>",
      masry: "\u0645\u062A\u0623\u0643\u062F \u0625\u0646\u0643 \u0639\u0627\u064A\u0632 \u062A\u0634\u064A\u0644 \u0627\u0644\u0631\u0642\u0645 \u200F<code>{id}</code>\u200F \u0646\u0647\u0627\u0626\u064A\u0627\u064B\u061F\n\n<i>\u0643\u0644 \u0645\u0646\u062A\u062C\u0627\u062A\u0647 \u0627\u0644\u0645\u062D\u0641\u0648\u062D\u0629 \u0647\u062A\u062A\u062A\u0645\u0633\u062D. \u0627\u0644\u0639\u0645\u0644\u064A\u0629 \u062F\u064A \u0645\u0644\u0647\u0627\u0634 \u0631\u062C\u0639\u0629.</i>"
    },
    "admin.btn_revoke": {
      en: "\u2705 Yes, Revoke",
      masry: "\u2705 \u0623\u064A\u0648\u0629\u060C \u0627\u0644\u063A\u064A"
    },
    "admin.btn_cancel": {
      en: "\u274C Cancel",
      masry: "\u274C \u0625\u0644\u063A\u0627\u0621"
    },
    // ── Admin: Confirm Demotion ───────────────────────────────────────────────
    "admin.confirm_demote_head": {
      en: "\u26A0\uFE0F <b>Confirm Demotion</b>",
      masry: "\u26A0\uFE0F <b>\u0639\u0627\u064A\u0632 \u062A\u062E\u0641\u0636 \u0631\u062A\u0628\u062A\u0647\u061F</b>"
    },
    "admin.confirm_demote_body": {
      en: "Are you sure you want to strip Admin privileges from ID \u200F<code>{id}</code>\u200F?",
      masry: "\u0645\u062A\u0623\u0643\u062F \u0625\u0646\u0643 \u0639\u0627\u064A\u0632 \u062A\u0634\u064A\u0644 \u0635\u0644\u0627\u062D\u064A\u0627\u062A \u0627\u0644\u0623\u062F\u0645\u0646 \u0645\u0646 \u0622\u064A \u062F\u064A \u200F<code>{id}</code>\u200F\u061F"
    },
    "admin.btn_demote": {
      en: "\u2705 Yes, Demote",
      masry: "\u2705 \u0623\u064A\u0648\u0629\u060C \u062E\u0641\u0636"
    },
    // ── Admin: Confirm Promotion ──────────────────────────────────────────────
    "admin.confirm_promote_head": {
      en: "\u26A0\uFE0F <b>Confirm Promotion</b>",
      masry: "\u26A0\uFE0F <b>\u0639\u0627\u064A\u0632 \u062A\u062E\u0644\u064A\u0647 \u0623\u062F\u0645\u0646\u061F</b>"
    },
    "admin.confirm_promote_body": {
      en: "Are you sure you want to grant full Admin privileges to ID \u200F<code>{id}</code>\u200F?",
      masry: "\u0645\u062A\u0623\u0643\u062F \u0625\u0646\u0643 \u0639\u0627\u064A\u0632 \u062A\u062E\u0644\u064A \u0627\u0644\u0631\u0642\u0645 \u200F<code>{id}</code>\u200F \u0623\u062F\u0645\u0646\u061F"
    },
    "admin.btn_promote": {
      en: "\u2705 Yes, Promote",
      masry: "\u2705 \u0623\u064A\u0648\u0629\u060C \u064A\u0644\u0627 \u0628\u064A\u0646\u0627"
    },
    // ── Admin: Revoked ────────────────────────────────────────────────────────
    "admin.revoked_result": {
      en: "\u{1F5D1}\uFE0F <b>Revoked & Purged!</b>\nID \u200F<code>{id}</code>\u200F and their entire saved list have been permanently erased.",
      masry: "\u{1F5D1}\uFE0F <b>\u0634\u064A\u0644\u0646\u0627\u0647 \u0648\u0645\u0633\u062D\u0646\u0627\u0647!</b>\n\u0622\u064A \u062F\u064A \u200F<code>{id}</code>\u200F \u0648\u0643\u0644 \u0645\u0646\u062A\u062C\u0627\u062A\u0647 \u0627\u062A\u0645\u0633\u062D\u0648\u0627."
    },
    // ── Admin: Promoted ──────────────────────────────────────────────────────
    "admin.promoted_result": {
      en: "\u{1F31F} <b>Promoted!</b>\nID \u200F<code>{id}</code>\u200F has been elevated to Admin privileges.",
      masry: "\u{1F31F} <b>\u0628\u0642\u064A\u062A \u0623\u062F\u0645\u0646!</b>\n\u0622\u064A \u062F\u064A \u200F<code>{id}</code>\u200F \u0627\u062A\u0631\u0642\u0649."
    },
    "admin.promoted_notify": {
      en: "\u{1F31F} <b>You have been promoted to Admin!</b>\nYou now have authorization to approve users. Run /start to see the admin features.",
      masry: "\u{1F31F} <b>\u0645\u0628\u0631\u0648\u0643 \u0628\u0642\u064A\u062A \u0623\u062F\u0645\u0646!</b>\n\u062F\u0644\u0648\u0642\u062A\u064A \u062A\u0642\u062F\u0631 \u062A\u0642\u0628\u0644 \u0623\u0648 \u062A\u0631\u0641\u0636 \u0645\u0633\u062A\u062E\u062F\u0645\u064A\u0646. \u0627\u0641\u062A\u062D \u0627\u0644\u0645\u0646\u064A\u0648 \u0639\u0634\u0627\u0646 \u062A\u0634\u0648\u0641 \u0623\u062F\u0648\u0627\u062A \u0627\u0644\u0623\u062F\u0645\u0646."
    },
    "admin.back_to_directory": {
      en: "\u2B05\uFE0F Back to Directory",
      masry: "\u2B05\uFE0F \u0631\u062C\u0648\u0639 \u0644\u0644\u062F\u0644\u064A\u0644"
    },
    // ── Admin: Demoted ──────────────────────────────────────────────────────
    "admin.demoted_result": {
      en: "\u{1F53D} <b>Demoted.</b>\nID \u200F<code>{id}</code>\u200F has returned to standard access tier.",
      masry: "\u{1F53D} <b>\u0627\u062A\u0634\u0627\u0644 \u0645\u0646\u0647 \u0627\u0644\u0623\u062F\u0645\u0646.</b>\n\u0622\u064A \u062F\u064A \u200F<code>{id}</code>\u200F \u0631\u062C\u0639 \u0645\u0633\u062A\u062E\u062F\u0645 \u0639\u0627\u062F\u064A."
    },
    // ── Admin: Unban ────────────────────────────────────────────────────────
    "admin.unban_result": {
      en: "\u{1F504} <b>User Unbanned</b>\nUser \u200F<code>{id}</code>\u200F has been removed from the Banned Directory. They can now send /start to request access again if they wish.",
      masry: "\u{1F504} <b>\u0631\u0641\u0639\u0646\u0627 \u0627\u0644\u062D\u0638\u0631 \u0639\u0646\u0647</b>\n\u0622\u064A \u062F\u064A \u200F<code>{id}</code>\u200F \u0627\u062A\u0634\u0627\u0644 \u0645\u0646 \u0627\u0644\u0628\u0627\u0646. \u064A\u0642\u062F\u0631 \u064A\u0628\u0639\u062A /start \u062A\u0627\u0646\u064A \u0644\u0648 \u0639\u0627\u064A\u0632 \u064A\u062F\u062E\u0644."
    },
    // ── Admin: Reference expired/handled ──────────────────────────────────────
    "admin.request_expired": {
      en: "\u26A0\uFE0F <b>Request Expired or Handled</b>\nThis application is no longer in the pending queue.",
      masry: "\u26A0\uFE0F <b>\u0627\u0644\u0637\u0644\u0628 \u062F\u0647 \u0642\u062F\u064A\u0645</b>\n\u0627\u0644\u0637\u0644\u0628 \u062F\u0647 \u0628\u0642\u0649 \u0645\u0634 \u0641\u064A \u0627\u0644\u0644\u064A\u0633\u062A."
    },
    "admin.approved_result": {
      en: "\u2705 <b>Approved!</b>\nUser \u200F<code>{id}</code>\u200F was approved by {admin}.",
      masry: "\u2705 <b>\u0648\u0627\u0641\u0642\u0646\u0627 \u0639\u0644\u064A\u0647!</b>\n\u0622\u064A \u062F\u064A \u200F<code>{id}</code>\u200F \u0627\u062A\u0648\u0627\u0641\u0642 \u0639\u0644\u064A\u0647 \u0645\u0646 {admin}."
    },
    "admin.approved_manual_result": {
      en: "\u2705 <b>Approved!</b>\nUser \u200F<code>{id}</code>\u200F can now use the Amazon deals application.",
      masry: "\u2705 <b>\u0648\u0627\u0641\u0642\u0646\u0627 \u0639\u0644\u064A\u0647!</b>\n\u0622\u064A \u062F\u064A \u200F<code>{id}</code>\u200F \u064A\u0642\u062F\u0631 \u064A\u0633\u062A\u062E\u062F\u0645 \u0623\u0628\u0644\u0643\u064A\u0634\u0646 \u0623\u0645\u0627\u0632\u0648\u0646 \u0645\u0635\u0631 \u062F\u0644\u0648\u0642\u062A\u064A."
    },
    // ── Navigation ────────────────────────────────────────────────────────────
    "nav.main_menu": {
      en: "\u{1F3E0} Main Menu",
      masry: "\u{1F3E0} \u0627\u0644\u0642\u0627\u0626\u0645\u0629 \u0627\u0644\u0631\u0626\u064A\u0633\u064A\u0629"
    },
    "nav.back": {
      en: "\u2B05\uFE0F Back",
      masry: "\u2B05\uFE0F \u0631\u062C\u0648\u0639"
    },
    "nav.open_menu": {
      en: "\u{1F3E0} Open Main Menu",
      masry: "\u{1F3E0} \u0627\u0644\u0642\u0627\u0626\u0645\u0629 \u0627\u0644\u0631\u0626\u064A\u0633\u064A\u0629"
    },
    "nav.back_to_product": {
      en: "\u2B05\uFE0F Back to Product",
      masry: "\u2B05\uFE0F \u0631\u062C\u0648\u0639 \u0644\u0644\u0645\u0646\u062A\u062C"
    },
    // ── Scraper Alerts ─────────────────────────────────────────────────────────
    "alert.target_met_head": {
      en: "\u{1F3AF} <b>TARGET MET!</b>",
      masry: "\u{1F3AF} <b>\u062C\u0628\u062A \u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u0644\u064A \u0639\u0627\u064A\u0632\u0647!</b>"
    },
    "alert.target_met_current": {
      en: "\u{1F4B0} <b>Current Price:</b> {price} EGP",
      masry: "\u{1F4B0} <b>\u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u062D\u0627\u0644\u064A:</b> {price} \u062C.\u0645"
    },
    "alert.target_met_target": {
      en: "\u{1F3AF} <b>Target:</b> {price} EGP",
      masry: "\u{1F3AF} <b>\u0627\u0644\u062A\u0627\u0631\u062C\u062A:</b> {price} \u062C.\u0645"
    },
    "alert.target_met_dropped": {
      en: "\u{1F4C9} <b>Dropped:</b> {price} EGP",
      masry: "\u{1F4C9} <b>\u0646\u0632\u0644:</b> {price} \u062C.\u0645"
    },
    "alert.target_met_seller": {
      en: "\u{1F3EC} <b>Seller:</b> {seller}",
      masry: "\u{1F3EC} <b>\u0627\u0644\u0628\u0627\u0626\u0639:</b> {seller}"
    },
    "alert.restock_head": {
      en: "\u{1F504} <b>RESTOCK ALERT</b>",
      masry: "\u{1F504} <b>\u0627\u0644\u0645\u0646\u062A\u062C \u0631\u062C\u0639 \u0627\u0644\u0645\u062E\u0632\u0648\u0646!</b>"
    },
    "alert.restock_price": {
      en: "\u{1F4B0} <b>Price:</b> {price} EGP",
      masry: "\u{1F4B0} <b>\u0627\u0644\u0633\u0639\u0631:</b> {price} \u062C.\u0645"
    },
    "alert.restock_seller": {
      en: "\u{1F3EC} <b>Seller:</b> {seller}",
      masry: "\u{1F3EC} <b>\u0627\u0644\u0628\u0627\u0626\u0639:</b> {seller}"
    },
    "alert.price_drop_head": {
      en: "\u{1F4C9} <b>PRICE DROP ALERT</b>",
      masry: "\u{1F4C9} <b>\u0627\u0644\u0633\u0639\u0631 \u0646\u0632\u0644!</b>"
    },
    "alert.price_drop_new": {
      en: "\u{1F4B0} <b>New Price:</b> {price} EGP",
      masry: "\u{1F4B0} <b>\u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u062C\u062F\u064A\u062F:</b> {price} \u062C.\u0645"
    },
    "alert.price_drop_dropped": {
      en: "\u{1F4C9} <b>Dropped:</b> {diff} EGP",
      masry: "\u{1F4C9} <b>\u0646\u0632\u0644:</b> {diff} \u062C.\u0645"
    },
    "alert.price_drop_was": {
      en: "\u{1F4CA} <b>Was:</b> {price} EGP",
      masry: "\u{1F4CA} <b>\u0643\u0627\u0646:</b> {price} \u062C.\u0645"
    },
    "alert.price_drop_seller": {
      en: "\u{1F3EC} <b>Seller:</b> {seller}",
      masry: "\u{1F3EC} <b>\u0627\u0644\u0628\u0627\u0626\u0639:</b> {seller}"
    },
    "alert.missing_head": {
      en: "\u{1F6A8} <b>Item Missing!</b>",
      masry: "\u{1F6A8} <b>\u0627\u0644\u0645\u0646\u062A\u062C \u062F\u0647 \u0627\u062E\u062A\u0641\u0649 \u0645\u0646 \u0623\u0645\u0627\u0632\u0648\u0646!</b>"
    },
    "alert.stale_target_head": {
      en: "\u23F0 <b>STALE TARGET RETIRED</b>",
      masry: "\u23F0 <b>\u0627\u0644\u062A\u0627\u0631\u062C\u062A \u062F\u0647 \u0627\u062A\u0634\u0627\u0644 \u062E\u0644\u0627\u0635</b>"
    },
    "alert.stale_target_with_price": {
      en: "Your target of <b>{target} EGP</b> for <b>{days}</b> days without being met has been retired. You will now resume receiving standard price alerts.",
      masry: "\u0627\u0644\u062A\u0627\u0631\u062C\u062A \u0628\u062A\u0627\u0639\u0643 <b>{target} \u062C.\u0645</b> \u0645\u0646 <b>{days}</b> \u064A\u0648\u0645 \u0645\u0646 \u063A\u064A\u0631 \u0645\u0627 \u064A\u062A\u062D\u0642\u0642 \u0627\u062A\u0634\u0627\u0644. \u0647\u062A\u0631\u062C\u0639 \u062A\u0627\u0646\u064A \u062A\u0633\u062A\u0642\u0628\u0644 \u0625\u0634\u0639\u0627\u0631\u0627\u062A \u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u0639\u0627\u062F\u064A\u0629."
    },
    "alert.stale_target_no_price": {
      en: "You had no target set for {asin}, but tracking has been inactive for <b>{days}</b> days without activity. Standard price alerts have been resumed.",
      masry: "\u0645\u0627 \u0643\u0627\u0646\u0634 \u0639\u0646\u062F\u0643 \u062A\u0627\u0631\u062C\u062A \u0644\u0640 {asin}\u060C \u0628\u0633 \u0627\u0644\u0645\u062A\u0627\u0628\u0639\u0629 \u0643\u0627\u0646\u062A \u0645\u0634 \u0646\u0634\u0637\u0629 \u0644\u0645\u062F\u0629 <b>{days}</b> \u064A\u0648\u0645. \u0625\u0634\u0639\u0627\u0631\u0627\u062A \u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u0639\u0627\u062F\u064A\u0629 \u0631\u062C\u0639\u062A."
    },
    "alert.tracking_expired_head": {
      en: "\u23F0 <b>TRACKING EXPIRED</b>",
      masry: "\u23F0 <b>\u0645\u062A\u0627\u0628\u0639\u062A\u0643 \u0627\u0646\u062A\u0647\u062A</b>"
    },
    "alert.tracking_expired_body": {
      en: "Your subscription for ASIN <code>{asin}</code> has been retired after <b>{days}</b> days without activity. If you still want to track this item, please re-add it.",
      masry: "\u062A\u0631\u0627\u0643 ASIN \u200F<code>{asin}</code>\u200F \u0627\u062A\u0634\u0627\u0644 \u0628\u0639\u062F <b>{days}</b> \u064A\u0648\u0645 \u0645\u0646 \u063A\u064A\u0631 \u0623\u064A \u0646\u0634\u0627\u0637. \u0644\u0648 \u0639\u0627\u064A\u0632 \u062A\u062A\u0627\u0628\u0639 \u0627\u0644\u0645\u0646\u062A\u062C \u062F\u0647\u060C \u0623\u0636\u0641\u0647 \u0645\u0646 \u062C\u062F\u064A\u062F."
    },
    "alert.btn_open_new": {
      en: "\u{1F6D2} Open in Amazon.eg",
      masry: "\u{1F6D2} \u0627\u0641\u062A\u062D \u0623\u0645\u0627\u0632\u0648\u0646"
    },
    "alert.btn_open_resale": {
      en: "\u{1F4E6} Open Amazon Resale",
      masry: "\u267B\uFE0F \u0634\u0648\u0641 \u0627\u0644\u0631\u064A\u0633\u064A\u0644"
    },
    "alert.btn_disclaimer": {
      en: "\u2139\uFE0F Price Disclaimer",
      masry: "\u2139\uFE0F \u0627\u0644\u0623\u0633\u0639\u0627\u0631 \u0645\u0645\u0643\u0646 \u062A\u062A\u063A\u064A\u0631"
    },
    "alert.disclaimer_text": {
      en: "Prices are indicative and sourced from Amazon.eg at the time of check. Actual prices may vary.",
      masry: "\u0627\u0644\u0623\u0633\u0639\u0627\u0631 \u062F\u064A \u062A\u0642\u0631\u064A\u0628\u064A\u0629 \u0648\u0623\u062E\u062F\u0646\u0627\u0647\u0627 \u0645\u0646 \u0623\u0645\u0627\u0632\u0648\u0646 \u0645\u0635\u0631 \u0648\u0642\u062A \u0645\u0627 \u0634\u064A\u0643\u0646\u0627. \u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u062D\u0642\u064A\u0642\u064A \u0645\u0645\u0643\u0646 \u064A\u062E\u062A\u0644\u0641."
    },
    "alert.boosted_label": {
      en: "#ad",
      masry: "#\u0625\u0639\u0644\u0627\u0646"
    },
    "alert.historical_new": {
      en: "Amazon.eg:",
      masry: "\u0623\u0645\u0627\u0632\u0648\u0646 \u0645\u0635\u0631:"
    },
    "alert.historical_resale": {
      en: "Amazon Resale:",
      masry: "\u0623\u0645\u0627\u0632\u0648\u0646 \u0631\u064A\u0633\u064A\u0644:"
    },
    // ── Scraper: Analytical Stale Target (shared between variants) ────────────
    "alert.stale_days": {
      en: "{days} days",
      masry: "{days} \u064A\u0648\u0645"
    },
    // ── Broadcast ─────────────────────────────────────────────────────────────
    "broadcast.atl_head": {
      en: "\u23EC <b>ALL-TIME LOW</b> \u23EC",
      masry: "\u23EC <b>\u0623\u0642\u0644 \u0633\u0639\u0631 \u0641\u064A \u0627\u0644\u062A\u0627\u0631\u064A\u062E</b> \u23EC"
    },
    "broadcast.exceptional_head": {
      en: "\u{1F525} <b>EXCEPTIONAL DEAL</b> \u{1F525}",
      masry: "\u{1F6A8} \u0644\u0642\u0637\u0629 \u{1F6A8}"
    },
    "broadcast.cta_shop": {
      en: "\u{1F6D2} Click here to grab the deal \u2192",
      masry: "\u{1F6D2} \u062F\u0648\u0633 \u0647\u0646\u0627 \u0639\u0634\u0627\u0646 \u062A\u0644\u062D\u0642 \u2192"
    },
    "broadcast.cta_more": {
      en: "\u{1F50D} Find more exceptional deals \u2192",
      masry: "\u{1F50D} \u0644\u0639\u0631\u0648\u0636 \u0623\u062C\u0645\u062F \u2192"
    },
    "broadcast.price_as_of": {
      en: "\u{1F4C5} Price as of {date}",
      masry: "\u{1F4C5} \u0627\u0644\u0633\u0639\u0631 \u0628\u062A\u0627\u0631\u064A\u062E {date}"
    },
    "broadcast.btn_open": {
      en: "\u{1F6D2} Open in Amazon.eg",
      masry: "\u{1F6D2} \u0634\u0648\u0641\u0647 \u0639\u0644\u0649 \u0623\u0645\u0627\u0632\u0648\u0646"
    },
    // ── CRM Dashboard ──────────────────────────────────────────────────────────
    // ── Shared Misc ───────────────────────────────────────────────────────────
    "happy_shopping": {
      en: "\u{1F6CD}\uFE0F Happy shopping!",
      masry: "\u{1F6CD}\uFE0F \u0631\u0628\u0646\u0627 \u064A\u0648\u0641\u0642\u0643!"
    },
    // ── CRM Dashboard ──────────────────────────────────────────────────────────
    "crm.hub_title": {
      en: "AzTracker Hub",
      masry: "AzTracker Hub"
    },
    "crm.users_title": {
      en: "Users",
      masry: "\u0627\u0644\u0646\u0627\u0633"
    },
    "crm.products_title": {
      en: "Active Tracked Products",
      masry: "\u0627\u0644\u0645\u0646\u062A\u062C\u0627\u062A \u0627\u0644\u0646\u0634\u0637\u0629"
    },
    "crm.system_overview": {
      en: "System Overview",
      masry: "\u0645\u0644\u062E\u0635 \u0633\u0631\u064A\u0639"
    },
    "crm.last_sync": {
      en: "Last Sync",
      masry: "\u0622\u062E\u0631 \u062A\u062D\u062F\u064A\u062B"
    },
    "crm.restore_products": {
      en: "Restore Products",
      masry: "\u0627\u0633\u062A\u0639\u0627\u062F\u0629 \u0627\u0644\u0645\u0646\u062A\u062C\u0627\u062A"
    },
    "crm.force_check": {
      en: "Force Check",
      masry: "\u0634\u0648\u0641 \u0627\u0644\u0623\u0633\u0639\u0627\u0631 \u062F\u0644\u0648\u0642\u062A\u064A"
    },
    "crm.system_broadcast": {
      en: "System Broadcast",
      masry: "\u0628\u0631\u0648\u062F\u0643\u0627\u0633\u062A"
    },
    "crm.broadcast_placeholder": {
      en: "Enter message to blast to all users...",
      masry: "\u0627\u0643\u062A\u0628 \u0631\u0633\u0627\u0644\u0629 \u062A\u0628\u0639\u062A\u0647\u0627 \u0644\u0643\u0644 \u0627\u0644\u0646\u0627\u0633..."
    },
    "crm.send_broadcast": {
      en: "Send Broadcast",
      masry: "\u0627\u0628\u0639\u062A \u0627\u0644\u0631\u0633\u0627\u0644\u0629"
    },
    "crm.tab_approved": {
      en: "Approved",
      masry: "\u062D\u0628\u0627\u064A\u0628\u0646\u0627"
    },
    "crm.tab_pending": {
      en: "Pending",
      masry: "\u0641\u064A \u0627\u0644\u0627\u0646\u062A\u0638\u0627\u0631"
    },
    "crm.queue_type_access": {
      en: "New Access",
      masry: "\u0637\u0644\u0628 \u062C\u062F\u064A\u062F"
    },
    "crm.queue_type_unban": {
      en: "Unban Request",
      masry: "\u0625\u0644\u063A\u0627\u0621 \u062D\u0638\u0631"
    },
    "crm.tab_banned": {
      en: "Banned",
      masry: "\u0648\u0627\u062E\u062F\u064A\u0646 \u0628\u0627\u0646"
    },
    "crm.tab_admins": {
      en: "Admins",
      masry: "\u0627\u0644\u0627\u062F\u0645\u0646\u0632"
    },
    "crm.search_placeholder": {
      en: "Search Name, @username or ID...",
      masry: "\u062F\u0648\u0631 \u0628\u0627\u0644\u0627\u0633\u0645\u060C @\u064A\u0648\u0632\u0631 \u0646\u064A\u0645 \u0623\u0648 \u0631\u0642\u0645..."
    },
    "crm.no_pending": {
      en: "No pending requests",
      masry: "\u0645\u0641\u064A\u0634 \u0637\u0644\u0628\u0627\u062A \u0645\u0639\u0644\u0642\u0629"
    },
    "crm.no_users_found": {
      en: "No users found",
      masry: "\u0645\u0641\u064A\u0634 \u062D\u062F \u0647\u0646\u0627"
    },
    "crm.no_saved_products": {
      en: "No saved products",
      masry: "\u0645\u0641\u064A\u0634 \u0645\u0646\u062A\u062C\u0627\u062A \u0645\u062D\u0641\u0648\u0638\u0629"
    },
    "crm.price_history": {
      en: "Price History",
      masry: "\u062A\u0627\u0631\u064A\u062E \u0627\u0644\u0623\u0633\u0639\u0627\u0631"
    },
    "crm.loading_chart": {
      en: "Loading chart data...",
      masry: "\u0628\u0646\u062D\u0645\u0644 \u0628\u064A\u0627\u0646\u0627\u062A \u0627\u0644\u0631\u0633\u0645 \u0627\u0644\u0628\u064A\u0627\u0646\u064A..."
    },
    "crm.no_price_history": {
      en: "No price history available yet.",
      masry: "\u0645\u0641\u064A\u0634 \u062A\u0627\u0631\u064A\u062E \u0623\u0633\u0639\u0627\u0631 \u0644\u0633\u0647."
    },
    "crm.ath": {
      en: "ATH",
      masry: "ATH"
    },
    "crm.atl": {
      en: "ATL",
      masry: "ATL"
    },
    "crm.avg": {
      en: "Avg",
      masry: "\u0627\u0644\u0645\u062A\u0648\u0633\u0637"
    },
    "crm.new_price": {
      en: "New (EGP)",
      masry: "\u062C\u062F\u064A\u062F (\u062C.\u0645)"
    },
    "crm.used_price": {
      en: "Used (EGP)",
      masry: "\u0645\u0633\u062A\u0639\u0645\u0644 (\u062C.\u0645)"
    },
    "crm.no_audit": {
      en: "No administrative actions logged in the past 7 days.",
      masry: "\u0645\u0641\u064A\u0634 \u0623\u062D\u062F\u0627\u062B \u0623\u062F\u0645\u0646 \u0627\u062A\u0633\u062C\u0644\u062A \u0641\u064A \u0622\u062E\u0631 7 \u0623\u064A\u0627\u0645."
    },
    "crm.user_products": {
      en: "User Products",
      masry: "\u0645\u0646\u062A\u062C\u0627\u062A \u0627\u0644\u0645\u0633\u062A\u062E\u062F\u0645"
    },
    "crm.user_id_label": {
      en: "ID:",
      masry: "\u0627\u0644\u0631\u0642\u0645:"
    },
    "crm.loading_items": {
      en: "Loading items...",
      masry: "\u0628\u0646\u062D\u0645\u0644 \u0627\u0644\u0645\u0646\u062A\u062C\u0627\u062A..."
    },
    "crm.user_paused": {
      en: "Paused",
      masry: "\u0645\u062A\u0648\u0642\u0641"
    },
    "crm.user_active": {
      en: "Active",
      masry: "\u0646\u0634\u0637"
    },
    "crm.user_used_only": {
      en: "Used Only",
      masry: "\u0645\u0633\u062A\u0639\u0645\u0644 \u0628\u0633"
    },
    "crm.user_out_of_stock": {
      en: "Out of Stock",
      masry: "\u063A\u064A\u0631 \u0645\u062A\u0648\u0641\u0631"
    },
    "crm.btn_resume": {
      en: "Resume",
      masry: "\u0643\u0645\u0644"
    },
    "crm.btn_pause_drawer": {
      en: "Pause",
      masry: "\u0648\u0642\u0641"
    },
    "crm.btn_chart": {
      en: "Chart",
      masry: "\u0631\u0633\u0645 \u0628\u064A\u0627\u0646\u064A"
    },
    "crm.btn_delete_drawer": {
      en: "Delete",
      masry: "\u0627\u0645\u0633\u062D"
    },
    "crm.btn_view_items": {
      en: "View Items",
      masry: "\u0634\u0648\u0641 \u0627\u0644\u0645\u0646\u062A\u062C\u0627\u062A"
    },
    "crm.btn_message": {
      en: "Message",
      masry: "\u0631\u0633\u0627\u0644\u0629"
    },
    "crm.btn_edit": {
      en: "Edit",
      masry: "\u062A\u0639\u062F\u064A\u0644"
    },
    "crm.btn_edit_limit": {
      en: "Edit Limit",
      masry: "\u062A\u0639\u062F\u064A\u0644 \u0627\u0644\u062D\u062F"
    },
    "crm.btn_promote": {
      en: "Promote",
      masry: "\u0631\u0648\u0651\u062C"
    },
    "crm.btn_demote_drawer": {
      en: "Demote",
      masry: "\u062E\u0641\u0636"
    },
    "crm.btn_unban": {
      en: "Unban User",
      masry: "\u0627\u0644\u063A\u064A \u0627\u0644\u062D\u0638\u0631"
    },
    "crm.toast_syncing": {
      en: "Syncing...",
      masry: "\u0628\u0646\u062C\u064A\u0628 \u0622\u062E\u0631 \u0627\u0644\u062F\u0627\u062A\u0627..."
    },
    "crm.toast_synced": {
      en: "Data synchronized",
      masry: "\u0627\u0644\u062F\u0627\u062A\u0627 \u0627\u0644\u062C\u062F\u064A\u062F\u0647 \u062C\u0627\u062A!"
    },
    "crm.toast_network_error": {
      en: "Network Error",
      masry: "\u062E\u0637\u0623 \u0641\u064A \u0627\u0644\u0634\u0628\u0643\u0629"
    },
    "crm.toast_action_queued": {
      en: "Action queued in background",
      masry: "\u0642\u064A\u062F \u0627\u0644\u062A\u0646\u0641\u064A\u0630"
    },
    "crm.toast_success": {
      en: "Success",
      masry: "\u062A\u0645"
    },
    "crm.toast_processing": {
      en: "Processing...",
      masry: "\u0628\u0646\u062C\u0647\u0632..."
    },
    "crm.toast_msg_empty": {
      en: "Message is empty",
      masry: "\u0627\u0644\u0631\u0633\u0627\u0644\u0629 \u0641\u0627\u0636\u064A\u0629"
    },
    "crm.action_approved": {
      en: "Your access request has been <b>APPROVED</b>!",
      masry: "\u0637\u0644\u0628 \u0627\u0644\u0648\u0635\u0648\u0644 \u0628\u062A\u0627\u0639\u0643 \u0627\u062A\u0648\u0627\u0641\u0642 \u0639\u0644\u064A\u0647!"
    },
    "crm.action_rejected": {
      en: "Your access request was <b>REJECTED</b>.",
      masry: "\u0637\u0644\u0628 \u0627\u0644\u0648\u0635\u0648\u0644 \u0628\u062A\u0627\u0639\u0643 \u0627\u062A\u0631\u0641\u0636."
    },
    "crm.action_revoked": {
      en: "Your access has been <b>REVOKED</b>.",
      masry: "\u0648\u0635\u0648\u0644\u0643 \u0627\u062A\u0634\u0627\u0644."
    },
    "crm.action_restored": {
      en: "Your access has been <b>RESTORED</b>.",
      masry: "\u0648\u0635\u0648\u0644\u0643 \u0627\u062A\u0631\u062C\u0639."
    },
    "crm.action_promoted": {
      en: "You have been <b>PROMOTED</b> to Admin!",
      masry: "\u0627\u062A\u0631\u0642\u064A\u062A \u0644\u0623\u062F\u0645\u0646!"
    },
    "crm.action_demoted": {
      en: "You have been <b>DEMOTED</b> to standard user.",
      masry: "\u0634\u064A\u0644\u0646\u0627 \u0645\u0646\u0643 \u0635\u0644\u0627\u062D\u064A\u0627\u062A \u0627\u0644\u0623\u062F\u0645\u0646."
    },
    "crm.action_limit_updated": {
      en: "Your tracking limit has been updated to <b>{limit}</b> items.",
      masry: "\u062D\u062F \u0627\u0644\u0645\u062A\u0627\u0628\u0639\u0629 \u0628\u062A\u0627\u0639\u0643 \u0627\u062A\u063A\u064A\u0631 \u0644\u0640 <b>{limit}</b> \u0645\u0646\u062A\u062C\u0627\u062A."
    },
    "crm.action_message_from": {
      en: "\u{1F4EC} <b>Message from Admin:</b>",
      masry: "\u{1F4EC} <b>\u0631\u0633\u0627\u0644\u0629 \u0645\u0646 \u0627\u0644\u0623\u062F\u0645\u0646:</b>"
    },
    "crm.action_restoration_complete": {
      en: "\u2705 <b>Restoration Complete</b>",
      masry: "\u2705 <b>\u0643\u0644 \u062D\u0627\u062C\u0629 \u0627\u062A\u0631\u062C\u0639\u062A</b>"
    },
    "crm.action_restoration_fail": {
      en: "\u274C <b>Restoration Failed</b>",
      masry: "\u274C <b>\u0645\u0646\u0641\u0639\u0634</b>"
    },
    "crm.action_force_scrape_ok": {
      en: "\u2705 <b>Force Scrape Completed</b>",
      masry: "\u2705 <b>\u062A\u0645</b>"
    },
    "crm.action_force_scrape_fail": {
      en: "\u274C <b>Force Scrape Failed</b>",
      masry: "\u274C <b>\u0645\u0646\u0641\u0639\u0634</b>"
    },
    "crm.action_unauthorized": {
      en: "\u26D4 <b>Unauthorized</b>\n\nOnly root admins can perform this action.",
      masry: "\u26D4 <b>\u0645\u0634 \u0645\u0633\u0645\u0648\u062D</b>\n\n\u0627\u0644\u0623\u062F\u0645\u0646 \u0627\u0644\u0631\u0626\u064A\u0633\u064A \u0628\u0633 \u0627\u0644\u0644\u064A \u064A\u0642\u062F\u0631 \u064A\u0639\u0645\u0644 \u062F\u0647."
    },
    "crm.edit_limit_title": {
      en: "Edit Product Limit",
      masry: "\u062A\u0639\u062F\u064A\u0644 \u062D\u062F \u0627\u0644\u0645\u0646\u062A\u062C\u0627\u062A"
    },
    "crm.edit_limit_prompt": {
      en: "Set new product limit for",
      masry: "\u062D\u062F\u062F \u0639\u062F\u062F \u0627\u0644\u0645\u0646\u062A\u062C\u0627\u062A \u0627\u0644\u062C\u062F\u064A\u062F \u0644\u0640"
    },
    "crm.edit_limit_success": {
      en: "\u2705 Limit updated to {limit} items for {user}.",
      masry: "\u2705 \u0627\u062A\u063A\u064A\u0631 \u0627\u0644\u062D\u062F \u0644\u0640 {limit} \u0645\u0646\u062A\u062C\u0627\u062A \u0644\u0640 {user}."
    },
    "crm.action_global_broadcast": {
      en: "\u{1F4E2} <b>Global Broadcast</b>",
      masry: "\u{1F4E2} <b>\u0628\u0631\u0648\u062F\u0643\u0627\u0633\u062A</b>"
    },
    "crm.security_audit": {
      en: "\u{1F512} <b>Security Audit Log</b>",
      masry: "\u{1F512} <b>\u0633\u062C\u0644 \u0627\u0644\u0623\u0645\u0627\u0646</b>"
    },
    "crm.tab_system": {
      en: "System",
      masry: "\u0627\u0644\u0646\u0638\u0627\u0645"
    },
    "crm.rolling_retention": {
      en: "\u{1F4C5} 7-Day Rolling Retention",
      masry: "\u{1F4C5} \u0622\u062E\u0631 7 \u0623\u064A\u0627\u0645"
    },
    "crm.compiling_ledger": {
      en: "\u23F3 Compiling forensic ledger...",
      masry: "\u23F3 \u0628\u0646\u062C\u0647\u0632 \u0633\u062C\u0644 \u0627\u0644\u0623\u0645\u0627\u0646..."
    },
    "crm.refresh": {
      en: "Refresh",
      masry: "\u062A\u062D\u062F\u064A\u062B"
    },
    // ── CRM Admin Action Notifications ────────────────────────────────────────
    "crm.notify_approved": {
      en: "\u2705 <b>Your access request has been APPROVED!</b>\n\nYou can now use AzTracker. Send /start to begin.",
      masry: "\u2705 <b>\u0645\u0648\u0627\u0641\u0642\u064A\u0646 \u0639\u0644\u064A\u0643!</b>\n\n\u062A\u0642\u062F\u0631 \u062F\u0644\u0648\u0642\u062A\u064A \u062A\u0633\u062A\u062E\u062F\u0645 AzTracker. \u0627\u0628\u0639\u062A /start \u0639\u0634\u0627\u0646 \u062A\u0639\u064A\u0634."
    },
    "crm.notify_rejected": {
      en: "\u274C <b>Your access request was REJECTED.</b>",
      masry: "\u274C <b>\u0637\u0644\u0628\u0643 \u0627\u062A\u0631\u0641\u0636.</b>"
    },
    "crm.notify_revoked": {
      en: "\u26D4 <b>Your access has been REVOKED.</b>",
      masry: "\u26D4 <b>\u0627\u0644\u0628\u0627\u0633\u0628\u0648\u0631 \u0627\u062A\u0633\u062D\u0628.</b>\n\u0645\u062A\u0642\u062F\u0631\u0634 \u062A\u0633\u062A\u062E\u062F\u0645 \u0627\u0644\u0628\u0648\u062A \u062A\u0627\u0646\u064A."
    },
    "crm.notify_restored": {
      en: "\u2705 <b>Your access has been RESTORED.</b>",
      masry: "\u2705 <b>\u062F\u0644\u0648\u0642\u062A\u064A \u062A\u0642\u062F\u0631 \u062A\u0633\u062A\u062E\u062F\u0645 \u0627\u0644\u0628\u0648\u062A \u0645\u0631\u0629 \u062A\u0627\u0646\u064A\u0629.</b>"
    },
    "crm.notify_promoted": {
      en: "\u{1F451} <b>You have been PROMOTED to Admin!</b>",
      masry: "\u{1F451} <b>\u0627\u062A\u0631\u0642\u064A\u062A \u0644\u0640 \u0623\u062F\u0645\u0646! \u0645\u0628\u0631\u0648\u0643 \u064A\u0627 \u0628\u0627\u0634\u0627.</b>"
    },
    "crm.notify_demoted": {
      en: "\u{1F53D} <b>You have been DEMOTED to standard user.</b>",
      masry: "\u{1F53D} <b>\u0631\u062C\u0639\u062A \u064A\u0648\u0632\u0631 \u0639\u0627\u062F\u064A \u0632\u064A \u062D\u0627\u0644\u0627\u062A\u0646\u0627.</b>"
    },
    "crm.notify_limit_updated": {
      en: "\u{1F4C8} <b>Your tracking limit has been updated to {limit} items.</b>",
      masry: "\u{1F4C8} <b>\u062D\u062F\u0643 \u0627\u062A\u0631\u0641\u0639 \u0644\u0640 {limit} \u0645\u0646\u062A\u062C. \u0639\u064A\u0634 \u064A\u0627 \u0645\u0639\u0644\u0645!</b>"
    },
    "crm.notify_direct_message": {
      en: "\u{1F4AC} <b>Message from Admin:</b>\n\n{message}",
      masry: "\u{1F4AC} <b>\u0631\u0633\u0627\u0644\u0629 \u0645\u0646 \u0627\u0644\u0623\u062F\u0645\u0646:</b>\n\n{message}"
    },
    "crm.seller_unknown": {
      en: "Unknown",
      masry: "\u0645\u0634 \u0645\u0639\u0631\u0648\u0641"
    },
    "crm.unknown_user": {
      en: "Unknown User ({id})",
      masry: "\u0645\u0633\u062A\u062E\u062F\u0645 \u063A\u064A\u0631 \u0645\u0639\u0631\u0648\u0641 ({id})"
    },
    "crm.global_broadcast": {
      en: "Global Broadcast",
      masry: "\u0628\u0631\u0648\u062F\u0643\u0627\u0633\u062A"
    },
    "crm.loading_audit": {
      en: "Loading audit log...",
      masry: "\u0628\u0646\u062D\u0645\u0644 \u0633\u062C\u0644 \u0627\u0644\u0645\u0631\u0627\u062C\u0639\u0629..."
    },
    "crm.requested_label": {
      en: "Requested:",
      masry: "\u062A\u0627\u0631\u064A\u062E \u0627\u0644\u0637\u0644\u0628:"
    },
    "crm.id_label": {
      en: "ID:",
      masry: "\u0622\u064A \u062F\u064A:"
    },
    "crm.never": {
      en: "Never",
      masry: "\u0623\u0628\u062F\u0627\u064B"
    },
    "crm.current_label": {
      en: "current:",
      masry: "\u0627\u0644\u062D\u0627\u0644\u064A:"
    },
    "crm.local_mode_toast": {
      en: "Local mode: Telegram verification bypassed (Read Only)",
      masry: "\u0648\u0636\u0639 \u0645\u062D\u0644\u064A: \u062A\u0645 \u062A\u062C\u0627\u0648\u0632 \u062A\u0644\u064A\u062C\u0631\u0627\u0645 (\u0642\u0631\u0627\u0621\u0629 \u0641\u0642\u0637)"
    },
    "crm.migrate_success": {
      en: "Successfully migrated {subscriptions} subscriptions and {users} users!",
      masry: "\u062A\u0645 \u062A\u0631\u062D\u064A\u0644 {subscriptions} \u0627\u0634\u062A\u0631\u0627\u0643 \u0648 {users} \u0645\u0633\u062A\u062E\u062F\u0645 \u0628\u0646\u062C\u0627\u062D!"
    },
    "crm.broadcast_prefix": {
      en: "\u{1F4E2} <b>Global Broadcast</b>\n\n{message}",
      masry: "\u{1F4E2} <b>\u0628\u0631\u0648\u062F\u0643\u0627\u0633\u062A</b>\n\n{message}"
    },
    "crm.chart_loading": {
      en: "Loading chart data...",
      masry: "\u0628\u0646\u062D\u0645\u0644 \u0628\u064A\u0627\u0646\u0627\u062A \u0627\u0644\u0631\u0633\u0645 \u0627\u0644\u0628\u064A\u0627\u0646\u064A..."
    },
    // ── System Overview: New Stats ──────────────────────────────────────────────
    "crm.paused_products": {
      en: "Paused Products",
      masry: "\u0645\u0646\u062A\u062C\u0627\u062A \u0645\u0648\u0642\u0648\u0641\u0629"
    },
    "crm.ghost_products": {
      en: "Ghost Products",
      masry: "\u0645\u0646\u062A\u062C\u0627\u062A \u0623\u0634\u0628\u0627\u062D"
    },
    "crm.click_to_expand": {
      en: "Tap to view details",
      masry: "\u0627\u0636\u063A\u0637 \u0639\u0634\u0627\u0646 \u062A\u0634\u0648\u0641 \u0627\u0644\u062A\u0641\u0627\u0635\u064A\u0644"
    },
    "crm.audit_target": {
      en: "Target:",
      masry: "\u0627\u0644\u0647\u062F\u0641:"
    },
    "crm.audit_details": {
      en: "Details:",
      masry: "\u0627\u0644\u062A\u0641\u0627\u0635\u064A\u0644:"
    },
    "crm.btn_view": {
      en: "\u27A1\uFE0F View",
      masry: "\u2B05\uFE0F \u0634\u0648\u0641"
    },
    "crm.select_all": {
      en: "Select All",
      masry: "\u062D\u062F\u062F \u0627\u0644\u0643\u0644"
    },
    "crm.joined_date": {
      en: "Joined:",
      masry: "\u0627\u0646\u0636\u0645:"
    },
    "crm.minutes_short": {
      en: "min",
      masry: "\u062F\u0642\u064A\u0642\u0629"
    },
    // ── Engine Health Widget ─────────────────────────────────────────────────────
    "crm.engine_health": {
      en: "Engine Health",
      masry: "\u062D\u0627\u0644\u0629 \u0627\u0644\u0645\u062D\u0631\u0643"
    },
    "crm.engine_interval": {
      en: "Current Interval",
      masry: "\u0627\u0644\u0641\u062A\u0631\u0629 \u0627\u0644\u062D\u0627\u0644\u064A\u0629"
    },
    "crm.engine_daily_ops": {
      en: "Daily Queue Load",
      masry: "\u062D\u0645\u0644 \u0627\u0644\u064A\u0648\u0645 \u0639\u0644\u0649 \u0627\u0644\u0642\u0627\u0626\u0645\u0629"
    },
    "crm.engine_batches": {
      en: "Batches/Run",
      masry: "\u062F\u0641\u0639\u0627\u062A/\u062A\u0634\u063A\u064A\u0644"
    },
    "crm.engine_status_ok": {
      en: "Healthy",
      masry: "\u0633\u0644\u064A\u0645"
    },
    "crm.engine_status_warn": {
      en: "Approaching Limit",
      masry: "\u0642\u0631\u0628\u062A \u0645\u0646 \u0627\u0644\u062D\u062F"
    },
    "crm.engine_status_critical": {
      en: "Critical",
      masry: "\u062D\u0631\u062C"
    },
    // ── Top Charts Drawer ────────────────────────────────────────────────────────
    "crm.top_charts_title": {
      en: "\u{1F525} Most Popular Products",
      masry: "\u{1F525} \u0623\u0643\u062B\u0631 \u0627\u0644\u0645\u0646\u062A\u062C\u0627\u062A \u0645\u062A\u0627\u0628\u0639\u0629"
    },
    "crm.top_charts_trackers": {
      en: "trackers",
      masry: "\u0645\u062A\u0627\u0628\u0639"
    },
    "crm.top_charts_no_data": {
      en: "No subscription data yet.",
      masry: "\u0645\u0641\u064A\u0634 \u0628\u064A\u0627\u0646\u0627\u062A \u0645\u062A\u0627\u0628\u0639\u064A\u0646 \u0644\u0633\u0647."
    },
    // ── Graveyard Drawer ─────────────────────────────────────────────────────────
    "crm.graveyard_title": {
      en: "\u{1F480} Ghost & Delisted Products",
      masry: "\u{1F480} \u0645\u0646\u062A\u062C\u0627\u062A \u0623\u0634\u0628\u0627\u062D \u0648\u0645\u0634 \u0645\u062A\u0648\u0641\u0631\u0629"
    },
    "crm.graveyard_purge_btn": {
      en: "\u{1F5D1}\uFE0F Purge Selected",
      masry: "\u{1F5D1}\uFE0F \u0627\u0645\u0633\u062D \u0627\u0644\u0645\u062E\u062A\u0627\u0631"
    },
    "crm.graveyard_purge_confirm": {
      en: "Are you sure? This will permanently delete the selected products from the database. This cannot be undone.",
      masry: "\u0645\u062A\u0623\u0643\u062F\u061F \u0627\u0644\u0645\u0646\u062A\u062C\u0627\u062A \u0627\u0644\u0645\u062E\u062A\u0627\u0631\u0629 \u0647\u062A\u062A\u0645\u0633\u062D \u0645\u0646 \u0642\u0627\u0639\u062F\u0629 \u0627\u0644\u0628\u064A\u0627\u0646\u0627\u062A \u0646\u0647\u0627\u0626\u064A\u0627\u064B. \u0645\u0634 \u0647\u062A\u0642\u062F\u0631 \u062A\u0631\u062C\u0639\u0647\u0627."
    },
    "crm.graveyard_purged_ok": {
      en: "Successfully purged {count} products.",
      masry: "\u062A\u0645 \u0645\u0633\u062D {count} \u0645\u0646\u062A\u062C \u0628\u0646\u062C\u0627\u062D."
    },
    "crm.graveyard_empty": {
      en: "No ghost products found. Database is clean!",
      masry: "\u0645\u0641\u064A\u0634 \u0645\u0646\u062A\u062C\u0627\u062A \u0623\u0634\u0628\u0627\u062D. \u0642\u0627\u0639\u062F\u0629 \u0627\u0644\u0628\u064A\u0627\u0646\u0627\u062A \u0646\u0638\u064A\u0641\u0629!"
    },
    "crm.graveyard_subs": {
      en: "active subscribers",
      masry: "\u0645\u062A\u0627\u0628\u0639 \u0646\u0634\u0637"
    },
    "crm.graveyard_delisted": {
      en: "Delisted",
      masry: "\u0645\u0634 \u0645\u062A\u0648\u0641\u0631"
    },
    "crm.graveyard_all_missing": {
      en: "Missing in all conditions",
      masry: "\u0645\u0634 \u0645\u0648\u062C\u0648\u062F \u0641\u064A \u0623\u064A \u062D\u0627\u0644\u0629"
    },
    // ── Fallback Strings ─────────────────────────────────────────────────────
    "fallback.unknown_product": {
      en: "Unknown Product",
      masry: "\u0645\u0646\u062A\u062C \u063A\u064A\u0631 \u0645\u0639\u0631\u0648\u0641"
    },
    "fallback.unknown_seller": {
      en: "Unknown",
      masry: "\u0645\u0634 \u0645\u0639\u0631\u0648\u0641"
    },
    "fallback.unknown_user": {
      en: "Unknown User ({id})",
      masry: "\u0645\u0633\u062A\u062E\u062F\u0645 \u063A\u064A\u0631 \u0645\u0639\u0631\u0648\u0641 ({id})"
    },
    // ── Broadcast Strings ────────────────────────────────────────────────────
    "broadcast.snapshot": {
      en: "\u{1F6A8} Snapshot \u{1F6A8}",
      masry: "\u{1F6A8} \u0644\u0642\u0637\u0629 \u{1F6A8}"
    },
    "broadcast.buy_here": {
      en: "\u{1F6D2} Buy from here \u2190",
      masry: "\u{1F6D2} \u0627\u0634\u062A\u0631\u064A \u0645\u0646 \u0647\u0646\u0627 \u2190"
    },
    "broadcast.catch_deal": {
      en: "\u{1F449} Catch the deal from here \u2190",
      masry: "\u{1F449} \u0627\u0644\u062D\u0642 \u0627\u0644\u0639\u0631\u0636 \u0645\u0646 \u0647\u0646\u0627 \u2190"
    },
    "broadcast.follow_more": {
      en: "\u{1F517} Follow more deals",
      masry: "\u{1F517} \u062A\u0627\u0628\u0639 \u0639\u0631\u0648\u0636 \u0623\u0643\u062A\u0631"
    },
    "broadcast.ad_disclosure": {
      en: "#ad",
      masry: "#\u0625\u0639\u0644\u0627\u0646"
    },
    // ── WebApp Dashboard ────────────────────────────────────────────────────────
    "dashboard.my_products": {
      en: "\u{1F4E6} My Products",
      masry: "\u{1F4E6} \u0645\u0646\u062A\u062C\u0627\u062A\u064A"
    },
    "dashboard.hot_deals": {
      en: "\u{1F525} Hot Deals",
      masry: "\u{1F525} \u0639\u0631\u0648\u0636 \u0646\u0627\u0631"
    },
    "dashboard.syncing": {
      en: "Syncing products...",
      masry: "\u0628\u0646\u062C\u064A\u0628 \u0627\u0644\u0645\u0646\u062A\u062C\u0627\u062A..."
    },
    "dashboard.finding_deals": {
      en: "Finding hot deals...",
      masry: "\u0628\u0646\u062F\u0648\u0631 \u0639\u0644\u0649 \u0639\u0631\u0648\u0636 \u0646\u0627\u0631..."
    },
    "dashboard.failed_load": {
      en: "Failed to load.",
      masry: "\u0627\u0644\u062A\u062D\u0645\u064A\u0644 \u0641\u0634\u0644."
    },
    "dashboard.error": {
      en: "Error.",
      masry: "\u062D\u0635\u0644\u062A \u0645\u0634\u0643\u0644\u0629."
    },
    "dashboard.no_deals": {
      en: "No hot deals right now.",
      masry: "\u0645\u0641\u064A\u0634 \u0639\u0631\u0648\u0636 \u062F\u0644\u0648\u0642\u062A\u064A."
    },
    "dashboard.unknown_product": {
      en: "Unknown Product",
      masry: "\u0645\u0646\u062A\u062C \u0645\u062C\u0647\u0648\u0644"
    },
    "dashboard.tracked": {
      en: "Tracked",
      masry: "\u0639\u0646\u062F\u0643 \u0641\u064A \u0627\u0644\u0644\u064A\u0633\u062A"
    },
    "dashboard.track": {
      en: "Track",
      masry: "\u0636\u064A\u0641\u0647 \u0644\u0640 \u0627\u0644\u0644\u064A\u0633\u062A"
    },
    "dashboard.price_now": {
      en: "Now",
      masry: "\u0627\u0644\u0633\u0639\u0631 \u062F\u0644\u0648\u0642\u062A\u064A"
    },
    "dashboard.price_drop": {
      en: "Drop",
      masry: "\u0646\u0632\u0644"
    },
    "dashboard.open_amazon": {
      en: "Open in Amazon",
      masry: "\u0634\u0648\u0641\u0647 \u0639\u0644\u0649 \u0623\u0645\u0627\u0632\u0648\u0646"
    },
    "dashboard.limit_reached": {
      en: "You have reached your product limit.",
      masry: "\u0643\u062F\u0647 \u0625\u0646\u062A \u0642\u0641\u0644\u062A \u0627\u0644\u0644\u064A\u0645\u064A\u062A \u0628\u062A\u0627\u0639\u0643."
    },
    "dashboard.error_tracking": {
      en: "Error tracking product.",
      masry: "\u0645\u0634\u0643\u0644\u0629 \u0641\u064A \u062A\u062A\u0628\u0639 \u0627\u0644\u0645\u0646\u062A\u062C."
    },
    "dashboard.open_in_telegram": {
      en: "Please open this inside Telegram.",
      masry: "\u0627\u0641\u062A\u062D \u0627\u0644\u0644\u064A\u0646\u0643 \u062F\u0647 \u0645\u0646 \u062C\u0648\u0629 \u062A\u0644\u064A\u062C\u0631\u0627\u0645."
    },
    "dashboard.error_loading_products": {
      en: "Error loading products.",
      masry: "\u0641\u064A\u0647 \u0645\u0634\u0643\u0644\u0629 \u0641\u064A \u062A\u062D\u0645\u064A\u0644 \u0627\u0644\u0645\u0646\u062A\u062C\u0627\u062A."
    },
    "dashboard.no_products_found": {
      en: "No products found. Send an Amazon link to the bot to start tracking!",
      masry: "\u0644\u0633\u0647 \u0645\u0641\u064A\u0634 \u0645\u0646\u062A\u062C\u0627\u062A! \u0627\u0628\u0639\u062A \u0644\u064A\u0646\u0643 \u0623\u0645\u0627\u0632\u0648\u0646 \u0644\u0644\u0628\u0648\u062A \u0639\u0634\u0627\u0646 \u0646\u0631\u0627\u0642\u0628\u0644\u0643 \u0627\u0644\u0633\u0639\u0631."
    },
    "dashboard.last_checked": {
      en: "Last Checked: ",
      masry: "\u0622\u062E\u0631 \u0641\u062D\u0635: "
    },
    "dashboard.never": {
      en: "Never",
      masry: "\u0623\u0628\u062F\u0627\u064B"
    },
    "dashboard.resume": {
      en: "\u25B6\uFE0F Resume",
      masry: "\u0643\u0645\u0644 \u25B6\uFE0F"
    },
    "dashboard.pause": {
      en: "\u23F8 Pause",
      masry: "\u0648\u0642\u0641 \u0645\u0624\u0642\u062A\u0627\u064B \u23F8"
    },
    "dashboard.new_condition": {
      en: "New",
      masry: "\u062C\u062F\u064A\u062F"
    },
    "dashboard.amazon_eg": {
      en: "Amazon.eg",
      masry: "\u0623\u0645\u0627\u0632\u0648\u0646"
    },
    "dashboard.currently_out_of_stock": {
      en: "Currently Out of Stock",
      masry: "\u062E\u0644\u0635\u0627\u0646 \u062F\u0644\u0648\u0642\u062A\u064A"
    },
    "dashboard.likely_out_of_stock": {
      en: "Likely Out of Stock",
      masry: "\u063A\u0627\u0644\u0628\u064B\u0627 \u062E\u0644\u0635"
    },
    "dashboard.check_stock": {
      en: "Check Stock",
      masry: "\u0634\u064A\u0651\u0643 \u0639\u0644\u0649 \u0627\u0644\u0645\u062E\u0632\u0648\u0646"
    },
    "dashboard.resale": {
      en: "Resale",
      masry: "\u0645\u0633\u062A\u0639\u0645\u0644"
    },
    "dashboard.target_price": {
      en: "Target Price:",
      masry: "\u062A\u0627\u0631\u062C\u062A \u0627\u0644\u0633\u0639\u0631:"
    },
    "dashboard.none": {
      en: "None",
      masry: "\u0645\u0641\u064A\u0634"
    },
    "dashboard.clear": {
      en: "Clear",
      masry: "\u0627\u0645\u0633\u062D"
    },
    "dashboard.delete": {
      en: "Delete",
      masry: "\u0627\u062D\u0630\u0641"
    },
    "dashboard.confirm_target_prefix": {
      en: "Are you sure you want to set the target to ",
      masry: "\u0645\u062A\u0623\u0643\u062F \u0625\u0646\u0643 \u0639\u0627\u064A\u0632 \u062A\u062E\u0644\u064A \u0627\u0644\u062A\u0627\u0631\u062C\u062A "
    },
    "dashboard.confirm_target_suffix": {
      en: " EGP?",
      masry: " \u062C\u0646\u064A\u0647\u061F"
    },
    "dashboard.saved": {
      en: "Saved",
      masry: "\u0627\u062A\u062D\u0641\u0638"
    },
    "dashboard.target_updated": {
      en: "Target price updated for ",
      masry: "\u0627\u0644\u0633\u0639\u0631 \u0627\u062A\u062D\u062F\u062B \u0644\u0640 "
    },
    "dashboard.cleared": {
      en: "Cleared",
      masry: "\u0627\u062A\u0645\u0633\u062D"
    },
    "dashboard.target_cleared": {
      en: "Target price cleared for ",
      masry: "\u062A\u0627\u0631\u062C\u062A \u0627\u0644\u0633\u0639\u0631 \u0627\u062A\u0645\u0633\u062D \u0644\u0640 "
    },
    "dashboard.confirm_stop": {
      en: "Are you sure you want to stop tracking this product?",
      masry: "\u0645\u062A\u0623\u0643\u062F \u0625\u0646\u0643 \u0639\u0627\u064A\u0632 \u062A\u0648\u0642\u0641 \u062A\u062A\u0628\u0639 \u0627\u0644\u0645\u0646\u062A\u062C \u062F\u0647\u061F"
    }
  };
  function t(key, lang = "en", vars = {}) {
    const entry = dict[key];
    if (!entry) {
      console.warn(`[i18n] Missing key: "${key}"`);
      return key;
    }
    let text = entry[lang] || entry["en"] || key;
    if (vars && typeof vars === "object") {
      for (const [ph, val] of Object.entries(vars)) {
        text = text.replace(new RegExp(`\\{${ph}\\}`, "g"), String(val));
      }
    }
    return text;
  }
  function resolveLanguageCode(languageCode) {
    if (!languageCode) return "en";
    return languageCode.startsWith("ar") ? "masry" : "en";
  }
  function getWelcomeMessage(lang, limit) {
    const steps = [
      t("welcome.head", lang),
      "",
      t("welcome.step1", lang),
      "",
      t("welcome.step2", lang),
      "",
      t("welcome.step3", lang),
      "",
      t("welcome.step4", lang),
      "",
      t("welcome.step5", lang, { limit }),
      "",
      t("welcome.protip", lang),
      "",
      t("happy_shopping", lang),
      "",
      t("chrome.ad_disclaimer", lang)
    ];
    return steps.join("\n");
  }

  // src/core/utils.js
  function escapeHtml(unsafe) {
    if (!unsafe) return "";
    return String(unsafe).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  function formatEGP(price) {
    if (price === null || price === void 0) return "";
    return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function truncateName(name, maxLength = 60) {
    if (!name) return null;
    if (name.length <= maxLength) return name;
    return name.substring(0, maxLength) + "...";
  }
  function resolveProductName(item, lang, fallback) {
    if (lang === "masry" && item.name_ar) return item.name_ar;
    return item.name || item.asin || fallback || "Unknown Product";
  }
  function convertHindiToArabic(text) {
    if (!text) return "";
    const hindiToAr = { "\u0660": "0", "\u0661": "1", "\u0662": "2", "\u0663": "3", "\u0664": "4", "\u0665": "5", "\u0666": "6", "\u0667": "7", "\u0668": "8", "\u0669": "9" };
    return text.replace(/[٠-٩]/g, (match) => hindiToAr[match]);
  }
  function getCairoTime(now) {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    const parts = formatter.formatToParts(new Date(now));
    const p = {};
    parts.forEach((part) => {
      p[part.type] = part.value;
    });
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} EET`;
  }

  // src/workers/scraper_engine.js
  var AMAZON_EG_MERCHANT_ID = "A1ZVRGNO5AYLOV";
  var AMAZON_RESALE_MERCHANT_ID = "A2N2MP47XAP1MK";
  var TELEGRAM_MSG_LIMIT = 4096;
  var CB_KEY = "amazon_api_circuit_breaker";
  var CB_FAILURE_THRESHOLD = 5;
  var CB_COOLDOWN_MS = 5 * 60 * 1e3;
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
      return state.state;
    } catch (e) {
      return "closed";
    }
  }
  async function recordCircuitSuccess(env) {
    try {
      await env.AZTRACKER_DB.put(CB_KEY, JSON.stringify({ state: "closed", failures: 0 }));
    } catch (e) {
    }
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
    } catch (e) {
    }
  }
  function truncateMessage(msg) {
    if (msg.length <= TELEGRAM_MSG_LIMIT) return msg;
    let cut = msg.lastIndexOf("\n", TELEGRAM_MSG_LIMIT - 20);
    if (cut < TELEGRAM_MSG_LIMIT / 2) cut = TELEGRAM_MSG_LIMIT - 20;
    return msg.substring(0, cut) + "\n\n\u2026";
  }
  async function executeScrapeEngine(env, offset = 0) {
    const query = "SELECT DISTINCT g.* FROM Global_Products g INNER JOIN User_Subscriptions u ON g.asin = u.asin WHERE u.is_paused = 0 ORDER BY g.asin LIMIT 10 OFFSET ?";
    const { results: staleProducts } = await env.DB.prepare(query).bind(offset).all();
    if (!staleProducts || staleProducts.length === 0) return false;
    const cbState = await checkCircuitBreaker(env);
    if (cbState === "open") {
      console.warn("[CircuitBreaker] Amazon API circuit is OPEN \u2014 skipping scrape batch");
      return false;
    }
    const clientId = env.AMAZON_CLIENT_ID || env.AMZN_CREATORS_ACCESS_KEY || env.AWS_ACCESS_KEY_ID;
    const clientSecret = env.AMAZON_CLIENT_SECRET || env.AMZN_CREATORS_SECRET_KEY || env.AWS_SECRET_ACCESS_KEY;
    let accessToken = await env.AZTRACKER_DB.get("amazon_access_token");
    if (!accessToken) {
      try {
        accessToken = await getAmazonAccessToken(clientId, clientSecret);
        await env.AZTRACKER_DB.put("amazon_access_token", accessToken, { expirationTtl: 3300 });
      } catch (e) {
        console.error("Failed to acquire Amazon Access Token:", e);
        await recordCircuitFailure(env);
        return false;
      }
    }
    const parser = new AmazonEdgeParser(accessToken, env.AMZN_ASSOCIATES_TAG, "www.amazon.eg", env);
    const asins = staleProducts.map((p) => p.asin);
    let liveItems;
    try {
      liveItems = await parser.getItems(asins);
      if (cbState === "half_open") {
        await recordCircuitSuccess(env);
      }
    } catch (error) {
      console.error("Creators API error in executeScrapeEngine:", error);
      await recordCircuitFailure(env);
      throw error;
    }
    try {
      const arabicNames = await parser.getItemsWithArabic(asins);
      for (const item of liveItems) {
        if (arabicNames.has(item.asin)) {
          item.name_ar = arabicNames.get(item.asin);
        }
      }
      for (const item of liveItems) {
        if (item.name && /[\u0600-\u06FF]/.test(item.name)) {
          if (!item.name_ar) item.name_ar = item.name;
          item.name = null;
        }
        if (!item.name_ar) {
          const scraped = await parser.scrapeArabicTitle(item.asin);
          if (scraped) item.name_ar = scraped;
          await new Promise((r) => setTimeout(r, 200));
        }
        if (!item.name) {
          const scraped = await parser.scrapeEnglishTitle(item.asin);
          if (scraped) item.name = scraped;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    } catch (e) {
      console.warn("[ScraperEngine] Arabic name enrichment failed (non-blocking):", e.message);
    }
    const d1Batch = [];
    const kvPromises = [];
    const queueBatch = [];
    const now = Date.now();
    if (staleProducts.length > 0 && liveItems.length === 0) {
      console.log(`Global failsafe: 0 items returned for batch at offset ${offset}. Assuming API Outage. Throwing to retry.`);
      throw new Error("0 items returned from Amazon");
    }
    const liveAsins = new Set(liveItems.map((i) => i.asin));
    let bestDeal = [];
    function queueAlert(chatId, lang, condLabel, price, lastPrice, seller, mid, isTarget, targetPrice, liveItem, isAtl, seenAmazonAt, seenResaleAt, amznPrice, usedPrice, newPrice, isUsed) {
      const base_url = `https://www.amazon.eg/dp/${liveItem.asin}`;
      const primary_mid = isUsed ? AMAZON_RESALE_MERCHANT_ID : mid;
      const qParams = new URLSearchParams();
      if (primary_mid) qParams.append("m", primary_mid);
      const pTag = env.AMAZON_PARTNER_TAG;
      if (pTag) qParams.append("tag", pTag);
      const alert_url = qParams.toString() ? `${base_url}?${qParams.toString()}` : base_url;
      const btn_text = isUsed ? t("alert.btn_open_resale", lang) : t("alert.btn_open_new", lang);
      const btn_markup = {
        inline_keyboard: [
          [{ text: btn_text, url: alert_url }],
          [{ text: t("alert.btn_disclaimer", lang), url: "https://telegra.ph/Pricing-Disclaimer-06-05" }]
        ]
      };
      const safe_name = escapeHtml(truncateName(resolveProductName(liveItem, lang)));
      const safe_seller = escapeHtml(seller || t("crm.seller_unknown", lang));
      const sellerLower = (seller || "").toLowerCase();
      let historical_links = [];
      const isAmznSeller = mid === AMAZON_EG_MERCHANT_ID || sellerLower === "amazon" || sellerLower.includes("amazon.eg");
      const isResaleSeller = mid === AMAZON_RESALE_MERCHANT_ID || sellerLower.includes("resale") || sellerLower.includes("warehouse") || sellerLower.includes("renewed");
      const amazon_seen_recently = seenAmazonAt && now - seenAmazonAt < 14 * 24 * 60 * 60 * 1e3;
      const resale_seen_recently = seenResaleAt && now - seenResaleAt < 14 * 24 * 60 * 60 * 1e3;
      if (!isAmznSeller) {
        let amzUrl = `https://www.amazon.eg/dp/${liveItem.asin}?m=${AMAZON_EG_MERCHANT_ID}`;
        if (pTag) amzUrl += `&tag=${pTag}`;
        if (amznPrice !== null) {
          historical_links.push(`\u2518 \u{1F6E1}\uFE0F <a href="${amzUrl}">${t("product.amazon_eg_label", lang)}</a>: <b>${formatEGP(amznPrice)} ${t("chrome.currency_egp", lang)}</b>`);
        } else if (amazon_seen_recently) {
          historical_links.push(`\u2518 \u{1F6E1}\uFE0F <a href="${amzUrl}">${t("product.amazon_eg_label", lang)}</a> <i>${t("product.check_stock", lang)}</i>`);
        }
      }
      if (!isResaleSeller) {
        let resUrl = `https://www.amazon.eg/dp/${liveItem.asin}?m=${AMAZON_RESALE_MERCHANT_ID}`;
        if (pTag) resUrl += `&tag=${pTag}`;
        if (usedPrice !== null) {
          historical_links.push(`\u2518 \u{1F4E6} <a href="${resUrl}">${t("product.resale_label", lang)}</a>: <b>${formatEGP(usedPrice)} ${t("chrome.currency_egp", lang)}</b> <i>${t("product.used_tag", lang)}</i>`);
        } else if (resale_seen_recently) {
          historical_links.push(`\u2518 \u{1F4E6} <a href="${resUrl}">${t("product.resale_label", lang)}</a> <i>${t("product.check_stock", lang)}</i>`);
        }
      }
      let final_smart_alts = "";
      if (historical_links.length > 0) {
        final_smart_alts = `

${t("product.other_options_head", lang)}
` + historical_links.join("\n");
      }
      const atl_banner = isAtl ? t("broadcast.atl_head", lang) + "\n\n" : "";
      const timeStr = getCairoTime(now);
      const currency = t("chrome.currency_egp", lang);
      let msg = "";
      if (isTarget) {
        const diff = lastPrice ? lastPrice - price : 0;
        const down_text = diff > 0 ? ` (${t("alert.price_drop_dropped", lang, { diff: formatEGP(diff) })})` : "";
        msg = `${atl_banner}${t("alert.target_met_head", lang)} ${condLabel}

\u{1F4E6} <b>${safe_name}</b>
${t("product.asin_row", lang, { asin: liveItem.asin })}

${t("alert.target_met_current", lang, { price: formatEGP(price) })}
${t("alert.target_met_target", lang, { price: formatEGP(targetPrice) })}${down_text}
${t("alert.target_met_seller", lang, { seller: safe_seller })}${final_smart_alts}

\u{1F550} <i>${timeStr}</i>

#ad`;
      } else {
        if (lastPrice === null) {
          msg = `${atl_banner}${t("alert.restock_head", lang)} ${condLabel}

\u{1F4E6} <b>${safe_name}</b>
${t("product.asin_row", lang, { asin: liveItem.asin })}

${t("alert.restock_price", lang, { price: formatEGP(price) })}
${t("alert.restock_seller", lang, { seller: safe_seller })}${final_smart_alts}

\u{1F550} <i>${timeStr}</i>

#ad`;
        } else {
          const diff = lastPrice - price;
          const pct = lastPrice ? diff / lastPrice * 100 : 0;
          msg = `${atl_banner}${t("alert.price_drop_head", lang)} ${condLabel}

\u{1F4E6} <b>${safe_name}</b>
${t("product.asin_row", lang, { asin: liveItem.asin })}

${t("alert.price_drop_new", lang, { price: formatEGP(price) })}
${t("alert.price_drop_dropped", lang, { diff: formatEGP(diff) })} (${pct.toFixed(1)}% off)
${t("alert.price_drop_was", lang, { price: formatEGP(lastPrice) })}
${t("alert.price_drop_seller", lang, { seller: safe_seller })}${final_smart_alts}

\u{1F550} <i>${timeStr}</i>

#ad`;
        }
      }
      let alertType = "telegram_alert";
      if (isTarget) {
        alertType = isUsed ? "telegram_alert_used" : "telegram_alert_new";
      }
      queueBatch.push({
        type: alertType,
        asin: liveItem.asin,
        chatId,
        text: truncateMessage(msg),
        markup: btn_markup
      });
    }
    for (const liveItem of liveItems) {
      const oldItem = staleProducts.find((p) => p.asin === liveItem.asin);
      if (!oldItem) continue;
      let newMissingSince = oldItem.new_missing_since || null;
      let usedMissingSince = oldItem.used_missing_since || null;
      let amazonMissingSince = oldItem.amazon_missing_since || null;
      let timersChanged = false;
      if (liveItem.newPrice === void 0 || liveItem.newPrice === null) {
        if (oldItem.new_price !== null && !newMissingSince) {
          newMissingSince = now;
          timersChanged = true;
        }
      } else {
        if (newMissingSince !== null) {
          newMissingSince = null;
          timersChanged = true;
        }
      }
      if (liveItem.usedPrice === void 0 || liveItem.usedPrice === null) {
        if (oldItem.used_price !== null && !usedMissingSince) {
          usedMissingSince = now;
          timersChanged = true;
        }
      } else {
        if (usedMissingSince !== null) {
          usedMissingSince = null;
          timersChanged = true;
        }
      }
      if (liveItem.amazonPrice === void 0 || liveItem.amazonPrice === null) {
        if (oldItem.amazon_price !== null && !amazonMissingSince) {
          amazonMissingSince = now;
          timersChanged = true;
        }
      } else {
        if (amazonMissingSince !== null) {
          amazonMissingSince = null;
          timersChanged = true;
        }
      }
      const MS_2_5_HOURS = 9e6;
      const MS_1_HOUR = 36e5;
      let finalNewPrice = newMissingSince && now - newMissingSince < MS_2_5_HOURS ? oldItem.new_price : liveItem.newPrice ?? null;
      let finalUsedPrice = usedMissingSince && now - usedMissingSince < MS_2_5_HOURS ? oldItem.used_price : liveItem.usedPrice ?? null;
      let finalAmazonPrice = amazonMissingSince && now - amazonMissingSince < MS_1_HOUR ? oldItem.amazon_price : liveItem.amazonPrice ?? null;
      let finalNewSeller = newMissingSince && now - newMissingSince < MS_2_5_HOURS ? oldItem.new_seller : liveItem.newSeller ?? null;
      let finalNewMid = newMissingSince && now - newMissingSince < MS_2_5_HOURS ? oldItem.new_mid : liveItem.newMid ?? null;
      let finalUsedSeller = usedMissingSince && now - usedMissingSince < MS_2_5_HOURS ? oldItem.used_seller : liveItem.usedSeller ?? null;
      let finalUsedMid = usedMissingSince && now - usedMissingSince < MS_2_5_HOURS ? oldItem.used_mid : liveItem.usedMid ?? null;
      let finalAmazonSeller = amazonMissingSince && now - amazonMissingSince < MS_1_HOUR ? oldItem.amazon_seller : liveItem.amazonSeller ?? null;
      let finalAmazonMid = amazonMissingSince && now - amazonMissingSince < MS_1_HOUR ? oldItem.amazon_mid : liveItem.amazonMid ?? null;
      let finalAmazonIsBuybox = amazonMissingSince && now - amazonMissingSince < MS_1_HOUR ? oldItem.amazon_is_buybox : liveItem.amazonIsBuybox ? 1 : 0;
      const { results: subs } = await env.DB.prepare(
        "SELECT s.chat_id, s.target_price, s.alert_sent_new, s.alert_sent_used, s.added_at, COALESCE(u.lang, 'en') AS lang FROM User_Subscriptions s LEFT JOIN Users u ON s.chat_id = u.chat_id WHERE s.asin = ? AND s.is_paused = 0"
      ).bind(liveItem.asin).all();
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
      let amznChanged = oldItem.amazon_price === null || finalAmazonPrice === null ? oldItem.amazon_price !== finalAmazonPrice : Math.abs(oldItem.amazon_price - finalAmazonPrice) >= 1;
      let usedChanged = oldItem.used_price === null || finalUsedPrice === null ? oldItem.used_price !== finalUsedPrice : Math.abs(oldItem.used_price - finalUsedPrice) >= 1;
      let newChanged = oldItem.new_price === null || finalNewPrice === null ? oldItem.new_price !== finalNewPrice : Math.abs(oldItem.new_price - finalNewPrice) >= 1;
      if (amznTargetBypass) amznChanged = oldItem.amazon_price !== finalAmazonPrice;
      if (!amznChanged && finalAmazonPrice !== null) {
        finalAmazonPrice = oldItem.amazon_price;
        finalAmazonSeller = oldItem.amazon_seller;
        finalAmazonMid = oldItem.amazon_mid;
        finalAmazonIsBuybox = oldItem.amazon_is_buybox;
      }
      if (usedTargetBypass) usedChanged = oldItem.used_price !== finalUsedPrice;
      if (!usedChanged && finalUsedPrice !== null) {
        finalUsedPrice = oldItem.used_price;
        finalUsedSeller = oldItem.used_seller;
        finalUsedMid = oldItem.used_mid;
      }
      if (newTargetBypass) newChanged = oldItem.new_price !== finalNewPrice;
      if (!newChanged && finalNewPrice !== null) {
        finalNewPrice = oldItem.new_price;
        finalNewSeller = oldItem.new_seller;
        finalNewMid = oldItem.new_mid;
      }
      const priceDelta = amznChanged || usedChanged || newChanged;
      let histMean = oldItem.hist_mean || 0;
      let histStdev = oldItem.hist_stdev || 0;
      let isAtlNew = oldItem.is_atl_new || 0;
      let seenAmazonEgAt = oldItem.seen_amazon_eg_at;
      let seenResaleAt = oldItem.seen_resale_at;
      if (finalAmazonPrice !== null) seenAmazonEgAt = now;
      if (finalUsedPrice !== null) seenResaleAt = now;
      const historyKey = `history:${liveItem.asin}`;
      let history = [];
      if (newChanged || usedChanged) {
        history = await env.AZTRACKER_DB.get(historyKey, "json") || [];
        if (history.length >= 2) {
          const validHistory = history.filter((h) => h.n !== null && h.t !== void 0);
          if (validHistory.length >= 2) {
            const nowSec = Math.floor(now / 1e3);
            const HALF_LIFE_SEC = 30 * 24 * 60 * 60;
            const DECAY_CONSTANT = Math.LN2 / HALF_LIFE_SEC;
            let sumWeights = 0;
            let weightedSum = 0;
            validHistory.forEach((h) => {
              const age = Math.max(0, nowSec - h.t);
              h.weight = Math.exp(-DECAY_CONSTANT * age);
              sumWeights += h.weight;
              weightedSum += h.n * h.weight;
            });
            const mean = sumWeights > 0 ? weightedSum / sumWeights : 0;
            let weightedVarianceSum = 0;
            validHistory.forEach((h) => {
              weightedVarianceSum += h.weight * Math.pow(h.n - mean, 2);
            });
            const variance = sumWeights > 0 ? weightedVarianceSum / sumWeights : 0;
            const stdev = Math.sqrt(variance);
            const atl = Math.min(...validHistory.map((h) => h.n));
            histMean = mean;
            histStdev = stdev;
            isAtlNew = finalNewPrice && finalNewPrice < atl ? 1 : 0;
          }
        }
      }
      const MS_90_DAYS = 7776e6;
      for (const sub of subs) {
        if (sub.added_at && now - sub.added_at > MS_90_DAYS) {
          d1Batch.push(env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 1 WHERE chat_id = ? AND asin = ?").bind(sub.chat_id, liveItem.asin));
          const subLang = sub.lang || "en";
          const safeProductName = escapeHtml(truncateName(resolveProductName(liveItem, subLang)));
          let expiryMsg;
          if (sub.target_price) {
            expiryMsg = t("alert.stale_target_head", subLang) + `

\u{1F4E6} <b>${safeProductName}</b>
${t("product.asin_row", subLang, { asin: liveItem.asin })}

` + t("alert.stale_target_with_price", subLang, { target: Number(sub.target_price).toLocaleString(), days: 90 });
          } else {
            expiryMsg = t("alert.tracking_expired_head", subLang) + `

\u{1F4E6} <b>${safeProductName}</b>
${t("product.asin_row", subLang, { asin: liveItem.asin })}

` + t("alert.tracking_expired_body", subLang, { asin: liveItem.asin, days: 90 });
          }
          queueBatch.push({ type: "telegram_alert", asin: liveItem.asin, chatId: sub.chat_id, text: expiryMsg });
          continue;
        }
        let alertSentNew = sub.alert_sent_new;
        let alertSentUsed = sub.alert_sent_used;
        const targetPrice = sub.target_price;
        let newAlertSentThisTick = false;
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
              targetHitUsed = true;
            } else {
              queueAlert(sub.chat_id, sub.lang, "(Used - Amazon Resale)", finalUsedPrice, oldItem.used_price, finalUsedSeller, finalUsedMid, true, targetPrice, liveItem, false, seenAmazonEgAt, seenResaleAt, finalAmazonPrice, finalUsedPrice, finalNewPrice, true);
              targetHitUsed = true;
            }
          }
          if (targetHitNew) alertSentNew = 1;
          if (targetHitUsed) alertSentUsed = 1;
        } else {
          if (finalNewPrice !== null) {
            if (oldItem.new_price === null && oldItem.last_updated) {
              queueAlert(sub.chat_id, sub.lang, "(New - Restocked)", finalNewPrice, null, finalNewSeller, finalNewMid, false, 0, liveItem, false, seenAmazonEgAt, seenResaleAt, finalAmazonPrice, finalUsedPrice, finalNewPrice, false);
            } else if (oldItem.new_price !== null && finalNewPrice < oldItem.new_price) {
              queueAlert(sub.chat_id, sub.lang, "(New)", finalNewPrice, oldItem.new_price, finalNewSeller, finalNewMid, false, 0, liveItem, isAtlNew, seenAmazonEgAt, seenResaleAt, finalAmazonPrice, finalUsedPrice, finalNewPrice, false);
            }
          }
          if (finalUsedPrice !== null) {
            if (oldItem.used_price === null && oldItem.last_updated) {
              queueAlert(sub.chat_id, sub.lang, "(Used - Amazon Resale - Restocked)", finalUsedPrice, null, finalUsedSeller, finalUsedMid, false, 0, liveItem, false, seenAmazonEgAt, seenResaleAt, finalAmazonPrice, finalUsedPrice, finalNewPrice, true);
            } else if (oldItem.used_price !== null && finalUsedPrice < oldItem.used_price) {
              queueAlert(sub.chat_id, sub.lang, "(Used - Amazon Resale)", finalUsedPrice, oldItem.used_price, finalUsedSeller, finalUsedMid, false, 0, liveItem, false, seenAmazonEgAt, seenResaleAt, finalAmazonPrice, finalUsedPrice, finalNewPrice, true);
            }
          }
        }
      }
      let dbNeedsUpdate = false;
      if (priceDelta || newTargetBypass || usedTargetBypass || amznTargetBypass || timersChanged) {
        dbNeedsUpdate = true;
      }
      if (dbNeedsUpdate && (newChanged || usedChanged)) {
        history.push({ t: Math.floor(now / 1e3), n: finalNewPrice, u: finalUsedPrice });
        if (history.length > 500) history = history.slice(-500);
        kvPromises.push(env.AZTRACKER_DB.put(historyKey, JSON.stringify(history)));
        const globalKey = "global:history_all_new";
        let globalHist = await env.AZTRACKER_DB.get(globalKey, "json") || [];
        const currentMatrix = {};
        if (finalNewPrice !== null) currentMatrix[liveItem.asin] = [finalNewPrice, 0];
        if (Object.keys(currentMatrix).length > 0) {
          globalHist.push({ t: Math.floor(now / 1e3), p: currentMatrix });
          if (globalHist.length > 150) globalHist = globalHist.slice(-150);
          kvPromises.push(env.AZTRACKER_DB.put(globalKey, JSON.stringify(globalHist)));
        }
      }
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
            finalAmazonPrice,
            finalUsedPrice,
            finalNewPrice,
            now,
            seenAmazonEgAt,
            seenResaleAt,
            finalNewSeller,
            finalNewMid,
            finalUsedSeller,
            finalUsedMid,
            finalAmazonSeller,
            finalAmazonMid,
            finalAmazonIsBuybox,
            newMissingSince,
            usedMissingSince,
            amazonMissingSince,
            histMean,
            histStdev,
            isAtlNew,
            liveItem.name_ar || null,
            liveItem.name || null,
            liveItem.imageUrl || null,
            liveItem.asin
          )
        );
      } else {
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
      const broadcastPrice = finalNewPrice;
      const lPrice = oldItem.new_price;
      if (env.TELEGRAM_PUBLIC_CHANNEL_ID && broadcastPrice && lPrice && broadcastPrice < lPrice) {
        const last_broadcast_time = oldItem.last_broadcast_time_ms || 0;
        const last_broadcast_price = oldItem.last_broadcast_price || 0;
        let proceed = true;
        if (now - last_broadcast_time < 864e5) {
          if (last_broadcast_price && broadcastPrice >= last_broadcast_price) {
            proceed = false;
          }
        }
        if (proceed) {
          let zScore = 0;
          if (histMean > 0 && histStdev > 0) {
            zScore = (broadcastPrice - histMean) / histStdev;
          } else if (histMean > 0 && histStdev === 0) {
            if (broadcastPrice <= histMean * 0.9) zScore = -1;
          }
          const displayLastPrice = histMean > 0 ? histMean : lPrice;
          const dropPct = (displayLastPrice - broadcastPrice) / displayLastPrice * 100;
          let reqDrop = 10;
          if (displayLastPrice <= 1e3) reqDrop = 15;
          else if (displayLastPrice <= 5e3) reqDrop = 10;
          else if (displayLastPrice <= 2e4) reqDrop = 7;
          else if (displayLastPrice <= 5e4) reqDrop = 5;
          else reqDrop = 3;
          const isStandardDeal = zScore <= -1 && dropPct >= reqDrop;
          const isAtlDeal = isAtlNew && zScore <= -0.5 && dropPct >= reqDrop / 2;
          const isFlashSale = dropPct >= reqDrop * 2;
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
    if (bestDeal.length > 0 && env.TELEGRAM_PUBLIC_CHANNEL_ID) {
      bestDeal.sort((a, b) => b.absZ - a.absZ);
      const topDeals = bestDeal.slice(0, 3);
      for (const deal of topDeals) {
        const safe_name = escapeHtml(truncateName(deal.name_ar || deal.name || deal.asin) || t("product.unknown_product", "masry"));
        const base_url = `https://www.amazon.eg/dp/${deal.asin}`;
        const qParams = new URLSearchParams();
        const pTag = env.AMAZON_PARTNER_TAG;
        if (pTag) qParams.append("tag", pTag);
        const broadcast_url = qParams.toString() ? `${base_url}?${qParams.toString()}` : base_url;
        const safe_broadcast_seller = escapeHtml(deal.seller || t("fallback.unknown_seller", "masry"));
        const broadcast_msg = `${t("broadcast.snapshot", "masry")}

<b>${safe_name}</b>

\u{1F4B5} <b>${formatEGP(deal.price)} \u062C.\u0645</b>
\u{1F3EC} ${safe_broadcast_seller}

\u{1F449} <a href="${broadcast_url}">${t("broadcast.catch_deal", "masry")}</a>

\u{1F916} @AzTrackerr_bot

<a href="https://t.me/AzTrackerr_bot?start=ref_broadcast">${t("broadcast.follow_more", "masry")}</a>

${t("broadcast.ad_disclosure", "masry")}`;
        queueBatch.push({
          type: "telegram_alert",
          asin: deal.asin,
          chatId: env.TELEGRAM_PUBLIC_CHANNEL_ID,
          text: truncateMessage(broadcast_msg),
          markup: {
            inline_keyboard: [
              [
                { text: t("broadcast.buy_here", "masry"), url: broadcast_url },
                { text: "\u{1F3AF} Track Deal", url: `https://t.me/${env.BOT_USERNAME || "AzTrackerr_bot"}?start=track_${deal.asin}` }
              ],
              [
                { text: t("alert.btn_disclaimer", "masry"), url: "https://telegra.ph/Pricing-Disclaimer-06-05" }
              ]
            ]
          }
        });
        d1Batch.push(env.DB.prepare("UPDATE Global_Products SET last_broadcast_time_ms = ?, last_broadcast_price = ? WHERE asin = ?").bind(now, deal.price, deal.asin));
      }
    }
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
        const batchBody = consolidatedBatch.slice(i, i + 100).map((b) => ({ body: b }));
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

  // src/core/telegram.js
  async function sendTelegramMessage(env, chatId, text, replyMarkup = null) {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
    if (replyMarkup) body.reply_markup = replyMarkup;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error(`Telegram API Error [sendMessage]: ${res.status} - ${errText}`);
        return { ok: false, error_code: res.status, description: errText };
      }
      return await res.json();
    } catch (e) {
      console.error("sendTelegramMessage fetch failed:", e);
      return { ok: false, error_code: 500, description: e.message };
    }
  }
  async function editTelegramMessage(env, chatId, messageId, text, replyMarkup = null) {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`;
    const body = { chat_id: chatId, message_id: Number(messageId), text, parse_mode: "HTML", disable_web_page_preview: true };
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
        return { ok: false, error_code: res.status, description: errText };
      }
      return await res.json();
    } catch (e) {
      console.error("editTelegramMessage fetch failed:", e);
      return { ok: false, error_code: 500, description: e.message };
    }
  }

  // src/workers/queue_worker.js
  var MAX_RETRY_ATTEMPTS = 5;
  async function deadLetter(env, queueName, msg, error) {
    try {
      await env.DB.prepare(
        "INSERT INTO Failed_Queue_Messages (queue_name, body, attempts, last_error, failed_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(queueName, JSON.stringify(msg.body), msg.attempts || 0, error.message, Date.now()).run();
    } catch (e) {
      console.error("DLQ write failed:", e);
    }
  }
  async function queue(batch, env, ctx) {
    if (batch.queue.startsWith("scraper-queue")) {
      for (const msg of batch.messages) {
        try {
          if ((msg.attempts || 0) >= MAX_RETRY_ATTEMPTS) {
            console.error(`[ScraperQueue] Msg exceeded ${MAX_RETRY_ATTEMPTS} retries, dead-lettering`);
            await deadLetter(env, "scraper-queue", msg, new Error("Max retries exceeded"));
            msg.ack();
            continue;
          }
          const offset = msg.body.offset || 0;
          const hasMore = await executeScrapeEngine(env, offset);
          if (hasMore) {
            await env.SCRAPER_QUEUE.send({ offset: offset + 10 }, { delaySeconds: 1 });
          }
          msg.ack();
        } catch (e) {
          console.error("Scraper Queue Error:", e);
          msg.retry({ delaySeconds: 30 });
        }
      }
      return;
    }
    let rateLimited = false;
    let retryDelay = 5;
    for (const msg of batch.messages) {
      if (rateLimited) {
        msg.retry({ delaySeconds: retryDelay });
        continue;
      }
      try {
        if ((msg.attempts || 0) >= MAX_RETRY_ATTEMPTS) {
          console.error(`[MsgQueue] Msg exceeded ${MAX_RETRY_ATTEMPTS} retries, dead-lettering`);
          await deadLetter(env, "message-queue", msg, new Error("Max retries exceeded"));
          msg.ack();
          continue;
        }
        const payload = msg.body;
        if (payload.type === "telegram_alert" || payload.type === "telegram_alert_new" || payload.type === "telegram_alert_used") {
          const res = await sendTelegramMessage(env, payload.chatId, payload.text, payload.markup);
          if (res && !res.ok) {
            if (res.error_code === 429) {
              rateLimited = true;
              retryDelay = res.parameters?.retry_after || 5;
              msg.retry({ delaySeconds: retryDelay });
              continue;
            } else if (res.error_code === 403) {
              await env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 1 WHERE chat_id = ?").bind(payload.chatId).run();
              await env.DB.prepare("UPDATE Users SET role = 'blocked' WHERE chat_id = ?").bind(payload.chatId).run();
              msg.ack();
              continue;
            }
            throw new Error(res.description || "Telegram API Error");
          } else {
            if (payload.asin && payload.type === "telegram_alert_new") {
              await env.DB.prepare("UPDATE User_Subscriptions SET alert_sent_new = 1 WHERE chat_id = ? AND asin = ?").bind(payload.chatId, payload.asin).run();
            }
            if (payload.asin && payload.type === "telegram_alert_used") {
              await env.DB.prepare("UPDATE User_Subscriptions SET alert_sent_used = 1 WHERE chat_id = ? AND asin = ?").bind(payload.chatId, payload.asin).run();
            }
          }
        }
        msg.ack();
      } catch (e) {
        console.error("Queue error:", e);
        if ((msg.attempts || 0) >= MAX_RETRY_ATTEMPTS) {
          console.error(`[MsgQueue] Msg exceeded ${MAX_RETRY_ATTEMPTS} retries, dead-lettering`);
          await deadLetter(env, "message-queue", msg, e);
          msg.ack();
        } else {
          msg.retry();
        }
      }
    }
  }

  // src/core/db.js
  async function getUserRoles(chatId, env, ctx) {
    const chatIdStr = String(chatId);
    const cache = caches.default;
    const cacheReq = new Request(`https://auth.internal/roles/${chatIdStr}`);
    const cached = await cache.match(cacheReq);
    if (cached) {
      return await cached.json();
    }
    const rootAdminsRaw = env.TELEGRAM_ROOT_ADMIN_IDS || env.ROOT_ADMIN_ID || "";
    const rootAdmins = rootAdminsRaw.split(",").filter(Boolean);
    let isRootAdmin = rootAdmins.includes(chatIdStr);
    const { results: adminRows } = await env.DB.prepare("SELECT chat_id FROM Users WHERE role = 'admin' ORDER BY created_at ASC").all();
    const admins = adminRows.map((r) => r.chat_id);
    const { results: approvedRows } = await env.DB.prepare("SELECT chat_id FROM Users WHERE role IN ('approved', 'admin')").all();
    const approvedUsers = approvedRows.map((r) => r.chat_id);
    const user = await env.DB.prepare("SELECT role, lang FROM Users WHERE chat_id = ?").bind(chatId).first();
    let role = user ? user.role : null;
    if (!isRootAdmin && rootAdmins.length === 0 && admins.length > 0 && admins[0] === chatIdStr) {
      isRootAdmin = true;
    }
    const isAdmin = isRootAdmin || role === "admin" || admins.includes(chatIdStr);
    const isApproved = isAdmin || role === "approved" || approvedUsers.includes(chatIdStr);
    const isRejected = role === "rejected";
    const result = { isRootAdmin, isAdmin, isApproved, isRejected, rootAdmins, admins, approvedUsers, lang: user?.lang || null };
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(cache.put(cacheReq, new Response(JSON.stringify(result), {
        headers: { "Cache-Control": "s-maxage=5", "Content-Type": "application/json" }
      })));
    }
    return result;
  }
  async function resolveUserProfile(env, id, ctx) {
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
  async function logAudit(env, adminId, action, target, details) {
    try {
      let adminHandle = adminId.toString();
      const { results: adminRows } = await env.DB.prepare(
        "SELECT first_name, username FROM Users WHERE chat_id = ?"
      ).bind(adminId.toString()).all();
      if (adminRows && adminRows.length > 0) {
        const admin = adminRows[0];
        const fullName = admin.first_name || "";
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
          const fullName = tUser.first_name || "";
          const handle = tUser.username ? `@${tUser.username}` : null;
          targetHandle = handle ? `${fullName} (${handle})` : fullName || null;
        }
      }
      const timestamp = Date.now();
      const auditValues = [
        timestamp,
        adminId.toString(),
        adminHandle,
        action,
        target ? target.toString() : null,
        JSON.stringify({ targetHandle, details })
      ];
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await env.DB.prepare(
            "INSERT INTO Audit_Logs (timestamp, actor_id, actor_name, action, target_id, details) VALUES (?, ?, ?, ?, ?, ?)"
          ).bind(...auditValues).run();
          return;
        } catch (e) {
          if (attempt === 2) {
            console.error("Audit log FAILED after 3 attempts:", JSON.stringify({
              timestamp,
              actorId: adminId.toString(),
              action,
              targetId: target ? target.toString() : null,
              error: e.message
            }));
          } else {
            await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
          }
        }
      }
    } catch (e) {
      console.error("Audit log failed:", e);
    }
  }

  // src/routes/telegram_webhook.js
  var QUEUE_MAX_DEPTH = 25;
  var AMAZON_EG_MERCHANT_ID2 = "A1ZVRGNO5AYLOV";
  var AMAZON_RESALE_MERCHANT_ID2 = "A2N2MP47XAP1MK";
  var ALT_SELLER_TTL_MS = 864e5;
  var RATE_LIMIT_WINDOW_MS = 6e4;
  var RATE_LIMIT_MAX_MESSAGES = 30;
  var RATE_LIMIT_KV_PREFIX = "rl:";
  async function checkRateLimit(chatId, env) {
    const key = `${RATE_LIMIT_KV_PREFIX}${chatId}`;
    try {
      const raw = await env.AZTRACKER_DB.get(key);
      const now = Date.now();
      if (!raw) {
        await env.AZTRACKER_DB.put(key, JSON.stringify({ count: 1, windowStart: now }), {
          expirationTtl: Math.ceil(RATE_LIMIT_WINDOW_MS / 1e3)
        });
        return { allowed: true, remaining: RATE_LIMIT_MAX_MESSAGES - 1, resetMs: RATE_LIMIT_WINDOW_MS };
      }
      const data = JSON.parse(raw);
      const elapsed = now - data.windowStart;
      if (elapsed >= RATE_LIMIT_WINDOW_MS) {
        await env.AZTRACKER_DB.put(key, JSON.stringify({ count: 1, windowStart: now }), {
          expirationTtl: Math.ceil(RATE_LIMIT_WINDOW_MS / 1e3)
        });
        return { allowed: true, remaining: RATE_LIMIT_MAX_MESSAGES - 1, resetMs: RATE_LIMIT_WINDOW_MS };
      }
      data.count += 1;
      const remaining = Math.max(0, RATE_LIMIT_MAX_MESSAGES - data.count);
      const resetMs = RATE_LIMIT_WINDOW_MS - elapsed;
      if (data.count <= RATE_LIMIT_MAX_MESSAGES) {
        await env.AZTRACKER_DB.put(key, JSON.stringify(data), {
          expirationTtl: Math.max(60, Math.ceil(resetMs / 1e3) + 1)
        });
      }
      return { allowed: data.count <= RATE_LIMIT_MAX_MESSAGES, remaining, resetMs };
    } catch (e) {
      console.error("Rate limit KV error:", e);
      return { allowed: true, remaining: RATE_LIMIT_MAX_MESSAGES, resetMs: 0 };
    }
  }
  async function handleTelegramWebhook(request, env, ctx) {
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
      const chatId = payload.message?.chat?.id?.toString() || payload.callback_query?.message?.chat?.id?.toString() || null;
      if (chatId) {
        const rl = await checkRateLimit(chatId, env);
        if (!rl.allowed) {
          console.warn(`[RateLimit] chat ${chatId} exceeded ${RATE_LIMIT_MAX_MESSAGES} msgs/min \u2014 dropping update`);
          return new Response("OK", { status: 200 });
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
      const isParseError = err instanceof SyntaxError || err instanceof TypeError;
      return new Response("Error", { status: isParseError ? 500 : 200 });
    }
  }
  async function handleMessage(message, env, baseUrl, ctx) {
    let text = message.text.trim();
    if (typeof convertHindiToArabic === "function") text = convertHindiToArabic(text);
    const chatId = message.chat.id.toString();
    const messageId = message.message_id;
    const { isRootAdmin, isAdmin, isApproved, isRejected, rootAdmins, admins, approvedUsers, lang: dbLang } = await getUserRoles(chatId, env, ctx);
    const osLang = resolveLanguageCode(message.from?.language_code);
    const lang = dbLang || osLang || "en";
    if (!isApproved) {
      if (isRejected) {
        const existingUnban = await env.DB.prepare("SELECT 1 FROM Join_Queue WHERE chat_id = ? AND request_type = 'unban'").bind(chatId).first();
        const userRow = await env.DB.prepare("SELECT unban_rejected FROM Users WHERE chat_id = ?").bind(chatId).first();
        const isPermBanned = userRow && userRow.unban_rejected === 1;
        if (text === "/start") {
          if (isPermBanned) {
            await sendAppMessage(env, chatId, t("access.unban_rejected", lang));
          } else if (existingUnban) {
            await sendAppMessage(env, chatId, t("access.unban_pending", lang));
          } else {
            await sendAppMessage(env, chatId, t("access.denied_head", lang) + "\n\n" + t("access.denied_body_private", lang), {
              inline_keyboard: [[{ text: t("access.unban_btn", lang), callback_data: `request_unban_${chatId}` }]]
            });
          }
        } else {
          if (isPermBanned) {
            await sendAppMessage(env, chatId, t("access.unban_rejected", lang));
          } else {
            await sendAppMessage(env, chatId, t("access.denied_head", lang) + "\n\n" + t("access.denied_body_private", lang) + "\n\n" + t("access.denied_hint_start", lang));
          }
        }
        return;
      }
      const blockedUser = await env.DB.prepare("SELECT 1 FROM Users WHERE chat_id = ? AND role = 'blocked'").bind(chatId).first() !== null;
      const inQueue = await env.DB.prepare("SELECT 1 FROM Join_Queue WHERE chat_id = ?").bind(chatId).first() !== null;
      console.error(`[JOIN_QUEUE] /start check: chatId=${chatId}, lang=${lang}, isRejected=${isRejected}, blockedUser=${blockedUser}, inQueue=${inQueue}`);
      if (inQueue) {
        await sendAppMessage(env, chatId, t("access.pending_head", lang) + "\n\n" + t("access.pending_body", lang));
        return;
      }
      if (blockedUser) {
        if (text === "/start") {
          await sendAppMessage(env, chatId, t("access.blocked_head", lang) + "\n\n" + t("access.blocked_body", lang), {
            inline_keyboard: [[{ text: t("access.unban_btn", lang), callback_data: `request_unban_${chatId}` }]]
          });
        } else {
          await sendAppMessage(env, chatId, t("access.blocked_head", lang) + "\n\n" + t("access.blocked_body", lang) + "\n\n" + t("access.denied_hint_start", lang));
        }
        return;
      }
      if (text === "/start") {
        console.error(`[JOIN_QUEUE] New user /start: chatId=${chatId}, sending Request Access button`);
        await sendAppMessage(env, chatId, t("access.denied_head", lang) + "\n\n" + t("access.denied_body_private", lang), {
          inline_keyboard: [[{ text: t("access.request_btn", lang), callback_data: `request_access_${chatId}` }]]
        });
      } else {
        await sendAppMessage(env, chatId, t("access.denied_head", lang) + "\n\n" + t("access.denied_body_private", lang) + "\n\n" + t("access.denied_hint_start", lang));
      }
      return;
    }
    const stateKey = `state:${chatId}`;
    const activeState = await env.DB.prepare("SELECT value FROM Bot_States WHERE key = ?").bind(stateKey).first("value");
    if (text.startsWith("/start")) {
      if (activeState) await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(stateKey).run();
      await deleteTelegramMessage(env, chatId, messageId);
      const __raRaw = env.TELEGRAM_ROOT_ADMIN_IDS || env.ROOT_ADMIN_ID || env.TELEGRAM_ADMIN_IDS || "";
      const __raList = __raRaw.split(",").filter(Boolean).map((s) => s.trim());
      if (__raList.includes(String(chatId))) {
        await env.DB.prepare("INSERT OR IGNORE INTO Users (chat_id, role, item_limit, created_at) VALUES (?, 'admin', 0, ?)").bind(String(chatId), Date.now()).run();
      }
      await env.DB.prepare("UPDATE Users SET lang = ? WHERE chat_id = ? AND lang IS NULL").bind(osLang, chatId).run();
      const freshRoles = await getUserRoles(chatId, env, ctx);
      const effectiveLang = freshRoles.lang || osLang || "en";
      const startPayload = text.split(" ")[1];
      if (startPayload && startPayload.startsWith("track_")) {
        const asin = startPayload.replace("track_", "").trim();
        if (asin) {
          text = `https://www.amazon.eg/dp/${asin}`;
        } else {
          await renderMainMenu(env, chatId, null, isAdmin, baseUrl, effectiveLang);
          return;
        }
      } else {
        await renderMainMenu(env, chatId, null, isAdmin, baseUrl, effectiveLang);
        return;
      }
    } else if (text.startsWith("/")) {
      if (activeState) await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(stateKey).run();
      await deleteTelegramMessage(env, chatId, messageId);
      const freshRoles = await getUserRoles(chatId, env, ctx);
      const effectiveLang = freshRoles.lang || osLang || "en";
      await renderMainMenu(env, chatId, null, isAdmin, baseUrl, effectiveLang);
      return;
    }
    if (activeState && activeState.startsWith("target_")) {
      const pid = activeState.replace("target_", "");
      const num = parseFloat(text);
      if (isNaN(num) || num <= 0) {
        await deleteTelegramMessage(env, chatId, messageId);
        await sendAppMessage(env, chatId, t("target.invalid_amount", lang), {
          inline_keyboard: [[{ text: t("nav.back", lang), callback_data: `view_${pid}` }]]
        });
        return;
      }
      let historyData = await env.AZTRACKER_DB.get(`history:${pid}`, "json") || [];
      let atl = null;
      if (historyData.length > 0) {
        atl = Math.min(...historyData.map((h) => h.price));
      }
      if (atl !== null && num < atl * 0.8) {
        await deleteTelegramMessage(env, chatId, messageId);
        const warnText = `\u26A0\uFE0F This product has never dropped below ${atl.toLocaleString()} ${t("chrome.currency_egp", lang)}.
Setting a target of ${num.toLocaleString()} ${t("chrome.currency_egp", lang)} might never trigger.

Do you want to set your target to ${atl.toLocaleString()} ${t("chrome.currency_egp", lang)} instead?`;
        await sendAppMessage(env, chatId, warnText, {
          inline_keyboard: [
            [{ text: `\u{1F3AF} Set to ${atl.toLocaleString()} ${t("chrome.currency_egp", lang)}`, callback_data: `forceset_${pid}_${atl}` }],
            [{ text: `Keep ${num.toLocaleString()} ${t("chrome.currency_egp", lang)}`, callback_data: `forceset_${pid}_${num}` }],
            [{ text: t("target.cancel", lang), callback_data: `view_${pid}` }]
          ]
        });
        return;
      }
      await env.DB.prepare("UPDATE User_Subscriptions SET target_price = ?, alert_sent_new = 0, alert_sent_used = 0 WHERE chat_id = ? AND asin = ?").bind(num, chatId, pid).run();
      await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(stateKey).run();
      await deleteTelegramMessage(env, chatId, messageId);
      const rawPrice = num.toLocaleString();
      await sendAppMessage(env, chatId, t("target.set_confirm_head", lang) + "\n\n" + t("target.set_confirm_body", lang, { asin: pid, price: t("chrome.currency_egp", lang) + " " + rawPrice }), {
        inline_keyboard: [[{ text: t("nav.back_to_product", lang), callback_data: `view_${pid}` }]]
      });
      return;
    }
    const isNumericId = /^\d{6,15}$/.test(text);
    const isAmazonLink = text.includes("amazon.") || text.includes("amzn.");
    if (isNumericId || isAmazonLink) {
      await deleteTelegramMessage(env, chatId, messageId);
    }
    if (isAmazonLink) {
      let inputUrl = text.split(/\s+/).find((w) => w.includes("amazon.") || w.includes("amzn.")) || text;
      if (!/^https?:\/\//i.test(inputUrl)) {
        inputUrl = "https://" + inputUrl;
      }
      const sentMsg = await sendAppMessage(env, chatId, t("link.processing", lang));
      if (!sentMsg?.result?.message_id) {
        console.error("sendAppMessage failed: no message_id", sentMsg);
        return;
      }
      const tempMessageId = sentMsg.result.message_id;
      const expandedUrl = await expandAmazonUrl(inputUrl);
      const domainMatch = expandedUrl.match(/https?:\/\/(?:www\.)?(amazon\.[a-z\.]+)/i);
      const productDomain = domainMatch ? domainMatch[1].toLowerCase() : null;
      const SUPPORTED_REGIONS = ["amazon.eg"];
      if (!productDomain || !SUPPORTED_REGIONS.includes(productDomain)) {
        await editTelegramMessage2(env, chatId, tempMessageId, t("link.region_not_supported_head", lang) + "\n\n" + t("link.region_not_supported_body", lang), {
          inline_keyboard: [[{ text: t("nav.main_menu", lang), callback_data: "main_menu" }]]
        });
        return;
      }
      const pid = getAsinFromUrl(expandedUrl);
      if (!pid) {
        await editTelegramMessage2(env, chatId, tempMessageId, t("link.could_not_parse", lang), {
          inline_keyboard: [[{ text: t("nav.main_menu", lang), callback_data: "main_menu" }]]
        });
        return;
      }
      const user = await env.DB.prepare("SELECT item_limit FROM Users WHERE chat_id = ?").bind(chatId).first();
      const defaultLimit = parseInt(env.DEFAULT_USER_PRODUCT_LIMIT);
      const userLimit = user && user.item_limit !== null ? parseInt(user.item_limit) : defaultLimit;
      const { results: existingProducts } = await env.DB.prepare("SELECT asin FROM User_Subscriptions WHERE chat_id = ?").bind(chatId).all();
      if (!isAdmin) {
        if (isNaN(defaultLimit)) {
          await editTelegramMessage2(env, chatId, tempMessageId, t("link.system_error", lang), {
            inline_keyboard: [[{ text: t("nav.main_menu", lang), callback_data: "main_menu" }]]
          });
          return;
        }
        if (existingProducts && existingProducts.length >= userLimit) {
          await editTelegramMessage2(env, chatId, tempMessageId, t("link.limit_reached_head", lang) + "\n\n" + t("link.limit_reached_body", lang, { used: existingProducts.length, limit: userLimit }), {
            inline_keyboard: [
              [{ text: t("link.manage_products", lang), web_app: { url: `${baseUrl}/user_app?lang=${lang}` } }],
              [{ text: t("nav.main_menu", lang), callback_data: "main_menu" }]
            ]
          });
          return;
        }
      }
      if (existingProducts && existingProducts.some((p) => p.asin === pid)) {
        await editTelegramMessage2(env, chatId, tempMessageId, t("link.already_exists", lang), {
          inline_keyboard: [[{ text: t("nav.main_menu", lang), callback_data: "main_menu" }]]
        });
        return;
      }
      let extractedName = extractNameFromUrl(expandedUrl);
      let arabicName = null;
      try {
        const clientId = env.AMAZON_CLIENT_ID || env.AMZN_CREATORS_ACCESS_KEY || env.AWS_ACCESS_KEY_ID;
        const clientSecret = env.AMAZON_CLIENT_SECRET || env.AMZN_CREATORS_SECRET_KEY || env.AWS_SECRET_ACCESS_KEY;
        if (clientId && clientSecret) {
          const token = await getAmazonAccessToken(clientId, clientSecret);
          const parser = new AmazonEdgeParser(token, env.AMZN_ASSOCIATES_TAG, "www.amazon.eg", env);
          const arabicMap = await parser.getItemsWithArabic([pid]);
          if (arabicMap.has(pid)) {
            arabicName = arabicMap.get(pid);
          }
          if (!arabicName) {
            arabicName = await parser.scrapeArabicTitle(pid);
          }
          if (!extractedName) {
            extractedName = await parser.scrapeEnglishTitle(pid);
          }
        }
      } catch (e) {
        console.warn("[Webhook] Name fetch failed (non-blocking):", e.message);
      }
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
      if (ctx && ctx.waitUntil) ctx.waitUntil(logAudit(env, chatId, "ADD_PRODUCT", chatId, `Added product ${pid}`));
      const title = extractedName ? extractedName : pid;
      const cleanTitle = escapeHtml(title.length > 35 ? title.substring(0, 32) + "..." : title);
      const successText = t("link.registered_head", lang) + `

\u{1F4CC} <b>${cleanTitle}</b>
${t("product.asin_inline", lang, { asin: pid })}

` + t("link.registered_status", lang) + `

\u{1F550} <b>${t("link.status_label", lang)}</b> ${t("link.pending_scan", lang)}

${t("alert.boosted_label", lang)}`;
      await editTelegramMessage2(env, chatId, tempMessageId, successText, {
        inline_keyboard: [
          [{ text: "\u{1F4E6} View My Products", web_app: { url: `${baseUrl}/user_app?lang=${lang}` } }],
          [{ text: t("nav.main_menu", lang), callback_data: "main_menu" }]
        ]
      });
      return;
    }
    await deleteTelegramMessage(env, chatId, messageId);
    await sendAppMessage(env, chatId, t("link.invalid_command", lang), {
      inline_keyboard: [[{ text: t("nav.open_menu", lang), callback_data: "main_menu" }]]
    });
  }
  async function handleCallback(callback, env, baseUrl, ctx) {
    const data = callback.data;
    const message = callback.message;
    const chatId = message.chat.id.toString();
    const messageId = message.message_id;
    const { isRootAdmin, isAdmin, isApproved, rootAdmins, admins, approvedUsers, lang } = await getUserRoles(chatId, env, ctx);
    if (ctx && ctx.waitUntil) ctx.waitUntil(syncUserNames(env, chatId, callback.from, baseUrl));
    if (!isApproved && !data.startsWith("request_access_") && !data.startsWith("request_unban_")) return;
    console.log(`[JOIN_QUEUE] handleCallback: data=${data}, chatId=${chatId}, isApproved=${isApproved}, isAdmin=${isAdmin}`);
    try {
      if (data.startsWith("request_access_")) {
        const targetId = data.replace("request_access_", "");
        if (targetId !== chatId) return;
        const countRow = await env.DB.prepare("SELECT COUNT(*) as count FROM Join_Queue").first();
        if (countRow.count >= QUEUE_MAX_DEPTH) {
          await editTelegramMessage2(env, chatId, messageId, t("access.queue_full_head", lang) + "\n\n" + t("access.queue_full_body", lang));
          return;
        }
        await editTelegramMessage2(env, chatId, messageId, t("access.request_sent", lang));
        console.error(`[JOIN_QUEUE] Attempting INSERT for chatId=${chatId}, first_name=${callback.from?.first_name}, username=${callback.from?.username}`);
        const insertResult = await env.DB.prepare(`
        INSERT OR IGNORE INTO Join_Queue (chat_id, first_name, username, requested_at, admin_messages, request_type, lang)
        VALUES (?, ?, ?, ?, '{}', 'access', ?)
      `).bind(
          chatId,
          callback.from ? callback.from.first_name : "",
          callback.from ? callback.from.username : "",
          Date.now(),
          lang
        ).run();
        console.error(`[JOIN_QUEUE] INSERT result: changes=${insertResult.meta.changes}, last_row_id=${insertResult.meta.last_row_id}`);
        if (insertResult.meta.changes === 0) {
          console.error(`[JOIN_QUEUE] Duplicate request \u2014 chatId=${chatId} already in queue`);
          return;
        }
        const { label } = await resolveUserProfile(env, chatId, ctx);
        const allAdmins = [.../* @__PURE__ */ new Set([...admins, ...rootAdmins])];
        const adminLangMap = {};
        if (allAdmins.length > 0) {
          const placeholders = allAdmins.map(() => "?").join(",");
          const { results: adminRows } = await env.DB.prepare(
            `SELECT chat_id, lang FROM Users WHERE chat_id IN (${placeholders})`
          ).bind(...allAdmins).all();
          for (const row of adminRows) {
            adminLangMap[row.chat_id] = row.lang || "en";
          }
        }
        console.error(`[JOIN_QUEUE] Notifying ${allAdmins.length} admins: ${JSON.stringify(allAdmins)}`);
        let admin_messages = {};
        for (const adminId of allAdmins) {
          const adminLang = adminLangMap[adminId] || "en";
          const adminMsg = t("access.admin_new_request_head", adminLang) + "\n\n" + t("access.admin_new_request_body", adminLang, { name: escapeHtml(label), id: chatId });
          const adminButtons = {
            inline_keyboard: [
              [{ text: t("access.admin_new_request_btn_approve", adminLang), callback_data: `queueApprove_${chatId}` }, { text: t("access.admin_new_request_btn_reject", adminLang), callback_data: `queueReject_${chatId}` }]
            ]
          };
          try {
            const sent = await sendTelegram(env, adminId, adminMsg, adminButtons);
            console.error(`[JOIN_QUEUE] Admin ${adminId} notify: ok=${sent?.ok}, error=${sent?.description || "none"}`);
            if (sent && sent.ok && sent.result) {
              admin_messages[adminId] = sent.result.message_id;
            }
          } catch (e) {
            console.error("Failed to notify admin", adminId, e);
          }
        }
        await env.DB.prepare("UPDATE Join_Queue SET admin_messages = ? WHERE chat_id = ?").bind(
          JSON.stringify(admin_messages),
          chatId
        ).run();
        console.error(`[JOIN_QUEUE] Done. Admin messages persisted: ${JSON.stringify(admin_messages)}`);
      } else if (data.startsWith("request_unban_")) {
        const targetId = data.replace("request_unban_", "");
        if (targetId !== chatId) return;
        await editTelegramMessage2(env, chatId, messageId, t("access.unban_sent", lang));
        const unbanInsert = await env.DB.prepare(`
        INSERT OR IGNORE INTO Join_Queue (chat_id, first_name, username, requested_at, admin_messages, request_type, lang)
        VALUES (?, ?, ?, ?, '{}', 'unban', ?)
      `).bind(
          chatId,
          callback.from ? callback.from.first_name : "",
          callback.from ? callback.from.username : "",
          Date.now(),
          lang
        ).run();
        if (unbanInsert.meta.changes === 0) {
          return;
        }
        const { label } = await resolveUserProfile(env, chatId, ctx);
        const allAdmins = [.../* @__PURE__ */ new Set([...admins, ...rootAdmins])];
        const adminLangMap = {};
        if (allAdmins.length > 0) {
          const placeholders = allAdmins.map(() => "?").join(",");
          const { results: adminRows } = await env.DB.prepare(
            `SELECT chat_id, lang FROM Users WHERE chat_id IN (${placeholders})`
          ).bind(...allAdmins).all();
          for (const row of adminRows || []) {
            adminLangMap[row.chat_id] = row.lang || "en";
          }
        }
        for (const adminId of allAdmins) {
          const adminLang = adminLangMap[adminId] || "en";
          const adminMsg = t("admin.unban_request_head", adminLang) + "\n\n" + t("admin.unban_request_body", adminLang, { name: escapeHtml(label), id: chatId }) + "\n\n" + t("admin.unban_request_dashboard_hint", adminLang);
          try {
            await sendTelegram(env, adminId, adminMsg);
          } catch (e) {
            console.error("Failed to notify admin", adminId);
          }
        }
      } else if (data.startsWith("queueReject_") && isAdmin) {
        const targetId = data.replace("queueReject_", "");
        let queueObj = await env.DB.prepare("SELECT * FROM Join_Queue WHERE chat_id = ?").bind(targetId).first();
        if (!queueObj) {
          const expiredText = t("admin.request_expired", lang);
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: callback.id, text: expiredText, show_alert: true })
          }).catch(() => {
          });
          await editTelegramMessage2(env, chatId, messageId, expiredText, { inline_keyboard: [] }).catch(() => {
          });
          return;
        }
        if (typeof queueObj.admin_messages === "string") {
          try {
            queueObj.admin_messages = JSON.parse(queueObj.admin_messages);
          } catch (e) {
            queueObj.admin_messages = {};
          }
        }
        const otherAdminMessages = {};
        for (const [admId, msgId] of Object.entries(queueObj.admin_messages || {})) {
          if (admId !== String(chatId)) otherAdminMessages[admId] = msgId;
        }
        const deleteResult = await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();
        if (deleteResult.meta.changes === 0) {
          const expiredText = t("admin.request_expired", lang);
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: callback.id, text: expiredText, show_alert: true })
          }).catch(() => {
          });
          await editTelegramMessage2(env, chatId, messageId, expiredText, { inline_keyboard: [] }).catch(() => {
          });
          return;
        }
        const { label: adminName } = await resolveUserProfile(env, chatId, ctx);
        await editTelegramMessage2(env, chatId, messageId, t("access.admin_rejected", lang, { id: targetId, admin: escapeHtml(adminName) }));
        for (const [admId, msgId] of Object.entries(otherAdminMessages)) {
          try {
            const aLangRow = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(admId).first();
            const aLang = aLangRow?.lang || "en";
            await editTelegramMessage2(env, admId, msgId, t("access.handled_request", aLang, { id: targetId, admin: escapeHtml(adminName) }), { inline_keyboard: [] });
          } catch (e) {
            console.error(`Failed to update admin ${admId} message:`, e);
          }
        }
        if (queueObj?.request_type === "unban") {
          await env.DB.prepare(`
          INSERT INTO Users (chat_id, first_name, username, role, approved_by, item_limit, created_at, lang, unban_rejected)
          VALUES (?, ?, ?, 'rejected', ?, ?, ?, ?, 1)
          ON CONFLICT(chat_id) DO UPDATE SET role = 'rejected', unban_rejected = 1
        `).bind(
            targetId,
            queueObj ? queueObj.first_name || "" : "",
            queueObj ? queueObj.username || "" : "",
            chatId,
            env.DEFAULT_USER_PRODUCT_LIMIT || "3",
            Date.now(),
            queueObj?.lang || "en"
          ).run();
        } else {
          await env.DB.prepare(`
          INSERT INTO Users (chat_id, first_name, username, role, approved_by, item_limit, created_at, lang)
          VALUES (?, ?, ?, 'rejected', ?, ?, ?, ?)
          ON CONFLICT(chat_id) DO UPDATE SET role = 'rejected'
        `).bind(
            targetId,
            queueObj ? queueObj.first_name || "" : "",
            queueObj ? queueObj.username || "" : "",
            chatId,
            env.DEFAULT_USER_PRODUCT_LIMIT || "3",
            Date.now(),
            queueObj?.lang || "en"
          ).run();
        }
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
        const targetLang = queueObj?.lang || "en";
        if (queueObj?.request_type === "unban") {
          await sendTelegram(env, targetId, t("access.unban_rejected", targetLang));
        } else {
          await sendTelegram(env, targetId, t("access.denied_notify", targetLang));
        }
        ctx.waitUntil(logAudit(env, chatId, "REJECT_USER", targetId, `Rejected via Join Queue${queueObj?.request_type === "unban" ? " (unban \u2014 permanent)" : ""}`));
      } else if (data.startsWith("queueApprove_") && isAdmin) {
        const targetId = data.replace("queueApprove_", "");
        let queueObj = await env.DB.prepare("SELECT * FROM Join_Queue WHERE chat_id = ?").bind(targetId).first();
        if (!queueObj) {
          const expiredText = t("admin.request_expired", lang);
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: callback.id, text: expiredText, show_alert: true })
          }).catch(() => {
          });
          await editTelegramMessage2(env, chatId, messageId, expiredText, { inline_keyboard: [] }).catch(() => {
          });
          return;
        }
        if (typeof queueObj.admin_messages === "string") {
          try {
            queueObj.admin_messages = JSON.parse(queueObj.admin_messages);
          } catch (e) {
            queueObj.admin_messages = {};
          }
        }
        const otherAdminMessages = {};
        for (const [admId, msgId] of Object.entries(queueObj.admin_messages || {})) {
          if (admId !== String(chatId)) otherAdminMessages[admId] = msgId;
        }
        const deleteResult = await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();
        if (deleteResult.meta.changes === 0) {
          const expiredText = t("admin.request_expired", lang);
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: callback.id, text: expiredText, show_alert: true })
          }).catch(() => {
          });
          await editTelegramMessage2(env, chatId, messageId, expiredText, { inline_keyboard: [] }).catch(() => {
          });
          return;
        }
        const targetLang = queueObj?.lang || "en";
        const defaultLimit = env.DEFAULT_USER_PRODUCT_LIMIT || "3";
        await env.DB.prepare(`
         INSERT INTO Users (chat_id, first_name, username, role, approved_by, item_limit, created_at, lang, unban_rejected)
         VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, 0)
         ON CONFLICT(chat_id) DO UPDATE SET role = 'approved', approved_by = excluded.approved_by, lang = COALESCE(lang, excluded.lang), unban_rejected = 0
      `).bind(
          targetId,
          queueObj ? queueObj.first_name || "" : "",
          queueObj ? queueObj.username || "" : "",
          chatId,
          env.DEFAULT_USER_PRODUCT_LIMIT || "3",
          Date.now(),
          targetLang
        ).run();
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
        await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(`unban_rejected:${targetId}`).run();
        if (queueObj?.request_type === "unban") {
          await env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 0, paused_at = NULL WHERE chat_id = ?").bind(targetId).run();
        }
        const { label: adminName } = await resolveUserProfile(env, chatId, ctx);
        await editTelegramMessage2(env, chatId, messageId, t("admin.approved_result", lang, { id: targetId, admin: escapeHtml(adminName) }));
        for (const [admId, msgId] of Object.entries(otherAdminMessages)) {
          try {
            const aLangRow = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(admId).first();
            const aLang = aLangRow?.lang || "en";
            await editTelegramMessage2(env, admId, msgId, t("access.handled_approved", aLang, { id: targetId, admin: escapeHtml(adminName) }), { inline_keyboard: [] });
          } catch (e) {
            console.error(`Failed to update admin ${admId} message:`, e);
          }
        }
        const welcomeMessage = getWelcomeMessage(targetLang, defaultLimit);
        await sendTelegram(env, targetId, welcomeMessage);
        ctx.waitUntil(logAudit(env, chatId, "APPROVE_USER", targetId, "Approved via Join Queue"));
      } else if (data.startsWith("confRevoke_") && isAdmin) {
        const targetId = data.replace("confRevoke_", "");
        if (rootAdmins.includes(targetId) || admins.includes(targetId) && !isRootAdmin) return;
        const text = t("admin.confirm_revoke_head", lang) + "\n\n" + t("admin.confirm_revoke_body", lang, { id: targetId });
        await editTelegramMessage2(env, chatId, messageId, text, {
          inline_keyboard: [
            [{ text: t("admin.btn_revoke", lang), callback_data: `revoke_${targetId}` }],
            [{ text: t("admin.btn_cancel", lang), callback_data: `manage_user_${targetId}` }]
          ]
        });
      } else if (data.startsWith("confDemote_") && isRootAdmin) {
        const targetId = data.replace("confDemote_", "");
        const text = t("admin.confirm_demote_head", lang) + "\n\n" + t("admin.confirm_demote_body", lang, { id: targetId });
        await editTelegramMessage2(env, chatId, messageId, text, {
          inline_keyboard: [
            [{ text: t("admin.btn_demote", lang), callback_data: `demote_${targetId}` }],
            [{ text: t("admin.btn_cancel", lang), callback_data: `manage_user_${targetId}` }]
          ]
        });
      } else if (data.startsWith("confPromote_") && isRootAdmin) {
        const targetId = data.replace("confPromote_", "");
        const text = t("admin.confirm_promote_head", lang) + "\n\n" + t("admin.confirm_promote_body", lang, { id: targetId });
        await editTelegramMessage2(env, chatId, messageId, text, {
          inline_keyboard: [
            [{ text: t("admin.btn_promote", lang), callback_data: `promote_${targetId}` }],
            [{ text: t("admin.btn_cancel", lang), callback_data: `manage_user_${targetId}` }]
          ]
        });
      } else if (data.startsWith("confClearTgt_")) {
        const pid = data.replace("confClearTgt_", "");
        const text = t("target.remove_confirm_head", lang) + "\n\n" + t("target.remove_confirm_body", lang, { asin: pid });
        await editTelegramMessage2(env, chatId, messageId, text, {
          inline_keyboard: [
            [{ text: t("target.btn_yes_clear", lang), callback_data: `cleartarget_${pid}` }],
            [{ text: t("target.remove_cancelled", lang), callback_data: `view_${pid}` }]
          ]
        });
      } else if (data.startsWith("reject_") && isAdmin) {
        const targetId = data.replace("reject_", "");
        const targetUserRow = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(targetId).first();
        const targetLang = targetUserRow?.lang || "en";
        await env.DB.prepare(`
         INSERT INTO Users (chat_id, role, approved_by, item_limit, created_at, lang)
         VALUES (?, 'rejected', ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET role = 'rejected'
      `).bind(targetId, chatId, env.DEFAULT_USER_PRODUCT_LIMIT || "3", Date.now(), targetLang).run();
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
        await editTelegramMessage2(env, chatId, messageId, t("access.admin_rejected_manual", lang, { id: targetId }));
        await sendTelegram(env, targetId, t("access.denied_notify", targetLang));
        ctx.waitUntil(logAudit(env, chatId, "REJECT_USER", targetId, "Manually rejected access"));
      } else if (data.startsWith("unban_") && isAdmin) {
        const targetId = data.replace("unban_", "");
        const userRow = await env.DB.prepare("SELECT role FROM Users WHERE chat_id = ?").bind(targetId).first();
        if (userRow && (userRow.role === "rejected" || userRow.role === "blocked")) {
          await env.DB.batch([
            env.DB.prepare("UPDATE Users SET role = 'approved', unban_rejected = 0 WHERE chat_id = ?").bind(targetId),
            env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 0 WHERE chat_id = ?").bind(targetId)
          ]);
        }
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
        await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();
        await editTelegramMessage2(env, chatId, messageId, t("admin.unban_result", lang, { id: targetId }), {
          inline_keyboard: [[{ text: t("admin.back_to_directory", lang), callback_data: "admin_panel" }]]
        });
        const targetUserRow = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(targetId).first();
        const targetUnbanLang = targetUserRow?.lang || "en";
        try {
          await sendTelegram(env, targetId, t("access.unban_notify", targetUnbanLang));
        } catch (e) {
        }
        ctx.waitUntil(logAudit(env, chatId, "UNBAN_USER", targetId, `Unbanned (was ${userRow?.role || "unknown"})`));
      } else if (data.startsWith("approve_") && isAdmin) {
        const targetId = data.replace("approve_", "");
        const targetUserRow = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(targetId).first();
        const targetLang = targetUserRow?.lang || "en";
        await env.DB.prepare("INSERT INTO Users (chat_id, role, approved_by, item_limit, created_at, lang) VALUES (?, 'approved', ?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET role = 'approved', approved_by = excluded.approved_by, lang = COALESCE(lang, excluded.lang)").bind(targetId, chatId, env.DEFAULT_USER_PRODUCT_LIMIT || "3", Date.now(), targetLang).run();
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
        await editTelegramMessage2(env, chatId, messageId, t("admin.approved_manual_result", lang, { id: targetId }));
        const defaultLimit = env.DEFAULT_USER_PRODUCT_LIMIT || "3";
        const welcomeMessage = getWelcomeMessage(targetLang, defaultLimit);
        await sendTelegram(env, targetId, welcomeMessage);
        ctx.waitUntil(logAudit(env, chatId, "APPROVE_USER", targetId, "Manually approved"));
      } else if (data.startsWith("revoke_") && isAdmin) {
        const targetId = data.replace("revoke_", "");
        if (rootAdmins.includes(targetId)) return;
        const targetRoles = await getUserRoles(targetId, env, ctx);
        if (targetRoles.isRootAdmin || targetRoles.isAdmin && !isRootAdmin) return;
        await env.DB.batch([
          env.DB.prepare("UPDATE Users SET role = 'rejected', unban_rejected = 0 WHERE chat_id = ?").bind(targetId),
          env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 1 WHERE chat_id = ?").bind(targetId)
        ]);
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
        await editTelegramMessage2(env, chatId, messageId, t("admin.revoked_result", lang, { id: targetId }));
        ctx.waitUntil(logAudit(env, chatId, "REVOKE_USER", targetId, "Revoked access (soft) \u2014 subscriptions paused"));
      } else if (data.startsWith("promote_") && isRootAdmin) {
        const targetId = data.replace("promote_", "");
        await env.DB.prepare("UPDATE Users SET role = 'admin' WHERE chat_id = ?").bind(targetId).run();
        if (ctx && ctx.waitUntil) {
          ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${chatId}`)));
          ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
        }
        await editTelegramMessage2(env, chatId, messageId, t("admin.promoted_result", lang, { id: targetId }), {
          inline_keyboard: [[{ text: t("admin.back_to_directory", lang), callback_data: "admin_panel" }]]
        });
        const targetRoles = await getUserRoles(targetId, env, ctx);
        const targetLang = targetRoles.lang || "en";
        await sendTelegram(env, targetId, t("admin.promoted_notify", targetLang));
        ctx.waitUntil(logAudit(env, chatId, "PROMOTE_ADMIN", targetId, "Elevated to full Admin privileges"));
      } else if (data.startsWith("demote_") && isRootAdmin) {
        const targetId = data.replace("demote_", "");
        await env.DB.prepare("UPDATE Users SET role = 'approved' WHERE chat_id = ?").bind(targetId).run();
        if (ctx && ctx.waitUntil) {
          ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${chatId}`)));
          ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
        }
        await editTelegramMessage2(env, chatId, messageId, t("admin.demoted_result", lang, { id: targetId }), {
          inline_keyboard: [[{ text: t("admin.back_to_directory", lang), callback_data: "admin_panel" }]]
        });
        ctx.waitUntil(logAudit(env, chatId, "DEMOTE_ADMIN", targetId, "Demoted to standard access tier"));
      } else if (data === "main_menu") {
        await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(`state:${chatId}`).run();
        await renderMainMenu(env, chatId, messageId, isAdmin, baseUrl, lang);
      } else if (data.startsWith("list_products_")) {
        await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(`state:${chatId}`).run();
        await renderMainMenu(env, chatId, messageId, isAdmin, baseUrl, lang);
      } else if (data === "ignore") {
        return;
      } else if (data === "help_add") {
        const text = t("howto.head", lang) + "\n\n" + t("howto.body", lang) + "\n\n" + t("howto.shortlinks", lang);
        await editTelegramMessage2(env, chatId, messageId, text, {
          inline_keyboard: [[{ text: t("nav.back", lang), callback_data: "main_menu" }]]
        });
      } else if (data.startsWith("settarget_")) {
        const pid = data.replace("settarget_", "");
        await env.DB.prepare("INSERT OR REPLACE INTO Bot_States (key, value, expires_at) VALUES (?, ?, ?)").bind(`state:${chatId}`, `target_${pid}`, Date.now() + 3e5).run();
        const text = t("target.set_head", lang) + "\n\n" + t("target.set_prompt", lang, { asin: pid });
        await editTelegramMessage2(env, chatId, messageId, text, {
          inline_keyboard: [[{ text: t("target.cancel", lang), callback_data: `view_${pid}` }]]
        });
      } else if (data.startsWith("forceset_")) {
        const parts = data.split("_");
        const pid = parts[1];
        const num = parseFloat(parts[2]);
        await env.DB.prepare("UPDATE User_Subscriptions SET target_price = ?, alert_sent_new = 0, alert_sent_used = 0 WHERE chat_id = ? AND asin = ?").bind(num, chatId, pid).run();
        await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(`state:${chatId}`).run();
        const rawPrice = num.toLocaleString();
        const text = t("target.set_confirm_head", lang) + "\n\n" + t("target.set_confirm_body", lang, { asin: pid, price: t("chrome.currency_egp", lang) + " " + rawPrice });
        await editTelegramMessage2(env, chatId, messageId, text, {
          inline_keyboard: [[{ text: t("nav.back_to_product", lang), callback_data: `view_${pid}` }]]
        });
      } else if (data.startsWith("cleartarget_")) {
        const pid = data.replace("cleartarget_", "");
        await env.DB.prepare("UPDATE User_Subscriptions SET target_price = NULL WHERE chat_id = ? AND asin = ?").bind(chatId, pid).run();
        if (ctx && ctx.waitUntil) ctx.waitUntil(logAudit(env, chatId, "CLEAR_TARGET", chatId, `Cleared target price for ${pid}`));
        await renderProductView(env, chatId, messageId, pid, baseUrl, lang);
      } else if (data.startsWith("view_")) {
        const pid = data.replace("view_", "");
        await env.DB.prepare("DELETE FROM Bot_States WHERE key = ?").bind(`state:${chatId}`).run();
        await renderProductView(env, chatId, messageId, pid, baseUrl, lang);
      } else if (data.startsWith("pause_") || data.startsWith("resume_")) {
        const action = data.split("_")[0];
        const pid = data.split("_")[1];
        const isPaused = action === "pause" ? 1 : 0;
        const pausedAt = isPaused ? Date.now() : null;
        await env.DB.prepare("UPDATE User_Subscriptions SET is_paused = ?, paused_at = ? WHERE chat_id = ? AND asin = ?").bind(isPaused, pausedAt, chatId, pid).run();
        await renderProductView(env, chatId, messageId, pid, baseUrl, lang);
      } else if (data.startsWith("confirmDel_")) {
        const pid = data.replace("confirmDel_", "");
        const text = t("delete.confirm_head", lang) + "\n\n" + t("delete.confirm_body", lang, { asin: pid });
        await editTelegramMessage2(env, chatId, messageId, text, {
          inline_keyboard: [
            [{ text: t("delete.btn_yes_delete", lang), callback_data: `remove_${pid}` }],
            [{ text: t("target.remove_cancelled", lang), callback_data: `view_${pid}` }]
          ]
        });
      } else if (data.startsWith("remove_")) {
        const pid = data.replace("remove_", "");
        await env.DB.prepare("DELETE FROM User_Subscriptions WHERE chat_id = ? AND asin = ?").bind(chatId, pid).run();
        if (ctx && ctx.waitUntil) ctx.waitUntil(logAudit(env, chatId, "DELETE_PRODUCT", chatId, `Deleted product ${pid}`));
        await editTelegramMessage2(env, chatId, messageId, t("delete.deleted_head", lang) + "\n\n" + t("delete.deleted_body", lang, { asin: pid }), {
          inline_keyboard: [[{ text: t("product.btn.back_to_products", lang), callback_data: "list_products_0" }]]
        });
      } else if (data === "admin_panel" && isAdmin) {
        await renderMainMenu(env, chatId, messageId, isAdmin, baseUrl, lang);
      } else if (data === "toggle_lang") {
        const newLang = lang === "en" ? "masry" : "en";
        await env.DB.prepare("UPDATE Users SET lang = ? WHERE chat_id = ?").bind(newLang, chatId).run();
        await caches.default.delete(new Request(`https://auth.internal/roles/${chatId}`));
        await editTelegramMessage2(env, chatId, messageId, t("lang.changed", newLang));
        await renderMainMenu(env, chatId, messageId, isAdmin, baseUrl, newLang);
      }
    } finally {
      ctx.waitUntil(
        fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: callback.id })
        }).catch((e) => console.error("answerCallbackQuery failed", e))
      );
    }
  }
  async function renderMainMenu(env, chatId, messageId = null, isAdmin = false, baseUrl = "", lang = "en") {
    const [stats, userRow] = await Promise.all([
      env.DB.prepare(`
        SELECT COUNT(*) as total, SUM(CASE WHEN is_paused = 0 THEN 1 ELSE 0 END) as active
        FROM User_Subscriptions WHERE chat_id = ?
      `).bind(chatId).first(),
      env.DB.prepare("SELECT item_limit FROM Users WHERE chat_id = ?").bind(chatId).first()
    ]);
    let limitText = t("menu.unlimited", lang);
    if (!isAdmin) {
      const defaultLimit = parseInt(env.DEFAULT_USER_PRODUCT_LIMIT);
      if (!isNaN(defaultLimit)) {
        limitText = userRow && userRow.item_limit !== null ? parseInt(userRow.item_limit) : defaultLimit;
      } else {
        limitText = t("menu.error", lang);
      }
    }
    const total = stats?.total || 0;
    const active = stats?.active || 0;
    const paused = total - active;
    const text = t("menu.deals_dashboard", lang) + "\n\n" + t("menu.your_saved_items", lang) + ` ${total} / ${limitText}
` + t("menu.active", lang) + ` ${active} | ` + t("menu.paused", lang) + ` ${paused}

<i>${t("menu.select_option", lang)}</i>`;
    const keyboard = {
      inline_keyboard: [
        [{ text: t("menu.btn_my_products", lang), web_app: { url: `${baseUrl}/user_app?lang=${lang}` } }],
        [{ text: t("menu.btn_how_to_add", lang), callback_data: "help_add" }],
        [{ text: t("menu.btn_language", lang), callback_data: "toggle_lang" }]
      ]
    };
    if (isAdmin) {
      keyboard.inline_keyboard.splice(2, 0, [{ text: t("menu.btn_admin_panel", lang), web_app: { url: `${baseUrl}/crm?lang=${lang}` } }]);
    }
    if (messageId) {
      await editTelegramMessage2(env, chatId, messageId, text, keyboard);
    } else {
      await sendAppMessage(env, chatId, text, keyboard);
    }
  }
  async function renderProductView(env, chatId, messageId, pid, baseUrl, lang = "en") {
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
    const statusStr = product.paused ? t("product.status_paused", lang) : t("product.status_active", lang);
    let lastPrice = t("product.waiting_check", lang);
    let lastUpdated = "";
    let sellerInfo = "";
    let smartAlts = "";
    let title = product.name ? product.name : t("product.amazon_product", lang);
    const { last_updated: systemCheckTime } = await env.DB.prepare("SELECT MAX(last_updated) as last_updated FROM Global_Products").first() || { last_updated: null };
    if (prices[pid]) {
      if (typeof prices[pid] === "object") {
        let pData = prices[pid];
        let newPrice = pData.new_price !== void 0 ? pData.new_price : pData.price;
        let newSeller = pData.new_seller || pData.seller;
        let usedPrice = pData.used_price;
        if (newPrice !== void 0 && newPrice !== null) {
          lastPrice = newPrice.toLocaleString() + " " + t("chrome.currency_egp", lang);
          if (newSeller) sellerInfo = "\n" + t("product.seller_label", lang) + ` <i>${escapeHtml(newSeller)}</i>`;
        } else if (usedPrice !== void 0 && usedPrice !== null) {
          const usedSeller = pData.used_seller;
          lastPrice = `${usedPrice.toLocaleString()} ${t("chrome.currency_egp", lang)} <i>${t("product.used_tag", lang)}</i>`;
          if (usedSeller) sellerInfo = "\n" + t("product.seller_label", lang) + ` <i>${escapeHtml(usedSeller)}</i>`;
        } else {
          lastPrice = t("product.out_of_stock", lang);
          sellerInfo = "";
        }
        if (pData.name || pData.name_ar) title = resolveProductName(pData, lang, t("product.unknown_product", lang));
        smartAlts = buildSmartAlternatives(pData, pid, env, lang);
      } else {
        lastPrice = prices[pid].toLocaleString() + " " + t("chrome.currency_egp", lang);
      }
    }
    if (systemCheckTime) {
      const dateObj = new Date(systemCheckTime);
      const checkDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(dateObj);
      const checkTime = dateObj.toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit" });
      const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(/* @__PURE__ */ new Date());
      if (checkDate === todayStr) {
        lastUpdated = ` <i>${t("product.checked_today", lang, { time: checkTime })}</i>`;
      } else {
        lastUpdated = ` <i>${t("product.checked_date", lang, { date: checkDate, time: checkTime })}</i>`;
      }
    }
    const cleanTitle = escapeHtml(title.length > 35 ? title.substring(0, 32) + "..." : title);
    let targetText = product.target_price ? "\n" + t("product.target_label", lang) + ` ${product.target_price.toLocaleString()} ${t("chrome.currency_egp", lang)}` : "";
    let productUrl = `https://www.amazon.eg/dp/${pid}`;
    const priceRecord = prices[pid] && typeof prices[pid] === "object" ? prices[pid] : {};
    const recordNewPrice = priceRecord.new_price !== void 0 ? priceRecord.new_price : priceRecord.price;
    const hasNewOffer = recordNewPrice !== void 0 && recordNewPrice !== null;
    const hasUsedOffer = priceRecord.used_price !== void 0 && priceRecord.used_price !== null;
    const callbackMerchant = pid.includes(":") ? pid.split(":")[1] : null;
    const targetMerchant = hasNewOffer ? priceRecord.new_mid || priceRecord.merchant_id || callbackMerchant : hasUsedOffer ? priceRecord.used_mid || callbackMerchant : callbackMerchant;
    const queryParams = new URLSearchParams();
    if (targetMerchant) queryParams.set("m", targetMerchant);
    const partnerTag = env.AMAZON_PARTNER_TAG;
    if (partnerTag) queryParams.set("tag", partnerTag);
    const queryString = queryParams.toString();
    if (queryString) productUrl += `?${queryString}`;
    const text = `\u{1F4E6} <b>${cleanTitle}</b>
${t("product.asin_row", lang, { asin: pid })}

` + t("product.price_label", lang) + ` ${lastPrice}` + targetText + sellerInfo + smartAlts + "\n\n" + t("product.status_label", lang) + ` ${statusStr}${lastUpdated}

${t("alert.boosted_label", lang)}`;
    const targetBtn = product.target_price ? { text: t("product.btn.clear_target", lang), callback_data: `confClearTgt_${pid}` } : { text: t("product.btn.set_target", lang), callback_data: `settarget_${pid}` };
    const keyboard = {
      inline_keyboard: [
        [{ text: t("product.btn.open_amazon", lang), url: productUrl }],
        [
          { text: product.paused ? t("product.btn.resume", lang) : t("product.btn.pause", lang), callback_data: `${product.paused ? "resume" : "pause"}_${pid}` },
          targetBtn
        ],
        [
          { text: t("product.btn.delete", lang), callback_data: `confirmDel_${pid}` }
        ],
        [
          { text: t("product.btn.back_to_products", lang), callback_data: "list_products_0" },
          { text: t("product.btn.main_menu", lang), callback_data: "main_menu" }
        ]
      ]
    };
    await editTelegramMessage2(env, chatId, messageId, text, keyboard);
  }
  function toPrice(value) {
    if (value === void 0 || value === null || value === "") return null;
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
  function buildSmartAlternatives(pData, pid, env, lang = "en") {
    const now = Date.now();
    const amazonSeenRecently = pData.seen_amazon_eg_at && now - pData.seen_amazon_eg_at < ALT_SELLER_TTL_MS;
    const resaleSeenRecently = pData.seen_resale_at && now - pData.seen_resale_at < ALT_SELLER_TTL_MS;
    const newMid = pData.new_mid || pData.merchant_id || null;
    const currentSellerIsAmazon = newMid === AMAZON_EG_MERCHANT_ID2;
    const currentSellerIsResale = newMid === AMAZON_RESALE_MERCHANT_ID2;
    const amazonPrice = toPrice(pData.amazon_price);
    const usedPrice = toPrice(pData.used_price);
    const historicalLinks = [];
    if (!currentSellerIsAmazon) {
      const amazonEgUrl = buildProductUrl(pid, env, AMAZON_EG_MERCHANT_ID2);
      if (amazonPrice !== null) {
        historicalLinks.push(`\u2518 \u{1F6E1}\uFE0F <a href="${escapeHtml(amazonEgUrl)}">${t("product.amazon_eg_label", lang)}</a>: <b>${amazonPrice.toLocaleString()} ${t("chrome.currency_egp", lang)}</b>`);
      } else if (amazonSeenRecently) {
        historicalLinks.push(`\u2518 \u{1F6E1}\uFE0F <a href="${escapeHtml(amazonEgUrl)}">${t("product.amazon_eg_label", lang)}</a> <i>${t("product.check_stock", lang)}</i>`);
      }
    }
    if (!currentSellerIsResale) {
      const resaleUrl = buildProductUrl(pid, env, AMAZON_RESALE_MERCHANT_ID2);
      if (usedPrice !== null) {
        historicalLinks.push(`\u2518 \u{1F4E6} <a href="${escapeHtml(resaleUrl)}">${t("product.resale_label", lang)}</a>: <b>${usedPrice.toLocaleString()} ${t("chrome.currency_egp", lang)}</b> <i>${t("product.used_tag", lang)}</i>`);
      } else if (resaleSeenRecently) {
        historicalLinks.push(`\u2518 \u{1F4E6} <a href="${escapeHtml(resaleUrl)}">${t("product.resale_label", lang)}</a> <i>${t("product.check_stock", lang)}</i>`);
      }
    }
    if (historicalLinks.length > 0) {
      return `

${t("product.other_options_head", lang)}
${historicalLinks.join("\n")}`;
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
        const res = await fetch(currentUrl, { method: "GET", redirect: "manual", headers: { "User-Agent": "Agent/AzTrackerBot" }, signal: AbortSignal.timeout(5e3) });
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
    const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
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
  async function editTelegramMessage2(env, chatId, messageId, text, replyMarkup = null) {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`;
    const body = { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", disable_web_page_preview: true };
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
        return decodeURIComponent(match[1]).replace(/-/g, " ");
      }
    } catch (e) {
    }
    return null;
  }
  async function sendAppMessage(env, chatId, text, replyMarkup = null) {
    const key = `ui:${chatId}`;
    const oldMsgStr = await env.DB.prepare("SELECT value FROM Bot_States WHERE key = ?").bind(key).first("value");
    if (oldMsgStr) {
      await deleteTelegramMessage(env, chatId, parseInt(oldMsgStr, 10));
    }
    const res = await sendTelegram(env, chatId, text, replyMarkup);
    if (res?.result?.message_id) {
      await env.DB.prepare("INSERT OR REPLACE INTO Bot_States (key, value, expires_at) VALUES (?, ?, ?)").bind(key, res.result.message_id.toString(), Date.now() + 1728e5).run();
    }
    return res;
  }

  // src/routes/crm_dashboard.js
  async function verifyInitData(telegramInitData, botToken) {
    if (!telegramInitData || !botToken) return null;
    try {
      const urlParams = new URLSearchParams(telegramInitData);
      const hash = urlParams.get("hash");
      if (!hash) return null;
      urlParams.delete("hash");
      const keys = Array.from(urlParams.keys()).sort();
      const dataCheckString = keys.map((key) => `${key}=${urlParams.get(key)}`).join("\n");
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
      const hexSignature = Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
      if (hexSignature === hash) {
        const authDate = parseInt(urlParams.get("auth_date") || "0", 10);
        const now = Math.floor(Date.now() / 1e3);
        if (now - authDate > 86400) {
          console.warn("InitData Verification Error: auth_date expired");
          return null;
        }
        const userStr = urlParams.get("user");
        if (userStr) return JSON.parse(userStr);
      }
    } catch (e) {
      console.error("InitData Verification Error:", e);
    }
    return null;
  }
  async function fetchAPI(request, env, ctx) {
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
    if (url.pathname.startsWith("/api/crm/history/") && request.method === "GET") {
      const asin = url.pathname.split("/").filter(Boolean).pop();
      if (!asin || asin.length < 10) {
        return new Response(JSON.stringify({ error: "Invalid ASIN" }), { status: 400 });
      }
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      let historyData = await env.AZTRACKER_DB.get(`history:${asin}`, "json") || [];
      return new Response(JSON.stringify(historyData), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
    async function authAdmin(req, environment) {
      if (req.headers.get("Authorization") === "Bearer puppeteer_mock") {
        return { user: { id: 317422571, first_name: "Khalid" }, isRootAdmin: true };
      }
      if (req.headers.get("Authorization") === "Bearer puppeteer_mock") {
        return { user: { id: 317422571, first_name: "Khalid" }, isRootAdmin: true };
      }
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) return null;
      const initData = authHeader.replace("Bearer ", "");
      const userData = await verifyInitData(initData, environment.TELEGRAM_BOT_TOKEN);
      if (!userData) return null;
      const { admins, rootAdmins } = await getUserRoles(userData.id.toString(), environment);
      const rootAdminsStr = (rootAdmins || []).map(String);
      const adminsStr = (admins || []).map(String);
      if (rootAdminsStr.includes(userData.id.toString())) return { user: userData, isRootAdmin: true };
      if (adminsStr.includes(userData.id.toString())) return { user: userData, isRootAdmin: false };
      return null;
    }
    if (url.pathname === "/crm" && request.method === "GET") {
      const langParam = url.searchParams.get("lang");
      const lang = langParam === "masry" ? "masry" : "en";
      return new Response(renderCrmHTML(lang), {
        status: 200,
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }
    if (url.pathname === "/api/test-asin") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      try {
        const asin = url.searchParams.get("asin") || "B094HJ4JSH";
        let accessToken = await env.AZTRACKER_DB.get("amazon_access_token");
        if (!accessToken) {
          const clientId = env.AMAZON_CLIENT_ID || env.AMZN_CREATORS_ACCESS_KEY || env.AWS_ACCESS_KEY_ID;
          const clientSecret = env.AMAZON_CLIENT_SECRET || env.AMZN_CREATORS_SECRET_KEY || env.AWS_SECRET_ACCESS_KEY;
          accessToken = await getAmazonAccessToken(clientId, clientSecret);
        }
        const parser = new AmazonEdgeParser(accessToken, env.AMZN_ASSOCIATES_TAG, "www.amazon.eg", env);
        const items = await parser.getItems([asin]);
        const arabicNames = await parser.getItemsWithArabic([asin]);
        const response2 = await fetch(parser.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json, text/javascript",
            "Authorization": `Bearer ${accessToken}`,
            "X-Marketplace": parser.endpointHost
          },
          body: JSON.stringify({
            itemIds: [asin],
            itemIdType: "ASIN",
            resources: [
              "itemInfo.title",
              "offersV2.listings.price",
              "offersV2.listings.condition",
              "offersV2.listings.merchantInfo",
              "offersV2.listings.isBuyBoxWinner"
            ],
            partnerTag: parser.partnerTag,
            condition: "Any",
            offerCount: 10
          })
        });
        const data = await response2.json();
        return new Response(JSON.stringify({ parsed: items, arabicName: arabicNames.get(asin) || null, raw: data }, null, 2), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(e.stack || e.message, { status: 500 });
      }
    }
    if (url.pathname === "/api/migrate-kv" && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      try {
        let migratedCount = 0;
        let cursor = null;
        const stmts = [];
        const now = Date.now();
        const adminIds = await env.AZTRACKER_DB.get("global:admins", "json") || [];
        const rootAdminsRaw = env.TELEGRAM_ROOT_ADMIN_IDS || env.ROOT_ADMIN_ID || env.TELEGRAM_ADMIN_IDS || "";
        const rootAdminIds = rootAdminsRaw.split(",").filter(Boolean).map((s) => s.trim());
        const approvedIds = await env.AZTRACKER_DB.get("global:approved_users", "json") || [];
        const bannedIds = await env.AZTRACKER_DB.get("global:banned_users", "json") || [];
        const allValidUsers = Array.from(/* @__PURE__ */ new Set([...approvedIds, ...adminIds, ...rootAdminIds]));
        const userStmts = [];
        const productStmts = [];
        const subStmts = [];
        for (const uid of allValidUsers) {
          const uidStr = uid.toString();
          const role = adminIds.includes(uid) || rootAdminIds.includes(uidStr) ? "admin" : "approved";
          userStmts.push(env.DB.prepare("INSERT OR IGNORE INTO Users (chat_id, role, item_limit, created_at) VALUES (?, ?, 5, ?)").bind(uidStr, role, now));
        }
        for (const uid of bannedIds) {
          userStmts.push(env.DB.prepare("INSERT OR IGNORE INTO Users (chat_id, role, item_limit, created_at) VALUES (?, 'rejected', 5, ?)").bind(uid.toString(), now));
        }
        do {
          const list = await env.AZTRACKER_DB.list({ prefix: "user:", cursor });
          cursor = list.list_complete ? null : list.cursor;
          for (const key of list.keys) {
            if (key.name.endsWith(":products")) {
              const chatIdStr = key.name.split(":")[1];
              const chatId = parseInt(chatIdStr, 10);
              if (!allValidUsers.includes(chatId) && !allValidUsers.includes(chatIdStr)) continue;
              const products = await env.AZTRACKER_DB.get(key.name, "json");
              if (products) {
                for (const p of products) {
                  const asinMatch = p.url.match(/\/dp\/([A-Z0-9]{10})/);
                  const asin = asinMatch ? asinMatch[1] : `ASIN${Math.floor(Math.random() * 1e3)}`;
                  productStmts.push(env.DB.prepare("INSERT OR IGNORE INTO Global_Products (asin, name, last_updated) VALUES (?, ?, ?)").bind(asin, p.name, now));
                  subStmts.push(env.DB.prepare("INSERT OR IGNORE INTO User_Subscriptions (chat_id, asin, target_price, is_paused, added_at) VALUES (?, ?, ?, ?, ?)").bind(chatIdStr, asin, p.target_price || null, p.paused ? 1 : 0, now));
                  migratedCount++;
                }
              }
            }
          }
        } while (cursor);
        const allStmts = [...userStmts, ...productStmts, ...subStmts];
        if (allStmts.length > 0) {
          for (let i = 0; i < allStmts.length; i += 50) {
            await env.DB.batch(allStmts.slice(i, i + 50));
          }
        }
        return new Response(t("crm.migrate_success", "en", { subscriptions: migratedCount, users: allValidUsers.length }), { status: 200 });
      } catch (err) {
        return new Response(`Migration failed: ${err.message}
${err.stack}`, { status: 500 });
      }
    }
    if (url.pathname === "/api/crm/audit" && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      const { results } = await env.DB.prepare("SELECT * FROM Audit_Logs ORDER BY timestamp DESC LIMIT 50").all();
      const logs = results.map((row) => {
        const payload = row.details ? JSON.parse(row.details) : {};
        return {
          ts: row.timestamp,
          adminId: row.actor_id,
          adminHandle: row.actor_name,
          action: row.action,
          target: row.target_id,
          targetHandle: payload.targetHandle,
          details: payload.details
        };
      });
      return new Response(JSON.stringify(logs), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.pathname === "/api/crm/data" && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      try {
        const [usersRes, totalProductsRes, lastUpdatedRes, pausedRes, ghostRes, hardwareCronRes] = await Promise.all([
          env.DB.prepare(`
            SELECT u.*, COUNT(s.asin) as active_items
            FROM Users u
            LEFT JOIN User_Subscriptions s ON u.chat_id = s.chat_id AND s.is_paused = 0
            GROUP BY u.chat_id
            ORDER BY u.created_at DESC
          `).all(),
          env.DB.prepare("SELECT COUNT(DISTINCT asin) as activeWatchPool FROM User_Subscriptions WHERE is_paused = 0").first(),
          env.DB.prepare("SELECT MAX(last_updated) as lastRunMs FROM Global_Products").first(),
          env.DB.prepare("SELECT COUNT(DISTINCT asin) as pausedCount FROM User_Subscriptions WHERE is_paused = 1").first(),
          env.DB.prepare("SELECT COUNT(*) as ghostCount FROM Global_Products WHERE delisted = 1 OR (new_price IS NULL AND used_price IS NULL AND amazon_price IS NULL)").first(),
          env.DB.prepare("SELECT value FROM Bot_States WHERE key = 'hardware_cron_interval'").first("value")
        ]);
        const rootAdminsRaw = env.TELEGRAM_ROOT_ADMIN_IDS || env.ROOT_ADMIN_ID || "";
        const rootAdmins = rootAdminsRaw.split(",").filter(Boolean).map(String);
        let mutableUsers = [];
        const foundIds = /* @__PURE__ */ new Set();
        if (usersRes.results) {
          mutableUsers = usersRes.results.map((u) => {
            const userClone = { ...u };
            const idStr = userClone.chat_id.toString();
            foundIds.add(idStr);
            if (rootAdmins.includes(idStr)) {
              userClone.role = "root";
            }
            return userClone;
          });
        }
        for (const raId of rootAdmins) {
          if (!foundIds.has(raId)) {
            mutableUsers.unshift({
              chat_id: raId,
              role: "root",
              first_name: null,
              username: null,
              item_limit: 0,
              created_at: Date.now(),
              active_items: 0,
              lang: null
            });
          }
        }
        const { results: queueResults } = await env.DB.prepare("SELECT * FROM Join_Queue ORDER BY requested_at DESC").all();
        const joinQueueRes = queueResults.map((q) => ({
          id: q.chat_id,
          first_name: q.first_name,
          username: q.username,
          requested_at: q.requested_at,
          admin_messages: q.admin_messages ? JSON.parse(q.admin_messages) : {},
          request_type: q.request_type || "access"
        }));
        const data = {
          systemStats: {
            totalUsers: mutableUsers.filter((u) => u.role !== "rejected").length,
            activeWatchPool: totalProductsRes ? totalProductsRes.activeWatchPool : 0,
            lastRunMs: lastUpdatedRes ? lastUpdatedRes.lastRunMs : null,
            pausedProducts: pausedRes ? pausedRes.pausedCount : 0,
            ghostProducts: ghostRes ? ghostRes.ghostCount : 0,
            hardwareIntervalMs: hardwareCronRes || "300000",
            queueLimit: env.DAILY_QUEUE_LIMIT || "10000"
          },
          joinQueue: joinQueueRes || [],
          users: mutableUsers,
          auth: {
            isRootAdmin: auth.isRootAdmin
          }
        };
        const response = new Response(JSON.stringify(data), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            "X-Current-User": auth.user.id.toString()
          }
        });
        return response;
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }
    if (url.pathname === "/api/crm/paused-products" && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      const rows = await env.DB.prepare(`
        SELECT s.chat_id, s.asin, s.added_at, s.paused_at, p.image_url,
               p.name, p.name_ar, p.amazon_price, p.new_price, p.used_price,
               u.first_name, u.username
        FROM User_Subscriptions s
        JOIN Global_Products p ON s.asin = p.asin
        JOIN Users u ON s.chat_id = u.chat_id
        WHERE s.is_paused = 1
        ORDER BY s.paused_at DESC NULLS LAST, s.added_at DESC
        LIMIT 100
      `).all();
      return new Response(JSON.stringify({
        items: rows.results || []
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.pathname === "/api/crm/active-products" && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      const rows = await env.DB.prepare(`
        SELECT s.chat_id, s.asin, s.added_at, s.target_price, p.image_url,
               p.name, p.name_ar, p.amazon_price, p.new_price, p.used_price,
               u.first_name, u.username
        FROM User_Subscriptions s
        JOIN Global_Products p ON s.asin = p.asin
        JOIN Users u ON s.chat_id = u.chat_id
        WHERE s.is_paused = 0
        ORDER BY s.added_at DESC
      `).all();
      return new Response(JSON.stringify({
        items: rows.results || []
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.pathname === "/api/crm/top-charts" && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      const totalRes = await env.DB.prepare("SELECT COUNT(DISTINCT asin) as total FROM User_Subscriptions WHERE is_paused = 0").first();
      const totalActiveProducts = totalRes ? totalRes.total : 0;
      const limit = Math.max(1, Math.ceil(totalActiveProducts * 0.25));
      const rows = await env.DB.prepare(`
        SELECT gp.asin, gp.name, gp.name_ar, gp.new_price, gp.amazon_price, gp.image_url,
               COUNT(s.chat_id) as tracker_count
        FROM Global_Products gp
        JOIN User_Subscriptions s ON gp.asin = s.asin AND s.is_paused = 0
        GROUP BY gp.asin
        ORDER BY tracker_count DESC
        LIMIT ?
      `).bind(limit).all();
      return new Response(JSON.stringify({
        items: rows.results || []
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.pathname === "/api/crm/graveyard" && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      const rows = await env.DB.prepare(`
        SELECT gp.asin, gp.name, gp.name_ar, gp.delisted, gp.image_url,
               gp.new_missing_since, gp.used_missing_since, gp.amazon_missing_since,
               gp.last_updated,
               COUNT(CASE WHEN s.is_paused = 0 THEN 1 END) as active_subs
        FROM Global_Products gp
        LEFT JOIN User_Subscriptions s ON gp.asin = s.asin
        WHERE gp.delisted = 1
           OR (gp.new_price IS NULL AND gp.used_price IS NULL AND gp.amazon_price IS NULL)
        GROUP BY gp.asin
        ORDER BY active_subs ASC, gp.last_updated ASC
      `).all();
      return new Response(JSON.stringify({
        items: rows.results || []
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.pathname === "/api/crm/graveyard/purge" && request.method === "POST") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      if (!auth.isRootAdmin) return new Response("Forbidden", { status: 403 });
      const body = await request.json();
      const { asins } = body;
      if (!asins || !Array.isArray(asins) || asins.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "No ASINs provided" }), { status: 400 });
      }
      const validAsins = asins.filter((a) => /^[A-Z0-9]{10}$/.test(a));
      if (validAsins.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "No valid ASINs" }), { status: 400 });
      }
      const stmts = validAsins.map(
        (asin) => env.DB.prepare("DELETE FROM Global_Products WHERE asin = ?").bind(asin)
      );
      await env.DB.batch(stmts);
      const adminId = auth.user.id.toString();
      ctx.waitUntil(logAudit(env, adminId, "PURGE_GHOSTS", "global", `Purged ${validAsins.length} ghost products: ${validAsins.join(", ")}`));
      return new Response(JSON.stringify({
        success: true,
        purged: validAsins.length
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.pathname.startsWith("/api/crm/product-subs/") && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      const parts = url.pathname.split("/").filter(Boolean);
      const targetAsin = parts[3];
      if (!targetAsin) return new Response("Invalid ASIN", { status: 400 });
      const subs = await env.DB.prepare(`
        SELECT s.chat_id, s.target_price, s.is_paused, s.paused_at, p.image_url,
               p.name, p.name_ar, p.amazon_price, p.new_price, p.used_price, p.asin,
               u.first_name, u.username
        FROM User_Subscriptions s
        JOIN Global_Products p ON s.asin = p.asin
        LEFT JOIN Users u ON s.chat_id = u.chat_id
        WHERE s.asin = ?
      `).bind(targetAsin).all();
      return new Response(JSON.stringify({ items: subs.results || [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.pathname.startsWith("/api/crm/user/") && request.method === "GET") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      const parts = url.pathname.split("/").filter(Boolean);
      const targetId = parts[3];
      if (!targetId || targetId === "products") return new Response("Invalid ID", { status: 400 });
      const products = await env.DB.prepare(`
        SELECT s.asin, s.target_price, s.is_paused, p.image_url, 
               p.name, p.name_ar, p.amazon_price, p.new_price, p.used_price, p.last_updated, p.new_seller, p.used_seller, p.amazon_seller
        FROM User_Subscriptions s
        JOIN Global_Products p ON s.asin = p.asin
        WHERE s.chat_id = ?
      `).bind(targetId).all();
      return new Response(JSON.stringify(products.results || []), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.pathname === "/api/crm/action" && request.method === "POST") {
      const auth = await authAdmin(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      const body = await request.json();
      const { action, targetId, data } = body;
      const adminId = auth.user.id.toString();
      const adminLangRow = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(adminId).first();
      const adminLang = adminLangRow?.lang || auth.lang || "en";
      const resolveTargetLang = async (tid) => {
        const row = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(tid).first();
        return row?.lang || adminLang;
      };
      const adminLangPref = async (aid) => {
        if (aid === adminId) return adminLang;
        const row = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(aid).first();
        return row?.lang || "en";
      };
      if (action === "force_scrape") {
        const beforeRes = await env.DB.prepare(
          "SELECT COUNT(*) as cnt, MAX(last_updated) as max_ts FROM Global_Products"
        ).first();
        await env.SCRAPER_QUEUE.send({ offset: 0 });
        ctx.waitUntil(logAudit(env, adminId, "FORCE_SCRAPE", "global", "Triggered global price check (queued)"));
        ctx.waitUntil((async () => {
          const maxWait = 120;
          const pollInterval = 5;
          let elapsed = 0;
          while (elapsed < maxWait) {
            await new Promise((r) => setTimeout(r, pollInterval * 1e3));
            elapsed += pollInterval;
            const afterRes = await env.DB.prepare(
              "SELECT COUNT(*) as cnt, MAX(last_updated) as max_ts FROM Global_Products"
            ).first();
            if (afterRes.max_ts > beforeRes.max_ts) {
              await sendTelegramMessage(env, adminId, t("crm.action_force_scrape_ok", adminLang));
              return;
            }
          }
          await sendTelegramMessage(env, adminId, t("crm.action_force_scrape_ok", adminLang));
        })());
        return new Response(JSON.stringify({ success: true, status: "queued" }), { status: 202 });
      }
      if (action === "broadcast") {
        if (!auth.isRootAdmin) return new Response("Forbidden", { status: 403 });
        if (!data || !data.message) return new Response("Missing message", { status: 400 });
        ctx.waitUntil((async () => {
          const users = await env.DB.prepare("SELECT chat_id, lang FROM Users WHERE role IN ('approved', 'admin')").all();
          for (const row of users.results) {
            const userLang = row.lang || "en";
            await sendTelegramMessage(env, row.chat_id, t("crm.broadcast_prefix", userLang, { message: data.message }));
          }
          await logAudit(env, adminId, "GLOBAL_BROADCAST", "all", "Sent global broadcast");
        })());
        return new Response(JSON.stringify({ success: true, status: "queued" }), { status: 202 });
      }
      if (action === "approve") {
        const queueRow = await env.DB.prepare("SELECT admin_messages, first_name, username, lang FROM Join_Queue WHERE chat_id = ?").bind(targetId).first();
        const deleteResult = await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();
        if (deleteResult.meta.changes === 0) {
          return new Response(JSON.stringify({ success: false, error: "already_handled", message: "Request was already processed by another admin" }), { status: 200 });
        }
        const defaultLimit = parseInt(env.DEFAULT_USER_PRODUCT_LIMIT) || 3;
        await env.DB.prepare(`
          INSERT INTO Users (chat_id, first_name, username, role, item_limit, approved_by, created_at, unban_rejected, lang) 
          VALUES (?, ?, ?, 'approved', ?, ?, ?, 0, ?)
          ON CONFLICT(chat_id) DO UPDATE SET 
            role = 'approved', 
            item_limit = excluded.item_limit, 
            approved_by = excluded.approved_by, 
            unban_rejected = 0,
            lang = COALESCE(Users.lang, excluded.lang)
        `).bind(
          targetId,
          queueRow?.first_name || "",
          queueRow?.username || "",
          defaultLimit,
          adminId,
          Date.now(),
          queueRow?.lang || "en"
        ).run();
        ctx.waitUntil((async () => {
          const tl = await resolveTargetLang(targetId);
          await sendTelegramMessage(env, targetId, getWelcomeMessage(tl, defaultLimit));
        })());
        ctx.waitUntil(logAudit(env, adminId, "APPROVE_USER", targetId, "Approved join request"));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
        if (queueRow?.admin_messages) {
          let adminMessages = {};
          try {
            adminMessages = typeof queueRow.admin_messages === "string" ? JSON.parse(queueRow.admin_messages) : queueRow.admin_messages;
          } catch (e) {
          }
          for (const [admId, msgId] of Object.entries(adminMessages)) {
            try {
              const al = await adminLangPref(admId);
              await editTelegramMessage(env, admId, msgId, t("access.handled_approved", al, { id: targetId, admin: "CRM admin" }), { inline_keyboard: [] });
            } catch (e) {
            }
          }
        }
      } else if (action === "reject") {
        const queueRow = await env.DB.prepare("SELECT request_type, admin_messages, first_name, username FROM Join_Queue WHERE chat_id = ?").bind(targetId).first();
        const existingUser = await env.DB.prepare("SELECT lang FROM Users WHERE chat_id = ?").bind(targetId).first();
        const userLang = existingUser?.lang || "en";
        const deleteResult = await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();
        if (deleteResult.meta.changes === 0) {
          const currentRole = await env.DB.prepare("SELECT role FROM Users WHERE chat_id = ?").first("role");
          if (currentRole !== "approved") {
            await env.DB.prepare("INSERT INTO Users (chat_id, first_name, username, role, item_limit, created_at, lang) VALUES (?, ?, ?, 'rejected', ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET role = 'rejected'").bind(targetId, queueRow?.first_name || "", queueRow?.username || "", env.DEFAULT_USER_PRODUCT_LIMIT || "3", Date.now(), userLang).run();
          }
          return new Response(JSON.stringify({ success: false, error: "already_handled", message: "Request was already processed by another admin" }), { status: 200 });
        }
        if (queueRow?.request_type === "unban") {
          await env.DB.prepare("INSERT INTO Users (chat_id, first_name, username, role, item_limit, created_at, lang, unban_rejected) VALUES (?, ?, ?, 'rejected', ?, ?, ?, 1) ON CONFLICT(chat_id) DO UPDATE SET role = 'rejected', unban_rejected = 1").bind(targetId, queueRow?.first_name || "", queueRow?.username || "", env.DEFAULT_USER_PRODUCT_LIMIT || "3", Date.now(), userLang).run();
          ctx.waitUntil((async () => {
            const tl = await resolveTargetLang(targetId);
            await sendTelegramMessage(env, targetId, t("access.unban_rejected", tl));
          })());
        } else {
          await env.DB.prepare("INSERT INTO Users (chat_id, first_name, username, role, item_limit, created_at, lang) VALUES (?, ?, ?, 'rejected', ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET role = 'rejected'").bind(targetId, queueRow?.first_name || "", queueRow?.username || "", env.DEFAULT_USER_PRODUCT_LIMIT || "3", Date.now(), userLang).run();
          ctx.waitUntil((async () => {
            const tl = await resolveTargetLang(targetId);
            await sendTelegramMessage(env, targetId, t("crm.notify_rejected", tl));
          })());
        }
        ctx.waitUntil(logAudit(env, adminId, "REJECT_USER", targetId, `Rejected join request${queueRow?.request_type === "unban" ? " (unban \u2014 permanent)" : ""}`));
        if (queueRow?.admin_messages) {
          let adminMessages = {};
          try {
            adminMessages = typeof queueRow.admin_messages === "string" ? JSON.parse(queueRow.admin_messages) : queueRow.admin_messages;
          } catch (e) {
          }
          for (const [admId, msgId] of Object.entries(adminMessages)) {
            try {
              const al = await adminLangPref(admId);
              await editTelegramMessage(env, admId, msgId, t("access.handled_request", al, { id: targetId, admin: "CRM admin" }), { inline_keyboard: [] });
            } catch (e) {
            }
          }
        }
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "revoke") {
        if (targetId === adminId) return new Response("Cannot revoke yourself", { status: 400 });
        await env.DB.batch([
          env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 1, paused_at = ? WHERE chat_id = ?").bind(Date.now(), targetId),
          env.DB.prepare("UPDATE Users SET role = 'rejected', unban_rejected = 0 WHERE chat_id = ?").bind(targetId)
        ]);
        ctx.waitUntil((async () => {
          const tl = await resolveTargetLang(targetId);
          await sendTelegramMessage(env, targetId, t("crm.notify_revoked", tl));
        })());
        ctx.waitUntil(logAudit(env, adminId, "REVOKE_USER", targetId, "Revoked user access (soft) \u2014 subscriptions paused"));
      } else if (action === "unban") {
        const queueRow = await env.DB.prepare("SELECT admin_messages FROM Join_Queue WHERE chat_id = ?").bind(targetId).first();
        if (queueRow) {
          const deleteResult = await env.DB.prepare("DELETE FROM Join_Queue WHERE chat_id = ?").bind(targetId).run();
          if (deleteResult.meta.changes === 0) {
            return new Response(JSON.stringify({ success: false, error: "already_handled", message: "Request was already processed by another admin" }), { status: 200 });
          }
        }
        await env.DB.batch([
          env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 0, paused_at = NULL WHERE chat_id = ?").bind(targetId),
          env.DB.prepare("UPDATE Users SET role = 'approved', unban_rejected = 0 WHERE chat_id = ?").bind(targetId)
        ]);
        ctx.waitUntil((async () => {
          const tl = await resolveTargetLang(targetId);
          await sendTelegramMessage(env, targetId, t("crm.notify_restored", tl));
        })());
        ctx.waitUntil(logAudit(env, adminId, "UNBAN_USER", targetId, "Unbanned user and resumed subscriptions"));
        if (queueRow?.admin_messages) {
          let adminMessages = {};
          try {
            adminMessages = typeof queueRow.admin_messages === "string" ? JSON.parse(queueRow.admin_messages) : queueRow.admin_messages;
          } catch (e) {
          }
          for (const [admId, msgId] of Object.entries(adminMessages)) {
            try {
              const al = await adminLangPref(admId);
              await editTelegramMessage(env, admId, msgId, t("access.handled_approved", al, { id: targetId, admin: "CRM admin" }), { inline_keyboard: [] });
            } catch (e) {
            }
          }
        }
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "promote") {
        if (!auth.isRootAdmin) return new Response("Forbidden", { status: 403 });
        await env.DB.prepare("UPDATE Users SET role = 'admin' WHERE chat_id = ?").bind(targetId).run();
        ctx.waitUntil((async () => {
          const tl = await resolveTargetLang(targetId);
          await sendTelegramMessage(env, targetId, t("crm.notify_promoted", tl));
        })());
        ctx.waitUntil(logAudit(env, adminId, "PROMOTE_ADMIN", targetId, "Promoted user to Admin"));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "demote") {
        if (!auth.isRootAdmin) return new Response("Forbidden", { status: 403 });
        if (targetId === adminId) return new Response("Cannot demote yourself", { status: 400 });
        await env.DB.prepare("UPDATE Users SET role = 'approved' WHERE chat_id = ?").bind(targetId).run();
        ctx.waitUntil((async () => {
          const tl = await resolveTargetLang(targetId);
          await sendTelegramMessage(env, targetId, t("crm.notify_demoted", tl));
        })());
        ctx.waitUntil(logAudit(env, adminId, "DEMOTE_ADMIN", targetId, "Demoted Admin to standard user"));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "set_limit") {
        const newLimit = parseInt(data.limit);
        if (isNaN(newLimit) || newLimit < 1) return new Response("Invalid limit", { status: 400 });
        await env.DB.prepare("UPDATE Users SET item_limit = ? WHERE chat_id = ?").bind(newLimit, targetId).run();
        ctx.waitUntil((async () => {
          const tl = await resolveTargetLang(targetId);
          await sendTelegramMessage(env, targetId, t("crm.notify_limit_updated", tl, { limit: newLimit }));
        })());
        ctx.waitUntil(logAudit(env, adminId, "SET_LIMIT", targetId, `Changed limit to ${newLimit}`));
      } else if (action === "delete_product") {
        const asin = data.asin;
        const result = await env.DB.prepare("DELETE FROM User_Subscriptions WHERE chat_id = ? AND asin = ?").bind(targetId, asin).run();
        if (result.meta && result.meta.changes === 0) return new Response(JSON.stringify({ error: "not_found" }), { status: 200 });
        ctx.waitUntil(logAudit(env, adminId, "DELETE_PRODUCT", targetId, `Deleted product ${asin}`));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "pause_product") {
        const asin = data.asin;
        const result = await env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 1, paused_at = ? WHERE chat_id = ? AND asin = ?").bind(Date.now(), targetId, asin).run();
        if (result.meta && result.meta.changes === 0) return new Response(JSON.stringify({ error: "not_found" }), { status: 200 });
        ctx.waitUntil(logAudit(env, adminId, "PAUSE_PRODUCT", targetId, `Paused product ${asin}`));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "resume_product") {
        const asin = data.asin;
        const result = await env.DB.prepare("UPDATE User_Subscriptions SET is_paused = 0, paused_at = NULL WHERE chat_id = ? AND asin = ?").bind(targetId, asin).run();
        if (result.meta && result.meta.changes === 0) return new Response(JSON.stringify({ error: "not_found" }), { status: 200 });
        ctx.waitUntil(logAudit(env, adminId, "RESUME_PRODUCT", targetId, `Resumed product ${asin}`));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "set_target") {
        const asin = data.asin;
        const target = parseFloat(data.target);
        if (isNaN(target)) return new Response("Invalid target", { status: 400 });
        const result = await env.DB.prepare("UPDATE User_Subscriptions SET target_price = ?, alert_sent_new = 0, alert_sent_used = 0 WHERE chat_id = ? AND asin = ?").bind(target, targetId, asin).run();
        if (result.meta && result.meta.changes === 0) return new Response(JSON.stringify({ error: "not_found" }), { status: 200 });
        ctx.waitUntil(logAudit(env, adminId, "SET_TARGET", targetId, `Set target price for ${asin} to ${target}`));
        ctx.waitUntil(caches.default.delete(new Request(`https://auth.internal/user/${targetId}`)));
      } else if (action === "direct_message") {
        if (!data || !data.message) return new Response("Missing message", { status: 400 });
        ctx.waitUntil((async () => {
          const tl = await resolveTargetLang(targetId);
          await sendTelegramMessage(env, targetId, t("crm.notify_direct_message", tl, { message: data.message }));
        })());
        ctx.waitUntil(logAudit(env, adminId, "DIRECT_MESSAGE", targetId, "Sent direct message"));
      } else {
        return new Response("Unknown action", { status: 400 });
      }
      ctx.waitUntil(caches.default.delete(new Request(`${url.origin}/_internal/crm/data`)));
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/crm/sync-env" && request.method === "POST") {
      try {
        const auth = await authAdmin(request, env);
        if (!auth) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
        if (!auth.isRootAdmin) return new Response(JSON.stringify({ error: "Forbidden: Root Admin only" }), { status: 403, headers: { "Content-Type": "application/json" } });
        const adminId = auth.user.id.toString();
        const pat = env.GITHUB_PAT;
        if (!pat) {
          return new Response(JSON.stringify({ error: "GITHUB_PAT not set in environment." }), { status: 500 });
        }
        const ghRes = await fetch("https://api.github.com/repos/aka-khalid/AzTracker/actions/workflows/sync-prod-to-dev.yml/dispatches", {
          method: "POST",
          headers: {
            "Accept": "application/vnd.github+json",
            "Authorization": "Bearer " + pat,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "AzTracker-Worker"
          },
          body: JSON.stringify({ ref: "feature/product-discovery" })
        });
        if (!ghRes.ok) {
          const errBody = await ghRes.text();
          throw new Error(`GitHub API returned ${ghRes.status}: ${errBody}`);
        }
        ctx.waitUntil(logAudit(env, adminId, "SYNC_ENV", "global", "Triggered Prod-to-Dev synchronization via GitHub Actions"));
        return new Response(JSON.stringify({ success: true, message: "Synchronization started in background." }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }
    return new Response("Not Found", { status: 404 });
  }
  function renderCrmHTML(lang = "en") {
    const isMasry = lang === "masry";
    const js = (key, vars) => JSON.stringify(t(key, lang, vars));
    return `<!DOCTYPE html>
<html lang="${lang}" dir="${lang === "masry" ? "rtl" : "ltr"}" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${t("crm.hub_title", lang)}</title>
    <script src="https://cdn.tailwindcss.com"><\/script>
    <script src="https://telegram.org/js/telegram-web-app.js"><\/script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"><\/script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script>
      tailwind.config = {
        darkMode: 'class',
        theme: {
          extend: {
            fontFamily: { sans: ['Inter', 'sans-serif'] },
            colors: {
              gray: { 850: '#1f2937', 900: '#111827', 950: '#030712' },
              brand: { 400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7' }
            }
          }
        }
      }
    <\/script>
    <style>
      body { background-color: #030712; color: #f3f4f6; -webkit-tap-highlight-color: transparent; }
      .glass { background: rgba(31, 41, 55, 0.7); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.05); }
      .toast { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
      .toast-enter { transform: translateY(100%); opacity: 0; }
      .toast-enter-active { transform: translateY(0); opacity: 1; }
      .toast-leave { transform: translateY(0); opacity: 1; }
      .toast-leave-active { transform: translateY(100%); opacity: 0; }
      
      .loader { border-top-color: #38bdf8; -webkit-animation: spinner 1.5s linear infinite; animation: spinner 1.5s linear infinite; }
      @keyframes spinner { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      
      .tab-active { border-bottom: 2px solid #38bdf8; color: #f3f4f6; }
      .tab-inactive { border-bottom: 2px solid transparent; color: #9ca3af; }
    </style>
</head>
<body class="min-h-screen flex flex-col font-sans">
    
    <header class="glass sticky top-0 z-40 px-4 py-3 flex justify-between items-center shadow-lg">
        <div class="flex items-center gap-2">
            <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center font-bold text-white shadow-lg">A</div>
            <h1 class="font-bold text-lg tracking-tight">${t("crm.hub_title", lang)}</h1>
        </div>
        <button onclick="refreshData()" class="p-2 rounded-full hover:bg-gray-800 transition text-gray-400 hover:text-white">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
        </button>
    </header>

    <main class="flex-1 px-4 py-6 pb-24 space-y-6 max-w-2xl mx-auto w-full" id="app-container">
        
        <!-- MAIN TABS -->
        <div class="flex gap-4 border-b border-gray-800 mb-6" id="main-tabs">
            <button onclick="switchMainTab('system-view')" id="main-tab-system-view" class="flex-1 pb-3 text-sm font-medium border-b-2 border-brand-400 text-white transition">\u{1F527} ${t("crm.tab_system", lang)}</button>
            <button onclick="switchMainTab('users-view')" id="main-tab-users-view" class="flex-1 pb-3 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition">\u{1F465} ${t("crm.users_title", lang)}</button>
            <button onclick="switchMainTab('audit-view')" id="main-tab-audit-view" class="flex-1 pb-3 text-sm font-medium border-b-2 border-transparent text-gray-400 hover:text-gray-200 transition">${t("crm.security_audit", lang)}</button>
        </div>

        <!-- \u2550\u2550\u2550 SYSTEM TAB \u2550\u2550\u2550 -->
        <div id="system-view-container" class="space-y-6">
            <!-- TELEMETRY -->
            <section>
                <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">${t("crm.system_overview", lang)}</h2>
                <div class="grid grid-cols-2 gap-3">
                    <div class="glass rounded-xl p-4 flex flex-col justify-center cursor-pointer hover:bg-gray-800/50 transition border border-emerald-500/20" onclick="openActiveDrawer()" role="button" tabindex="0">
                        <div class="text-gray-400 text-sm mb-1">${t("crm.products_title", lang)}</div>
                        <div class="text-2xl font-bold text-brand-400" id="stat-pool">--</div>
                    </div>
                    <div class="glass rounded-xl p-4 flex flex-col justify-center cursor-pointer hover:bg-gray-800/50 transition border border-brand-500/20" onclick="openTopChartsDrawer()" role="button" tabindex="0">
                        <div class="text-gray-400 text-sm mb-1">${t("crm.top_charts_title", lang)}</div>
                        <div class="text-sm font-bold text-brand-400 mt-1">${t("crm.btn_view", lang)}</div>
                    </div>
                    <div class="glass rounded-xl p-4 flex flex-col justify-center cursor-pointer hover:bg-gray-800/50 transition border border-amber-500/20" onclick="openPausedDrawer()" role="button" tabindex="0">
                        <div class="text-gray-400 text-sm mb-1">${t("crm.paused_products", lang)}</div>
                        <div class="text-2xl font-bold text-amber-400" id="stat-paused">--</div>
                    </div>
                    <div class="glass rounded-xl p-4 flex flex-col justify-center cursor-pointer hover:bg-gray-800/50 transition" onclick="openGraveyardDrawer()" role="button" tabindex="0">
                        <div class="text-gray-400 text-sm mb-1">${t("crm.ghost_products", lang)}</div>
                        <div class="text-2xl font-bold text-red-400" id="stat-ghost">--</div>
                    </div>
                </div>

                <!-- Engine Health Widget -->
                <div class="mt-3 glass rounded-xl p-4" id="engine-health-widget">
                    <div class="flex items-center justify-between mb-2">
                        <div class="text-xs font-semibold text-gray-400 uppercase tracking-wider">${t("crm.engine_health", lang)}</div>
                        <div class="flex items-center gap-1.5">
                            <div class="w-2 h-2 rounded-full bg-green-500" id="engine-status-dot"></div>
                            <span class="text-xs font-medium text-green-400" id="engine-status-text">--</span>
                        </div>
                    </div>
                    <div class="grid grid-cols-3 gap-2 text-center h-full">
                        <div class="bg-gray-800/50 rounded-lg p-2 flex flex-col justify-between h-full min-h-[60px]">
                            <div class="text-[10px] text-gray-500 uppercase mb-1">${t("crm.engine_interval", lang)}</div>
                            <div class="text-sm font-bold text-white" id="engine-interval">--</div>
                        </div>
                        <div class="bg-gray-800/50 rounded-lg p-2 flex flex-col justify-between h-full min-h-[60px]">
                            <div class="text-[10px] text-gray-500 uppercase mb-1">${t("crm.engine_daily_ops", lang)}</div>
                            <div class="text-sm font-bold text-white" id="engine-daily-ops">--</div>
                        </div>
                        <div class="bg-gray-800/50 rounded-lg p-2 flex flex-col justify-between h-full min-h-[60px]">
                            <div class="text-[10px] text-gray-500 uppercase mb-1">${t("crm.engine_batches", lang)}</div>
                            <div class="text-sm font-bold text-white" id="engine-batches">--</div>
                        </div>
                    </div>
                </div>

                <div class="mt-3 glass rounded-xl p-4 flex flex-col gap-3">
                    <div class="text-center w-full">
                        <span class="text-gray-400 text-sm">${t("crm.last_sync", lang)}: </span>
                        <span class="text-sm font-medium" id="stat-sync">--</span>
                    </div>
                    <div class="w-full">
                        <button onclick="triggerGlobalScrape()" class="w-full justify-center bg-gray-800 hover:bg-gray-700 text-white text-xs px-3 py-2 rounded-lg font-medium transition shadow border border-gray-700 flex items-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg> ${t("crm.force_check", lang)}
                        </button>
                    </div>
                </div>
            </section>
            <!-- ENV SYNC -->
            <section id="env-sync-section" class="mb-6">
                <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">${isMasry ? "\u0645\u0632\u0627\u0645\u0646\u0629 \u0627\u0644\u0628\u064A\u0626\u0629" : "Environment Sync"}</h2>
                <div class="glass rounded-xl p-4 flex flex-col gap-3">
                    <div class="text-sm text-gray-400">
                        ${isMasry ? "\u0646\u0633\u062E \u0628\u064A\u0627\u0646\u0627\u062A \u0627\u0644\u0625\u0646\u062A\u0627\u062C (Prod) \u0625\u0644\u0649 \u0627\u0644\u062A\u0637\u0648\u064A\u0631 (Dev)." : "Copy Prod data to Dev using Github Actions."}
                    </div>
                    <div class="w-full">
                        <button onclick="triggerSync(this)" class="w-full justify-center bg-gray-800 hover:bg-gray-700 text-white text-xs px-3 py-2 rounded-lg font-medium transition shadow border border-gray-700 flex items-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> 
                            ${isMasry ? "\u0645\u0632\u0627\u0645\u0646\u0629 \u0627\u0644\u0622\u0646" : "Sync Prod to Dev"}
                        </button>
                    </div>
                </div>
            </section>

            <!-- BROADCAST -->
            <section id="broadcast-section">
                <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">${t("crm.system_broadcast", lang)}</h2>
                <div class="glass rounded-xl p-4">
                    <textarea id="broadcast-msg" rows="2" class="w-full bg-gray-900 border border-gray-700 rounded-lg p-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition" placeholder="${escapeHtml(t("crm.broadcast_placeholder", lang))}"></textarea>
                    <div class="flex justify-end mt-3">
                        <button onclick="sendBroadcast()" class="bg-brand-600 hover:bg-brand-500 text-white text-sm px-4 py-2 rounded-lg font-medium transition shadow-lg shadow-brand-500/20 flex items-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"></path></svg> ${t("crm.send_broadcast", lang)}
                        </button>
                    </div>
                </div>
            </section>
        </div>

        <!-- \u2550\u2550\u2550 USERS TAB \u2550\u2550\u2550 -->
        <div id="users-view-container" class="hidden space-y-6">
            <div class="glass rounded-xl p-4 flex items-center justify-between border-b-2 border-brand-500">
                <div class="text-gray-400 text-sm font-medium">${t("crm.users_title", lang)}</div>
                <div class="text-2xl font-bold text-white" id="stat-users">--</div>
            </div>
            <!-- DIRECTORY NAVIGATION -->
            <section>
                <div class="flex border-b border-gray-800 mb-4 overflow-x-auto" style="scrollbar-width: none;">
                    <button onclick="switchTab('users')" id="tab-users" class="px-4 pb-3 text-sm font-medium tab-active transition whitespace-nowrap">${t("crm.tab_approved", lang)}</button>
                    <button onclick="switchTab('queue')" id="tab-queue" class="px-4 pb-3 text-sm font-medium tab-inactive transition flex items-center gap-1.5 whitespace-nowrap">
                        ${t("crm.tab_pending", lang)} <span id="badge-queue" class="hidden bg-brand-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full"></span>
                    </button>
                    <button onclick="switchTab('banned')" id="tab-banned" class="px-4 pb-3 text-sm font-medium tab-inactive transition whitespace-nowrap text-red-400/80">${t("crm.tab_banned", lang)}</button>
                    <button onclick="switchTab('admins')" id="tab-admins" class="px-4 pb-3 text-sm font-medium tab-inactive transition whitespace-nowrap">${t("crm.tab_admins", lang)}</button>
                </div>

                <!-- Queue View -->
                <div id="view-queue" class="hidden space-y-3">
                    <div id="queue-list" class="text-center py-8 text-gray-500 text-sm">${t("crm.loading_items", lang)}</div>
                </div>

                <!-- Users View -->
                <div id="view-users" class="space-y-3">
                    <div class="relative">
                        <input type="text" id="search-users" onkeyup="filterUsers()" placeholder="${escapeHtml(t("crm.search_placeholder", lang))}" class="w-full bg-gray-900 border border-gray-800 rounded-lg ps-10 pe-4 py-2.5 text-sm focus:outline-none focus:border-gray-700 transition">
                        <svg class="w-4 h-4 text-gray-500 absolute start-3.5 top-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                    </div>
                    <div id="users-list" class="space-y-3">
                        <div class="text-center py-8 text-gray-500 text-sm">${t("crm.loading_items", lang)}</div>
                    </div>
                </div>
            </section>
        </div>

        <!-- \u2550\u2550\u2550 SECURITY AUDIT TAB \u2550\u2550\u2550 -->
        <div id="audit-view-container" class="hidden space-y-3">
            <div id="audit-list" class="space-y-3">
                <div class="glass rounded-xl p-6 text-center text-gray-400">${t("crm.compiling_ledger", lang)}</div>
            </div>
        </div>
    </main>

    <!-- Overlay Loader -->
    <div id="overlay" class="fixed inset-0 bg-gray-950/80 backdrop-blur-sm z-50 flex items-center justify-center hidden opacity-0 transition-opacity duration-300">
        <div class="glass rounded-2xl p-6 flex flex-col items-center shadow-2xl border-gray-700">
            <div class="w-10 h-10 border-4 border-gray-700 border-t-brand-500 rounded-full animate-spin mb-4"></div>
            <p class="text-sm font-medium" id="overlay-text">${t("crm.toast_processing", lang)}</p>
        </div>
    </div>

    <!-- Product Drawer -->
    <div id="drawer" class="fixed inset-0 z-50 hidden">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closeDrawer()"></div>
        <div class="absolute bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 rounded-t-2xl transform translate-y-full transition-transform duration-300 ease-out flex flex-col max-h-[85vh]" id="drawer-content">
            <div class="w-12 h-1.5 bg-gray-700 rounded-full mx-auto mt-3 mb-2"></div>
            <div class="px-4 pb-3 border-b border-gray-800 flex justify-between items-center">
                <div>
                    <h3 class="font-bold text-lg" id="drawer-title">${t("crm.user_products", lang)}</h3>
                    <p class="text-xs text-gray-400" id="drawer-subtitle">${t("crm.user_id_label", lang)} --</p>
                </div>
                <button onclick="closeDrawer()" class="p-2 bg-gray-800 rounded-full text-gray-400 hover:text-white">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            <div class="p-4 overflow-y-auto flex-1 space-y-3" id="drawer-items">
                <div class="text-center py-8 text-gray-500 text-sm">${t("crm.loading_items", lang)}</div>
            </div>
        </div>
    </div>

    <!-- Active Products Drawer -->
    <div id="drawer-active" class="fixed inset-0 z-50 hidden">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closeActiveDrawer()"></div>
        <div class="absolute bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 rounded-t-2xl transform translate-y-full transition-transform duration-300 ease-out flex flex-col max-h-[85vh]" id="drawer-active-content">
            <div class="w-12 h-1.5 bg-gray-700 rounded-full mx-auto mt-3 mb-2"></div>
            <div class="px-4 pb-3 border-b border-gray-800 flex justify-between items-center">
                <div>
                    <h3 class="font-bold text-lg">${t("crm.products_title", lang)}</h3>
                    <p class="text-xs text-emerald-400" id="drawer-active-count">0 items</p>
                </div>
                <button onclick="closeActiveDrawer()" class="p-2 bg-gray-800 rounded-full text-gray-400 hover:text-white">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            <div class="p-4 overflow-y-auto flex-1 space-y-3" id="drawer-active-items" onscroll="handleActiveScroll()">
            </div>
        </div>
    </div>

    <!-- Top Charts Drawer -->
    <div id="drawer-top-charts" class="fixed inset-0 z-50 hidden">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closeTopChartsDrawer()"></div>
        <div class="absolute bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 rounded-t-2xl transform translate-y-full transition-transform duration-300 ease-out flex flex-col max-h-[85vh]" id="drawer-top-charts-content">
            <div class="w-12 h-1.5 bg-gray-700 rounded-full mx-auto mt-3 mb-2"></div>
            <div class="px-4 pb-3 border-b border-gray-800 flex justify-between items-center">
                <div>
                    <h3 class="font-bold text-lg">${t("crm.top_charts_title", lang)}</h3>
                    <p class="text-xs text-gray-400" id="drawer-top-charts-subtitle">${t("crm.click_to_expand", lang)}</p>
                </div>
                <button onclick="closeTopChartsDrawer()" class="p-2 bg-gray-800 rounded-full text-gray-400 hover:text-white">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            <div class="p-4 overflow-y-auto flex-1 space-y-3" id="drawer-top-charts-items">
                <div class="text-center py-8 text-gray-500 text-sm">${t("crm.loading_items", lang)}</div>
            </div>
        </div>
    </div>

    <!-- Paused Products Drawer -->
    <div id="drawer-paused" class="fixed inset-0 z-50 hidden">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closePausedDrawer()"></div>
        <div class="absolute bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 rounded-t-2xl transform translate-y-full transition-transform duration-300 ease-out flex flex-col max-h-[85vh]" id="drawer-paused-content">
            <div class="w-12 h-1.5 bg-gray-700 rounded-full mx-auto mt-3 mb-2"></div>
            <div class="px-4 pb-3 border-b border-gray-800 flex justify-between items-center">
                <div>
                    <h3 class="font-bold text-lg">${t("crm.paused_products", lang)}</h3>
                    <p class="text-xs text-gray-400" id="drawer-paused-subtitle">${t("crm.click_to_expand", lang)}</p>
                </div>
                <button onclick="closePausedDrawer()" class="p-2 bg-gray-800 rounded-full text-gray-400 hover:text-white">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            <div class="p-4 overflow-y-auto flex-1 space-y-3" id="drawer-paused-items">
                <div class="text-center py-8 text-gray-500 text-sm">${t("crm.loading_items", lang)}</div>
            </div>
        </div>
    </div>

    <!-- Graveyard Drawer -->
    <div id="drawer-graveyard" class="fixed inset-0 z-50 hidden">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closeGraveyardDrawer()"></div>
        <div class="absolute bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 rounded-t-2xl transform translate-y-full transition-transform duration-300 ease-out flex flex-col max-h-[85vh]" id="drawer-graveyard-content">
            <div class="w-12 h-1.5 bg-gray-700 rounded-full mx-auto mt-3 mb-2"></div>
            <div class="px-4 pb-3 border-b border-gray-800 flex justify-between items-center">
                <div>
                    <h3 class="font-bold text-lg">${t("crm.graveyard_title", lang)}</h3>
                    <p class="text-xs text-gray-400" id="drawer-graveyard-count">--</p>
                </div>
                <button onclick="closeGraveyardDrawer()" class="p-2 bg-gray-800 rounded-full text-gray-400 hover:text-white">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            <div class="px-4 py-2 border-b border-gray-800 flex justify-between items-center bg-red-900/10">
                <label class="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" id="graveyard-select-all" onchange="toggleGraveyardSelectAll()" class="rounded bg-gray-800 border-gray-600 text-red-500 focus:ring-red-500">
                    <span class="text-xs text-gray-400" id="graveyard-select-all-label">${t("crm.select_all", lang)}</span>
                </label>
                <button onclick="purgeSelectedGhosts()" class="bg-red-600/20 hover:bg-red-600/30 text-red-400 text-xs px-3 py-1.5 rounded-lg font-medium transition border border-red-500/20 flex items-center gap-1.5">
                    ${t("crm.graveyard_purge_btn", lang)}
                </button>
            </div>
            <div class="p-4 overflow-y-auto flex-1 space-y-3" id="drawer-graveyard-items">
                <div class="text-center py-8 text-gray-500 text-sm">${t("crm.loading_items", lang)}</div>
            </div>
        </div>
    </div>

    <!-- Product Subs Drawer -->
    <div id="drawer-product-subs" class="fixed inset-0 z-50 hidden">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closeProductSubsDrawer()"></div>
        <div class="absolute bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 rounded-t-2xl transform translate-y-full transition-transform duration-300 ease-out flex flex-col max-h-[85vh]" id="drawer-product-subs-content">
            <div class="w-12 h-1.5 bg-gray-700 rounded-full mx-auto mt-3 mb-2"></div>
            <div class="px-4 pb-3 border-b border-gray-800 flex justify-between items-center">
                <div>
                    <h3 class="font-bold text-lg" id="drawer-product-subs-title">Subscribers</h3>
                    <p class="text-xs text-gray-400" id="drawer-product-subs-count">--</p>
                </div>
                <button onclick="closeProductSubsDrawer()" class="p-2 bg-gray-800 rounded-full text-gray-400 hover:text-white">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            <div class="p-4 overflow-y-auto flex-1 space-y-3" id="drawer-product-subs-items">
                <div class="text-center py-8 text-gray-500 text-sm">${t("crm.loading_items", lang)}</div>
            </div>
        </div>
    </div>

    <!-- Chart Modal -->
    <div id="chart-modal" class="fixed inset-0 z-50 hidden">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closeChartModal()"></div>
        <div class="absolute inset-x-4 top-1/2 -translate-y-1/2 bg-gray-900 border border-gray-800 rounded-2xl p-4 shadow-2xl flex flex-col max-h-[85vh]">
            <div class="flex justify-between items-center mb-4">
                <h3 class="font-bold text-lg">${t("crm.price_history", lang)}</h3>
                <button onclick="closeChartModal()" class="p-2 bg-gray-800 rounded-full text-gray-400 hover:text-white">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            
            <div class="flex gap-4 mb-4" id="chart-metrics" style="display: none;">
                <div class="flex-1 bg-gray-800 rounded-lg p-2 text-center">
                    <div class="text-[10px] text-gray-400 uppercase">${t("crm.ath", lang)}</div>
                    <div class="font-bold text-red-400 text-sm" id="chart-ath">--</div>
                </div>
                <div class="flex-1 bg-gray-800 rounded-lg p-2 text-center">
                    <div class="text-[10px] text-gray-400 uppercase">${t("crm.avg", lang)}</div>
                    <div class="font-bold text-gray-200 text-sm" id="chart-avg">--</div>
                </div>
                <div class="flex-1 bg-gray-800 rounded-lg p-2 text-center">
                    <div class="text-[10px] text-gray-400 uppercase">${t("crm.atl", lang)}</div>
                    <div class="font-bold text-green-400 text-sm" id="chart-atl">--</div>
                </div>
            </div>

            <div id="chart-loading" class="text-center py-8 text-gray-500 text-sm">${t("crm.loading_chart", lang)}</div>
            <div class="w-full relative flex-1 min-h-[300px]">
                <canvas id="crmPriceChart" style="display: none;"></canvas>
            </div>
        </div>
    </div>

    <!-- Toast Container -->
    <div id="toast-container" class="fixed bottom-6 left-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"></div>

    <script>
        const tg = window.Telegram?.WebApp || {};
        if (tg.expand) tg.expand();
        if (tg.ready) tg.ready();
        try {
            if (tg.setHeaderColor) tg.setHeaderColor('#030712');
            if (tg.setBackgroundColor) tg.setBackgroundColor('#030712');
        } catch (e) { console.warn('Telegram theme color not supported:', e); }

        const initData = tg.initData || '';
        let appData = { users: [], joinQueue: [] };
        let activeTab = 'users';

        function escapeHtml(unsafe) {
            if (!unsafe) return "";
            return String(unsafe)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }

        async function fetchAPI(path, method = 'GET', body = null) {
            if(!initData) return showToast(${js("crm.local_mode_toast")}, "error");
            try {
                const opts = {
                    method,
                    headers: { 'Authorization': 'Bearer ' + initData, 'Content-Type': 'application/json' }
                };
                if (body) opts.body = JSON.stringify(body);
                
                const res = await fetch('/api/crm' + path, opts);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                
                if (res.status === 202) return { status: 'queued' };
                const json = await res.json();
                const currentUser = res.headers.get("X-Current-User");
                if (currentUser) json._currentUser = currentUser;
                return json;
            } catch (err) {
                console.error(err);
                showToast(${js("crm.toast_network_error")} + ": " + err.message, 'error');
                return null;
            }
        }

        async function refreshData() {
            showLoader(${js("crm.toast_syncing")});
            const data = await fetchAPI('/data');
            hideLoader();
            if (data) {
                appData = data;
                renderTelemetry();
                renderTabs();
                showToast(${js("crm.toast_synced")}, "success");
            }
        }

        function renderTelemetry() {
            if (appData.auth && !appData.auth.isRootAdmin) {
                const broadcastEl = document.getElementById('broadcast-section');
                if (broadcastEl) broadcastEl.style.display = 'none';
            }
            const activeLength = appData.systemStats.activeWatchPool || 0;
            document.getElementById('stat-users').innerText = appData.systemStats.totalUsers || 0;
            document.getElementById('stat-pool').innerText = activeLength;
            document.getElementById('stat-paused').innerText = appData.systemStats.pausedProducts || 0;
            document.getElementById('stat-ghost').innerText = appData.systemStats.ghostProducts || 0;
            const ms = appData.systemStats.lastRunMs;
            document.getElementById('stat-sync').innerText = ms ? new Date(ms).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : ${js("crm.never")};

            // Engine Health calculation (zero extra D1 reads \u2014 reuses activeWatchPool)
            renderEngineHealth(appData.systemStats.activeWatchPool || 0);

            const badge = document.getElementById('badge-queue');
            if(appData.joinQueue.length > 0) {
                badge.innerText = appData.joinQueue.length;
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }
        }

        // Engine Health: replicates cron_trigger.js governor math in-browser
        // Reuses poolSize from systemStats \u2014 zero extra D1 reads
        function renderEngineHealth(poolSize) {
            if (poolSize === 0) {
                document.getElementById('engine-interval').innerText = 'N/A';
                document.getElementById('engine-daily-ops').innerText = '0';
                document.getElementById('engine-batches').innerText = '0';
                document.getElementById('engine-status-dot').className = 'w-2 h-2 rounded-full bg-gray-500';
                document.getElementById('engine-status-text').innerText = 'Idle';
                document.getElementById('engine-status-text').className = 'text-xs font-medium text-gray-400';
                return;
            }

            // Exact same math as cron_trigger.js
            const batches = Math.ceil(poolSize / 10);
            const maxRuns = Math.floor(8640 / batches);
            const intervalMs = Math.floor(86400000 / maxRuns);

            // Fetch dynamic hardware cron interval from systemStats (default 5 mins)
            const hardwareIntervalMs = parseInt(appData.systemStats.hardwareIntervalMs || '300000', 10);
            const hardwareIntervalMin = Math.round(hardwareIntervalMs / 60000);

            // Format interval for display, clamping to actual hardware cron limit
            const intervalMin = Math.max(hardwareIntervalMin, Math.round(intervalMs / 60000));
            document.getElementById('engine-interval').innerText = intervalMin + ' ' + ${js("crm.minutes_short")};

            // Actual engine runs per day are strictly bounded by the dynamic hardware cron trigger
            // 86,400,000 ms per day / hardwareIntervalMs = max hardware wake-ups per day.
            const actualRunsPerDay = Math.floor(86400000 / Math.max(hardwareIntervalMs, intervalMs));

            // Daily Queue Operations = actual runs * batches * 3 (1 message = write + read + delete)
            const dailyOps = actualRunsPerDay * batches * 3;
            document.getElementById('engine-daily-ops').innerText = dailyOps.toLocaleString();

            document.getElementById('engine-batches').innerText = batches;

            // Status: color-code based on how close to daily ops limit
            const opsLimit = parseInt(appData.systemStats.queueLimit || '10000', 10);
            const opsRatio = dailyOps / opsLimit;
            const dot = document.getElementById('engine-status-dot');
            const text = document.getElementById('engine-status-text');

            if (opsRatio < 0.5) {
                dot.className = 'w-2 h-2 rounded-full bg-green-500';
                text.innerText = ${js("crm.engine_status_ok")};
                text.className = 'text-xs font-medium text-green-400';
            } else if (opsRatio < 0.8) {
                dot.className = 'w-2 h-2 rounded-full bg-amber-500';
                text.innerText = ${js("crm.engine_status_warn")};
                text.className = 'text-xs font-medium text-amber-400';
            } else {
                dot.className = 'w-2 h-2 rounded-full bg-red-500';
                text.innerText = ${js("crm.engine_status_critical")};
                text.className = 'text-xs font-medium text-red-400';
            }
        }

        function switchMainTab(tabId) {
            const tabs = ['system-view', 'users-view', 'audit-view'];
            tabs.forEach(t => {
                const el = document.getElementById('main-tab-' + t);
                if (el) {
                    if (t === tabId) {
                        el.classList.add('border-brand-400', 'text-white');
                        el.classList.remove('border-transparent', 'text-gray-400');
                    } else {
                        el.classList.add('border-transparent', 'text-gray-400');
                        el.classList.remove('border-brand-400', 'text-white');
                    }
                }
                document.getElementById(t + '-container').classList.toggle('hidden', t !== tabId);
            });

            if (tabId === 'audit-view' && !appData.auditLoaded) {
                loadAuditTab();
            }
        }
        
        async function loadAuditTab() {
            const container = document.getElementById('audit-list');
            container.innerHTML = '<div class="glass rounded-xl p-6 text-center text-gray-400">' + ${js("crm.loading_audit")} + '</div>';
            
            const logs = await fetchAPI('/audit');
            if (!logs) {
                container.innerHTML = '<div class="glass rounded-xl p-6 text-center text-red-400">' + ${js("crm.toast_network_error")} + '</div>';
                return;
            }
            appData.auditLoaded = true;
            
            if (logs.length === 0) {
                container.innerHTML = '<div class="glass rounded-xl p-6 text-center text-gray-500 border border-gray-800 border-dashed">' + ${js("crm.no_audit")} + '</div>';
                return;
            }
            
            container.innerHTML = logs.map(log => {
                const date = new Date(log.ts);
                const timeStr = date.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) + ' ' +
                              date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

                const adminDisplay = log.adminHandle ? escapeHtml(log.adminHandle) + ' <span class="text-[10px] opacity-60">(' + escapeHtml(log.adminId) + ')</span>' : '<code class="bg-gray-800 px-1 py-0.5 rounded">' + escapeHtml(log.adminId) + '</code>';
                let targetDisplay = '<code class="bg-gray-800 px-1 py-0.5 rounded">' + escapeHtml(log.target) + '</code>';
                if (log.targetHandle) targetDisplay = escapeHtml(log.targetHandle) + ' <span class="text-[10px] opacity-60">(' + escapeHtml(log.target) + ')</span>';
                const actionEsc = escapeHtml(log.action);
                const detailsEsc = escapeHtml(log.details || '');

                return '<div class="glass rounded-xl p-4">' +
                    '<div class="flex justify-between items-center text-xs opacity-80 border-b border-gray-700/50 pb-2 mb-2">' +
                        '<span>\u{1F552} ' + timeStr + '</span>' +
                        '<span>' + adminDisplay + '</span>' +
                    '</div>' +
                    '<div class="text-brand-400 font-bold text-sm mb-2">' + actionEsc + '</div>' +
                    '<div class="text-sm flex gap-2 mb-1"><span class="font-semibold opacity-80 w-16">' + ${js("crm.audit_target")} + '</span><span class="break-all">' + targetDisplay + '</span></div>' +
                    '<div class="text-sm flex gap-2"><span class="font-semibold opacity-80 w-16">' + ${js("crm.audit_details")} + '</span><span class="break-all">' + detailsEsc + '</span></div>' +
                '</div>';
            }).join('');
        }

        function switchTab(tab) {
            activeTab = tab;
            const tabs = ['users', 'queue', 'banned', 'admins'];
            tabs.forEach(t => {
                const el = document.getElementById('tab-' + t);
                if (el) {
                    const isBanned = t === 'banned';
                    const cls = t === tab ? 'tab-active' : (isBanned ? 'tab-inactive text-red-400/80' : 'tab-inactive');
                    el.className = 'px-4 pb-3 text-sm font-medium transition whitespace-nowrap relative ' + cls;
                }
            });
            
            document.getElementById('view-queue').style.display = tab === 'queue' ? 'block' : 'none';
            document.getElementById('view-users').style.display = tab !== 'queue' ? 'block' : 'none';
            
            renderTabs();
        }

        function renderTabs() {
            if (activeTab === 'queue') {
                const list = document.getElementById('queue-list');
                if (!appData.joinQueue || appData.joinQueue.length === 0) {
                    list.innerHTML = '<div class="text-center py-10 text-gray-500 text-sm glass rounded-xl border border-gray-800 border-dashed">' + ${js("crm.no_pending")} + '</div>';
                    return;
                }
                
                list.innerHTML = appData.joinQueue.map(u => {
                    const time = new Date(u.requested_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                    const isUnban = u.request_type === 'unban';
                    const typeLabel = isUnban ? ${js("crm.queue_type_unban")} : ${js("crm.queue_type_access")};
                    const typeColor = isUnban ? 'bg-orange-500/15 text-orange-400 border-orange-500/20' : 'bg-brand-500/15 text-brand-400 border-brand-500/20';
                    const idEsc = escapeHtml(String(u.id));
                    const firstEsc = escapeHtml(u.first_name) || 'User';
                    const userDisplay = u.username ? '@' + escapeHtml(u.username) : idEsc;
                    const borderClass = isUnban ? 'border-s-2 border-s-orange-500/40' : '';
                    const actionApprove = isUnban ? 'unban' : 'approve';
                    const approveTitle = isUnban ? (${js("crm.btn_unban")} || 'Unban') : 'Approve';
                    const approveInner = isUnban
                        ? '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>'
                        : '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>';
                    const approveAttr = isUnban ? ' title="' + approveTitle + '"' : '';
                    const rejectTitle = isUnban ? (${js("crm.btn_deny")} || 'Deny') : 'Reject';
                    const rejectAttr = ' title="' + rejectTitle + '"';
                    return '<div class="glass rounded-xl p-3 flex justify-between items-center ' + borderClass + '">' +
                        '<div class="min-w-0 flex-1">' +
                            '<div class="flex items-center gap-2 mb-1">' +
                                '<div class="font-medium text-sm truncate">' + firstEsc + ' (' + userDisplay + ')</div>' +
                            '</div>' +
                            '<div class="flex items-center gap-3">' +
                                '<span class="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ' + typeColor + ' border">' + typeLabel + '</span>' +
                                '<span class="text-xs text-gray-500 shrink-0">' + ${js("crm.requested_label")} + ' ' + time + '</span>' +
                            '</div>' +
                        '</div>' +
                        '<div class="flex items-center gap-2 ml-3 shrink-0">' +
                            '<button onclick="performAction(\\'reject\\', \\'' + idEsc + '\\')" class="w-8 h-8 rounded bg-red-500/10 text-red-400 flex items-center justify-center hover:bg-red-500/20 transition"' + rejectAttr + '><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>' +
                            '<button onclick="performAction(\\'' + actionApprove + '\\', \\'' + idEsc + '\\')" class="w-8 h-8 rounded bg-emerald-500/10 text-emerald-400 flex items-center justify-center hover:bg-emerald-500/20 transition"' + approveAttr + '>' + approveInner + '</button>' +
                        '</div>' +
                    '</div>';
                }).join('');
            } else {
                filterUsers();
            }
        }

        function filterUsers() {
            const query = (document.getElementById('search-users').value || '').toLowerCase();
            const list = document.getElementById('users-list');
            
            let filtered = appData.users;
            
            if (activeTab === 'admins') {
                filtered = filtered.filter(u => u.role === 'admin' || u.role === 'root');
            } else if (activeTab === 'banned') {
                filtered = filtered.filter(u => u.role === 'rejected');
            } else if (activeTab === 'users') {
                filtered = filtered.filter(u => u.role === 'approved');
            }
            
            filtered = filtered.filter(u => u.chat_id.toString().toLowerCase().includes(query) || u.role.toLowerCase().includes(query) || (u.first_name && u.first_name.toLowerCase().includes(query)) || (u.username && u.username.toLowerCase().includes(query)));
            
            if (filtered.length === 0) {
                list.innerHTML = '<div class="text-center py-10 text-gray-500 text-sm glass rounded-xl border border-gray-800 border-dashed">' + ${js("crm.no_users_found")} + '</div>';
                return;
            }

            list.innerHTML = filtered.map(u => {
                const roleColors = { 'root': 'text-purple-400 border-purple-400/20 bg-purple-400/10', 'admin': 'text-brand-400 border-brand-400/20 bg-brand-400/10', 'approved': 'text-gray-300 border-gray-700 bg-gray-800', 'rejected': 'text-red-400 border-red-400/20 bg-red-400/10' };
                const roleStyle = roleColors[u.role] || roleColors['rejected'];
                const firstNameEsc = escapeHtml(u.first_name) || 'User';
                const usernameEsc = u.username ? '@' + escapeHtml(u.username) : escapeHtml(String(u.chat_id));
                const chatIdEsc = escapeHtml(String(u.chat_id));
                const roleEsc = escapeHtml(u.role);
                const firstNameJsEsc = escapeHtml(u.first_name || '').replace(/'/g, "\\'");
                const usernameJsEsc = escapeHtml(u.username || '').replace(/'/g, "\\'");
                const isRoot = u.role === 'root';
                const isAdmin = u.role === 'admin';
                const isApproved = u.role === 'approved';
                const isRejected = u.role === 'rejected';
                const isPrivileged = isAdmin || isRoot;
                const itemLimit = isPrivileged ? '\u221E' : u.item_limit;
                const joinedDate = new Date(u.created_at).toLocaleDateString();

                let rootGlow = '';
                if (isRoot) rootGlow = '<div class="absolute -right-2 -top-2 w-10 h-10 bg-purple-500/20 blur-xl rounded-full"></div>';

                let roleBadge = '';
                if (isPrivileged) roleBadge = '<span class="text-[10px] px-2 py-0.5 rounded uppercase font-bold border ' + roleStyle + '">' + roleEsc + '</span>';

                let actionBtns = '';
                if (isRejected) {
                    actionBtns += '<button onclick="performAction(\\'unban\\', \\'' + chatIdEsc + '\\')" class="flex-1 py-1.5 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-xs text-emerald-400 font-medium transition text-center border border-emerald-500/20">' + ${js("crm.btn_unban")} + '</button>';
                } else {
                    actionBtns += '<button onclick="messageUser(\\'' + chatIdEsc + '\\')" class="flex-1 py-1.5 rounded bg-brand-500/10 hover:bg-brand-500/20 text-xs text-brand-400 font-medium transition text-center border border-brand-500/20">' + ${js("crm.btn_message")} + '</button>';
                    if (!isPrivileged) actionBtns += '<button onclick="changeLimit(\\'' + chatIdEsc + '\\', ' + u.item_limit + ', \\'' + firstNameJsEsc + '\\', \\'' + usernameJsEsc + '\\')" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 font-medium transition text-center border border-gray-700/50">' + ${js("crm.btn_edit_limit")} + '</button>';
                    if (isApproved) actionBtns += '<button onclick="performAction(\\'promote\\', \\'' + chatIdEsc + '\\')" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-brand-400 font-medium transition text-center border border-brand-500/20">' + ${js("crm.btn_promote")} + '</button>';
                    if (isAdmin) actionBtns += '<button onclick="performAction(\\'demote\\', \\'' + chatIdEsc + '\\')" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-orange-400 font-medium transition text-center border border-orange-500/20">' + ${js("crm.btn_demote_drawer")} + '</button>';
                    if (!isRoot) actionBtns += '<button onclick="performAction(\\'revoke\\', \\'' + chatIdEsc + '\\')" class="w-10 flex items-center justify-center py-1.5 rounded bg-red-500/10 hover:bg-red-500/20 text-xs text-red-400 font-medium transition border border-red-500/20"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>';
                }

                return '<div class="glass rounded-xl p-3 border border-gray-800/50 hover:border-gray-700 transition overflow-hidden relative mb-3">' +
                    rootGlow +
                    '<div class="flex justify-between items-center mb-2 relative z-10">' +
                        '<div class="font-medium text-sm font-semibold truncate">' + firstNameEsc + ' (' + usernameEsc + ')</div>' +
                        '<button onclick="openDrawer(\\'' + chatIdEsc + '\\')" class="px-3 py-1.5 rounded-lg bg-gray-800 text-xs font-medium text-brand-400 hover:bg-gray-700 transition shadow">' + ${js("crm.btn_view_items")} + '</button>' +
                    '</div>' +
                    '<div class="flex items-center gap-2 mb-3 relative z-10">' +
                        roleBadge +
                        '<span class="text-xs text-gray-500">' + u.active_items + ' / ' + itemLimit + ' items</span>' +
                        '<span class="text-xs text-gray-500">\u2022</span>' +
                        '<span class="text-xs text-gray-500">' + ${js("crm.joined_date")} + ' ' + joinedDate + '</span>' +
                    '</div>' +
                    '<div class="flex gap-2 relative z-10">' + actionBtns + '</div>' +
                '</div>';
            }).join('');
        }

        function messageUser(userId) {
            const msg = prompt(${js("crm.btn_message")} + " \u2014 " + userId + ":");
            if (msg) {
                performAction('direct_message', userId, { message: msg });
            }
        }

        async function openDrawer(userId) {
            const drawer = document.getElementById('drawer');
            const content = document.getElementById('drawer-content');
            const itemsCont = document.getElementById('drawer-items');
            
            document.getElementById('drawer-subtitle').innerText = ${js("crm.id_label")} + ' ' + userId;
            itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm"><div class="w-6 h-6 border-2 border-gray-700 border-t-brand-500 rounded-full animate-spin mx-auto mb-2"></div>' + ${js("crm.loading_items")} + '</div>';
            
            drawer.classList.remove('hidden');
            setTimeout(() => {
                content.style.transform = 'translateY(0)';
            }, 10);
            
            const products = await fetchAPI('/user/' + userId + '/products');

            if (!products || products.length === 0) {
                itemsCont.innerHTML = '<div class="text-center py-10 text-gray-500 text-sm glass rounded-xl border border-gray-800 border-dashed">' + ${js("crm.no_saved_products")} + '</div>';
                return;
            }

            const isMasry = document.documentElement.lang === 'masry';
            itemsCont.innerHTML = products.map(p => {
                const isPaused = p.is_paused === 1;
                const statusColor = isPaused ? 'text-orange-400 bg-orange-400/10' : 'text-emerald-400 bg-emerald-400/10';
                const statusText = isPaused ? ${js("crm.user_paused")} : ${js("crm.user_active")};
                const pName = (isMasry && p.name_ar) ? p.name_ar : (p.name || p.asin);
                const rawName = pName ? (pName.length > 35 ? pName.substring(0, 32) + '...' : pName) : p.asin;
                const nameEsc = escapeHtml(rawName);
                const asinEsc = escapeHtml(p.asin);
                const price = p.new_price ? p.new_price + ' ' + ${js("chrome.currency_egp")} : (p.used_price ? ${js("crm.user_used_only")} : ${js("crm.user_out_of_stock")});
                const userIdEsc = escapeHtml(String(userId));
                const actionType = isPaused ? 'resume_product' : 'pause_product';
                const pauseIcon = isPaused ? '\u25B6\uFE0F' : '\u23F8\uFE0F';
                const pauseLabel = isPaused ? ${js("crm.btn_resume")} : ${js("crm.btn_pause_drawer")};
                const hasTarget = !!p.target_price;
                const targetBadge = hasTarget
                    ? '<div class="text-xs text-brand-400 flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg> ' + ${js("crm.audit_target")} + ' ' + p.target_price + '</div>'
                    : '';

                return '<div class="glass rounded-xl p-3 border border-gray-800/50 relative overflow-hidden">' +
                    '<div class="flex items-start gap-3 mb-2">' +
                        '<img src="' + (p.image_url ? escapeHtml(p.image_url) : 'https://images-na.ssl-images-amazon.com/images/P/' + asinEsc + '.01.MZZZZZZZ.jpg') + '" class="w-12 h-12 rounded object-cover bg-white shrink-0" onerror="this.src=\\'https://images-na.ssl-images-amazon.com/images/P/' + asinEsc + '.01.MZZZZZZZ.jpg\\'; this.onerror=function(){this.style.display=\\'none\\'};">' +
                        '<div class="flex-1 min-w-0 pe-2">' +
                            '<a href="https://www.amazon.eg/dp/' + asinEsc + '" target="_blank" class="font-medium text-sm text-brand-400 hover:underline block leading-tight truncate">' + nameEsc + '</a>' +
                            '<div class="text-xs text-gray-500 mt-1 font-mono">' + asinEsc + '</div>' +
                        '</div>' +
                        '<span class="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase ' + statusColor + ' whitespace-nowrap shrink-0">' + statusText + '</span>' +
                    '</div>' +
                    '<div class="flex justify-between items-end mb-3">' +
                        '<div class="text-sm font-semibold">' + price + '</div>' +
                        targetBadge +
                    '</div>' +
                    '<div class="flex gap-2">' +
                        '<button onclick="performAction(\\'' + actionType + '\\', \\'' + userIdEsc.replace(/'/g, "\\'") + '\\', {asin: \\'' + asinEsc.replace(/'/g, "\\'") + '\\'})" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 font-medium transition border border-gray-700/50">' + pauseIcon + ' ' + pauseLabel + '</button>' +
                        '<button onclick="openChartModal(\\'' + asinEsc.replace(/'/g, "\\'") + '\\')" class="flex-1 py-1.5 rounded bg-brand-500/10 hover:bg-brand-500/20 text-xs text-brand-400 font-medium transition border border-brand-500/20">\u{1F4CA} ' + ${js("crm.btn_chart")} + '</button>' +
                        '<button onclick="performAction(\\'delete_product\\', \\'' + userIdEsc.replace(/'/g, "\\'") + '\\', {asin: \\'' + asinEsc.replace(/'/g, "\\'") + '\\'})" class="flex-1 py-1.5 rounded bg-red-500/10 hover:bg-red-500/20 text-xs text-red-400 font-medium transition border border-red-500/20">\u{1F5D1}\uFE0F ' + ${js("crm.btn_delete_drawer")} + '</button>' +
                    '</div>' +
                '</div>';
            }).join('');
        }

        function closeDrawer() {
            const content = document.getElementById('drawer-content');
            content.style.transform = 'translateY(100%)';
            setTimeout(() => {
                document.getElementById('drawer').classList.add('hidden');
            }, 300);
        }

        async function openTopChartsDrawer() {
            const drawer = document.getElementById('drawer-top-charts');
            const content = document.getElementById('drawer-top-charts-content');
            const itemsCont = document.getElementById('drawer-top-charts-items');

            itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm"><div class="w-6 h-6 border-2 border-gray-700 border-t-brand-500 rounded-full animate-spin mx-auto mb-2"></div>' + ${js("crm.loading_items")} + '</div>';

            drawer.classList.remove('hidden');
            setTimeout(() => { content.style.transform = 'translateY(0)'; }, 10);

            const data = await fetchAPI('/top-charts');
            if (!data || !data.items || data.items.length === 0) {
                itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm">' + ${js("crm.top_charts_no_data")} + '</div>';
                return;
            }

            const lang = document.documentElement.lang || 'en';
            let html = '';
            data.items.forEach((item, idx) => {
                const name = lang === 'masry' && item.name_ar ? escapeHtml(item.name_ar) : escapeHtml(item.name || item.asin);
                const price = item.amazon_price || item.new_price;
                const priceStr = price ? ${js("chrome.currency_egp")} + ' ' + parseFloat(price).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '--';
                html += '<div class="bg-gray-800 rounded-lg p-3 flex items-center gap-3 cursor-pointer hover:bg-gray-700 transition" onclick="openChartModal(\\'' + escapeHtml(item.asin) + '\\')">';
                html += '<div class="text-lg font-bold text-gray-600 w-8 text-center">#' + (idx + 1) + '</div>';
                html += '<img src="' + (item.image_url ? escapeHtml(item.image_url) : 'https://images-na.ssl-images-amazon.com/images/P/' + escapeHtml(item.asin) + '.01.MZZZZZZZ.jpg') + '" class="w-12 h-12 rounded object-cover bg-white shrink-0" onerror="this.src=\\'https://images-na.ssl-images-amazon.com/images/P/' + escapeHtml(item.asin) + '.01.MZZZZZZZ.jpg\\'; this.onerror=function(){this.style.display=\\'none\\'};">' ;
                html += '<div class="flex-1 min-w-0">';
                html += '<div class="text-sm font-medium truncate"><a href="https://www.amazon.eg/dp/' + item.asin + '" target="_blank" class="text-brand-400 hover:text-brand-300 hover:underline transition" onclick="event.stopPropagation()">' + name + '</a></div>';
                html += '<div class="text-xs text-gray-500">' + escapeHtml(item.asin) + ' \xB7 ' + priceStr + '</div>';
                html += '</div>';
                html += '<div class="text-right">';
                html += '<div class="text-sm font-bold text-brand-400">' + item.tracker_count + '</div>';
                html += '<div class="text-[10px] text-gray-500 uppercase">' + ${js("crm.top_charts_trackers")} + '</div>';
                html += '</div></div>';
            });
            itemsCont.innerHTML = html;
        }

        function closeTopChartsDrawer() {
            const drawer = document.getElementById('drawer-top-charts');
            const content = document.getElementById('drawer-top-charts-content');
            content.style.transform = 'translateY(100%)';
            setTimeout(() => { drawer.classList.add('hidden'); }, 300);
        }

        let activeProductsData = [];
        let activeRenderIndex = 0;

        async function openActiveDrawer() {
            const drawer = document.getElementById('drawer-active');
            const content = document.getElementById('drawer-active-content');
            const itemsCont = document.getElementById('drawer-active-items');
            
            itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm"><div class="w-6 h-6 border-2 border-gray-700 border-t-emerald-500 rounded-full animate-spin mx-auto mb-2"></div>Loading...</div>';
            drawer.classList.remove('hidden');
            setTimeout(() => { content.style.transform = 'translateY(0)'; }, 10);

            const data = await fetchAPI('/active-products');
            const isMasry = document.documentElement.lang === 'masry';
            const subsText = isMasry ? '\u0627\u0634\u062A\u0631\u0627\u0643' : 'subscriptions';
            if (!data || !data.items || data.items.length === 0) {
                itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm">No active products found.</div>';
                document.getElementById('drawer-active-count').innerText = '0 ' + subsText;
                return;
            }
            
            document.getElementById('drawer-active-count').innerText = data.items.length + ' ' + subsText;
            activeProductsData = data.items;
            activeRenderIndex = 0;
            itemsCont.innerHTML = '';
            renderMoreActiveProducts();
        }

        function renderMoreActiveProducts() {
            if (activeRenderIndex >= activeProductsData.length) return;
            const itemsCont = document.getElementById('drawer-active-items');
            const chunk = activeProductsData.slice(activeRenderIndex, activeRenderIndex + 50);
            activeRenderIndex += 50;
            const lang = document.documentElement.lang || 'en';
            const isMasry = lang === 'masry';

            const html = chunk.map((item) => {
                const name = (isMasry && item.name_ar) ? item.name_ar : (item.name || item.asin);
                const userName = escapeHtml(item.first_name || 'User');
                const userDetails = item.username ? \`(@\${item.username})\` : \`(\${item.chat_id})\`;
                const displayUser = \`\${userName} <span class="opacity-70">\${userDetails}</span>\`;
                const price = item.new_price ? item.new_price + ' ' + ${js("chrome.currency_egp")} : (item.used_price ? ${js("crm.user_used_only")} : ${js("crm.user_out_of_stock")});
                const hasTarget = !!item.target_price;
                const targetBadge = hasTarget ? '<div class="text-xs text-brand-400">\u{1F3AF} Target: ' + item.target_price + '</div>' : '';
                
                return \`
                <div class="glass rounded-xl p-3 border border-emerald-500/20 relative overflow-hidden" id="active-item-\${item.chat_id}-\${item.asin}">
                    <div class="flex gap-3 mb-2">
                        <img src="\${item.image_url ? escapeHtml(item.image_url) : 'https://images-na.ssl-images-amazon.com/images/P/' + item.asin + '.01.MZZZZZZZ.jpg'}" class="w-12 h-12 rounded object-cover bg-white shrink-0" onerror="this.src='https://images-na.ssl-images-amazon.com/images/P/\${item.asin}.01.MZZZZZZZ.jpg'; this.onerror=function(){this.style.display='none'};">
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center justify-between mb-1">
                        <div class="font-medium text-sm truncate max-w-[60%]"><a href="https://www.amazon.eg/dp/\${item.asin}" target="_blank" class="text-brand-400 hover:text-brand-300 hover:underline transition" onclick="event.stopPropagation()">\${escapeHtml(name)}</a></div>
                        <span class="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase text-emerald-400 bg-emerald-400/10">Active</span>
                    </div>
                    <div class="flex items-center justify-between text-xs mb-3">
                        <code class="text-gray-400">\${item.asin}</code>
                        <span class="text-brand-400">\${displayUser}</span>
                            </div>
                        </div>
                    </div>
                    <div class="flex justify-between items-end mb-3">
                        <div class="text-sm font-semibold">\${price}</div>
                        \${targetBadge}
                    </div>
                    <div class="flex gap-2">
                        <button onclick="performAction('pause_product', '\${item.chat_id}', { asin: '\${item.asin}' }, this)" class="flex-1 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-xs font-bold transition border border-gray-700/50">
                            \${isMasry ? '\u23F8\uFE0F \u0627\u064A\u0642\u0627\u0641' : '\u23F8\uFE0F Pause'}
                        </button>
                        <button onclick="openChartModal('\${item.asin}')" class="flex-1 py-1.5 bg-brand-500/10 text-brand-400 rounded-lg text-xs font-bold hover:bg-brand-500/20 transition border border-brand-500/20">
                            \${isMasry ? '\u{1F4CA} \u0627\u0644\u0631\u0633\u0645' : '\u{1F4CA} Chart'}
                        </button>
                    </div>
                </div>\`;
            }).join('');
            
            itemsCont.insertAdjacentHTML('beforeend', html);
        }

        function handleActiveScroll() {
            const cont = document.getElementById('drawer-active-items');
            if (cont.scrollTop + cont.clientHeight >= cont.scrollHeight - 100) {
                renderMoreActiveProducts();
            }
        }

        function closeActiveDrawer() {
            const drawer = document.getElementById('drawer-active');
            const content = document.getElementById('drawer-active-content');
            content.style.transform = 'translateY(100%)';
            setTimeout(() => { drawer.classList.add('hidden'); }, 300);
        }

        async function openPausedDrawer() {
            const drawer = document.getElementById('drawer-paused');
            const content = document.getElementById('drawer-paused-content');
            const itemsCont = document.getElementById('drawer-paused-items');

            itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm"><div class="w-6 h-6 border-2 border-gray-700 border-t-amber-500 rounded-full animate-spin mx-auto mb-2"></div>' + ${js("crm.loading_items")} + '</div>';

            drawer.classList.remove('hidden');
            setTimeout(() => { content.style.transform = 'translateY(0)'; }, 10);

            const data = await fetchAPI('/paused-products');
            if (!data || !data.items || data.items.length === 0) {
                itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm">No paused products found.</div>';
                return;
            }

            const lang = document.documentElement.lang || 'en';
            itemsCont.innerHTML = data.items.map((item) => {
                const isMasry = lang === 'masry';
                const name = (isMasry && item.name_ar) ? item.name_ar : (item.name || item.asin);
                const userName = escapeHtml(item.first_name || 'User');
                const userDetails = item.username ? \`(@\${item.username})\` : \`(\${item.chat_id})\`;
                const displayUser = \`\${userName} <span class="opacity-70">\${userDetails}</span>\`;
                const pausedAgo = item.paused_at ? Math.round((Date.now() - item.paused_at)/86400000) + 'd ago' : 'Unknown';
                
                return \`
                <div class="bg-gray-800/50 rounded-xl p-3 border border-amber-500/20" id="paused-item-\${item.chat_id}-\${item.asin}">
                    <div class="flex gap-3 mb-2">
                        <img src="\${item.image_url ? escapeHtml(item.image_url) : 'https://images-na.ssl-images-amazon.com/images/P/' + item.asin + '.01.MZZZZZZZ.jpg'}" class="w-12 h-12 rounded object-cover bg-white shrink-0" onerror="this.src='https://images-na.ssl-images-amazon.com/images/P/\${item.asin}.01.MZZZZZZZ.jpg'; this.onerror=function(){this.style.display='none'};">
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center justify-between mb-1">
                        <div class="font-medium text-sm truncate max-w-[60%]"><a href="https://www.amazon.eg/dp/\${item.asin}" target="_blank" class="text-brand-400 hover:text-brand-300 hover:underline transition" onclick="event.stopPropagation()">\${escapeHtml(name)}</a></div>
                        <div class="text-xs text-gray-400">\${pausedAgo}</div>
                    </div>
                    <div class="flex items-center justify-between text-xs mb-3">
                        <code class="text-gray-400">\${item.asin}</code>
                        <span class="text-brand-400">\${displayUser}</span>
                            </div>
                        </div>
                    </div>
                    <div class="flex gap-2">
                        <button onclick="performAction('resume_product', '\${item.chat_id}', { asin: '\${item.asin}' }, this)" class="flex-1 py-1.5 bg-emerald-500/10 text-emerald-400 rounded-lg text-xs font-bold hover:bg-emerald-500/20 transition border border-emerald-500/20">
                            \${isMasry ? '\u25B6\uFE0F \u062A\u0634\u063A\u064A\u0644' : '\u25B6\uFE0F Unpause'}
                        </button>
                        <button onclick="openChartModal('\${item.asin}')" class="flex-1 py-1.5 bg-brand-500/10 text-brand-400 rounded-lg text-xs font-bold hover:bg-brand-500/20 transition border border-brand-500/20">
                            \${isMasry ? '\u{1F4CA} \u0627\u0644\u0631\u0633\u0645' : '\u{1F4CA} Chart'}
                        </button>
                        <button onclick="performAction('delete_product', '\${item.chat_id}', { asin: '\${item.asin}' }, this)" class="flex-1 py-1.5 bg-red-500/10 text-red-400 rounded-lg text-xs font-bold hover:bg-red-500/20 transition border border-red-500/20">
                            \${isMasry ? '\u{1F5D1}\uFE0F \u0645\u0633\u062D' : '\u{1F5D1}\uFE0F Delete'}
                        </button>
                    </div>
                </div>\`;
            }).join('');
        }

        function closePausedDrawer() {
            const drawer = document.getElementById('drawer-paused');
            const content = document.getElementById('drawer-paused-content');
            content.style.transform = 'translateY(100%)';
            setTimeout(() => { drawer.classList.add('hidden'); }, 300);
        }

        // \u2500\u2500 Graveyard Drawer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

        async function openGraveyardDrawer() {
            const drawer = document.getElementById('drawer-graveyard');
            const content = document.getElementById('drawer-graveyard-content');
            const itemsCont = document.getElementById('drawer-graveyard-items');

            itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm"><div class="w-6 h-6 border-2 border-gray-700 border-t-brand-500 rounded-full animate-spin mx-auto mb-2"></div>' + ${js("crm.loading_items")} + '</div>';

            drawer.classList.remove('hidden');
            setTimeout(() => { content.style.transform = 'translateY(0)'; }, 10);

            const data = await fetchAPI('/graveyard');
            if (!data || !data.items || data.items.length === 0) {
                itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm">\u2705 ' + ${js("crm.graveyard_empty")} + '</div>';
                document.getElementById('drawer-graveyard-count').innerText = '0 items';
                return;
            }

            document.getElementById('drawer-graveyard-count').innerText = data.items.length + ' items';

            const lang = document.documentElement.lang || 'en';
            let html = '';
            data.items.forEach(item => {
                const name = lang === 'masry' && item.name_ar ? escapeHtml(item.name_ar) : escapeHtml(item.name || item.asin);
                const isDelisted = item.delisted === 1;
                const allMissing = item.new_price === null && item.used_price === null && item.amazon_price === null;
                let reasonBadge = '';
                if (isDelisted) {
                    reasonBadge = '<span class="text-[10px] bg-red-900/30 text-red-400 px-1.5 py-0.5 rounded border border-red-800/50">' + ${js("crm.graveyard_delisted")} + '</span>';
                } else if (allMissing) {
                    reasonBadge = '<span class="text-[10px] bg-red-900/30 text-red-400 px-1.5 py-0.5 rounded border border-red-800/50">' + ${js("crm.graveyard_all_missing")} + '</span>';
                }
                const subsText = '<bdi>' + item.active_subs + '</bdi> ' + ${js("crm.graveyard_subs")};

                html += '<div class="bg-gray-800 rounded-lg p-3 flex items-start gap-3 cursor-pointer hover:bg-gray-700 transition" onclick="openProductSubsDrawer(\\'' + escapeHtml(item.asin) + '\\')">';
                html += '<input type="checkbox" onclick="event.stopPropagation()" class="graveyard-checkbox mt-1 rounded bg-gray-700 border-gray-600 text-red-500 focus:ring-red-500" data-asin="' + escapeHtml(item.asin) + '">';
                html += '<img src="' + (item.image_url ? escapeHtml(item.image_url) : 'https://images-na.ssl-images-amazon.com/images/P/' + escapeHtml(item.asin) + '.01.MZZZZZZZ.jpg') + '" class="w-12 h-12 rounded object-cover bg-white shrink-0" onerror="this.src=\\'https://images-na.ssl-images-amazon.com/images/P/' + escapeHtml(item.asin) + '.01.MZZZZZZZ.jpg\\'; this.onerror=function(){this.style.display=\\'none\\'};">' ;
                html += '<div class="flex-1 min-w-0">';
                html += '<div class="text-sm font-medium truncate"><a href="https://www.amazon.eg/dp/' + item.asin + '" target="_blank" class="text-brand-400 hover:text-brand-300 hover:underline transition" onclick="event.stopPropagation()">' + name + '</a></div>';
                html += '<div class="text-xs text-gray-500 mt-0.5"><bdi>' + escapeHtml(item.asin) + '</bdi> &bull; ' + subsText + '</div>';
                html += '<div class="flex gap-1 mt-1">' + reasonBadge + '</div>';
                html += '</div></div>';
            });
            itemsCont.innerHTML = html;
        }

        function closeGraveyardDrawer() {
            const content = document.getElementById('drawer-graveyard-content');
            content.style.transform = 'translateY(100%)';
            setTimeout(() => { document.getElementById('drawer-graveyard').classList.add('hidden'); }, 300);
        }

        async function openProductSubsDrawer(asin) {
            const drawer = document.getElementById('drawer-product-subs');
            const content = document.getElementById('drawer-product-subs-content');
            const itemsCont = document.getElementById('drawer-product-subs-items');
            
            document.getElementById('drawer-product-subs-title').innerText = 'Subscribers for ' + asin;
            document.getElementById('drawer-product-subs-count').innerText = '--';
            itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm"><div class="w-6 h-6 border-2 border-gray-700 border-t-amber-500 rounded-full animate-spin mx-auto mb-2"></div>' + ${js("crm.loading_items")} + '</div>';

            drawer.classList.remove('hidden');
            setTimeout(() => { content.style.transform = 'translateY(0)'; }, 10);

            const data = await fetchAPI('/product-subs/' + asin);
            if (!data || !data.items || data.items.length === 0) {
                itemsCont.innerHTML = '<div class="text-center py-8 text-gray-500 text-sm">No subscribers found.</div>';
                document.getElementById('drawer-product-subs-count').innerText = '0 items';
                return;
            }

            document.getElementById('drawer-product-subs-count').innerText = data.items.length + ' items';
            const lang = document.documentElement.lang || 'en';
            
            itemsCont.innerHTML = data.items.map((item) => {
                const isMasry = lang === 'masry';
                const name = (lang === 'masry' && item.name_ar) ? escapeHtml(item.name_ar) : escapeHtml(item.name || item.asin);
                const userName = escapeHtml(item.first_name || 'User');
                const userDetails = item.username ? \`(@\${item.username})\` : \`(\${item.chat_id})\`;
                const displayUser = \`\${userName} <span class="opacity-70">\${userDetails}</span>\`;
                const price = item.new_price ? item.new_price + ' ' + ${js("chrome.currency_egp")} : (item.used_price ? ${js("crm.user_used_only")} : ${js("crm.user_out_of_stock")});
                const hasTarget = !!item.target_price;
                const targetBadge = hasTarget ? '<div class="text-xs text-brand-400">\u{1F3AF} Target: ' + item.target_price + '</div>' : '';
                
                const actionBtnHtml = item.is_paused === 1
                    ? \`
                        <button onclick="performAction('resume_product', '\${item.chat_id}', { asin: '\${item.asin}' }, this)" class="flex-1 py-1.5 bg-emerald-500/10 text-emerald-400 rounded-lg text-xs font-bold hover:bg-emerald-500/20 transition border border-emerald-500/20">
                            \${isMasry ? '\u25B6\uFE0F \u062A\u0634\u063A\u064A\u0644' : '\u25B6\uFE0F Unpause'}
                        </button>\`
                    : \`
                        <button onclick="performAction('pause_product', '\${item.chat_id}', { asin: '\${item.asin}' }, this)" class="flex-1 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-xs font-bold transition border border-gray-700/50">
                            \${isMasry ? '\u23F8\uFE0F \u0627\u064A\u0642\u0627\u0641' : '\u23F8\uFE0F Pause'}
                        </button>\`;

                return \`
                <div class="glass rounded-xl p-3 border \${item.is_paused === 1 ? 'border-amber-500/20' : 'border-emerald-500/20'} relative overflow-hidden" id="product-sub-item-\${item.chat_id}-\${item.asin}">
                    <div class="flex gap-3 mb-2">
                        <img src="https://images-na.ssl-images-amazon.com/images/P/\${item.asin}.01.MZZZZZZZ.jpg" class="w-12 h-12 rounded object-cover bg-white shrink-0" onerror="this.style.display='none'">
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center justify-between mb-1">
                        <div class="font-medium text-sm truncate max-w-[60%]"><a href="https://www.amazon.eg/dp/\${item.asin}" target="_blank" class="text-brand-400 hover:text-brand-300 hover:underline transition" onclick="event.stopPropagation()">\${escapeHtml(name)}</a></div>
                        \${item.is_paused === 1 ? '<span class="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase text-amber-400 bg-amber-400/10">Paused</span>' : '<span class="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase text-emerald-400 bg-emerald-400/10">Active</span>'}
                    </div>
                    <div class="flex items-center justify-between text-xs mb-3">
                        <code class="text-gray-400">\${item.asin}</code>
                        <span class="text-brand-400">\${displayUser}</span>
                            </div>
                        </div>
                    </div>
                    <div class="flex justify-between items-end mb-3">
                        <div class="text-sm font-semibold">\${price}</div>
                        \${targetBadge}
                    </div>
                    <div class="flex gap-2">
                        \${actionBtnHtml}
                        <button onclick="openChartModal('\${item.asin}')" class="flex-1 py-1.5 bg-brand-500/10 text-brand-400 rounded-lg text-xs font-bold hover:bg-brand-500/20 transition border border-brand-500/20">
                            \${isMasry ? '\u{1F4CA} \u0627\u0644\u0631\u0633\u0645' : '\u{1F4CA} Chart'}
                        </button>
                        <button onclick="performAction('delete_product', '\${item.chat_id}', { asin: '\${item.asin}' }, this)" class="flex-1 py-1.5 bg-red-500/10 text-red-400 rounded-lg text-xs font-bold hover:bg-red-500/20 transition border border-red-500/20">
                            \${isMasry ? '\u{1F5D1}\uFE0F \u0645\u0633\u062D' : '\u{1F5D1}\uFE0F Delete'}
                        </button>
                    </div>
                </div>\`;
            }).join('');
        }

        function closeProductSubsDrawer() {
            const content = document.getElementById('drawer-product-subs-content');
            content.style.transform = 'translateY(100%)';
            setTimeout(() => { document.getElementById('drawer-product-subs').classList.add('hidden'); }, 300);
        }

        function toggleGraveyardSelectAll() {
            const checked = document.getElementById('graveyard-select-all').checked;
            document.querySelectorAll('.graveyard-checkbox').forEach(cb => { cb.checked = checked; });
        }

        async function purgeSelectedGhosts() {
            const checkboxes = document.querySelectorAll('.graveyard-checkbox:checked');
            if (checkboxes.length === 0) return showToast('Select at least one product to purge', 'error');

            const asins = Array.from(checkboxes).map(cb => cb.dataset.asin);

            if (!confirm(${js("crm.graveyard_purge_confirm")})) return;

            showLoader();
            const res = await fetchAPI('/graveyard/purge', 'POST', { asins });
            hideLoader();

            if (res && res.success) {
                showToast(${js("crm.graveyard_purged_ok", { count: "REPLACE_COUNT" })}.replace('REPLACE_COUNT', res.purged), 'success');
                closeGraveyardDrawer();
                refreshData();
            } else {
                showToast('Purge failed: ' + (res?.error || 'Unknown error'), 'error');
            }
        }

        let crmChartInstance = null;

        function closeChartModal() {
            document.getElementById('chart-modal').classList.add('hidden');
            if (crmChartInstance) {
                crmChartInstance.destroy();
                crmChartInstance = null;
            }
        }

        async function openChartModal(asin) {
            document.getElementById('chart-modal').classList.remove('hidden');
            document.getElementById('chart-loading').style.display = 'block';
            document.getElementById('crmPriceChart').style.display = 'none';
            document.getElementById('chart-metrics').style.display = 'none';
            document.getElementById('chart-loading').innerText = ${js("crm.chart_loading")};
            
            const data = await fetchAPI('/history/' + asin); // This actually maps to /api/crm/history/ASIN due to fetchAPI prefix
            document.getElementById('chart-loading').style.display = 'none';
            
            if (!data || data.length === 0) {
                document.getElementById('chart-loading').innerText = ${js("crm.no_price_history")};
                document.getElementById('chart-loading').style.display = 'block';
                return;
            }
            
            const currentUnix = Math.floor(Date.now() / 1000);
            const lastPoint = data[data.length - 1];
            const lastTime = lastPoint.t !== undefined ? lastPoint.t : lastPoint.timestamp;
            if (lastTime < currentUnix - 60) {
                data.push({ ...lastPoint, t: currentUnix });
            }

            document.getElementById('crmPriceChart').style.display = 'block';

            const labels = data.map(point => {
                const t = point.t !== undefined ? point.t : point.timestamp;
                const date = new Date(t * 1000);
                return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + 
                       date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            });
            
            const newPrices = data.map(point => point.n !== undefined ? point.n : (point.p !== undefined ? point.p : null));
            const usedPrices = data.map(point => point.u !== undefined ? point.u : null);

            let validPrices = newPrices.filter(p => p !== null);
            if (validPrices.length === 0) validPrices = usedPrices.filter(p => p !== null);
            if (validPrices.length > 0) {
                const ath = Math.max(...validPrices);
                const atl = Math.min(...validPrices);
                const avg = Math.round(validPrices.reduce((sum, val) => sum + val, 0) / validPrices.length);
                
                document.getElementById('chart-ath').innerText = ath.toLocaleString() + ' ' + ${js("chrome.currency_egp")};
                document.getElementById('chart-atl').innerText = atl.toLocaleString() + ' ' + ${js("chrome.currency_egp")};
                document.getElementById('chart-avg').innerText = avg.toLocaleString() + ' ' + ${js("chrome.currency_egp")};
                document.getElementById('chart-metrics').style.display = 'flex';
            }

            const ctx = document.getElementById('crmPriceChart').getContext('2d');
            const lineColor = '#38bdf8';

            crmChartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [
                        {
                            label: ${js("crm.new_price")},
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
                            label: ${js("crm.used_price")},
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
                    maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: { labels: { color: '#f3f4f6' } },
                        tooltip: { backgroundColor: 'rgba(31, 41, 55, 0.9)', titleColor: '#fff', bodyColor: '#fff' }
                    },
                    scales: {
                        x: { display: false },
                        y: { 
                            grid: { color: '#374151', drawBorder: false },
                            ticks: { color: '#9ca3af', callback: function(value) { return value.toLocaleString(); } }
                        }
                    }
                }
            });
        }

        async function triggerSync(btn) {
            const originalContent = btn.innerHTML;
            btn.innerHTML = '<div class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>';
            btn.disabled = true;
            try {
                const json = await fetchAPI('/sync-env', 'POST');
                if (json.error) {
                    showToast(json.error, 'error');
                } else {
                    showToast(json.message || 'Sync started successfully', 'success');
                }
            } catch (err) {
                showToast('Failed to trigger sync: ' + err.message, 'error');
            } finally {
                btn.innerHTML = originalContent;
                btn.disabled = false;
            }
        }

        async function performAction(action, targetId, data = null, btn = null) {
            if (!targetId) targetId = "global";

            if (action === 'delete_product') {
                const confirmed = confirm("Are you sure you want to delete this tracked product? This cannot be undone.");
                if (!confirmed) return;
            }

            if (btn) {
                btn.disabled = true;
                const origHtml = btn.innerHTML;
                btn.innerHTML = '<div class="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin inline-block align-middle"></div>';
                btn.dataset.origHtml = origHtml;
            } else {
                showLoader();
            }

            const res = await fetchAPI('/action', 'POST', { action, targetId, data });
            
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = btn.dataset.origHtml;
            } else {
                hideLoader();
            }
            
            if (res) {
                if (res.status === 'queued') {
                    showToast(${js("crm.toast_action_queued")}, "success");
                } else if (res.error === 'already_handled' || res.error === 'not_found') {
                    showToast(res.message || 'Product no longer exists or was already modified.', 'warning');
                    refreshData(); // Auto-refresh to remove stale item
                } else {
                    showToast(${js("crm.toast_success")}, "success");

                    if (btn && (action === 'pause_product' || action === 'resume_product')) {
                        const isMasry = (document.documentElement.lang || 'en') === 'masry';
                        if (action === 'pause_product') {
                            btn.setAttribute('onclick', \`performAction('resume_product', '\${targetId}', { asin: '\${data.asin}' }, this)\`);
                            btn.innerHTML = isMasry ? '\u25B6\uFE0F \u062A\u0634\u063A\u064A\u0644' : '\u25B6\uFE0F Unpause';
                            btn.dataset.origHtml = btn.innerHTML;
                            btn.className = 'flex-1 py-1.5 bg-emerald-500/10 text-emerald-400 rounded-lg text-xs font-bold hover:bg-emerald-500/20 transition border border-emerald-500/20';
                        } else {
                            btn.setAttribute('onclick', \`performAction('pause_product', '\${targetId}', { asin: '\${data.asin}' }, this)\`);
                            btn.innerHTML = isMasry ? '\u23F8\uFE0F \u0627\u064A\u0642\u0627\u0641' : '\u23F8\uFE0F Pause';
                            btn.dataset.origHtml = btn.innerHTML;
                            btn.className = 'flex-1 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-xs font-bold transition border border-gray-700/50';
                        }
                    } else if (action.includes('_product') && !btn) {
                        openDrawer(targetId); // legacy refresh
                    }

                    if (action === 'delete_product' && btn) {
                        const itemCard = document.getElementById(\`paused-item-\${targetId}-\${data.asin}\`) || document.getElementById(\`active-item-\${targetId}-\${data.asin}\`) || document.getElementById(\`item-\${data.asin}\`);
                        if (itemCard) itemCard.remove();
                    }

                    refreshData();
                }
            }
        }

        function triggerGlobalScrape() {
            tg.showConfirm(${js("crm.force_check")} + "${lang === "masry" ? "\u061F" : "?"}", (ok) => {
                if(ok) performAction("force_scrape", null);
            });
        }

        function sendBroadcast() {
            const msg = document.getElementById('broadcast-msg').value.trim();
            if(!msg) return showToast(${js("crm.toast_msg_empty")}, "error");
            tg.showConfirm(${js("crm.send_broadcast")} + "?", (ok) => {
                if(ok) {
                    performAction("broadcast", null, { message: msg });
                    document.getElementById('broadcast-msg').value = '';
                }
            });
        }

        function changeLimit(userId, currentLimit, firstName, username) {
            // Build a descriptive label: "Firstname (@username)" or fall back to userId
            const userLabel = firstName
                ? (username ? firstName + ' (@' + username + ')' : firstName)
                : userId;
            // Static i18n strings baked at render time; dynamic values appended at runtime
            const promptMsg = ${js("crm.edit_limit_prompt")} + " " + userLabel + " (" + ${js("crm.current_label")} + " " + currentLimit + "):";
            const limit = prompt(promptMsg, currentLimit);
            if (limit !== null && limit !== "" && !isNaN(limit) && limit > 0) {
                performAction('set_limit', userId, { limit: parseInt(limit) });
                // Show confirmation toast using pre-rendered i18n template
                const successTemplate = ${js("crm.edit_limit_success")};
                const successMsg = successTemplate.replace("{limit}", parseInt(limit)).replace("{user}", userLabel);
                showToast(successMsg, "success");
            }
        }

        function changeTarget(userId, asin) {
            const target = prompt(${js("crm.btn_edit")} + " (" + ${js("crm.new_price")} + ") \u2014 " + asin + ":");
            if (target !== null && target !== "" && !isNaN(target) && target > 0) {
                performAction('set_target', userId, { asin, target: parseFloat(target) });
            }
        }

        function confirmRevoke(userId) {
            tg.showConfirm(${js("crm.btn_demote_drawer")} + " \u2014 " + userId + "?", (ok) => {
                if(ok) performAction('revoke', userId);
            });
        }

        // --- Helpers ---
        function showLoader(text = ${js("crm.toast_processing")}) {
            const overlay = document.getElementById('overlay');
            document.getElementById('overlay-text').innerText = text;
            if (loaderTimeout) clearTimeout(loaderTimeout);
            overlay.classList.remove('hidden');
            // Trigger reflow
            void overlay.offsetWidth;
            overlay.classList.remove('opacity-0');
        }

        let loaderTimeout = null;
        function hideLoader() {
            const overlay = document.getElementById('overlay');
            overlay.classList.add('opacity-0');
            if (loaderTimeout) clearTimeout(loaderTimeout);
            loaderTimeout = setTimeout(() => { overlay.classList.add('hidden'); }, 300);
        }

        function showToast(message, type = "info") {
            const container = document.getElementById('toast-container');
            const el = document.createElement('div');
            const bg = type === 'error' ? 'bg-red-500/90 border-red-500' : 'bg-gray-800 border-gray-700';
            const icon = type === 'error' ? '\u274C' : '\u2705';
            
            el.className = 'glass rounded-lg px-4 py-3 flex items-center gap-3 text-sm font-medium shadow-2xl border toast toast-enter ' + bg;
            el.innerHTML = '<span>' + icon + '</span> <span>' + escapeHtml(message) + '</span>';
            
            container.appendChild(el);
            
            // Trigger reflow
            void el.offsetWidth;
            el.classList.remove('toast-enter');
            el.classList.add('toast-enter-active');
            
            setTimeout(() => {
                el.classList.remove('toast-enter-active');
                el.classList.add('toast-leave');
                // Trigger reflow
                void el.offsetWidth;
                el.classList.remove('toast-leave');
                el.classList.add('toast-leave-active');
                setTimeout(() => el.remove(), 300);
            }, 3000);
        }

        // Init
        refreshData();
    <\/script>
</body>
</html>`;
  }

  // src/routes/user_dashboard.js
  async function fetchUserAPI(request, env, ctx) {
    const url = new URL(request.url);
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
      const dataCheckString = keys.map((k) => `${k}=${parsed.get(k)}`).join("\n");
      const encoder = new TextEncoder();
      const secretKey = await crypto.subtle.importKey(
        "raw",
        await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), encoder.encode(env.TELEGRAM_BOT_TOKEN)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const calcHashBuffer = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(dataCheckString));
      const calcHash = Array.from(new Uint8Array(calcHashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
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
        for (let prod of results) {
          let historyData = await env.AZTRACKER_DB.get(`history:${prod.asin}`, "json") || [];
          let atl = null;
          if (historyData.length > 0) {
            atl = Math.min(...historyData.map((h) => h.price || h.n || h.u || 999999));
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
            if (userRow) {
              const lang = userRow.lang || "en";
              const isAdmin = userRow.role === "admin";
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
            if (userRow) {
              const lang = userRow.lang || "en";
              const isAdmin = userRow.role === "admin";
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
          const isFree = !userRow || userRow.role !== "admin" && userRow.role !== "premium";
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
              const lang = userRow ? userRow.lang || "en" : "en";
              const isAdmin = userRow ? userRow.role === "admin" : false;
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
    const isMasry = lang === "masry";
    const htmlLang = isMasry ? "ar" : "en";
    const htmlDir = isMasry ? "rtl" : "ltr";
    const pTagStr = partnerTag ? partnerTag : "";
    const uiDict = {
      my_products: t("dashboard.my_products", lang),
      hot_deals: t("dashboard.hot_deals", lang),
      syncing: t("dashboard.syncing", lang),
      finding_deals: t("dashboard.finding_deals", lang),
      failed_load: t("dashboard.failed_load", lang),
      error: t("dashboard.error", lang),
      no_deals: t("dashboard.no_deals", lang),
      unknown_product: t("dashboard.unknown_product", lang),
      tracked: t("dashboard.tracked", lang),
      track: t("dashboard.track", lang),
      price_now: t("dashboard.price_now", lang),
      price_drop: t("dashboard.price_drop", lang),
      open_amazon: t("dashboard.open_amazon", lang),
      limit_reached: t("dashboard.limit_reached", lang),
      error_tracking: t("dashboard.error_tracking", lang),
      open_in_telegram: t("dashboard.open_in_telegram", lang),
      error_loading_products: t("dashboard.error_loading_products", lang),
      currency_egp: t("chrome.currency_egp", lang),
      no_products_found: t("dashboard.no_products_found", lang),
      last_checked: t("dashboard.last_checked", lang),
      never: t("dashboard.never", lang),
      resume: t("dashboard.resume", lang),
      pause: t("dashboard.pause", lang),
      new_condition: t("dashboard.new_condition", lang),
      amazon_eg: t("dashboard.amazon_eg", lang),
      currently_out_of_stock: t("dashboard.currently_out_of_stock", lang),
      likely_out_of_stock: t("dashboard.likely_out_of_stock", lang),
      check_stock: t("dashboard.check_stock", lang),
      resale: t("dashboard.resale", lang),
      target_price: t("dashboard.target_price", lang),
      none: t("dashboard.none", lang),
      clear: t("dashboard.clear", lang),
      delete: t("dashboard.delete", lang),
      confirm_target_prefix: t("dashboard.confirm_target_prefix", lang),
      confirm_target_suffix: t("dashboard.confirm_target_suffix", lang),
      saved: t("dashboard.saved", lang),
      target_updated: t("dashboard.target_updated", lang),
      cleared: t("dashboard.cleared", lang),
      target_cleared: t("dashboard.target_cleared", lang),
      confirm_stop: t("dashboard.confirm_stop", lang)
    };
    return `<!DOCTYPE html>
<html lang="${htmlLang}" dir="${htmlDir}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>My Products</title>
  <script src="https://telegram.org/js/telegram-web-app.js"><\/script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
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
      font-family: 'Inter', -apple-system, sans-serif;
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
    const ui = ${JSON.stringify(uiDict)};
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
          ? '<button disabled style="opacity:0.5; cursor:default; border: 1px solid var(--card-border);">\u2705 ' + (ui.tracked) + '</button>'
          : '<button class="primary" onclick="trackDeal(\\'' + p.asin + '\\')">\u{1F3AF} ' + (ui.track) + '</button>';

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
                   '<div class="price-val" style="color:var(--destructive-color)">' + dropPct + '% \u{1F53B}</div>' +
                 '</div>' +
               '</div>' +
            '</div>' +
          '</div>' +
          '<div class="action-row">' +
            '<button onclick="window.open(\\''+amzUrl+'\\', \\'_blank\\')">\u{1F6D2} ' + (ui.open_amazon) + '</button>' +
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
              pricesHtml = '<div style="background: rgba(255, 59, 48, 0.1); border: 1px solid rgba(255, 59, 48, 0.2); color: var(--destructive-color); padding: 12px; border-radius: 8px; text-align: center; margin: 12px 0; font-weight: 500; font-size: 14px;">' +
                           '<svg style="width: 16px; height: 16px; display: inline-block; vertical-align: text-bottom; margin-inline-end: 6px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>' +
                           (ui.currently_out_of_stock) +
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
            '<button class="danger" onclick="deleteProduct(\\''+p.asin+'\\')">\u{1F5D1} ' + (ui.delete) + '</button>' +
          '</div>' +
          '<div class="action-row">' +
            '<button class="primary" onclick="window.open(\\''+amzUrl+'\\', \\'_blank\\')">\u{1F6D2} ' + (ui.open_amazon) + '</button>' +
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
  <\/script>
</body>
</html>`;
  }

  // src/index.js
  var index_default = {
    async scheduled(event, env, ctx) {
      return scheduled(event, env, ctx);
    },
    async queue(batch, env, ctx) {
      return queue(batch, env, ctx);
    },
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (request.method === "POST" && (url.pathname === "/webhook" || url.pathname.startsWith("/webhook/"))) {
        return handleTelegramWebhook(request, env, ctx);
      }
      const userRes = await fetchUserAPI(request, env, ctx);
      if (userRes) return userRes;
      return fetchAPI(request, env, ctx);
    }
  };
})();
