const fs = require('fs');
const path = require('path');

const targetFile = path.resolve('src/routes/crm_dashboard.js');
let content = fs.readFileSync(targetFile, 'utf8');

// Fix Env Sync
content = content.replaceAll(
    "\\${js('crm.env_sync_title')}",
    "${t('crm.env_sync_title', lang)}"
);

content = content.replaceAll(
    "\\${js('crm.env_sync_desc')}",
    "${t('crm.env_sync_desc', lang)}"
);

content = content.replaceAll(
    "\\${js('crm.btn_sync')}",
    "${t('crm.btn_sync', lang)}"
);

// Fix Buttons
content = content.replaceAll(
    "\\${js('crm.btn_chart')}",
    "${t('crm.btn_chart', lang)}"
);

content = content.replaceAll(
    "\\${js('crm.btn_delete_drawer')}",
    "${t('crm.btn_delete_drawer', lang)}"
);

// Fix deadcode toggle keep alive issue
// The toggle keep alive button was updated to:
// btn.innerHTML = isOn ? ('🟢 ' + \${js('crm.btn_tracking_global')}) : ('📡 ' + \${js('crm.btn_track_global')});
// Wait, since it's raw JS string concatenation in the browser:
// btn.innerHTML = isOn ? ('🟢 ' + "تتبع دايم") : ...
// If we use js(), it returns "تتبع دايم", so it works! But wait, is it `\\${js(...)}`?
// Let's replace the `\\${js` in the toggle_keep_alive section just in case!
content = content.replaceAll(
    "\\${js('crm.btn_tracking_global')}",
    "${js('crm.btn_tracking_global')}"
);

content = content.replaceAll(
    "\\${js('crm.btn_track_global')}",
    "${js('crm.btn_track_global')}"
);

fs.writeFileSync(targetFile, content);
console.log('Script completed successfully.');
