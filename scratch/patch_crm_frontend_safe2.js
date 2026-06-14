const fs = require('fs');
const path = require('path');

const targetFile = path.resolve('src/routes/crm_dashboard.js');
let content = fs.readFileSync(targetFile, 'utf8');

content = content.replaceAll(
    "\\${isMasry ? '📊 سجل السعر' : '📊 Chart'}",
    "📊 \\${js('crm.btn_chart')}"
);

content = content.replaceAll(
    "\\${isMasry ? '🗑️ مسح' : '🗑️ Delete'}",
    "🗑️ \\${js('crm.btn_delete_drawer')}"
);

fs.writeFileSync(targetFile, content);
console.log('Script completed successfully.');
