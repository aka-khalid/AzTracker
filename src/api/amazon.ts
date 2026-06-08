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

  constructor(
    accessToken: string,
    partnerTag: string, 
    endpointHost: string = 'webservices.amazon.eg'
  ) {
    this.accessToken = accessToken;
    this.partnerTag = partnerTag;
    this.endpoint = `https://${endpointHost}/paapi5/getitems`;
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
        resources: [
          'ItemInfo.Title',
          'Offers.Listings.Price',
          'Offers.Listings.Condition',
          'Offers.Listings.MerchantInfo',
          'Offers.Listings.DeliveryInfo.IsBuyBoxWinner'
        ],
        partnerTag: this.partnerTag,
        partnerType: 'Associates',
        marketplace: 'www.amazon.eg'
      };

      try {
        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Authorization': `Bearer ${this.accessToken}`,
            'X-Amz-Target': 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems'
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
    
    // Retrieve AMZN_RETAIL_MID from global env if available, else fallback to Amazon.eg default
    const defaultMid = 'A1ZVRGNO5AYLOV';
    const amazonMid = typeof process !== 'undefined' && process.env ? (process.env.AMZN_RETAIL_MID || defaultMid) : defaultMid;

    const offers = rawItem.Offers || rawItem.offers;
    const listings = offers?.Listings || offers?.listings;

    if (listings) {
      for (const listing of listings) {
        const condition = (listing.Condition?.Value || listing.condition?.value || '').toLowerCase();
        const priceStr = listing.Price?.Amount || listing.price?.amount || 0;
        const price = Number(priceStr);
        
        const merchantInfo = listing.MerchantInfo || listing.merchantInfo;
        const sellerName = merchantInfo?.Name || merchantInfo?.name || 'Unknown';
        const sellerId = merchantInfo?.Id || merchantInfo?.id || '';
        
        // Fix: Use strictly boolean evaluation from the payload
        const deliveryInfo = listing.DeliveryInfo || listing.deliveryInfo;
        const rawIsBuyBox = deliveryInfo?.IsBuyBoxWinner || deliveryInfo?.isBuyBoxWinner || listing.IsBuyBoxWinner || listing.isBuyBoxWinner;
        const isBuyBox = String(rawIsBuyBox).toLowerCase() === 'true';

        // Fix: Check for Amazon or Amazon Resale
        const isAmazon = sellerId === amazonMid || sellerName.toLowerCase().match(/^amazon(\.eg)?$/);
        const isAmazonResale = sellerName.toLowerCase().match(/(amazon resale|amazon warehouse)/) || ['A2OAJ7377F756P', 'A8KICS1PHF7ZO'].includes(sellerId);
        
        if (isAmazon) {
            if (!parsed.amazonPrice || price < parsed.amazonPrice) {
                parsed.amazonPrice = price;
                parsed.amazonSeller = sellerName;
                parsed.amazonMid = sellerId;
                parsed.amazonIsBuybox = isBuyBox;
            }
        }

        if (condition === 'new') {
            if (!parsed.newPrice || price < parsed.newPrice) {
                parsed.newPrice = price;
                parsed.newSeller = sellerName;
                parsed.newMid = sellerId;
            }
        } else if (condition === 'used' || condition.includes('refurbished') || isAmazonResale) {
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
