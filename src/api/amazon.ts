import { AwsClient } from 'aws4fetch';

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

export class AmazonEdgeParser {
  private awsClient: AwsClient;
  private partnerTag: string;
  private endpoint: string;

  constructor(
    accessKeyId: string, 
    secretAccessKey: string, 
    partnerTag: string, 
    region: string = 'eu-south-1', 
    endpointHost: string = 'webservices.amazon.eg'
  ) {
    this.partnerTag = partnerTag;
    this.endpoint = `https://${endpointHost}/paapi5/getitems`;
    
    // Natively implements AWS Signature Version 4 for Cloudflare Workers
    this.awsClient = new AwsClient({
      accessKeyId,
      secretAccessKey,
      service: 'ProductAdvertisingAPI',
      region: region,
    });
  }

  /**
   * Fetches the latest pricing data for a batch of ASINs.
   * Handles PA-API's hard limit of 10 ASINs per request by batching internally.
   */
  public async getItems(asins: string[]): Promise<AmazonItem[]> {
    if (asins.length === 0) return [];
    
    const batchSize = 10;
    const results: AmazonItem[] = [];

    // Process ASINs in batches to respect PA-API limits
    for (let i = 0; i < asins.length; i += batchSize) {
      const batchAsins = asins.slice(i, i + batchSize);
      
      const payload = {
        ItemIds: batchAsins,
        Resources: [
          'ItemInfo.Title',
          'Offers.Listings.Price',
          'Offers.Listings.Condition',
          'Offers.Listings.MerchantInfo',
          'Offers.Listings.DeliveryInfo.IsPrimeEligible'
        ],
        PartnerTag: this.partnerTag,
        PartnerType: 'Associates',
        Marketplace: 'www.amazon.eg'
      };

      try {
        const response = await this.awsClient.fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
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
        
        if (data.ItemsResult && data.ItemsResult.Items) {
          for (const item of data.ItemsResult.Items) {
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
   * Transforms the bloated PA-API JSON response into our lean 15-column D1 schema format.
   */
  private parseItem(rawItem: any): AmazonItem {
    const parsed: AmazonItem = { asin: rawItem.ASIN };
    
    if (rawItem.ItemInfo?.Title?.DisplayValue) {
      parsed.name = rawItem.ItemInfo.Title.DisplayValue;
    }
    
    if (rawItem.Offers?.Listings) {
      for (const listing of rawItem.Offers.Listings) {
        const condition = listing.Condition?.Value?.toLowerCase() || '';
        const price = listing.Price?.Amount || 0;
        const sellerName = listing.MerchantInfo?.Name || 'Unknown';
        const sellerId = listing.MerchantInfo?.Id || '';
        const isAmazon = sellerName.toLowerCase().includes('amazon');
        
        if (isAmazon) {
            parsed.amazonPrice = price;
            parsed.amazonSeller = sellerName;
            parsed.amazonMid = sellerId;
            parsed.amazonIsBuybox = listing.DeliveryInfo?.IsPrimeEligible || false;
        }

        if (condition === 'new') {
            if (!parsed.newPrice || price < parsed.newPrice) {
                parsed.newPrice = price;
                parsed.newSeller = sellerName;
                parsed.newMid = sellerId;
            }
        } else if (condition === 'used' || condition.includes('refurbished')) {
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
