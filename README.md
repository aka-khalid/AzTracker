<div align="center">

<img src="assets/logo.png" alt="AzTracker Logo" width="200">

### The Serverless Amazon.eg Price Engine

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Python Engine](https://img.shields.io/badge/Python-3.11-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://python.org)
[![GitHub Actions](https://img.shields.io/badge/GitHub-Actions-2088FF?style=for-the-badge&logo=github-actions&logoColor=white)](https://github.com/features/actions)
[![Telegram API](https://img.shields.io/badge/Telegram-ChatOps-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white)](https://core.telegram.org/bots)

> A highly scalable, multi-tenant price tracking architecture built on Cloudflare KV and GitHub Actions. It features an interactive ChatOps UI, dual-hysteresis anti-flap protection, and a crowdsourced "Hivemind" pricing database.

🔗 **Try the Bot:** [@AzTrackerr_bot](https://t.me/AzTrackerr_bot)

📢 **Live Demo (Public Deals Channel):** [@AzTrackerr](https://t.me/AzTrackerr)

<img src="assets/StatsGraphDemo.jpg" alt="AzTracker Analytics Graph" width="400">
</div>

---

## 🚀 Key Engineering Achievements

### 🛡️ The Time-Based Hysteresis "Anti-Flap" Engine
Amazon's PA-API frequently truncates payloads under heavy load, falsely reporting items as "Out of Stock." AzTracker implements a static timestamp-driven Hysteresis buffer. It artificially holds the last known good price through API glitches, eliminating false-positive "Restock" spam and completely neutralizing Cloudflare KV write-amplification loops.

### ⚛️ Atomic Two-Phase Commit (2PC) Synchronization
To prevent TOCTOU (Time-Of-Check to Time-Of-Use) race conditions across the distributed Cloudflare KV edge network, the Python engine utilizes an atomic Two-Phase Commit. It executes webhooks synchronously, merges Telegram delivery locks with backend tracking resets into a single state array, and pushes the synchronized payload in one parallel execution.

### 📦 Smart Alternatives & Hidden Warehouse Deals
AzTracker doesn't just track the Buy Box. It parses complex condition sub-schemas to unearth hidden "Amazon Resale" (Used/Warehouse) deals. The engine routes these discoveries to a dynamic, context-aware Telegram UI, rendering specialized checkout buttons based on the exact condition of the targeted deal.

### 📉 Delta-Only Time-Series Logging
Storing identical price checks a day per product would destroy KV performance. AzTracker implements a "Delta-Logger" that strictly writes to the database *only* when a price shifts. Furthermore, the engine enforces a strict 150-point rolling cap on historical arrays, keeping historical payloads under **4.6 KB** to guarantee sub-10ms read times at the edge.

### 📊 Edge-Rendered Mini App Analytics
AzTracker intercepts Telegram's Native Web App triggers and acts as a web server, instantly rendering a beautiful, interactive `Chart.js` price graph. It native calculates All-Time Highs, All-Time Lows, and Averages on the client side, seamlessly matching the user's native Telegram Dark/Light theme.

### 🎲 Dynamic Jitter Scheduling
To prevent fixed-minute execution patterns (and subsequent API rate-limiting), the Cloudflare Worker intercepts a per-minute cron ping and generates randomized execution slots inside each hour. It uses Cloudflare's in-memory Cache API as a distributed lock to dispatch the GitHub Actions engine unpredictably.

---

## 🛠️ Architecture Pipeline

```mermaid
graph TD;
    User([📱 User Drops Amazon Link]) --> Worker[⚡ Cloudflare Worker Edge Node];
    Worker --> KV[(☁️ CF KV: User Registry)];
    Cron[⏱️ cron-job.org Ping] --> Worker;
    Worker -- Random Jitter Lock --> GH[⚙️ GitHub Actions Engine];
    GH -- Pulls Active Tracking List --> KV;
    GH -- Deduplicated Batch Query --> PAAPI[🛒 Amazon Creators API];
    PAAPI -- Live Prices --> GH;
    GH -- Dual Hysteresis Verification --> GH;
    GH -- Delta-Only Logging --> KV_Hist[(☁️ CF KV: Global History)];
    GH -- Context-Aware Alert Routing --> TG[📲 Telegram Push Notification];
    GH -- Atomic 2PC Lock Sync --> KV;
    GH_Backup[⏱️ GitHub Native Cron] -- 4-Hour Schedule --> KV_Backups[(☁️ CF KV: Auto-Backups)];
```

---
## ✨ System Features

* 👥 **Automated Join Queue:** Built-in ChatOps approval pipeline to manage guests safely, protected against "Thundering Herd" race conditions with a strict 25-item depth limit and 7-day TTL.
* 🕵️ **Web App SIEM Ledger:** A forensic audit log tracking all root administrative actions, secured by cryptographic HMAC-SHA256 URL tokens.
* 🌍 **Dynamic Geofencing:** Automatically parses incoming links and hard-rejects non-supported regions (locking the database securely to `amazon.eg`).
* 🎯 **Strict Boolean Target Locks:** Users set specific budgets. The engine features zero-spam target locks—alerting exactly once upon matching the target price.
* 📦 **Deduplicated Batch Processing:** 10 users tracking the same item triggers only 1 API request.
* ⚡ **Edge-Cached Authorization:** Leverages Cloudflare's in-memory `caches.default` API with synthetic internal routing to heavily minimize KV read quota consumption during UI interactions.
* 🎛️ **Granular Resource Quotas:** Global environment-driven tracking limits with individual admin overrides.
* 📈 **Global Price Matrix:** A root-only, HMAC-secured Web App dashboard charting the macro-trajectory of all active ASINs. The engine computationally tracks a 150-point rolling moving average and applies statistical Z-Score gating ($z \le -1.5$ and $\ge 15\%$ drop) to dynamically filter visual noise. This state-driven architecture creates a self-curating dashboard where volatile items persist visibly, naturally fading into a hidden state only when the moving average normalizes to the new low price.

---

## ⚙️ Deployment & Infrastructure

AzTracker relies on a fully automated GitOps pipeline. 

1. **The Edge Node:** `worker.js` handles all UI rendering, routing, user authorization, Web App serving, and the randomized scheduler logic. Deployed via Actions to Cloudflare.
2. **The Processing Engine:** `price_tracker.py` wakes up via a `repository_dispatch`, handles the heavy multi-tenant array processing, and dispatches Telegram alerts. 
3. **The Database:** A single Cloudflare KV namespace acts as the state manager, user registry, and global price history ledger.
4. **The Provisioner:** `setup.py` acts as a local zero-friction deployment tool. It dynamically parses cloud environments, executes PyNaCl asymmetric cryptography to inject GitHub secrets, provisions the Cloudflare KV REST API, and wires the Telegram webhook automatically.

*(See the [Deployment Guide](docs/DEPLOYMENT.md) for full step-by-step setup and quick-start instructions).*

---

## 📡 Advanced Feature: Omnichannel Broadcast (Optional)

AzTracker includes a hidden, opt-in feature to automatically run a public Deals Channel. The engine can evaluate every tracked item, calculate its standard deviation and historical mean, and deploy a statistical Z-Score algorithm. Trigger conditions require a statistical Z-Score anomaly of **$z \le -1.5$** paired with a strict **$\ge 15\%$** absolute price drop. This is dynamically lowered to **$z \le -1.0$** and a **$\ge 10\%$** drop if the item concurrently hits an All-Time Low (ATL). 

Furthermore, the engine enforces a **24-Hour High-Water Mark**: once an item is broadcast, it is mathematically locked from being re-broadcast for 24 hours unless the new price drops strictly lower than the previously alerted price, permanently eliminating intra-day bounce-back spam.

To enable this for your own deployment:
1. Ensure your bot is added to your public channel as an Administrator with "Post Messages" permission.
2. Go to your repository's **Settings > Secrets and variables > Actions**.
3. Add a new secret named `TELEGRAM_PUBLIC_CHANNEL_ID` and set its value to your channel's handle (e.g., `@AzTrackerr`).

If the `TELEGRAM_PUBLIC_CHANNEL_ID` secret is absent, the engine simply skips the broadcast logic and functions purely as a private tracker.

---

## 👨‍💻 Architect & Acknowledgements

Engineered and maintained by **Khalid Ibrahim**, built upon core cloud infrastructure and system architecture principles.

Special thanks to **[Abdelrahman Elkhayat](https://www.facebook.com/bodaa.elkhayat)** for generously providing the Amazon Creators API credentials that power the core tracking engine.

Built with assistance from:
* [Gemini](https://gemini.google.com) by Google
* [Claude](https://claude.ai) by Anthropic
* [ChatGPT](https://chatgpt.com) by OpenAI

---

## 🗺️ Future Development
*Check out the [Architecture Roadmap](docs/ROADMAP.md) to see planned features and tech debt resolutions.*

---

## License
MIT — free to use, modify, and distribute.
