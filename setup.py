import os
import secrets
import string
import re
import sys

# 🛡️ DEPENDENCY GATE
try:
    import requests
except ImportError:
    print("❌ Critical Dependency Missing: 'requests'")
    print("Please install it to continue: pip install requests")
    sys.exit(1)

def setup_gitignore():
    """Ensure sensitive files are ignored before any secrets are handled."""
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
                
    if not appended:
        print("  [✓] .gitignore is already secure.")
    print("-" * 40)

def generate_secure_string(length=32):
    """Generate a cryptographically secure random string."""
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))

def load_local_env():
    """Lightweight parser to load .env without requiring python-dotenv."""
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
    """Fetch Cloudflare credentials from .env, OS, or prompt the user."""
    print("☁️ Locating Cloudflare credentials...")
    account_id = env_vars.get("CLOUDFLARE_ACCOUNT_ID") or os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    api_token = env_vars.get("CLOUDFLARE_API_TOKEN") or os.environ.get("CLOUDFLARE_API_TOKEN")
    
    if not account_id:
        account_id = input("  [>] Enter your 32-character Cloudflare Account ID: ").strip()
    if not api_token:
        api_token = input("  [>] Enter your Cloudflare API Token (Requires KV Edit permissions): ").strip()
        
    return account_id, api_token

def provision_kv_namespace(account_id, api_token):
    """Idempotent KV Namespace provisioning via Cloudflare REST API."""
    print("-" * 40)
    print("🗄️ Provisioning AZTRACKER_DB KV Namespace...")
    url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/storage/kv/namespaces"
    headers = {
        "Authorization": f"Bearer {api_token}",
        "Content-Type": "application/json"
    }
    
    # 1. Scan for existing namespace (Idempotency)
    try:
        res = requests.get(url, headers=headers)
        res.raise_for_status()
        namespaces = res.json().get("result", [])
        
        for ns in namespaces:
            if ns.get("title") == "AZTRACKER_DB":
                print(f"  [✓] Namespace 'AZTRACKER_DB' already exists. ID: {ns['id']}")
                return ns["id"]
                
        # 2. Create if not found
        print("  [+] Namespace not found. Creating 'AZTRACKER_DB'...")
        create_res = requests.post(url, headers=headers, json={"title": "AZTRACKER_DB"})
        create_res.raise_for_status()
        new_id = create_res.json().get("result", {}).get("id")
        print(f"  [✓] Successfully created namespace. ID: {new_id}")
        return new_id
        
    except requests.exceptions.RequestException as e:
        print(f"  [❌] Cloudflare API Error: {e}")
        if hasattr(e, 'response') and e.response is not None:
            print(f"       Details: {e.response.text}")
        sys.exit(1)

def update_wrangler_toml(kv_id):
    """Surgically injects the KV ID into wrangler.toml without breaking formatting."""
    print("-" * 40)
    print("📝 Injecting KV ID into wrangler.toml...")
    if not os.path.exists("wrangler.toml"):
        print("  [❌] wrangler.toml not found in the current directory.")
        sys.exit(1)
        
    with open("wrangler.toml", "r") as f:
        content = f.read()
        
    # Safely targets the exact id string within the KV block
    updated_content = re.sub(
        r'(id\s*=\s*")[^"]+(")',
        r'\g<1>' + kv_id + r'\g<2>',
        content
    )
    
    if updated_content == content and kv_id not in content:
         print("  [!] Warning: Could not locate an existing 'id = \"...\"' field to replace.")
    else:
        with open("wrangler.toml", "w") as f:
            f.write(updated_content)
        print(f"  [✓] wrangler.toml updated successfully with ID: {kv_id}")

def main():
    print("\n🚀 AzTracker Infrastructure Provisioner\n")
    
    # 1. Local Pre-flight
    setup_gitignore()
    env_vars = load_local_env()
    
    print("🔑 Generating cryptographic secrets...")
    cron_key = generate_secure_string()
    webhook_secret = generate_secure_string()
    print("  [✓] Generated CRON_AUTH_KEY and TELEGRAM_WEBHOOK_SECRET")
    print("-" * 40)
    
    # 2. Cloudflare Provisioning
    cf_account_id, cf_api_token = get_cloudflare_credentials(env_vars)
    kv_id = provision_kv_namespace(cf_account_id, cf_api_token)
    
    # 3. Local File Updates
    update_wrangler_toml(kv_id)
    
    print("-" * 40)
    print("✅ Milestone 2 complete. Edge database is synchronized.")

if __name__ == "__main__":
    main()
