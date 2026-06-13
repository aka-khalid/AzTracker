const products = [
  {
    asin: 'B0BNVZ5QB4',
    name: 'Casio Watch',
    new_price: null,
    used_price: null,
    amazon_price: null,
    new_seller: null,
    seen_amazon_eg_at: 1781357117827,
    seen_resale_at: null,
    paused: 0
  }
];

let html = '';
let isMasry = false;
let maxVal = 1000;
let targetSliderVal = 500;
let amzUrl = '';
let resaleUrl = '';
let amazonEgUrl = '';
let classPaused = '';
let btnPauseTxt = '';
let sellerLabel = 'New';
let shortSeller = 'New';
let img = '';

try {
products.forEach((p, idx) => {
          html += '<div class="product-card ' + classPaused + '">' +
            '<div class="product-header">' +
              '<img src="' + img + '" class="product-img" />' +
              '<div>' +
                 '<h4 class="product-title">' + p.name + '</h4>' +
                 '<p class="product-asin">' + p.asin + '</p>' +
              '</div>' +
            '</div>';
            
            const isAmzDuplicate = p.new_seller && p.new_seller.toLowerCase() === 'amazon.eg';
            const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
            const now = Date.now();
            const amazonRecentlySeen = p.seen_amazon_eg_at && (now - p.seen_amazon_eg_at) < SEVEN_DAYS;
            const usedRecentlySeen = p.seen_resale_at && (now - p.seen_resale_at) < SEVEN_DAYS;
  
            const isOutOfStock = !p.new_price && !p.used_price && !p.amazon_price && !amazonRecentlySeen && !usedRecentlySeen;
            let pricesHtml = '';
            if (isOutOfStock) {
                pricesHtml = '<div style="background: rgba(255, 59, 48, 0.1); border: 1px solid rgba(255, 59, 48, 0.2); color: var(--destructive-color); padding: 12px; border-radius: 8px; text-align: center; margin: 12px 0; font-weight: 500; font-size: 14px;">' +
                             '<svg style="width: 16px; height: 16px; display: inline-block; vertical-align: text-bottom; margin-inline-end: 6px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>' +
                             (isMasry ? 'غير متوفر حالياً' : 'Currently Out of Stock') +
                             '</div>';
            } else {
                pricesHtml = '<div class="prices-grid" ' + (isAmzDuplicate ? 'style="grid-template-columns: repeat(2, 1fr);"' : '') + '>' +
                  '<div class="price-box" title="' + sellerLabel + '" onclick="window.open(\\''+amzUrl+'\\', \\'_blank\\')">' +
                    '<div class="price-label">' + shortSeller + '</div>' +
                    '<div class="price-val ' + (p.new_price ? 'active' : '') + '">' + (p.new_price ? p.new_price : (isMasry ? 'نفذت' : 'Out')) + '</div>' +
                  '</div>' +
                  '<div class="price-box" title="' + (isMasry ? 'مستعمل' : 'Resale') + '" onclick="window.open(\\''+resaleUrl+'\\', \\'_blank\\')">' +
                    '<div class="price-label">' + (isMasry ? 'مستعمل' : 'Resale') + '</div>' +
                    '<div class="price-val ' + (p.used_price ? 'active' : '') + '">' + (p.used_price ? p.used_price : (usedRecentlySeen ? (isMasry ? 'شوف' : 'Check') : (isMasry ? 'نفذت' : 'Out'))) + '</div>' +
                  '</div>' +
                  (isAmzDuplicate ? '' : 
                  '<div class="price-box" title="' + (isMasry ? 'أمازون' : 'Amazon.eg') + '" onclick="window.open(\\''+amazonEgUrl+'\\', \\'_blank\\')">' +
                    '<div class="price-label">' + (isMasry ? 'أمازون' : 'Amazon.eg') + '</div>' +
                    '<div class="price-val ' + (p.amazon_price ? 'active' : '') + '">' + (p.amazon_price ? p.amazon_price : (amazonRecentlySeen ? (isMasry ? 'شوف' : 'Check') : (isMasry ? 'نفذت' : 'Out'))) + '</div>' +
                  '</div>') +
                '</div>';
            }
  
            html += pricesHtml;
});
console.log("Success! HTML Length:", html.length);
} catch(e) {
  console.error(e);
}
