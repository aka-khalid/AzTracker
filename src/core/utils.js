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

export function truncateName(name, maxLength = 60) {
  if (!name) return null;
  if (name.length <= maxLength) return name;
  return name.substring(0, maxLength) + "...";
}

export function resolveProductName(item, lang, fallback) {
  if (lang === 'ar' && item.name_ar) return item.name_ar;
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
