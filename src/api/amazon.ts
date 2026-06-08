export interface AmazonItem {
  asin: string;
  name?: string;
  newPrice?: number;
  newSeller?: string;
  newMid?: string;
  usedPrice?: number;
  usedSeller?: string;
  usedMid?: string;
  amazonPrice?: number;
  amazonSeller?: string;
  amazonMid?: string;
  amazonIsBuybox?: boolean;
}

export async function getAmazonAccessToken(clientId: string, clientSecret: string): Promise<string> {
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

  const data = await res.json() as any;
  return data.access_token;
}

export class AmazonEdgeParser {
  private accessToken: string;
  private partnerTag: string;
  private endpoint: string;
  private endpointHost: string;

  constructor(
    accessToken: string,
    partnerTag: string, 
    endpointHost: string = 'www.amazon.eg'
  ) {
    this.accessToken = accessToken;
    this.partnerTag = partnerTag;
    this.endpoint = `https://creatorsapi.amazon/catalog/v1/getItems`;
    this.endpointHost = endpointHost;
  }

  /**
   * Fetches the latest pricing data for a batch of ASINs.
   * Handles Creators API limits by batching internally.
   */
  public async getItems(asins: string[]): Promise<AmazonItem[]> {
    if (asins.length === 0) return [];
    
    const batchSize = 10;
    const results: AmazonItem[] = [];

    // Process ASINs in batches
    for (let i = 0; i < asins.length; i += batchSize) {
      const batchAsins = asins.slice(i, i + batchSize);
      
      const payload = {
        itemIds: batchAsins,
        condition: 'Any',
        resources: [
          'itemInfo.title',
          'offersV2.listings.price',
          'offersV2.listings.condition',
          'offersV2.listings.merchantInfo',
          'offersV2.listings.isBuyBoxWinner'
        ],
        partnerTag: this.partnerTag,
        partnerType: 'Associates'
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

        if (!response.ok) {
          const errorBody = await response.text();
          console.error(`[AmazonEdgeParser] PA-API HTTP Error: ${response.status}`, errorBody);
          continue; // Skip this batch but continue processing others
        }

        const data = await response.json() as any;
        
        // The response keys typically remain PascalCase or might be camelCase depending on the exact Creators API version.
        // We handle both just in case:
        const itemsResult = data.ItemsResult || data.itemsResult;
        const items = itemsResult?.Items || itemsResult?.items;
        
        if (items) {
          for (const item of items) {
            results.push(this.parseItem(item));
          }
        }
      } catch (error) {
        console.error(`[AmazonEdgeParser] Fetch Exception for batch ${i}:`, error);
      }
      // Delay to avoid rate limiting (match Python's 3-second sleep)
      await new Promise(r => setTimeout(r, 3000));
    }
    
    return results;
  }

  /**
   * Transforms the JSON response into our lean 15-column D1 schema format.
   */
  private parseItem(rawItem: any): AmazonItem {
    const parsed: AmazonItem = { asin: rawItem.ASIN || rawItem.asin };
    
    const itemInfo = rawItem.ItemInfo || rawItem.itemInfo;
    if (itemInfo?.Title?.DisplayValue) {
      parsed.name = itemInfo.Title.DisplayValue;
    } else if (itemInfo?.title?.displayValue) {
      parsed.name = itemInfo.title.displayValue;
    }
    
    // Retrieve MIDs from global env if available, else fallback to defaults
    const amazonEgMid = typeof process !== 'undefined' && process.env ? (process.env.AMZN_EG_MERCHANT_ID || 'A1ZVRGNO5AYLOV') : 'A1ZVRGNO5AYLOV';
    const amazonResaleMid = typeof process !== 'undefined' && process.env ? (process.env.AMZN_RESALE_MERCHANT_ID || 'A2N2MP47XAP1MK') : 'A2N2MP47XAP1MK';

    const offers = rawItem.OffersV2 || rawItem.Offers || rawItem.offersV2 || rawItem.offers;
    const listings = offers?.Listings || offers?.listings;

    let newIsBuybox = false;

    // Helper: Normalize offer label (Python parity)
    const normalizeLabel = (lbl: string) => {
        if (!lbl) return '';
        let s = lbl.toString().toLowerCase();
        if (s.includes('.')) s = s.split('.')[1];
        return s.replace(/_/g, ' ').trim();
    };

    if (listings) {
      for (const listing of listings) {
        const rawCond = listing.Condition?.Value || listing.condition?.value || '';
        const rawSub = listing.Condition?.SubCondition?.Value || listing.condition?.subCondition?.value || '';
        const condition = normalizeLabel(rawCond);
        const subcondition = normalizeLabel(rawSub);
        
        // Creators API uses price.money.amount (matching Python SDK: lst.price.money.amount)
        const priceObj = listing.Price || listing.price;
        const moneyObj = priceObj?.Money || priceObj?.money;
        const priceStr = moneyObj?.Amount || moneyObj?.amount || priceObj?.Amount || priceObj?.amount;
        const price = Number(priceStr);
        
        // Skip listings with missing or invalid prices
        if (!price || price <= 0 || !Number.isFinite(price)) continue;
        
        const merchantInfo = listing.MerchantInfo || listing.merchantInfo;
        const sellerName = merchantInfo?.Name || merchantInfo?.name || 'Unknown';
        const sellerId = merchantInfo?.Id || merchantInfo?.id || '';
        
        // Fix: Use strictly boolean evaluation from the payload
        const deliveryInfo = listing.DeliveryInfo || listing.deliveryInfo;
        const rawIsBuyBox = deliveryInfo?.IsBuyBoxWinner || deliveryInfo?.isBuyBoxWinner || listing.IsBuyBoxWinner || listing.isBuyBoxWinner;
        const isBuyBox = String(rawIsBuyBox).toLowerCase() === 'true';

        // Match Python's exact logic
        const sellerLower = sellerName.toLowerCase();
        const isAmazon = Boolean(sellerId && sellerId === amazonEgMid);
        const isAmazonResale = sellerId === amazonResaleMid || sellerLower.includes('resale') || sellerLower.includes('warehouse') || sellerLower.includes('renewed');
        
        const usedTokens = ['used', 'refurbished', 'renewed', 'collectible'];
        const subTokens = ['like new', 'very good', 'good', 'acceptable', 'open box', 'oem', 'likenew', 'verygood', 'openbox'];
        
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
