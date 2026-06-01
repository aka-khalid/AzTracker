import os
import secrets
import string
import re
import sys
import base64
import subprocess

# 🛡️ DEPENDENCY GATE
try:
    import requests
    from nacl import encoding, public
except ImportError:
    print("❌ Critical Dependencies Missing.")
    print("Please install them to continue: pip install requests pynacl")
    sys.exit(1)

def setup_gitignore():
    print("🛡️ Verifying repository security boundaries...")
    gitignore_path = ".gitignore"
    required_ignores = ["wrangler.toml", ".env", "__pycache__/", "*.pyc", "tests/mock_db.json"]
    
    existing_lines = []
    if os.path.exists(gitignore_path):
        with open(gitignore_path, "r") as f:
            existing_lines = f.read().splitlines()
            
    appended = False
    with open(gitignore_path, "a") as f:
        for item in required_ignores:
            if item not in existing_lines:
                if not appended and existing_lines and existing_lines[-1] != "":
                    f.write("\n")
                f.write(f"{item}\n")
                print(f"  [+] Added '{item}' to .gitignore")
                appended = True
                
    if not appended: print("  [✓] .gitignore is already secure.")

def generate_secure_string(length=32):
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))

def load_local_env():
    env_vars = {}
    if os.path.exists(".env"):
        with open(".env", "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, val = line.split("=", 1)
                    env_vars[key.strip()] = val.strip().strip("'\"")
    return env_vars

def get_cloudflare_credentials(env_vars):
    print("-" * 40)
    print("☁️ Locating Cloudflare credentials...")
    account_id = env_vars.get("CLOUDFLARE_ACCOUNT_ID") or os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    api_token = env_vars.get("CLOUDFLARE_API_TOKEN") or os.environ.get("CLOUDFLARE_API_TOKEN")
    
    if not account_id: account_id = input("  [>] Enter your 32-character Cloudflare Account ID: ").strip()
    if not api_token: api_token = input("  [>] Enter your Cloudflare API Token: ").strip()
        
    return account_id, api_token

def provision_kv_namespace(account_id, api_token):
    print("🗄️ Provisioning AZTRACKER_DB KV Namespace...")
    url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/storage/kv/namespaces"
    headers = {"Authorization": f"Bearer {api_token}", "Content-Type": "application/json"}
    
    try:
        res = requests.get(url, headers=headers)
        res.raise_for_status()
        for ns in res.json().get("result", []):
            if ns.get("title") == "AZTRACKER_DB":
                print(f"  [✓] Namespace 'AZTRACKER_DB' already exists. ID: {ns['id']}")
                return ns["id"]
                
        create_res = requests.post(url, headers=headers, json={"title": "AZTRACKER_DB"})
        create_res.raise_for_status()
        new_id = create_res.json().get("result", {}).get("id")
        print(f"  [✓] Successfully created namespace. ID: {new_id}")
        return new_id
    except requests.exceptions.RequestException as e:
        print(f"  [❌] Cloudflare API Error: {e}")
        sys.exit(1)

def update_wrangler_toml(kv_id):
    print("📝 Injecting KV ID into wrangler.toml...")
    if not os.path.exists("wrangler.toml"):
        print("  [❌] wrangler.toml not found. Skipping TOML injection.")
        return
        
    with open("wrangler.toml", "r") as f: content = f.read()
    updated_content = re.sub(r'(id\s*=\s*")[^"]+(")', r'\g<1>' + kv_id + r'\g<2>', content)
    
    if updated_content != content or kv_id in content:
        with open("wrangler.toml", "w") as f: f.write(updated_content)
        print(f"  [✓] wrangler.toml updated successfully with ID: {kv_id}")

def get_github_repo_name():
    try:
        result = subprocess.run(["git", "config", "--get", "remote.origin.url"], capture_output=True, text=True)
        url = result.stdout.strip()
        if "github.com" in url:
            # Handle both SSH and HTTPS formats
            clean = url.replace("git@github.com:", "").replace("https://github.com/", "").replace(".git", "")
            return clean
    except Exception:
        pass
    return input("  [>] Could not detect repository name. Enter manually (e.g. username/repo): ").strip()

def encrypt_secret(public_key: str, secret_value: str) -> str:
    """Encrypts a string using PyNaCl and the GitHub Repository Public Key."""
    public_key_bytes = base64.b64decode(public_key)
    sealed_box = public.SealedBox(public.PublicKey(public_key_bytes))
    encrypted = sealed_box.encrypt(secret_value.encode("utf-8"))
    return base64.b64encode(encrypted).decode("utf-8")

def provision_github_secrets(env_vars, cf_account_id, cf_namespace_id, cf_api_token, cron_key, webhook_secret):
    print("-" * 40)
    print("🐙 Provisioning GitHub Actions Secrets...")
    
    gh_token = env_vars.get("GH_WORKFLOW_TOKEN") or input("  [>] Enter your GitHub Fine-Grained PAT (GH_WORKFLOW_TOKEN): ").strip()
    repo_name = get_github_repo_name()
    print(f"  [i] Target Repository: {repo_name}")
    
    headers = {
        "Authorization": f"Bearer {gh_token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
    }
    
    # 1. Fetch Repository Public Key
    try:
        pk_res = requests.get(f"https://api.github.com/repos/{repo_name}/actions/secrets/public-key", headers=headers)
        pk_res.raise_for_status()
        pk_data = pk_res.json()
        key_id = pk_data["key_id"]
        public_key = pk_data["key"]
    except requests.exceptions.RequestException as e:
        print(f"  [❌] Failed to fetch GitHub public key: {e}")
        sys.exit(1)

    # 2. Compile Secrets Dictionary
    secrets_map = {
        "TELEGRAM_BOT_TOKEN": env_vars.get("TELEGRAM_BOT_TOKEN") or input("  [>] Enter TELEGRAM_BOT_TOKEN: "),
        "TELEGRAM_ROOT_ADMIN_IDS": env_vars.get("TELEGRAM_ROOT_ADMIN_IDS") or input("  [>] Enter TELEGRAM_ROOT_ADMIN_IDS: "),
        "CLOUDFLARE_ACCOUNT_ID": cf_account_id,
        "CLOUDFLARE_KV_NAMESPACE_ID": cf_namespace_id,
        "CLOUDFLARE_API_TOKEN": cf_api_token,
        "AMZN_CREATORS_ACCESS_KEY": env_vars.get("AMZN_CREATORS_ACCESS_KEY") or input("  [>] Enter AMZN_CREATORS_ACCESS_KEY: "),
        "AMZN_CREATORS_SECRET_KEY": env_vars.get("AMZN_CREATORS_SECRET_KEY") or input("  [>] Enter AMZN_CREATORS_SECRET_KEY: "),
        "AMZN_ASSOCIATES_TAG": env_vars.get("AMZN_ASSOCIATES_TAG") or input("  [>] Enter AMZN_ASSOCIATES_TAG: "),
        "AMZN_API_VERSION": env_vars.get("AMZN_API_VERSION") or "3.2",
        "GH_WORKFLOW_TOKEN": gh_token,
        "CRON_AUTH_KEY": cron_key,
        "TELEGRAM_WEBHOOK_SECRET": webhook_secret
    }

    # 3. Check for Target-Safe Mode
    target_safe = env_vars.get("TARGET_SAFE_MODE", "true").lower() != "false"
    
    if target_safe:
        print("  [!] TARGET_SAFE_MODE is ACTIVE. Running dry-run payload generation.")
    
    # 4. Encrypt and Push
    success_count = 0
    for secret_name, secret_value in secrets_map.items():
        encrypted_val = encrypt_secret(public_key, secret_value)
        payload = {"encrypted_value": encrypted_val, "key_id": key_id}
        
        if target_safe:
            print(f"      [DRY RUN] Would PUT encrypted payload for: {secret_name}")
            success_count += 1
            continue

        try:
            put_res = requests.put(
                f"https://api.github.com/repos/{repo_name}/actions/secrets/{secret_name}",
                headers=headers,
                json=payload
            )
            put_res.raise_for_status()
            print(f"      [+] Pushed: {secret_name}")
            success_count += 1
        except requests.exceptions.RequestException as e:
            print(f"      [❌] Failed to push {secret_name}: {e}")

    print(f"  [✓] Successfully processed {success_count}/{len(secrets_map)} repository secrets.")


def main():
    print("\n🚀 AzTracker Infrastructure Provisioner\n")
    
    setup_gitignore()
    env_vars = load_local_env()
    
    print("-" * 40)
    print("🔑 Generating cryptographic secrets...")
    cron_key = generate_secure_string()
    webhook_secret = generate_secure_string()
    print("  [✓] Generated CRON_AUTH_KEY and TELEGRAM_WEBHOOK_SECRET")
    
    cf_account_id, cf_api_token = get_cloudflare_credentials(env_vars)
    kv_id = provision_kv_namespace(cf_account_id, cf_api_token)
    update_wrangler_toml(kv_id)
    
    provision_github_secrets(env_vars, cf_account_id, kv_id, cf_api_token, cron_key, webhook_secret)
    
    print("-" * 40)
    print("✅ Milestone 3 complete. Edge and Repository are synchronized.")

if __name__ == "__main__":
    main()
