"""
AzTracker — Interactive Telegram Bot
Runs on Render 24/7, handles user commands and updates products.json
in the GitHub repo via the GitHub API.
"""

import os
import json
import base64
import requests
import logging
from datetime import datetime
import pytz
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application, CommandHandler, CallbackQueryHandler,
    MessageHandler, ContextTypes, ConversationHandler, filters
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
TELEGRAM_TOKEN   = os.environ["TELEGRAM_TOKEN"]
TELEGRAM_CHAT_ID = int(os.environ["TELEGRAM_CHAT_ID"])
GITHUB_TOKEN     = os.environ["AZ_GITHUB_TOKEN"]
GITHUB_REPO      = os.environ["AZ_REPO"]          # e.g. "aka-khalid/AzTracker"
GITHUB_WORKFLOW  = os.environ.get("GITHUB_WORKFLOW", "price_tracker.yml")
# ─────────────────────────────────────────────────────────────────────────────

GITHUB_API = "https://api.github.com"
HEADERS = {
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
}

# Conversation states
ADDING_URL = 1
REMOVING_PRODUCT = 2
TOGGLING_PRODUCT = 3


# ── Security: only you can use the bot ───────────────────────────────────────

def restricted(func):
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        user_id = update.effective_user.id if update.effective_user else None
        if user_id != TELEGRAM_CHAT_ID:
            await update.effective_message.reply_text("⛔ Unauthorized.")
            return
        return await func(update, context)
    return wrapper


# ── GitHub API helpers ────────────────────────────────────────────────────────

def github_get_file(path):
    """Returns (content_dict, sha) or (None, None)."""
    resp = requests.get(f"{GITHUB_API}/repos/{GITHUB_REPO}/contents/{path}", headers=HEADERS)
    if resp.status_code == 200:
        data = resp.json()
        content = json.loads(base64.b64decode(data["content"]).decode())
        return content, data["sha"]
    return None, None


def github_put_file(path, content, sha, message):
    """Commits updated file to repo."""
    encoded = base64.b64encode(json.dumps(content, indent=2).encode()).decode()
    payload = {"message": message, "content": encoded, "sha": sha}
    resp = requests.put(
        f"{GITHUB_API}/repos/{GITHUB_REPO}/contents/{path}",
        headers=HEADERS, json=payload
    )
    return resp.status_code in (200, 201)


def trigger_workflow():
    """Triggers the price tracker workflow via GitHub API."""
    resp = requests.post(
        f"{GITHUB_API}/repos/{GITHUB_REPO}/actions/workflows/{GITHUB_WORKFLOW}/dispatches",
        headers=HEADERS,
        json={"ref": "main"}
    )
    return resp.status_code == 204


# ── Keyboards ─────────────────────────────────────────────────────────────────

def main_menu_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("➕ Add Product",     callback_data="add")],
        [InlineKeyboardButton("📦 My Products",     callback_data="list")],
        [InlineKeyboardButton("❌ Remove Product",  callback_data="remove")],
        [InlineKeyboardButton("⏸ Pause / ▶️ Resume", callback_data="toggle")],
        [InlineKeyboardButton("🔄 Check Now",       callback_data="check")],
        [InlineKeyboardButton("📊 Stats",           callback_data="stats")],
    ])


def back_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🏠 Main Menu", callback_data="menu")]
    ])


# ── Helpers ───────────────────────────────────────────────────────────────────

def truncate(name: str, length=50) -> str:
    return name[:length] + "..." if len(name) > length else name


def get_product_id(url: str) -> str:
    return url.rstrip("/").split("/")[-1]


# ── Main menu ─────────────────────────────────────────────────────────────────

@restricted
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.effective_message.reply_text(
        "🛒 <b>AzTracker</b>\nWhat would you like to do?",
        parse_mode="HTML",
        reply_markup=main_menu_keyboard()
    )


async def menu_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    await query.edit_message_text(
        "🛒 <b>AzTracker</b>\nWhat would you like to do?",
        parse_mode="HTML",
        reply_markup=main_menu_keyboard()
    )


# ── Add product ───────────────────────────────────────────────────────────────

async def add_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    await query.edit_message_text(
        "➕ <b>Add Product</b>\n\nSend me the Amazon.eg product URL:",
        parse_mode="HTML",
        reply_markup=back_keyboard()
    )
    return ADDING_URL


@restricted
async def receive_url(update: Update, context: ContextTypes.DEFAULT_TYPE):
    url = update.message.text.strip()

    if "amazon.eg" not in url and "amzn" not in url:
        await update.message.reply_text(
            "⚠️ That doesn't look like an Amazon.eg URL. Please send a valid link.",
            reply_markup=back_keyboard()
        )
        return ADDING_URL

    products, sha = github_get_file("products.json")
    if products is None:
        await update.message.reply_text("❌ Could not load products list.", reply_markup=back_keyboard())
        return ConversationHandler.END

    # Check if already tracked
    existing_urls = [p["url"] for p in products]
    if url in existing_urls:
        await update.message.reply_text("ℹ️ This product is already being tracked.", reply_markup=back_keyboard())
        return ConversationHandler.END

    products.append({"url": url, "paused": False})
    success = github_put_file("products.json", products, sha, f"feat: add product {get_product_id(url)}")

    if success:
        await update.message.reply_text(
            f"✅ Product added successfully!\n\n🔗 {url}\n\nIt will be checked on the next scheduled run.",
            reply_markup=back_keyboard()
        )
    else:
        await update.message.reply_text("❌ Failed to save product.", reply_markup=back_keyboard())

    return ConversationHandler.END


# ── List products ─────────────────────────────────────────────────────────────

async def list_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    products, _ = github_get_file("products.json")
    prices, _   = github_get_file("prices.json")

    if not products:
        await query.edit_message_text("📦 You have no products being tracked.", reply_markup=back_keyboard())
        return

    prices = prices or {}
    lines = ["📦 <b>My Products</b>\n"]

    for i, p in enumerate(products, 1):
        product_id = get_product_id(p["url"])
        price = prices.get(product_id)
        status = "⏸ Paused" if p.get("paused") else "✅ Active"
        price_str = f"{price:,.2f} EGP" if price else "Not checked yet"
        lines.append(f"{i}. <a href='{p['url']}'>{product_id}</a>\n   💰 {price_str} | {status}")

    await query.edit_message_text(
        "\n\n".join(lines),
        parse_mode="HTML",
        reply_markup=back_keyboard(),
        disable_web_page_preview=True
    )


# ── Remove product ────────────────────────────────────────────────────────────

async def remove_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    products, _ = github_get_file("products.json")
    if not products:
        await query.edit_message_text("📦 No products to remove.", reply_markup=back_keyboard())
        return ConversationHandler.END

    buttons = []
    for i, p in enumerate(products):
        product_id = get_product_id(p["url"])
        buttons.append([InlineKeyboardButton(f"❌ {product_id}", callback_data=f"remove_{i}")])
    buttons.append([InlineKeyboardButton("🏠 Main Menu", callback_data="menu")])

    await query.edit_message_text(
        "❌ <b>Remove Product</b>\n\nSelect a product to remove:",
        parse_mode="HTML",
        reply_markup=InlineKeyboardMarkup(buttons)
    )
    return REMOVING_PRODUCT


async def confirm_remove(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    index = int(query.data.split("_")[1])
    products, sha = github_get_file("products.json")

    if index >= len(products):
        await query.edit_message_text("❌ Product not found.", reply_markup=back_keyboard())
        return ConversationHandler.END

    removed = products.pop(index)
    product_id = get_product_id(removed["url"])
    success = github_put_file("products.json", products, sha, f"feat: remove product {product_id}")

    if success:
        await query.edit_message_text(f"✅ Removed: {product_id}", reply_markup=back_keyboard())
    else:
        await query.edit_message_text("❌ Failed to remove product.", reply_markup=back_keyboard())

    return ConversationHandler.END


# ── Pause / Resume ────────────────────────────────────────────────────────────

async def toggle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    products, _ = github_get_file("products.json")
    if not products:
        await query.edit_message_text("📦 No products to pause/resume.", reply_markup=back_keyboard())
        return ConversationHandler.END

    buttons = []
    for i, p in enumerate(products):
        product_id = get_product_id(p["url"])
        icon = "▶️" if p.get("paused") else "⏸"
        buttons.append([InlineKeyboardButton(f"{icon} {product_id}", callback_data=f"toggle_{i}")])
    buttons.append([InlineKeyboardButton("🏠 Main Menu", callback_data="menu")])

    await query.edit_message_text(
        "⏸ <b>Pause / Resume</b>\n\nSelect a product to toggle:",
        parse_mode="HTML",
        reply_markup=InlineKeyboardMarkup(buttons)
    )
    return TOGGLING_PRODUCT


async def confirm_toggle(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    index = int(query.data.split("_")[1])
    products, sha = github_get_file("products.json")

    if index >= len(products):
        await query.edit_message_text("❌ Product not found.", reply_markup=back_keyboard())
        return ConversationHandler.END

    products[index]["paused"] = not products[index].get("paused", False)
    product_id = get_product_id(products[index]["url"])
    state = "paused" if products[index]["paused"] else "resumed"
    success = github_put_file("products.json", products, sha, f"feat: {state} product {product_id}")

    if success:
        icon = "⏸" if products[index]["paused"] else "▶️"
        await query.edit_message_text(f"{icon} {product_id} is now {state}.", reply_markup=back_keyboard())
    else:
        await query.edit_message_text("❌ Failed to update product.", reply_markup=back_keyboard())

    return ConversationHandler.END


# ── Check now ─────────────────────────────────────────────────────────────────

async def check_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    await query.edit_message_text("🔄 Triggering price check...")

    success = trigger_workflow()
    if success:
        await query.edit_message_text(
            "✅ Price check triggered!\n\nYou'll get a Telegram notification if any price drops.",
            reply_markup=back_keyboard()
        )
    else:
        await query.edit_message_text(
            "❌ Failed to trigger workflow. Check your GITHUB_TOKEN.",
            reply_markup=back_keyboard()
        )


# ── Stats ─────────────────────────────────────────────────────────────────────

async def stats_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    products, _ = github_get_file("products.json")
    prices, _   = github_get_file("prices.json")

    products = products or []
    prices   = prices or {}

    total   = len(products)
    active  = sum(1 for p in products if not p.get("paused"))
    paused  = total - active
    checked = sum(1 for p in products if get_product_id(p["url"]) in prices)

    cairo_tz = pytz.timezone('Africa/Cairo')
    now = datetime.now(cairo_tz).strftime("%Y-%m-%d %H:%M %Z")

    await query.edit_message_text(
        f"📊 <b>Stats</b>\n\n"
        f"📦 Total products: {total}\n"
        f"✅ Active: {active}\n"
        f"⏸ Paused: {paused}\n"
        f"🔍 Checked at least once: {checked}\n\n"
        f"🕐 {now}",
        parse_mode="HTML",
        reply_markup=back_keyboard()
    )


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    app = Application.builder().token(TELEGRAM_TOKEN).build()

    # Add/remove/toggle conversation handlers
    conv_handler = ConversationHandler(
        entry_points=[
            CallbackQueryHandler(add_callback,    pattern="^add$"),
            CallbackQueryHandler(remove_callback, pattern="^remove$"),
            CallbackQueryHandler(toggle_callback, pattern="^toggle$"),
        ],
        states={
            ADDING_URL:        [MessageHandler(filters.TEXT & ~filters.COMMAND, receive_url)],
            REMOVING_PRODUCT:  [CallbackQueryHandler(confirm_remove, pattern="^remove_\\d+$")],
            TOGGLING_PRODUCT:  [CallbackQueryHandler(confirm_toggle, pattern="^toggle_\\d+$")],
        },
        fallbacks=[CallbackQueryHandler(menu_callback, pattern="^menu$")],
    )

    app.add_handler(CommandHandler("start", start))
    app.add_handler(conv_handler)
    app.add_handler(CallbackQueryHandler(menu_callback,  pattern="^menu$"))
    app.add_handler(CallbackQueryHandler(list_callback,  pattern="^list$"))
    app.add_handler(CallbackQueryHandler(check_callback, pattern="^check$"))
    app.add_handler(CallbackQueryHandler(stats_callback, pattern="^stats$"))

    print("Bot is running...")
    app.run_polling()


if __name__ == "__main__":
    main()
