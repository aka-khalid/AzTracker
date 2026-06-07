import subprocess
import json

def run_cmd(cmd):
    # Use utf-8 encoding explicitly
    result = subprocess.run(cmd, shell=True, capture_output=True, encoding='utf-8', errors='replace')
    return result.stdout.strip()

print("Fetching global:admins from KV...")
admins_json = run_cmd('npx wrangler kv:key get --binding=AZTRACKER_DB "global:admins"')
try:
    admins = json.loads(admins_json)
except:
    admins = []

print("Fetching global:banned_users from KV...")
banned_json = run_cmd('npx wrangler kv:key get --binding=AZTRACKER_DB "global:banned_users"')
try:
    banned = json.loads(banned_json)
except:
    banned = []

print("Fetching global:join_queue from KV...")
queue_json = run_cmd('npx wrangler kv:key get --binding=AZTRACKER_DB "global:join_queue"')
try:
    queue = json.loads(queue_json)
except:
    queue = []

if admins:
    print(f"Migrating {len(admins)} admins to D1...")
    for admin in admins:
        sql = f"UPDATE Users SET role = 'admin' WHERE chat_id = '{admin}' AND role != 'admin';"
        run_cmd(f'npx wrangler d1 execute aztracker-test-db --remote --command="{sql}"')

if banned:
    print(f"Migrating {len(banned)} banned users to D1...")
    for user in banned:
        sql = f"UPDATE Users SET role = 'rejected' WHERE chat_id = '{user}' AND role != 'rejected';"
        run_cmd(f'npx wrangler d1 execute aztracker-test-db --remote --command="{sql}"')

if queue:
    print(f"Migrating {len(queue)} join queue users to D1...")
    for q in queue:
        chat_id = str(q.get('id', ''))
        first_name = q.get('first_name', '')
        username = q.get('username', '')
        req_at = q.get('requested_at', 0)
        admin_msgs = json.dumps(q.get('admin_messages', {}))
        
        # Escape quotes for sqlite
        first_name = first_name.replace("'", "''") if first_name else ''
        username = username.replace("'", "''") if username else ''
        admin_msgs = admin_msgs.replace("'", "''") if admin_msgs else '{}'
        
        sql = f"INSERT OR IGNORE INTO Join_Queue (chat_id, first_name, username, requested_at, admin_messages) VALUES ('{chat_id}', '{first_name}', '{username}', {req_at}, '{admin_msgs}');"
        run_cmd(f'npx wrangler d1 execute aztracker-test-db --remote --command="{sql}"')

print("Deleting KV keys...")
run_cmd('npx wrangler kv:key delete --binding=AZTRACKER_DB "global:admins"')
run_cmd('npx wrangler kv:key delete --binding=AZTRACKER_DB "global:banned_users"')
run_cmd('npx wrangler kv:key delete --binding=AZTRACKER_DB "global:join_queue"')

print("Migration complete!")
