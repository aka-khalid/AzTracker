$prodWorker = "aztracker-prod-worker"
$devWorker = "aztracker-dev-worker"

$keys = @(
    "AMAZON_CLIENT_ID",
    "AMAZON_CLIENT_SECRET",
    "AMAZON_PARTNER_TAG",
    "AMZN_ASSOCIATES_TAG",
    "AMZN_EG_MERCHANT_ID",
    "AMZN_RESALE_MERCHANT_ID",
    "TELEGRAM_ROOT_ADMIN_IDS"
)

$secrets = @{}

Write-Host "========================================"
Write-Host " AzTracker Secret Injection Script"
Write-Host "========================================"
Write-Host "Please enter your secrets below."
Write-Host "These will be kept in memory only and will not be saved to disk.`n"

foreach ($key in $keys) {
    $secrets[$key] = Read-Host "Enter value for $key"
}

$prodBotToken = Read-Host "Enter value for Prod Bot Token (TELEGRAM_BOT_TOKEN)"
$devBotToken = Read-Host "Enter value for Dev Bot Token (TELEGRAM_BOT_TOKEN)"

Write-Host "`nGenerating secure webhook secrets..."
$prodWebhookSecret = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | % {[char]$_})
$devWebhookSecret = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | % {[char]$_})
Write-Host "Done."

Write-Host "`n[1/3] Deploying the workers to Cloudflare so they exist..."
npx wrangler deploy
npx wrangler deploy --env production

Write-Host "`n[2/3] Setting secrets for Production Worker ($prodWorker)..."
foreach ($key in $keys) {
    $value = $secrets[$key]
    Write-Host " -> Setting $key"
    $value | npx wrangler secret put $key --env production
}
Write-Host " -> Setting TELEGRAM_BOT_TOKEN"
$prodBotToken | npx wrangler secret put TELEGRAM_BOT_TOKEN --env production
Write-Host " -> Setting TELEGRAM_WEBHOOK_SECRET"
$prodWebhookSecret | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --env production

Write-Host "`n[3/3] Setting secrets for Dev Worker ($devWorker)..."
foreach ($key in $keys) {
    $value = $secrets[$key]
    Write-Host " -> Setting $key"
    $value | npx wrangler secret put $key
}
Write-Host " -> Setting TELEGRAM_BOT_TOKEN"
$devBotToken | npx wrangler secret put TELEGRAM_BOT_TOKEN
Write-Host " -> Setting TELEGRAM_WEBHOOK_SECRET"
$devWebhookSecret | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

Write-Host "`n========================================"
Write-Host " All secrets injected successfully!"
Write-Host "========================================"
Write-Host "`nCopy and paste these URLs into your browser to register your webhooks:"
Write-Host "`nProd Webhook Registration URL:"
Write-Host "https://api.telegram.org/bot${prodBotToken}/setWebhook?url=https://aztracker-prod-worker.aka-khalid.workers.dev/webhook&secret_token=${prodWebhookSecret}"
Write-Host "`nDev Webhook Registration URL:"
Write-Host "https://api.telegram.org/bot${devBotToken}/setWebhook?url=https://aztracker-dev-worker.aka-khalid.workers.dev/webhook&secret_token=${devWebhookSecret}"
