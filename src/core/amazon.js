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

  async getItems(asins, lang = 'en_AE') {
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
      languagesOfPreference: [lang]
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
      if (response.status === 400 || response.status === 404) return { items: [], invalidAsins: [] };
      throw new Error(`Creators API Error: ${response.status} - Body: ${errorBody}`);
    }

    const data = await response.json();

    // Detect ASIN-level errors (invalid, restricted, or inaccessible products)
    // The API returns HTTP 200 with an errors array and empty/partial itemsResult
    // InvalidParameterValue = garbage ASIN (e.g. 1231231231)
    // ItemNotAccessible = restricted/blocked product (e.g. adult, region-locked)
    const invalidAsins = [];
    const invalidAsinErrors = {}; // asin -> error code
    if (data.errors && Array.isArray(data.errors)) {
      for (const err of data.errors) {
        if (err.code === 'InvalidParameterValue' || err.code === 'ItemNotAccessible') {
          // Extract ASINs from messages like:
          //   "The ItemIds X, Y provided in the request is invalid."
          //   "The ItemIds X, Y provided in the request is not accessible."
          const match = err.message?.match(/ItemIds?\s+([A-Z0-9,\s]+)\s+provided/i);
          if (match) {
            const asins = match[1].split(/[,\s]+/).filter(a => /^[A-Z0-9]{10}$/i.test(a));
            invalidAsins.push(...asins);
            for (const a of asins) invalidAsinErrors[a] = err.code;
          }
        }
      }
      if (invalidAsins.length > 0) {
        console.warn(`[AmazonEdgeParser] ASIN errors detected by API (${[...new Set(data.errors.map(e => e.code))].join(', ')}): ${invalidAsins.join(', ')}`);
      }
    }

    const itemsResult = data.ItemsResult || data.itemsResult;
    const items = itemsResult?.Items || itemsResult?.items;

    if (items) {
      for (const item of items) {
        results.push(this.parseItem(item));
      }
    }

    return { items: results, invalidAsins, invalidAsinErrors };
  }

  /**
   * Fetch Arabic product titles using languagesOfPreference parameter.
   * The Creators API ignores Accept-Language headers — the correct way is
   * passing languagesOfPreference: ["ar_AE"] in the request body.
   * Returns a Map<asin, arabicTitle> for ASINs where Arabic title was found.
   */

  /**
   * Fetch raw Creators API response (unparsed) for debugging.
   * Returns the full JSON body from the API with all requested resources.
   */
  async getRawItems(asins, lang = 'en_AE') {
    if (asins.length === 0) return null;
    if (asins.length > 10) throw new Error('Batch size exceeds 10 ASINs limit.');

    const payload = {
      itemIds: asins,
      itemIdType: 'ASIN',
      resources: [
        'itemInfo.title',
        'itemInfo.byLineInfo',
        'itemInfo.classifications',
        'itemInfo.contentRating',
        'itemInfo.externalIds',
        'itemInfo.features',
        'itemInfo.manufactureInfo',
        'itemInfo.productInfo',
        'itemInfo.tradeInInfo',
        'itemInfo.contentInfo',
        'itemInfo.technicalInfo',
        'offersV2.listings.price',
        'offersV2.listings.condition',
        'offersV2.listings.merchantInfo',
        'offersV2.listings.isBuyBoxWinner',
        'offersV2.listings.availability',
        'offersV2.listings.type',
        'offersV2.listings.loyaltyPoints',
        'offersV2.listings.dealDetails',
        'images.primary.large',
        'images.primary.medium',
        'images.primary.small',
        'images.primary.highRes',
        'images.variants.large',
        'images.variants.medium',
        'images.variants.small',
        'images.variants.highRes',
        'customerReviews.starRating',
        'customerReviews.count',
        'parentASIN',
        'browseNodeInfo.browseNodes',
        'browseNodeInfo.browseNodes.salesRank',
        'browseNodeInfo.browseNodes.ancestor',
        'browseNodeInfo.websiteSalesRank'
      ],
      partnerTag: this.partnerTag,
      condition: 'Any',
      languagesOfPreference: [lang]
    };

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json, text/javascript',
        'Authorization': 'Bearer ' + this.accessToken,
        'X-Marketplace': this.endpointHost
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('[AmazonEdgeParser] Creators API HTTP Error: ' + response.status, errorBody);
      return { error: response.status, body: errorBody };
    }

    return await response.json();
  }

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
   * Fetch child variations for a parent ASIN using the Creators API.
   * Returns an array of { asin, name, imageUrl } for each child variation.
   */
  async getVariations(parentAsin, lang = 'ar_AE') {
    const prefLang = 'ar_AE'; // Always use Arabic for broadcast
    const variationsEndpoint = `https://creatorsapi.amazon/catalog/v1/getVariations`;
    const payload = {
      asin: parentAsin,
      resources: [
        'itemInfo.title',
        'images.primary.large',
        'offersV2.listings.price',
        'variationSummary.price.lowestPrice'
      ],
      partnerTag: this.partnerTag,
      languagesOfPreference: [prefLang]
    };

    try {
      const response = await fetch(variationsEndpoint, {
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
        console.warn(`[AmazonEdgeParser] getVariations HTTP Error: ${response.status}`, errorBody);
        return [];
      }

      const data = await response.json();
      const variationsResult = data.VariationsResult || data.variationsResult;
      const items = variationsResult?.Items || variationsResult?.items || [];

      // Extract basic info for all variations
      const rawVariations = items.map(item => {
        const asin = item.ASIN || item.asin;
        const itemInfo = item.ItemInfo || item.itemInfo;
        const titleObj = itemInfo?.Title || itemInfo?.title;
        const name = titleObj?.DisplayValue || titleObj?.displayValue || '';
        const images = item.Images || item.images;
        const primaryImage = images?.Primary || images?.primary;
        const largeImage = primaryImage?.Large || primaryImage?.large;
        const imageUrl = largeImage?.URL || largeImage?.url || null;
        return { asin, name, imageUrl };
      });

      // Batch query getItems to fetch accurate pricing for these variations
      const finalVariations = [];
      for (let i = 0; i < rawVariations.length; i += 10) {
        const chunk = rawVariations.slice(i, i + 10);
        const chunkAsins = chunk.map(v => v.asin);
        try {
          const detailedResult = await this.getItems(chunkAsins, prefLang);
          for (const raw of chunk) {
            const detailed = detailedResult.items.find(d => d.asin === raw.asin);
            if (!detailed) continue;
            
            const numPrice = detailed.amazonPrice || detailed.newPrice || detailed.usedPrice || 0;
            // Only keep the variation if getItems returned a valid non-zero price
            if (numPrice > 0) {
              const formattedPrice = numPrice.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' EGP';
              finalVariations.push({
                asin: raw.asin,
                name: raw.name || detailed.name,
                imageUrl: detailed.imageUrl || raw.imageUrl,
                detailPageURL: detailed.detailPageURL || null,
                price: formattedPrice,
                numPrice: numPrice,
                seller: detailed.amazonSeller || detailed.newSeller || detailed.usedSeller || 'Unknown',
                mid: detailed.amazonMid || detailed.newMid || detailed.usedMid || ''
              });
            }
          }
        } catch (e) {
          console.warn(`[AmazonEdgeParser] getItems batch failed for variations chunk:`, e.message);
        }
      }

      return finalVariations;
    } catch (e) {
      console.warn(`[AmazonEdgeParser] getVariations failed for ${parentAsin}:`, e.message);
      return [];
    }
  }

  /**
   * Scrape both English and Arabic product titles from amazon.eg in parallel.
   * Fallback when the Creators API doesn't return titles.
   * Returns { en: string|null, ar: string|null }
   */
  async scrapeTitles(asin) {
    const fetchTitle = async (lang, acceptLang) => {
      const url = `https://www.amazon.eg/dp/${asin}?language=${lang}`;
      try {
        const response = await fetch(url, {
          headers: {
            'Accept-Language': acceptLang,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          },
          signal: AbortSignal.timeout(8000)
        });
        if (!response.ok) return null;
        const html = await response.text();
        const match = html.match(/id="productTitle"[^>]*>([^<]+)</);
        return match?.[1]?.trim() || null;
      } catch (e) {
        console.warn(`[AmazonEdgeParser] ${lang} scrape failed for ${asin}:`, e.message);
        return null;
      }
    };

    const [en, ar] = await Promise.all([
      fetchTitle('en_AE', 'en,en-US;q=0.9'),
      fetchTitle('ar_AE', 'ar,ar-EG;q=0.9')
    ]);

    return {
      en: en || null,
      ar: ar && containsArabic(ar) ? ar : null
    };
  }

  parseItem(rawItem) {
    const parsed = { asin: rawItem.ASIN || rawItem.asin };

    // Use the canonical affiliate URL from the Creators API (includes tag, marketplace, language)
    if (rawItem.DetailPageURL || rawItem.detailPageURL) {
      parsed.detailPageURL = rawItem.DetailPageURL || rawItem.detailPageURL;
    }

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
