const fs = require('fs');
const path = require('path');

const targetFile = path.resolve('src/routes/crm_dashboard.js');
let content = fs.readFileSync(targetFile, 'utf8');

// 1. Environment Sync
const envSyncTarget = `<h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">\\\${isMasry ? 'مزامنة البيئة' : 'Environment Sync'}</h2>
                <div class="glass rounded-xl p-4 flex flex-col gap-3">
                    <div class="text-sm text-gray-400">
                        \\\${isMasry ? 'نسخ بيانات الإنتاج (Prod) إلى التطوير (Dev).' : 'Copy Prod data to Dev using Github Actions.'}
                    </div>
                    <div class="w-full">
                        <button onclick="triggerSync(this)" class="w-full justify-center bg-gray-800 hover:bg-gray-700 text-white text-xs px-3 py-2 rounded-lg font-medium transition shadow border border-gray-700 flex items-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> 
                            \\\${isMasry ? 'مزامنة الآن' : 'Sync Prod to Dev'}
                        </button>
                    </div>
                </div>`;

const envSyncReplace = `<h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">\\\${js('crm.env_sync_title')}</h2>
                <div class="glass rounded-xl p-4 border border-gray-800/50 relative overflow-hidden group">
                    <div class="flex items-center gap-4 mb-4 relative z-10">
                        <div class="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center shadow-inner group-hover:bg-brand-500/10 transition-colors">
                            <span class="text-lg">🔄</span>
                        </div>
                        <div class="flex-1">
                            <div class="text-sm font-semibold">\\\${js('crm.env_sync_title')}</div>
                            <div class="text-[10px] text-gray-500 mt-1">
                                \\\${js('crm.env_sync_desc')}
                            </div>
                        </div>
                        <button onclick="triggerSync(this)" class="px-4 py-2 bg-brand-500/10 text-brand-400 rounded-lg text-xs font-bold hover:bg-brand-500/20 transition border border-brand-500/20 flex items-center gap-2 group-hover:shadow-[0_0_15px_rgba(14,165,233,0.3)]">
                            <span>🔄</span>
                            \\\${js('crm.btn_sync')}
                        </button>
                    </div>
                </div>`;

content = content.replace(envSyncTarget, envSyncReplace);

// 2. subsText
content = content.replace(
    "const subsText = isMasry ? 'اشتراك' : 'subscriptions';",
    "const subsText = `\\${js('crm.subscriptions_text')}`;"
);

// 3. toggle_keep_alive dead code
const deadCodeTarget = `                        if (action === 'toggle_keep_alive') {
                            const wasOn = btn.className.includes('bg-emerald');
                            const isOn = !wasOn;
                            btn.className = isOn ? 'flex-1 py-1.5 rounded-lg text-xs font-bold transition border bg-emerald-600 hover:bg-emerald-500 text-white shadow-[0_0_10px_rgba(5,150,105,0.5)] border-emerald-500' 
                                                 : 'flex-1 py-1.5 rounded-lg text-xs font-bold transition border bg-gray-700 hover:bg-gray-600 text-gray-300 border-gray-600';
                            btn.innerHTML = isOn ? ('🟢 ' + \\\${js('crm.btn_tracking_global')}) 
                                                 : ('📡 ' + \\\${js('crm.btn_track_global')});
                            btn.dataset.origHtml = btn.innerHTML;
                        } else if (action === 'pause_product') {
                            btn.setAttribute('onclick', \\\`performAction('resume_product', '\\\${targetId}', { asin: '\\\${data.asin}' }, this)\\\`);
                            btn.innerHTML = isMasry ? '▶️ تشغيل' : '▶️ Unpause';
                            btn.dataset.origHtml = btn.innerHTML;
                            btn.className = 'flex-1 py-1.5 bg-emerald-500/10 text-emerald-400 rounded-lg text-xs font-bold hover:bg-emerald-500/20 transition border border-emerald-500/20';
                        } else {
                            btn.setAttribute('onclick', \\\`performAction('pause_product', '\\\${targetId}', { asin: '\\\${data.asin}' }, this)\\\`);
                            btn.innerHTML = isMasry ? '⏸️ ايقاف' : '⏸️ Pause';
                            btn.dataset.origHtml = btn.innerHTML;
                            btn.className = 'flex-1 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-xs font-bold transition border border-gray-700/50';
                        }`;

const deadCodeReplace = `                        if (action === 'toggle_keep_alive') {
                            const wasOn = btn.className.includes('bg-emerald');
                            const isOn = !wasOn;
                            btn.className = isOn ? 'flex-1 py-1.5 rounded-lg text-xs font-bold transition border bg-emerald-600 hover:bg-emerald-500 text-white shadow-[0_0_10px_rgba(5,150,105,0.5)] border-emerald-500' 
                                                 : 'flex-1 py-1.5 rounded-lg text-xs font-bold transition border bg-gray-700 hover:bg-gray-600 text-gray-300 border-gray-600';
                            btn.innerHTML = isOn ? ('🟢 ' + \\\${js('crm.btn_tracking_global')}) 
                                                 : ('📡 ' + \\\${js('crm.btn_track_global')});
                            btn.dataset.origHtml = btn.innerHTML;
                        }`;

content = content.replace(deadCodeTarget, deadCodeReplace);

// 4. One more subsText which is actually string concatenated, not template lit:
// const subsText = '<bdi>' + item.active_subs + '</bdi> ' + \${js('crm.graveyard_subs')};
// wait, the only one I wanted to replace is the hardcoded ternary

fs.writeFileSync(targetFile, content);
console.log('Script completed successfully.');
