import os
import secrets
import string

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

def main():
    print("\n🚀 AzTracker Infrastructure Provisioner (Dry Run / Local Mode)\n")
    
    # 1. Secure the perimeter
    setup_gitignore()
    
    # 2. Generate required local secrets
    print("🔑 Generating cryptographic secrets...")
    cron_key = generate_secure_string()
    webhook_secret = generate_secure_string()
    
    print(f"  [+] Generated CRON_AUTH_KEY: {cron_key}")
    print(f"  [+] Generated TELEGRAM_WEBHOOK_SECRET: {webhook_secret}")
    print("-" * 40)
    print("✅ Milestone 1 complete. No cloud environments were modified.")

if __name__ == "__main__":
    main()
