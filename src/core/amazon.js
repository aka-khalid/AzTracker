export async function getAmazonAccessToken(clientId, clientSecret) {
  const url = 'https://api.amazon.com/auth/o2/token';
  const body = {
    grant_type: 'client_credentials',
    scope: 'creatorsapi::default',
    client_id: clientId,
    client_secret: clientSecret
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
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

export class AmazonEdgeParser {
  constructor(accessToken, partnerTag, endpointHost = 'www.amazon.eg', env = null) {
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
      itemIdType: 'ASIN',
      resources: [
        'itemInfo.title',
        'offersV2.listings.price',
        'offersV2.listings.condition',
        'offersV2.listings.merchantInfo',
        'offersV2.listings.isBuyBoxWinner',
        'images.primary.large'
      ],
      partnerTag: this.partnerTag,
      condition: 'Any',
      languagesOfPreference: ['en_AE']
    };

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json, text/javascript',
        'Authorization': `Bearer ${this.accessToken}`,
        'X-Marketplace': this.endpointHost
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
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
    if (asins.length === 0) return new Map();
    if (asins.length > 10) throw new Error("Batch size exceeds 10 ASINs limit.");

    const arabicNames = new Map();

    const payload = {
      itemIds: asins,
      itemIdType: 'ASIN',
      resources: ['itemInfo.title'],
      partnerTag: this.partnerTag,
      condition: 'Any',
      languagesOfPreference: ['ar_AE']
    };

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Accept': 'application/json, text/javascript',
          'Authorization': `Bearer ${this.accessToken}`,
          'X-Marketplace': this.endpointHost
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000)
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
          if (title && (locale === 'ar_AE' || containsArabic(title))) {
            arabicNames.set(asin, title);
          }
        }
      }
    } catch (e) {
      console.warn('[AmazonEdgeParser] Arabic title fetch failed:', e.message);
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
          'Accept-Language': 'ar,ar-EG;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(8000)
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
          'Accept-Language': 'en,en-US;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(8000)
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
    
    const amazonEgMid = (this.env?.AMZN_EG_MERCHANT_ID) || 'A1ZVRGNO5AYLOV';
    const amazonResaleMid = (this.env?.AMZN_RESALE_MERCHANT_ID) || 'A2N2MP47XAP1MK';

    const offers = rawItem.OffersV2 || rawItem.Offers || rawItem.offersV2 || rawItem.offers;
    const listings = offers?.Listings || offers?.listings;

    let newIsBuybox = false;

    const normalizeLabel = (lbl) => {
        if (!lbl) return '';
        let s = lbl.toString().toLowerCase();
        if (s.includes('.')) s = s.split('.')[1];
        return s.replace(/_/g, ' ').trim();
    };

    if (listings) {
      for (const listing of listings) {
        const rawCond = typeof listing.Condition === 'string' ? listing.Condition : (typeof listing.condition === 'string' ? listing.condition : (listing.Condition?.Value || listing.condition?.value || ''));
        const rawSub = typeof listing.SubCondition === 'string' ? listing.SubCondition : (typeof listing.subCondition === 'string' ? listing.subCondition : (listing.Condition?.SubCondition?.Value || listing.condition?.subCondition?.value || ''));
        const condition = normalizeLabel(rawCond);
        const subcondition = normalizeLabel(rawSub);
        
        const priceObj = listing.Price || listing.price;
        const moneyObj = priceObj?.Money || priceObj?.money;
        const priceStr = moneyObj?.Amount || moneyObj?.amount || priceObj?.Amount || priceObj?.amount;
        const price = Number(priceStr);
        
        if (!price || price <= 0 || !Number.isFinite(price)) continue;
        
        const merchantInfo = listing.MerchantInfo || listing.merchantInfo;
        const sellerName = merchantInfo?.Name || merchantInfo?.name || 'Unknown';
        const sellerId = merchantInfo?.Id || merchantInfo?.id || '';
        
        const deliveryInfo = listing.DeliveryInfo || listing.deliveryInfo;
        const rawIsBuyBox = deliveryInfo?.IsBuyBoxWinner || deliveryInfo?.isBuyBoxWinner || listing.IsBuyBoxWinner || listing.isBuyBoxWinner;
        const isBuyBox = String(rawIsBuyBox).toLowerCase() === 'true';

        const sellerLower = sellerName.toLowerCase();
        const isAmazon = Boolean(sellerId && sellerId === amazonEgMid);
        const isAmazonResale = sellerId === amazonResaleMid || sellerLower.includes('resale') || sellerLower.includes('warehouse') || sellerLower.includes('renewed');
        
        const usedTokens = ['used', 'refurbished', 'renewed', 'collectible'];
        const subTokens = ['like new', 'very good', 'good', 'acceptable', 'open box', 'oem', 'likenew', 'verygood', 'openbox', 'refurbished'];
        
        const isUsedLike = 
            usedTokens.some(t => condition.includes(t)) ||
            subTokens.some(t => subcondition.includes(t)) ||
            isAmazonResale;

        if (isAmazon) {
            if (!parsed.amazonPrice || isBuyBox || (price < parsed.amazonPrice && !parsed.amazonIsBuybox)) {
                parsed.amazonPrice = price;
                parsed.amazonSeller = sellerName;
                parsed.amazonMid = sellerId;
                parsed.amazonIsBuybox = isBuyBox;
            }
        }

        if (condition === 'new') {
            if (!parsed.newPrice || isBuyBox || (price < parsed.newPrice && !newIsBuybox)) {
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
}
