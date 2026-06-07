import os

with open("worker.js", "r", encoding="utf-8") as f:
    content = f.read()

old_filter = """        function filterUsers() {
            const query = (document.getElementById('search-users').value || '').toLowerCase();
            const list = document.getElementById('users-list');
            
            const filtered = appData.users.filter(u => u.chat_id.toString().toLowerCase().includes(query) || u.role.toLowerCase().includes(query));
            
            if (filtered.length === 0) {
                list.innerHTML = '<div class="text-center py-10 text-gray-500 text-sm glass rounded-xl border border-gray-800 border-dashed">No users found</div>';
                return;
            }
            
            list.innerHTML = filtered.map(u => {
                const roleColors = { 'root': 'text-purple-400 border-purple-400/20 bg-purple-400/10', 'admin': 'text-brand-400 border-brand-400/20 bg-brand-400/10', 'approved': 'text-gray-300 border-gray-700 bg-gray-800' };
                const roleStyle = roleColors[u.role] || 'text-red-400 border-red-400/20 bg-red-400/10';
                
                return `
                <div class="glass rounded-xl p-3 border border-gray-800/50 hover:border-gray-700 transition overflow-hidden relative">
                    ${u.role === 'root' ? '<div class="absolute -right-2 -top-2 w-10 h-10 bg-purple-500/20 blur-xl rounded-full"></div>' : ''}
                    <div class="flex justify-between items-start mb-3 relative z-10">
                        <div>
                            <div class="font-medium flex items-center gap-2">
                                <span class="text-sm">${u.chat_id}</span>
                                <span class="text-[10px] px-2 py-0.5 rounded uppercase font-bold border ${roleStyle}">${u.role}</span>
                            </div>
                            <div class="text-xs text-gray-500 mt-1 flex items-center gap-2">
                                <span>${u.active_items} / ${u.item_limit} Items</span>
                                <span>•</span>
                                <span>Joined: ${new Date(u.created_at).toLocaleDateString()}</span>
                            </div>
                        </div>
                        <button onclick="openDrawer('${u.chat_id}')" class="px-3 py-1.5 rounded-lg bg-gray-800 text-xs font-medium text-brand-400 hover:bg-gray-700 transition shadow">View Items</button>
                    </div>
                    <div class="flex gap-2 relative z-10">
                        <button onclick="changeLimit('${u.chat_id}', ${u.item_limit})" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 font-medium transition text-center border border-gray-700/50">Edit Limit</button>
                        ${u.role === 'approved' ? `<button onclick="performAction('promote', '${u.chat_id}')" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-brand-400 font-medium transition text-center border border-brand-500/20">Promote</button>` : ''}
                        ${u.role === 'admin' ? `<button onclick="performAction('demote', '${u.chat_id}')" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-orange-400 font-medium transition text-center border border-orange-500/20">Demote</button>` : ''}
                        ${u.role !== 'root' ? `<button onclick="confirmRevoke('${u.chat_id}')" class="w-8 py-1.5 rounded bg-red-500/10 hover:bg-red-500/20 text-xs text-red-400 font-medium transition flex items-center justify-center border border-red-500/20"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>` : ''}
                    </div>
                </div>`;
            }).join('');
        }"""
new_filter = """        function filterUsers() {
            const query = (document.getElementById('search-users').value || '').toLowerCase();
            const list = document.getElementById('users-list');
            const currentUser = appData._currentUser;
            const myUser = appData.users.find(u => u.chat_id.toString() === currentUser);
            const isRoot = myUser ? myUser.role === 'root' : false;
            
            let filtered = appData.users.filter(u => {
                if (activeTab === 'admins') return u.role === 'admin' || u.role === 'root';
                if (activeTab === 'banned') return u.role === 'rejected';
                return u.role === 'approved';
            });
            
            if (query) {
                filtered = filtered.filter(u => 
                    u.chat_id.toString().toLowerCase().includes(query) || 
                    (u.first_name || '').toLowerCase().includes(query) || 
                    (u.username || '').toLowerCase().includes(query)
                );
            }
            
            if (filtered.length === 0) {
                list.innerHTML = `<div class="text-center py-10 text-gray-500 text-sm glass rounded-xl border border-gray-800 border-dashed">No ${activeTab} found</div>`;
                return;
            }
            
            list.innerHTML = filtered.map(u => {
                const roleColors = { 'root': 'text-purple-400 border-purple-400/20 bg-purple-400/10', 'admin': 'text-brand-400 border-brand-400/20 bg-brand-400/10', 'approved': 'text-gray-300 border-gray-700 bg-gray-800', 'rejected': 'text-red-400 border-red-400/20 bg-red-400/10' };
                const roleStyle = roleColors[u.role] || roleColors['rejected'];
                
                let displayName = u.chat_id;
                if (u.first_name || u.username) {
                    displayName = `${u.first_name || ''} ${u.username ? '(@' + u.username + ')' : ''} - ${u.chat_id}`.trim();
                }

                const isTargetRoot = u.role === 'root';
                const isTargetAdmin = u.role === 'admin' || isTargetRoot;
                const canManage = isRoot || (!isTargetAdmin);
                const limitText = isTargetAdmin ? '∞ Items' : `${u.active_items || 0} / ${u.item_limit} Items`;
                
                return `
                <div class="glass rounded-xl p-3 border border-gray-800/50 hover:border-gray-700 transition overflow-hidden relative">
                    ${isTargetRoot ? '<div class="absolute -right-2 -top-2 w-10 h-10 bg-purple-500/20 blur-xl rounded-full"></div>' : ''}
                    <div class="flex justify-between items-start mb-3 relative z-10">
                        <div>
                            <div class="font-medium flex items-center gap-2">
                                <span class="text-sm truncate max-w-[200px]" title="${displayName}">${displayName}</span>
                                <span class="text-[10px] px-2 py-0.5 rounded uppercase font-bold border ${roleStyle} flex-shrink-0">${u.role}</span>
                            </div>
                            <div class="text-xs text-gray-500 mt-1 flex items-center gap-2">
                                <span>${limitText}</span>
                                <span>•</span>
                                <span>Joined: ${new Date(u.created_at).toLocaleDateString()}</span>
                            </div>
                        </div>
                        ${!isTargetRoot && u.role !== 'rejected' ? `<button onclick="openDrawer('${u.chat_id}')" class="px-3 py-1.5 rounded-lg bg-gray-800 text-xs font-medium text-brand-400 hover:bg-gray-700 transition shadow flex-shrink-0">View Items</button>` : ''}
                    </div>
                    <div class="flex gap-2 relative z-10">
                        ${!isTargetAdmin && u.role !== 'rejected' ? `<button onclick="changeLimit('${u.chat_id}', ${u.item_limit})" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 font-medium transition text-center border border-gray-700/50">Edit Limit</button>` : ''}
                        
                        ${u.role === 'approved' && isRoot ? `<button onclick="performAction('promote', '${u.chat_id}')" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-brand-400 font-medium transition text-center border border-brand-500/20">Promote to Admin</button>` : ''}
                        
                        ${u.role === 'admin' && canManage ? `<button onclick="performAction('demote', '${u.chat_id}')" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-orange-400 font-medium transition text-center border border-orange-500/20">Demote</button>` : ''}
                        
                        ${u.role === 'rejected' && canManage ? `<button onclick="performAction('approve', '${u.chat_id}')" class="flex-1 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-emerald-400 font-medium transition text-center border border-emerald-500/20">Unban & Approve</button>` : ''}
                        
                        ${canManage && u.role !== 'root' && u.role !== 'rejected' ? `<button onclick="confirmRevoke('${u.chat_id}')" class="w-8 py-1.5 rounded bg-red-500/10 hover:bg-red-500/20 text-xs text-red-400 font-medium transition flex items-center justify-center border border-red-500/20" title="Revoke User"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>` : ''}
                    </div>
                </div>`;
            }).join('');
        }"""
content = content.replace(old_filter, new_filter)

old_tabs = """            <div class="flex border-b border-gray-800 mb-4">
                <button onclick="switchTab('queue')" id="tab-queue" class="flex-1 pb-3 text-sm font-medium tab-inactive transition relative">
                    Join Queue <span id="badge-queue" class="hidden absolute top-0 right-4 ml-1 bg-brand-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full"></span>
                </button>
                <button onclick="switchTab('users')" id="tab-users" class="flex-1 pb-3 text-sm font-medium tab-active transition">
                    Directory
                </button>
            </div>"""
new_tabs = """            <div class="flex border-b border-gray-800 mb-4 overflow-x-auto" style="scrollbar-width: none;">
                <button onclick="switchTab('queue')" id="tab-queue" class="px-4 pb-3 text-sm font-medium tab-inactive transition relative whitespace-nowrap">
                    Pending <span id="badge-queue" class="hidden absolute top-0 right-1 bg-brand-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full"></span>
                </button>
                <button onclick="switchTab('admins')" id="tab-admins" class="px-4 pb-3 text-sm font-medium tab-inactive transition whitespace-nowrap">
                    Admins
                </button>
                <button onclick="switchTab('users')" id="tab-users" class="px-4 pb-3 text-sm font-medium tab-active transition whitespace-nowrap">
                    Users
                </button>
                <button onclick="switchTab('banned')" id="tab-banned" class="px-4 pb-3 text-sm font-medium tab-inactive transition whitespace-nowrap text-red-400/80">
                    Banned
                </button>
            </div>"""
content = content.replace(old_tabs, new_tabs)

old_switch = """        function switchTab(tab) {
            activeTab = tab;
            document.getElementById('tab-queue').className = `flex-1 pb-3 text-sm font-medium transition relative ${tab === 'queue' ? 'tab-active' : 'tab-inactive'}`;
            document.getElementById('tab-users').className = `flex-1 pb-3 text-sm font-medium transition ${tab === 'users' ? 'tab-active' : 'tab-inactive'}`;
            
            document.getElementById('view-queue').style.display = tab === 'queue' ? 'block' : 'none';
            document.getElementById('view-users').style.display = tab === 'users' ? 'block' : 'none';
            
            renderTabs();
        }"""
new_switch = """        function switchTab(tab) {
            activeTab = tab;
            ['queue', 'admins', 'users', 'banned'].forEach(t => {
                const el = document.getElementById(`tab-${t}`);
                if(el) el.className = `px-4 pb-3 text-sm font-medium transition whitespace-nowrap ${t === 'queue' ? 'relative' : ''} ${t==='banned'&&tab!=='banned'?'text-red-400/80':''} ${tab === t ? 'tab-active' : 'tab-inactive'}`;
            });
            
            document.getElementById('view-queue').style.display = tab === 'queue' ? 'block' : 'none';
            document.getElementById('view-users').style.display = tab !== 'queue' ? 'block' : 'none';
            
            renderTabs();
        }"""
content = content.replace(old_switch, new_switch)


with open("worker.js", "w", encoding="utf-8") as f:
    f.write(content)
print("worker.js UI refactored successfully")
