import subprocess
import json
import time

def run_cmd(cmd):
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return result.stdout.strip()

print("Fetching global:admins from KV...")
admins_json = run_cmd('npx wrangler kv:key get --binding=AZTRACKER_DB "global:admins"')
print("Admins JSON:", admins_json)

try:
    admins = json.loads(admins_json)
except:
    admins = []

print("Fetching global:banned_users from KV...")
banned_json = run_cmd('npx wrangler kv:key get --binding=AZTRACKER_DB "global:banned_users"')
print("Banned JSON:", banned_json)

try:
    banned = json.loads(banned_json)
except:
    banned = []

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

print("Migration complete!")
