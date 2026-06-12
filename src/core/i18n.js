/**
 * i18n.js — Professional Masry Egyptian Arabic Localization Engine
 *
 * Flat key structure: t('category.key', lang) → string
 * Supported languages: 'en' (English), 'masry' (Professional Masry Egyptian Arabic)
 *
 * "Professional Masry" constraints:
 *   - Conversational Egyptian Arabic (عامية مصرية)
 *   - Not overly formal (no Fusha)
 *   - Not overly slangy (no deep street dialect)
 *   - Professional but relatable — like a knowledgeable friend at a coffee shop
 *   - Uses emoji naturally for mobile-first UI
 *   - EGP currency always rendered as "ج.م" or spelled out "جنيه مصري"
 */

const dict = {
  // ── Universal Chrome ──────────────────────────────────────────────────────
  "chrome.brand": {
    en: "AzTracker",
    masry: "AzTracker"
  },
  "chrome.ad_disclaimer": {
    en: "As an Amazon Associate I earn from qualifying purchases.",
    masry: "بناخد عمولة من أمازون على المشتريات."
  },
  "chrome.currency_egp": {
    en: "EGP",
    masry: "ج.م"
  },

  // ── Access Control / Onboarding ───────────────────────────────────────────
  "access.denied_head": {
    en: "⛔ <b>Access Denied</b>",
    masry: "⛔ <b>ممنوع الدخول</b>"
  },
  "access.denied_body_private": {
    en: "This is a private Amazon deals server. You are not authorized to use it.",
    masry: "ده سيرفر برايفت مقفول على حبايبنا لعروض أمازون، للأسف لسه مش معاك صلاحية."
  },
  "access.denied_hint_start": {
    en: "Send /start to request access.",
    masry: "ابعت /start عشان تدخل."
  },
  "access.request_btn": {
    en: "✋ Request Access",
    masry: "✋ ابعتلنا"
  },
  "access.pending_head": {
    en: "⏳ <b>Request Pending</b>",
    masry: "⏳ <b>هنشوف ونرد عليك</b>"
  },
  "access.pending_body": {
    en: "Your application is currently under review by an administrator. Please wait.",
    masry: "الادمنز بيشوفوا طلبك دلوقتي، طول بالك معانا وربنا يسهل."
  },
  "access.request_sent": {
    en: "⏳ <b>Request Sent.</b>\n\nPlease wait for an administrator to review your application.",
    masry: "⏳ <b>استلمنا طلبك يا غالي.</b>\n\nاستنى الادمنز يراجعوه وهنرد عليك."
  },
  "access.queue_full_head": {
    en: "⚠️ <b>Queue Full</b>",
    masry: "⚠️ <b>زحمة</b>"
  },
  "access.queue_full_body": {
    en: "The access queue is currently full. Please try again in 24 hours.",
    masry: "السيرفر متفول على آخره دلوقتي، حاول معانا تاني كمان يوم كده."
  },
  "access.admin_new_request_head": {
    en: "🔔 <b>New Access Request</b>",
    masry: "🔔 <b>في حد جديد عايز يدخل</b>"
  },
  "access.admin_new_request_body": {
    en: "👤 <b>Name:</b> {name}\n🆔 <b>ID:</b> <code>{id}</code>\n\n<i>This user is requesting authorization to access the server.</i>",
    masry: "👤 <b>الاسم:</b> {name}\n🆔 <b>آي دي:</b> <code>{id}</code>\n\n<i>الشخص ده طالب يدخل السيرفر، رأيك إيه؟</i>"
  },
  "access.admin_new_request_btn_approve": {
    en: "✅ Approve",
    masry: "✅ خليه يدخل"
  },
  "access.admin_new_request_btn_reject": {
    en: "❌ Reject",
    masry: "❌ فكك منه"
  },
  "access.denied_notify": {
    en: "⛔ <b>Access Request Denied</b>\n\nYour request to join the server has been declined by an administrator.",
    masry: "⛔ <b>الطلب اترفض</b>\n\nمعلش يا صاحبي، الادمن رفض طلب دخولك للسيرفر."
  },
  "access.blocked_head": {
    en: "🚫 <b>Account Blocked</b>",
    masry: "🚫 <b>الحساب مقفول</b>"
  },
  "access.blocked_body": {
    en: "Your account was blocked because the bot was banned or couldn't reach you. Request an unban below.",
    masry: "حسابك اتقفل عشان البوت أخد بان أو مش قادر يوصلك. اطلب إلغاء الحظر من الزرار اللي تحت."
  },
  "access.unban_btn": {
    en: "🔄 Request Unban",
    masry: "🔄 اطلب الغاء الحظر"
  },
  "access.unban_sent": {
    en: "✅ <b>Unban Request Sent</b>\n\nAn administrator will review your request shortly.",
    masry: "✅ <b>طلبك وصل</b>\n\nالادمن هيشوف طلب إلغاء الحظر قريب."
  },
  "access.unban_pending": {
    en: "⏳ <b>Unban Request Pending</b>\n\nYou already have a pending unban request. An administrator will review it shortly.\n\nPlease be patient — sending multiple requests will not speed up the process.",
    masry: "⏳ <b>طلبك لسه ماتردش عليه</b>\n\nعندك طلب إلغاء حظر لسه متراجعش. الادمن هيشوفه قريب.\n\nطول بالك معانا — كتر الطلبات مش هيسرع الدنيا."
  },
  "access.unban_rejected": {
    en: "🚫 <b>Access Denied</b>\n\nYour unban request was rejected. You cannot request again at this time.",
    masry: "🚫 <b>ممنوع الدخول</b>\n\nطلبك اترفض. مش هتقدر تبعت طلب تاني دلوقتي."
  },
  "admin.unban_request_head": {
    en: "🔒 <b>Unban Request</b>",
    masry: "🔒 <b>في حد عايز يلغي الحظر</b>"
  },
  "admin.unban_request_body": {
    en: "👤 <b>Name:</b> {name}\n🆔 <b>ID:</b> <code>{id}</code>\n\n<i>This user was previously blocked (bot banned/unreachable) and is requesting to be unbanned.</i>",
    masry: "👤 <b>الاسم:</b> {name}\n🆔 <b>آي دي:</b> <code>{id}</code>\n\n<i>الشخص ده كان محظور وعايز يرجع تاني.</i>"
  },
  "admin.unban_request_btn_unban": {
    en: "✅ Unban",
    masry: "✅ الغي الحظر"
  },
  "access.unban_notify": {
    en: "✅ <b>Your account has been unbanned.</b>\n\nSend /start to continue.",
    masry: "✅ <b>الحظر اتشال من عليك يا غالي.</b>\n\nابعت /start عشان تكمل وتشوف العروض."
  },
  "admin.unban_request_btn_keep": {
    en: "🚫 Keep Banned",
    masry: "🚫 سيبه محظور"
  },
  "admin.unban_request_dashboard_hint": {
    en: "📋 Handle this request in the admin dashboard.",
    masry: "📋 تعامل مع الطلب ده من لوحة تحكم الأدمن."
  },
  "crm.btn_deny": {
    en: "Deny",
    masry: "فكك منه"
  },
  "access.admin_rejected": {
    en: "🚫 <b>Request Rejected</b>\nUser ‏<code>{id}</code>‏ has been denied access by {admin}.",
    masry: "🚫 <b>الطلب اترفض</b>\nالشخص آي دي {id} اترفض من {admin}."
  },
  "access.admin_rejected_manual": {
    en: "🚫 <b>Request Rejected</b>\nUser ‏<code>{id}</code>‏ has been explicitly denied access.",
    masry: "🚫 <b>الطلب اترفض</b>\nآي دي {id} اترفض بالظبط."
  },
  "access.handled_request": {
    en: "🚫 <b>Request Handled</b>\nUser ‏<code>{id}</code>‏ was rejected by {admin}.",
    masry: "🚫 <b>خلصنا الحوار ده</b>\nالمستخدم <code>{id}</code> أخد رفض من {admin}."
  },
  "access.handled_approved": {
    en: "✅ <b>Request Handled</b>\nUser ‏<code>{id}</code>‏ was approved by {admin}.",
    masry: "✅ <b>خلصنا الحوار ده</b>\nالمستخدم <code>{id}</code> أخد موافقة من {admin}."
  },

  // ── Welcome Message ───────────────────────────────────────────────────────
  "welcome.head": {
    en: "🎉 <b>You have been approved! Welcome!</b>",
    masry: "🎉 <b>ألف مبروك! نورتنا يا غالي!</b>"
  },
  "welcome.step1": {
    en: "<b>1️⃣ Find your item</b>\nOpen the Amazon app or website and find the product you want to buy.",
    masry: "<b>1️⃣ اختار اللي على مزاجك</b>\nافتح أبلكيشن أمازون واختار المنتج اللي عينك منه."
  },
  "welcome.step2": {
    en: "<b>2️⃣ Share the link</b>\nThe easiest way: In the Amazon app, hit the <b>Share</b> button, select Telegram, and send it directly to this bot! (You can also just copy and paste the link into the chat).",
    masry: "<b>2️⃣ ابعتلنا اللينك</b>\nأسهل حاجة: من الأبلكيشن دوس <b>مشاركة (Share)</b> واختار تيليجرام وابعته للبوت دايركت! (أو خد اللينك كوبي بيست هنا)."
  },
  "welcome.step3": {
    en: "<b>3️⃣ Set a Target Price (Optional)</b>\nIf you only want alerts for a specific price, click the <i>🎯 Set Target</i> button after adding your item. The bot will stay quiet until the price drops to or below your exact target!",
    masry: "<b>3️⃣ حط تارجت للسعر (لو حابب)</b>\nلو مستني السعر ينزل لرقم معين، دوس على <i>🎯 قول السعر اللي عايزه</i> بعد ما تضيف المنتج. البوت مش هيصدعك غير لما السعر ينزل للرقم ده أو أقل!"
  },
  "welcome.step4": {
    en: "<b>4️⃣ Relax & Wait</b>\nThe bot will continuously monitor the market in the background. It will automatically notify you of major price drops, restocks, and even cheaper Amazon Resale (Used) alternatives.",
    masry: "<b>4️⃣ كبر دماغك واستنى</b>\nالبوت قاعد بيراقب السوق. أول ما السعر يقع أو المنتج يتوفر، هيجيلك إشعار في ساعتها. ولو في بديل كسر زيرو (ريسيل) أرخص، هنجيبهولك."
  },
  "welcome.step5": {
    en: "<b>5️⃣ The Item Limit</b>\nTo keep the servers from catching fire, everyone starts with a limit of <b>{limit}</b> saved items. If you desperately need to save more, you'll have to secretly bribe whichever admin invited you (coffee and a good shawarma usually do the trick 😉).",
    masry: "<b>5️⃣ الحد الأقصى للمنتجات</b>\nعشان السيرفرات متفرقعش مننا، كل واحد ليه <b>{limit}</b> منتجات. لو محتاج أكتر، راضي الادمن اللي دخلك (شاورما وقهوة بيعملوا المعجزات 😉)."
  },
  "welcome.protip": {
    en: "💡 <i>Pro-Tip: You can always click \"📦 My Products\" from the Main Menu to manage your items, update target prices, or pause checking on things you've already bought.</i>",
    masry: "💡 <i>خد بالك: تقدر في أي وقت تدوس على '📦 منتجاتي' من القائمة الرئيسية عشان تدير منتجاتك، تعدل أسعار التارجت، أو توقف متابعة حاجة اشتريتها خلاص عشان تفضي مكان.</i>"
  },

  // ── Language Command ──────────────────────────────────────────────────────
  "lang.head": {
    en: "🌐 <b>Language Settings</b>",
    masry: "🌐 <b>إعدادات اللغة</b>"
  },
  "lang.choose": {
    en: "Please select your preferred language:\n\n<i>اختار اللغة المفضلة بتاعتك:</i>",
    masry: "اختار اللغة المفضلة بتاعتك:\n\n<i>Please select your preferred language:</i>"
  },
  "lang.btn_en": {
    en: "🇬🇧 English",
    masry: "🇬🇧 الإنجليزية"
  },
  "lang.btn_ar": {
    en: "🇪🇬 العربية (مصرية)",
    masry: "🇪🇬 العربية (مصرية)"
  },
  "lang.changed": {
    en: "✅ Language changed to <b>English</b>.",
    masry: "✅ تم تغيير اللغة لـ <b>العربية</b>."
  },

  // ── Main Menu ─────────────────────────────────────────────────────────────
  "menu.deals_dashboard": {
    en: "🏠 <b>Deals Dashboard</b>",
    masry: "🏠 <b>لوحة العروض</b>"
  },
  "menu.your_saved_items": {
    en: "📦 <b>Your Saved Items:</b>",
    masry: "📦 <b>منتجاتك المحفوظة:</b>"
  },
  "menu.active": {
    en: "⚡ <b>Active:</b>",
    masry: "⚡ <b>نشط:</b>"
  },
  "menu.paused": {
    en: "⏸️ <b>Paused:</b>",
    masry: "⏸️ <b>متوقف:</b>"
  },
  "menu.select_option": {
    en: "Select an operative option below:",
    masry: "اختار اللي انت عايزه من تحت:"
  },
  "menu.btn_my_products": {
    en: "📦 My Products",
    masry: "📦 منتجاتي"
  },
  "menu.btn_how_to_add": {
    en: "➕ How to Add Products",
    masry: "➕ إزاي أضيف منتجات"
  },
  "menu.btn_admin_panel": {
    en: "👑 Admin Panel",
    masry: "👑 لوحة الأدمن"
  },
  "menu.btn_language": {
    en: "🌐 Language / اللغة",
    masry: "🌐 اللغة / Language"
  },
  "menu.unlimited": {
    en: "∞",
    masry: "∞"
  },
  "menu.error": {
    en: "⚠️ Error",
    masry: "⚠️ خطأ"
  },

  // ── How to Add ────────────────────────────────────────────────────────────
  "howto.head": {
    en: "💡 <b>How to Add a Product:</b>",
    masry: "💡 <b>إزاي تضيف منتج:</b>"
  },
  "howto.body": {
    en: "Copy any Amazon.eg product link from your browser or app and paste it directly into this chat box as a message.",
    masry: "هات لينك أي منتج من أمازون مصر وارميه في الشات هنا على طول."
  },
  "howto.shortlinks": {
    en: "📱 <b>Short links shared directly from the mobile app are fully supported!</b>",
    masry: "📱 <b>لينكات أمازون المختصرة من الأبلكيشن شغالة عادي!</b>"
  },

  // ── Product Link Processing ───────────────────────────────────────────────
  "link.processing": {
    en: "⏳ <b>Processing Amazon link...</b>",
    masry: "⏳ <b>ثواني بنشوف اللينك...</b>"
  },
  "link.region_not_supported_head": {
    en: "❌ <b>Region Not Supported</b>",
    masry: "❌ <b>المنطقة مش مدعومة</b>"
  },
  "link.region_not_supported_body": {
    en: "Currently, we only support ‏<code>amazon.eg</code>‏.",
    masry: "شغالين على <code>amazon.eg</code> بتاع مصر بس يا باشا."
  },
  "link.could_not_parse": {
    en: "❌ <b>Could not parse a valid 10-digit ASIN.</b>",
    masry: "❌ <b>اللينك ده شكله بايظ، مش لاقيين فيه رقم المنتج (ASIN).</b>"
  },
  "link.system_error": {
    en: "⚠️ <b>System Error:</b> Global item limit is unconfigured. Please contact an admin.",
    masry: "⚠️ <b>فيه مشكلة:</b> الحد الأقصى للمنتجات مش متحدد. كلم الأدمن."
  },
  "link.limit_reached_head": {
    en: "⛔ <b>Limit Reached</b>",
    masry: "⛔ <b>وصلت للحد الأقصى</b>"
  },
  "link.limit_reached_body": {
    en: "You have saved {used} items, but your current limit is {limit}.\n\nPlease delete some products to free up space before adding new ones.",
    masry: "انت كده مسيف {used} منتج، وآخرك معانا {limit}.\n\nفضيلنا مكان كده وامسح شوية حاجات قديمة عشان تعرف تضيف الجديد."
  },
  "link.manage_products": {
    en: "📦 Manage My Products",
    masry: "📦 إدارة منتجاتي"
  },
  "link.already_exists": {
    en: "⚠️ <b>You have already saved this product!</b>",
    masry: "⚠️ <b>يا ريس المنتج ده عندك متسيف أصلاً!</b>"
  },
  "link.registered_head": {
    en: "✅ <b>Product Registered!</b>",
    masry: "✅ <b>المنتج اتضاف يا باشا!</b>"
  },
  "link.registered_status": {
    en: "This item is now saved. It will pull the live price during the next automated check.",
    masry: "المنتج اتحفظ. هنجيبلك السعر في أقرب لفة للبوت."
  },
  "link.pending_scan": {
    en: "⏳ Pending initial scan...",
    masry: "⏳ مستنيين اللفة الجاية عشان نجيب السعر..."
  },
  "link.status_label": {
    en: "Status:",
    masry: "الحالة:"
  },
  "link.invalid_command": {
    en: "⚠️ <b>Invalid Command or Input Structure</b>\n\nPlease use the interactive options below or drop a valid Amazon item link.",
    masry: "⚠️ <b>إيه يا عم اللي انت كاتبه ده؟ مش فاهم حاجة!</b>\n\nاستخدم الزراير اللي تحت أو ارمي لينك أمازون شغال."
  },

  // ── Product List ──────────────────────────────────────────────────────────
  "list.my_saved_products": {
    en: "📦 <b>My Saved Products</b>",
    masry: "📦 <b>منتجاتي المحفوظة</b>"
  },
  "list.page_of": {
    en: "Page {page} of {total}",
    masry: "صفحة {page} من {total}"
  },
  "list.empty_head": {
    en: "❌ <b>Your saved list is empty.</b>",
    masry: "❌ <b>قايمتك بتصفر يا باشا، مفيش حاجة هنا.</b>"
  },
  "list.empty_hint": {
    en: "Paste an Amazon.eg link in the chat box to add it to your list.",
    masry: "ارمي أي لينك أمازون مصر في الشات عشان تضيفه لقايمتك."
  },
  "list.select_hint": {
    en: "Select an item below to modify its checking parameters:",
    masry: "اختار منتج من دول عشان تظبط إعداداته:"
  },
  "list.prev": {
    en: "⬅️ Prev",
    masry: "⬅️ السابق"
  },
  "list.next": {
    en: "Next ➡️",
    masry: "التالي ➡️"
  },

  // ── Product View ──────────────────────────────────────────────────────────
  "product.price_label": {
    en: "💰 <b>Price:</b>",
    masry: "💰 <b>السعر:</b>"
  },
  "product.target_label": {
    en: "🎯 <b>Target:</b>",
    masry: "🎯 <b>التارجت:</b>"
  },
  "product.seller_label": {
    en: "🏬 <b>Seller:</b>",
    masry: "🏬 <b>البائع:</b>"
  },
  "product.status_label": {
    en: "📡 <b>Status:</b>",
    masry: "📡 <b>الحالة:</b>"
  },
  "product.status_active": {
    en: "✅ Active",
    masry: "نشط ✅"
  },
  "product.status_paused": {
    en: "⏸️ Paused",
    masry: "مريح شوية ⏸️"
  },
  "product.waiting_check": {
    en: "⏳ Waiting for next automated check...",
    masry: "⏳ ثواني بنبص على السعر وراجعين..."
  },
  "product.out_of_stock": {
    en: "❌ Out of Stock",
    masry: "❌ غير متوفر"
  },
  "product.checked_today": {
    en: "(Checked: Today at {time})",
    masry: "(شوفناه: النهارده الساعة {time})"
  },
  "product.checked_date": {
    en: "(Checked: {date} {time})",
    masry: "(شوفناه: {date} {time})"
  },
  "product.used_tag": {
    en: "(Used)",
    masry: "(مستعمل)"
  },
  "product.amazon_product": {
    en: "Amazon Product",
    masry: "منتج أمازون"
  },
  "product.unknown_product": {
    en: "Unknown Product",
    masry: "منتج غير معروف"
  },
  "product.other_options_head": {
    en: "💡 <b>Other Options:</b>",
    masry: "💡 <b>خيارات تانية:</b>"
  },
  "product.amazon_eg_label": {
    en: "Amazon.eg",
    masry: "أمازون مصر"
  },
  "product.resale_label": {
    en: "Amazon Resale",
    masry: "أمازون ريسيل"
  },
  "product.check_stock": {
    en: "(Check Stock)",
    masry: "(شيّك على المخزون)"
  },
  "product.asin_row": {
    en: "└ 🆔 <code>{asin}</code>",
    masry: "\u200F┘ 🆔 \u200E<code>{asin}</code>\u200E"
  },
  "product.asin_inline": {
    en: "🆔 <code>{asin}</code>",
    masry: "\u200F🆔 \u200E<code>{asin}</code>\u200E"
  },
  
  // ── Product View Buttons ──────────────────────────────────────────────────
  "product.btn.open_amazon": {
    en: "🛒 Open in Amazon.eg",
    masry: "🛒 شوفه على أمازون"
  },
  "product.btn.set_target": {
    en: "🎯 Set Target",
    masry: "🎯 قول السعر اللي عايزه"
  },
  "product.btn.clear_target": {
    en: "❌ Clear Target",
    masry: "❌ امسح التارجت"
  },
  "product.btn.pause": {
    en: "⏸️ Pause Checking",
    masry: "⏸️ وقف المتابعة"
  },
  "product.btn.resume": {
    en: "▶️ Resume Checking",
    masry: "▶️ كمل المتابعة"
  },
  "product.btn.delete": {
    en: "🗑️ Delete Product",
    masry: "🗑️ امسح المنتج"
  },
  "product.btn.back_to_products": {
    en: "⬅️ Back to Products",
    masry: "⬅️ رجوع للمنتجات"
  },
  "product.btn.main_menu": {
    en: "🏠 Main Menu",
    masry: "🏠 القائمة الرئيسية"
  },

  // ── Set Target Flow ───────────────────────────────────────────────────────
  "target.set_head": {
    en: "🎯 <b>Set Target Price</b>",
    masry: "🎯 <b>قول السعر اللي عايزه</b>"
  },
  "target.set_prompt": {
    en: "ASIN: <code>{asin}</code>\n\nPlease type your desired maximum price in EGP as a message (e.g., <code>4500</code>).",
    masry: "ASIN: ‏<code>{asin}</code>‏\n\nاكتب السعر الأقصى اللي عايزه بالجنيه في رسالة (مثلاً: ‏<code>4500</code>‏)."
  },
  "target.cancel": {
    en: "❌ Cancel",
    masry: "❌ إلغاء"
  },
  "target.invalid_amount": {
    en: "⚠️ <b>Invalid amount.</b> Please enter a valid number.",
    masry: "⚠️ <b>الرقم ده مش مظبوط.</b> اكتب رقم صحيح."
  },
  "target.set_confirm_head": {
    en: "🎯 <b>Target Price Set!</b>",
    masry: "🎯 <b>حطينا السعر اللي عايزه!</b>"
  },
  "target.set_confirm_body": {
    en: "You will only be notified when ASIN <code>{asin}</code> drops to or below <b>{price}</b>.",
    masry: "هيجيلك إشعار بس لما ASIN ‏<code>{asin}</code>‏ ينزل لـ <b>{price}</b> أو أقل."
  },
  // ── Confirm Target Removal ────────────────────────────────────────────────
  "target.remove_confirm_head": {
    en: "⚠️ <b>Confirm Target Removal</b>",
    masry: "⚠️ <b>عايز تمسح التارجت؟</b>"
  },
  "target.remove_confirm_body": {
    en: "Are you sure you want to clear the target price for ASIN <code>{asin}</code>?",
    masry: "متأكد إنك عايز تمسح التارجت لـ ASIN ‏<code>{asin}</code>‏؟"
  },
  "target.btn_yes_clear": {
    en: "✅ Yes, Clear Target",
    masry: "✅ أيوة، امسح التارجت"
  },
  "target.remove_cancelled": {
    en: "❌ Cancel",
    masry: "❌ إلغاء"
  },

  // ── Confirm Deletion ─────────────────────────────────────────────────────
  "delete.confirm_head": {
    en: "⚠️ <b>Confirm Deletion</b>",
    masry: "⚠️ <b>عايز تمسح؟</b>"
  },
  "delete.confirm_body": {
    en: "Are you sure you want to permanently delete ASIN <code>{asin}</code> from your saved list?\n\n<i>This action cannot be undone.</i>",
    masry: "متأكد إنك عايز تمسح ASIN ‏<code>{asin}</code>‏ من قايمتك نهائياً؟\n\n<i>العملية دي ملهاش رجعة.</i>"
  },
  "delete.btn_yes_delete": {
    en: "✅ Yes, Delete",
    masry: "✅ أيوة، امسح"
  },
  "delete.deleted_head": {
    en: "🗑️ <b>Product Deleted</b>",
    masry: "🗑️ <b>تم مسح المنتج</b>"
  },
  "delete.deleted_body": {
    en: "ASIN <code>{asin}</code> has been completely removed from your active register.",
    masry: "ASIN ‏<code>{asin}</code>‏ اتمسح خلاص."
  },

  // ── Admin: Confirm Revocation ─────────────────────────────────────────────
  "admin.confirm_revoke_head": {
    en: "⚠️ <b>Confirm Revocation</b>",
    masry: "⚠️ <b>تأكيد إلغاء الوصول</b>"
  },
  "admin.confirm_revoke_body": {
    en: "Are you sure you want to permanently revoke ID ‏<code>{id}</code>‏?\n\n<i>Their entire saved list will be erased. This cannot be undone.</i>",
    masry: "متأكد إنك عايز تشيل الرقم ‏<code>{id}</code>‏ نهائياً؟\n\n<i>كل منتجاته المحفوحة هتتتمسح. العملية دي ملهاش رجعة.</i>"
  },
  "admin.btn_revoke": {
    en: "✅ Yes, Revoke",
    masry: "✅ أيوة، الغي"
  },
  "admin.btn_cancel": {
    en: "❌ Cancel",
    masry: "❌ إلغاء"
  },

  // ── Admin: Confirm Demotion ───────────────────────────────────────────────
  "admin.confirm_demote_head": {
    en: "⚠️ <b>Confirm Demotion</b>",
    masry: "⚠️ <b>عايز تخفض رتبته؟</b>"
  },
  "admin.confirm_demote_body": {
    en: "Are you sure you want to strip Admin privileges from ID ‏<code>{id}</code>‏?",
    masry: "متأكد إنك عايز تشيل صلاحيات الأدمن من آي دي ‏<code>{id}</code>‏؟"
  },
  "admin.btn_demote": {
    en: "✅ Yes, Demote",
    masry: "✅ أيوة، خفض"
  },

  // ── Admin: Confirm Promotion ──────────────────────────────────────────────
  "admin.confirm_promote_head": {
    en: "⚠️ <b>Confirm Promotion</b>",
    masry: "⚠️ <b>عايز تخليه أدمن؟</b>"
  },
  "admin.confirm_promote_body": {
    en: "Are you sure you want to grant full Admin privileges to ID ‏<code>{id}</code>‏?",
    masry: "متأكد إنك عايز تخلي الرقم ‏<code>{id}</code>‏ أدمن؟"
  },
  "admin.btn_promote": {
    en: "✅ Yes, Promote",
    masry: "✅ أيوة، يلا بينا"
  },

  // ── Admin: Revoked ────────────────────────────────────────────────────────
  "admin.revoked_result": {
    en: "🗑️ <b>Revoked & Purged!</b>\nID ‏<code>{id}</code>‏ and their entire saved list have been permanently erased.",
    masry: "🗑️ <b>شيلناه ومسحناه!</b>\nآي دي ‏<code>{id}</code>‏ وكل منتجاته اتمسحوا."
  },

  // ── Admin: Promoted ──────────────────────────────────────────────────────
  "admin.promoted_result": {
    en: "🌟 <b>Promoted!</b>\nID ‏<code>{id}</code>‏ has been elevated to Admin privileges.",
    masry: "🌟 <b>بقيت أدمن!</b>\nآي دي ‏<code>{id}</code>‏ اترقى."
  },
  "admin.promoted_notify": {
    en: "🌟 <b>You have been promoted to Admin!</b>\nYou now have authorization to approve users. Run /start to see the admin features.",
    masry: "🌟 <b>مبروك بقيت أدمن!</b>\nدلوقتي تقدر تقبل أو ترفض مستخدمين. افتح المنيو عشان تشوف أدوات الأدمن."
  },
  "admin.back_to_directory": {
    en: "⬅️ Back to Directory",
    masry: "⬅️ رجوع للدليل"
  },

  // ── Admin: Demoted ──────────────────────────────────────────────────────
  "admin.demoted_result": {
    en: "🔽 <b>Demoted.</b>\nID ‏<code>{id}</code>‏ has returned to standard access tier.",
    masry: "🔽 <b>اتشال منه الأدمن.</b>\nآي دي ‏<code>{id}</code>‏ رجع مستخدم عادي."
  },

  // ── Admin: Unban ────────────────────────────────────────────────────────
  "admin.unban_result": {
    en: "🔄 <b>User Unbanned</b>\nUser ‏<code>{id}</code>‏ has been removed from the Banned Directory. They can now send /start to request access again if they wish.",
    masry: "🔄 <b>رفعنا الحظر عنه</b>\nآي دي ‏<code>{id}</code>‏ اتشال من البان. يقدر يبعت /start تاني لو عايز يدخل."
  },

  // ── Admin: Reference expired/handled ──────────────────────────────────────
  "admin.request_expired": {
    en: "⚠️ <b>Request Expired or Handled</b>\nThis application is no longer in the pending queue.",
    masry: "⚠️ <b>الطلب ده قديم</b>\nالطلب ده بقى مش في الليست."
  },
  "admin.approved_result": {
    en: "✅ <b>Approved!</b>\nUser ‏<code>{id}</code>‏ was approved by {admin}.",
    masry: "✅ <b>وافقنا عليه!</b>\nآي دي ‏<code>{id}</code>‏ اتوافق عليه من {admin}."
  },
  "admin.approved_manual_result": {
    en: "✅ <b>Approved!</b>\nUser ‏<code>{id}</code>‏ can now use the Amazon deals application.",
    masry: "✅ <b>وافقنا عليه!</b>\nآي دي ‏<code>{id}</code>‏ يقدر يستخدم أبلكيشن أمازون مصر دلوقتي."
  },

  // ── Navigation ────────────────────────────────────────────────────────────
  "nav.main_menu": {
    en: "🏠 Main Menu",
    masry: "🏠 القائمة الرئيسية"
  },
  "nav.back": {
    en: "⬅️ Back",
    masry: "⬅️ رجوع"
  },
  "nav.open_menu": {
    en: "🏠 Open Main Menu",
    masry: "🏠 القائمة الرئيسية"
  },
  "nav.back_to_product": {
    en: "⬅️ Back to Product",
    masry: "⬅️ رجوع للمنتج"
  },

  // ── Scraper Alerts ─────────────────────────────────────────────────────────
  "alert.target_met_head": {
    en: "🎯 <b>TARGET MET!</b>",
    masry: "🎯 <b>جبت السعر اللي عايزه!</b>"
  },
  "alert.target_met_current": {
    en: "💰 <b>Current Price:</b> {price} EGP",
    masry: "💰 <b>السعر الحالي:</b> {price} ج.م"
  },
  "alert.target_met_target": {
    en: "🎯 <b>Target:</b> {price} EGP",
    masry: "🎯 <b>التارجت:</b> {price} ج.م"
  },
  "alert.target_met_dropped": {
    en: "📉 <b>Dropped:</b> {price} EGP",
    masry: "📉 <b>نزل:</b> {price} ج.م"
  },
  "alert.target_met_seller": {
    en: "🏬 <b>Seller:</b> {seller}",
    masry: "🏬 <b>البائع:</b> {seller}"
  },

  "alert.restock_head": {
    en: "🔄 <b>RESTOCK ALERT</b>",
    masry: "🔄 <b>المنتج رجع المخزون!</b>"
  },
  "alert.restock_price": {
    en: "💰 <b>Price:</b> {price} EGP",
    masry: "💰 <b>السعر:</b> {price} ج.م"
  },
  "alert.restock_seller": {
    en: "🏬 <b>Seller:</b> {seller}",
    masry: "🏬 <b>البائع:</b> {seller}"
  },

  "alert.price_drop_head": {
    en: "📉 <b>PRICE DROP ALERT</b>",
    masry: "📉 <b>السعر نزل!</b>"
  },
  "alert.price_drop_new": {
    en: "💰 <b>New Price:</b> {price} EGP",
    masry: "💰 <b>السعر الجديد:</b> {price} ج.م"
  },
  "alert.price_drop_dropped": {
    en: "📉 <b>Dropped:</b> {diff} EGP",
    masry: "📉 <b>نزل:</b> {diff} ج.م"
  },
  "alert.price_drop_was": {
    en: "📊 <b>Was:</b> {price} EGP",
    masry: "📊 <b>كان:</b> {price} ج.م"
  },
  "alert.price_drop_seller": {
    en: "🏬 <b>Seller:</b> {seller}",
    masry: "🏬 <b>البائع:</b> {seller}"
  },

  "alert.missing_head": {
    en: "🚨 <b>Item Missing!</b>",
    masry: "🚨 <b>المنتج ده اختفى من أمازون!</b>"
  },

  "alert.stale_target_head": {
    en: "⏰ <b>STALE TARGET RETIRED</b>",
    masry: "⏰ <b>التارجت ده اتشال خلاص</b>"
  },
  "alert.stale_target_with_price": {
    en: "Your target of <b>{target} EGP</b> for <b>{days}</b> days without being met has been retired. You will now resume receiving standard price alerts.",
    masry: "التارجت بتاعك <b>{target} ج.م</b> من <b>{days}</b> يوم من غير ما يتحقق اتشال. هترجع تاني تستقبل إشعارات السعر العادية."
  },
  "alert.stale_target_no_price": {
    en: "You had no target set for {asin}, but tracking has been inactive for <b>{days}</b> days without activity. Standard price alerts have been resumed.",
    masry: "ما كانش عندك تارجت لـ {asin}، بس المتابعة كانت مش نشطة لمدة <b>{days}</b> يوم. إشعارات السعر العادية رجعت."
  },

  "alert.tracking_expired_head": {
    en: "⏰ <b>TRACKING EXPIRED</b>",
    masry: "⏰ <b>متابعتك انتهت</b>"
  },
  "alert.tracking_expired_body": {
    en: "Your subscription for ASIN <code>{asin}</code> has been retired after <b>{days}</b> days without activity. If you still want to track this item, please re-add it.",
    masry: "تراك ASIN ‏<code>{asin}</code>‏ اتشال بعد <b>{days}</b> يوم من غير أي نشاط. لو عايز تتابع المنتج ده، أضفه من جديد."
  },

  "alert.btn_open_new": {
    en: "🛒 Open in Amazon.eg",
    masry: "🛒 افتح أمازون"
  },
  "alert.btn_open_resale": {
    en: "📦 Open Amazon Resale",
    masry: "♻️ شوف الريسيل"
  },
  "alert.btn_disclaimer": {
    en: "ℹ️ Price Disclaimer",
    masry: "ℹ️ الأسعار ممكن تتغير"
  },
  "alert.disclaimer_text": {
    en: "Prices are indicative and sourced from Amazon.eg at the time of check. Actual prices may vary.",
    masry: "الأسعار دي تقريبية وأخدناها من أمازون مصر وقت ما شيكنا. السعر الحقيقي ممكن يختلف."
  },
  "alert.boosted_label": {
    en: "#ad",
    masry: "#إعلان"
  },
  "alert.historical_new": {
    en: "Amazon.eg:",
    masry: "أمازون مصر:"
  },
  "alert.historical_resale": {
    en: "Amazon Resale:",
    masry: "أمازون ريسيل:"
  },

  // ── Scraper: Analytical Stale Target (shared between variants) ────────────
  "alert.stale_days": {
    en: "{days} days",
    masry: "{days} يوم"
  },

  // ── Broadcast ─────────────────────────────────────────────────────────────
  "broadcast.atl_head": {
    en: "⏬ <b>ALL-TIME LOW</b> ⏬",
    masry: "⏬ <b>أقل سعر في التاريخ</b> ⏬"
  },
  "broadcast.exceptional_head": {
    en: "🔥 <b>EXCEPTIONAL DEAL</b> 🔥",
    masry: "🚨 لقطة 🚨"
  },
  "broadcast.cta_shop": {
    en: "🛒 Click here to grab the deal →",
    masry: "🛒 دوس هنا عشان تلحق →"
  },
  "broadcast.cta_more": {
    en: "🔍 Find more exceptional deals →",
    masry: "🔍 لعروض أجمد →"
  },
  "broadcast.price_as_of": {
    en: "📅 Price as of {date}",
    masry: "📅 السعر بتاريخ {date}"
  },
  "broadcast.btn_open": {
    en: "🛒 Open in Amazon.eg",
    masry: "🛒 شوفه على أمازون"
  },

  // ── CRM Dashboard ──────────────────────────────────────────────────────────
  // ── Shared Misc ───────────────────────────────────────────────────────────
  "happy_shopping": {
    en: "🛍️ Happy shopping!",
    masry: "🛍️ ربنا يوفقك!"
  },

  // ── CRM Dashboard ──────────────────────────────────────────────────────────
  "crm.hub_title": {
    en: "AzTracker Hub",
    masry: "AzTracker Hub"
  },
  "crm.users_title": {
    en: "Users",
    masry: "الناس"
  },
  "crm.products_title": {
    en: "Active Tracked Products",
    masry: "المنتجات النشطة"
  },
  "crm.system_overview": {
    en: "System Overview",
    masry: "ملخص سريع"
  },
  "crm.last_sync": {
    en: "Last Sync",
    masry: "آخر تحديث"
  },
  "crm.restore_products": {
    en: "Restore Products",
    masry: "استعادة المنتجات"
  },
  "crm.force_check": {
    en: "Force Check",
    masry: "شوف الأسعار دلوقتي"
  },
  "crm.system_broadcast": {
    en: "System Broadcast",
    masry: "برودكاست"
  },
  "crm.broadcast_placeholder": {
    en: "Enter message to blast to all users...",
    masry: "اكتب رسالة تبعتها لكل الناس..."
  },
  "crm.send_broadcast": {
    en: "Send Broadcast",
    masry: "ابعت الرسالة"
  },
  "crm.tab_approved": {
    en: "Approved",
    masry: "حبايبنا"
  },
  "crm.tab_pending": {
    en: "Pending",
    masry: "في الانتظار"
  },
  "crm.queue_type_access": {
    en: "New Access",
    masry: "طلب جديد"
  },
  "crm.queue_type_unban": {
    en: "Unban Request",
    masry: "إلغاء حظر"
  },
  "crm.tab_banned": {
    en: "Banned",
    masry: "واخدين بان"
  },
  "crm.tab_admins": {
    en: "Admins",
    masry: "الادمنز"
  },
  "crm.search_placeholder": {
    en: "Search Name, @username or ID...",
    masry: "دور بالاسم، @يوزر نيم أو رقم..."
  },
  "crm.no_pending": {
    en: "No pending requests",
    masry: "مفيش طلبات معلقة"
  },
  "crm.no_users_found": {
    en: "No users found",
    masry: "مفيش حد هنا"
  },
  "crm.no_saved_products": {
    en: "No saved products",
    masry: "مفيش منتجات محفوظة"
  },
  "crm.price_history": {
    en: "Price History",
    masry: "تاريخ الأسعار"
  },
  "crm.loading_chart": {
    en: "Loading chart data...",
    masry: "بنحمل بيانات الرسم البياني..."
  },
  "crm.no_price_history": {
    en: "No price history available yet.",
    masry: "مفيش تاريخ أسعار لسه."
  },
  "crm.ath": {
    en: "ATH",
    masry: "ATH"
  },
  "crm.atl": {
    en: "ATL",
    masry: "ATL"
  },
  "crm.avg": {
    en: "Avg",
    masry: "المتوسط"
  },
  "crm.new_price": {
    en: "New (EGP)",
    masry: "جديد (ج.م)"
  },
  "crm.used_price": {
    en: "Used (EGP)",
    masry: "مستعمل (ج.م)"
  },
  "crm.no_audit": {
    en: "No administrative actions logged in the past 7 days.",
    masry: "مفيش أحداث أدمن اتسجلت في آخر 7 أيام."
  },
  "crm.user_products": {
    en: "User Products",
    masry: "منتجات المستخدم"
  },
  "crm.user_id_label": {
    en: "ID:",
    masry: "الرقم:"
  },
  "crm.loading_items": {
    en: "Loading items...",
    masry: "بنحمل المنتجات..."
  },
  "crm.user_paused": {
    en: "Paused",
    masry: "متوقف"
  },
  "crm.user_active": {
    en: "Active",
    masry: "نشط"
  },
  "crm.user_used_only": {
    en: "Used Only",
    masry: "مستعمل بس"
  },
  "crm.user_out_of_stock": {
    en: "Out of Stock",
    masry: "غير متوفر"
  },
  "crm.btn_resume": {
    en: "Resume",
    masry: "كمل"
  },
  "crm.btn_pause_drawer": {
    en: "Pause",
    masry: "وقف"
  },
  "crm.btn_chart": {
    en: "Chart",
    masry: "رسم بياني"
  },
  "crm.btn_delete_drawer": {
    en: "Delete",
    masry: "امسح"
  },
  "crm.btn_view_items": {
    en: "View Items",
    masry: "شوف المنتجات"
  },
  "crm.btn_message": {
    en: "Message",
    masry: "رسالة"
  },
  "crm.btn_edit": {
    en: "Edit",
    masry: "تعديل"
  },
  "crm.btn_edit_limit": {
    en: "Edit Limit",
    masry: "تعديل الحد"
  },
  "crm.btn_promote": {
    en: "Promote",
    masry: "روّج"
  },
  "crm.btn_demote_drawer": {
    en: "Demote",
    masry: "خفض"
  },
  "crm.btn_unban": {
    en: "Unban User",
    masry: "الغي الحظر"
  },
  "crm.toast_syncing": {
    en: "Syncing...",
    masry: "بنجيب آخر الداتا..."
  },
  "crm.toast_synced": {
    en: "Data synchronized",
    masry: "الداتا الجديده جات!"
  },
  "crm.toast_network_error": {
    en: "Network Error",
    masry: "خطأ في الشبكة"
  },
  "crm.toast_action_queued": {
    en: "Action queued in background",
    masry: "قيد التنفيذ"
  },
  "crm.toast_success": {
    en: "Success",
    masry: "تم"
  },
  "crm.toast_processing": {
    en: "Processing...",
    masry: "بنجهز..."
  },
  "crm.toast_msg_empty": {
    en: "Message is empty",
    masry: "الرسالة فاضية"
  },
  "crm.action_approved": {
    en: "Your access request has been <b>APPROVED</b>!",
    masry: "طلب الوصول بتاعك اتوافق عليه!"
  },
  "crm.action_rejected": {
    en: "Your access request was <b>REJECTED</b>.",
    masry: "طلب الوصول بتاعك اترفض."
  },
  "crm.action_revoked": {
    en: "Your access has been <b>REVOKED</b>.",
    masry: "وصولك اتشال."
  },
  "crm.action_restored": {
    en: "Your access has been <b>RESTORED</b>.",
    masry: "وصولك اترجع."
  },
  "crm.action_promoted": {
    en: "You have been <b>PROMOTED</b> to Admin!",
    masry: "اترقيت لأدمن!"
  },
  "crm.action_demoted": {
    en: "You have been <b>DEMOTED</b> to standard user.",
    masry: "شيلنا منك صلاحيات الأدمن."
  },
  "crm.action_limit_updated": {
    en: "Your tracking limit has been updated to <b>{limit}</b> items.",
    masry: "حد المتابعة بتاعك اتغير لـ <b>{limit}</b> منتجات."
  },
  "crm.action_message_from": {
    en: "📬 <b>Message from Admin:</b>",
    masry: "📬 <b>رسالة من الأدمن:</b>"
  },
  "crm.action_restoration_complete": {
    en: "✅ <b>Restoration Complete</b>",
    masry: "✅ <b>كل حاجة اترجعت</b>"
  },
  "crm.action_restoration_fail": {
    en: "❌ <b>Restoration Failed</b>",
    masry: "❌ <b>منفعش</b>"
  },
  "crm.action_force_scrape_ok": {
    en: "✅ <b>Force Scrape Completed</b>",
    masry: "✅ <b>تم</b>"
  },
  "crm.action_force_scrape_fail": {
    en: "❌ <b>Force Scrape Failed</b>",
    masry: "❌ <b>منفعش</b>"
  },
  "crm.action_unauthorized": {
    en: "⛔ <b>Unauthorized</b>\n\nOnly root admins can perform this action.",
    masry: "⛔ <b>مش مسموح</b>\n\nالأدمن الرئيسي بس اللي يقدر يعمل ده."
  },
  "crm.edit_limit_title": {
    en: "Edit Product Limit",
    masry: "تعديل حد المنتجات"
  },
  "crm.edit_limit_prompt": {
    en: "Set new product limit for",
    masry: "حدد عدد المنتجات الجديد لـ"
  },
  "crm.edit_limit_success": {
    en: "✅ Limit updated to {limit} items for {user}.",
    masry: "✅ اتغير الحد لـ {limit} منتجات لـ {user}."
  },
  "crm.action_global_broadcast": {
    en: "📢 <b>Global Broadcast</b>",
    masry: "📢 <b>برودكاست</b>"
  },
  "crm.security_audit": {
    en: "🔒 <b>Security Audit Log</b>",
    masry: "🔒 <b>سجل الأمان</b>"
  },
  "crm.tab_system": {
    en: "System",
    masry: "النظام"
  },
  "crm.rolling_retention": {
    en: "📅 7-Day Rolling Retention",
    masry: "📅 آخر 7 أيام"
  },
  "crm.compiling_ledger": {
    en: "⏳ Compiling forensic ledger...",
    masry: "⏳ بنجهز سجل الأمان..."
  },
  "crm.refresh": {
    en: "Refresh",
    masry: "تحديث"
  },

  // ── CRM Admin Action Notifications ────────────────────────────────────────
  "crm.notify_approved": {
    en: "✅ <b>Your access request has been APPROVED!</b>\n\nYou can now use AzTracker. Send /start to begin.",
    masry: "✅ <b>موافقين عليك!</b>\n\nتقدر دلوقتي تستخدم AzTracker. ابعت /start عشان تعيش."
  },
  "crm.notify_rejected": {
    en: "❌ <b>Your access request was REJECTED.</b>",
    masry: "❌ <b>طلبك اترفض.</b>"
  },
  "crm.notify_revoked": {
    en: "⛔ <b>Your access has been REVOKED.</b>",
    masry: "⛔ <b>الباسبور اتسحب.</b>\nمتقدرش تستخدم البوت تاني."
  },
  "crm.notify_restored": {
    en: "✅ <b>Your access has been RESTORED.</b>",
    masry: "✅ <b>دلوقتي تقدر تستخدم البوت مرة تانية.</b>"
  },
  "crm.notify_promoted": {
    en: "👑 <b>You have been PROMOTED to Admin!</b>",
    masry: "👑 <b>اترقيت لـ أدمن! مبروك يا باشا.</b>"
  },
  "crm.notify_demoted": {
    en: "🔽 <b>You have been DEMOTED to standard user.</b>",
    masry: "🔽 <b>رجعت يوزر عادي زي حالاتنا.</b>"
  },
  "crm.notify_limit_updated": {
    en: "📈 <b>Your tracking limit has been updated to {limit} items.</b>",
    masry: "📈 <b>حدك اترفع لـ {limit} منتج. عيش يا معلم!</b>"
  },
  "crm.notify_direct_message": {
    en: "💬 <b>Message from Admin:</b>\n\n{message}",
    masry: "💬 <b>رسالة من الأدمن:</b>\n\n{message}"
  },
  "crm.seller_unknown": {
    en: "Unknown",
    masry: "مش معروف"
  },
  "crm.unknown_user": {
    en: "Unknown User ({id})",
    masry: "مستخدم غير معروف ({id})"
  },
  "crm.global_broadcast": {
    en: "Global Broadcast",
    masry: "برودكاست"
  },
  "crm.loading_audit": {
    en: "Loading audit log...",
    masry: "بنحمل سجل المراجعة..."
  },
  "crm.requested_label": {
    en: "Requested:",
    masry: "تاريخ الطلب:"
  },
  "crm.id_label": {
    en: "ID:",
    masry: "آي دي:"
  },
  "crm.never": {
    en: "Never",
    masry: "أبداً"
  },
  "crm.current_label": {
    en: "current:",
    masry: "الحالي:"
  },
  "crm.local_mode_toast": {
    en: "Local mode: Telegram verification bypassed (Read Only)",
    masry: "وضع محلي: تم تجاوز تليجرام (قراءة فقط)"
  },
  "crm.migrate_success": {
    en: "Successfully migrated {subscriptions} subscriptions and {users} users!",
    masry: "تم ترحيل {subscriptions} اشتراك و {users} مستخدم بنجاح!"
  },
  "crm.broadcast_prefix": {
    en: "📢 <b>Global Broadcast</b>\n\n{message}",
    masry: "📢 <b>برودكاست</b>\n\n{message}"
  },
  "crm.chart_loading": {
    en: "Loading chart data...",
    masry: "بنحمل بيانات الرسم البياني..."
  },

  // ── System Overview: New Stats ──────────────────────────────────────────────
  "crm.paused_products": {
    en: "Paused Products",
    masry: "منتجات موقوفة"
  },
  "crm.ghost_products": {
    en: "Ghost Products",
    masry: "منتجات أشباح"
  },
  "crm.click_to_expand": {
    en: "Tap to view details",
    masry: "اضغط عشان تشوف التفاصيل"
  },

  
  "crm.audit_target": {
    en: "Target:",
    masry: "الهدف:"
  },
  "crm.audit_details": {
    en: "Details:",
    masry: "التفاصيل:"
  },
  "crm.btn_view": {
    en: "➡️ View",
    masry: "⬅️ شوف"
  },
  "crm.select_all": {
    en: "Select All",
    masry: "حدد الكل"
  },
  "crm.joined_date": {
    en: "Joined:",
    masry: "انضم:"
  },
  "crm.minutes_short": {
    en: "min",
    masry: "دقيقة"
  },
  // ── Engine Health Widget ─────────────────────────────────────────────────────
  "crm.engine_health": {
    en: "Engine Health",
    masry: "حالة المحرك"
  },
  "crm.engine_interval": {
    en: "Current Interval",
    masry: "الفترة الحالية"
  },
  "crm.engine_daily_ops": {
    en: "Daily Queue Load",
    masry: "حمل اليوم على القائمة"
  },
  "crm.engine_batches": {
    en: "Batches/Run",
    masry: "دفعات/تشغيل"
  },
  "crm.engine_status_ok": {
    en: "Healthy",
    masry: "سليم"
  },
  "crm.engine_status_warn": {
    en: "Approaching Limit",
    masry: "قربت من الحد"
  },
  "crm.engine_status_critical": {
    en: "Critical",
    masry: "حرج"
  },

  // ── Top Charts Drawer ────────────────────────────────────────────────────────
  "crm.top_charts_title": {
    en: "🔥 Most Popular Products",
    masry: "🔥 أكثر المنتجات متابعة"
  },
  "crm.top_charts_trackers": {
    en: "trackers",
    masry: "متابع"
  },
  "crm.top_charts_no_data": {
    en: "No subscription data yet.",
    masry: "مفيش بيانات متابعين لسه."
  },

  // ── Graveyard Drawer ─────────────────────────────────────────────────────────
  "crm.graveyard_title": {
    en: "💀 Ghost & Delisted Products",
    masry: "💀 منتجات أشباح ومش متوفرة"
  },
  "crm.graveyard_purge_btn": {
    en: "🗑️ Purge Selected",
    masry: "🗑️ امسح المختار"
  },
  "crm.graveyard_purge_confirm": {
    en: "Are you sure? This will permanently delete the selected products from the database. This cannot be undone.",
    masry: "متأكد؟ المنتجات المختارة هتتمسح من قاعدة البيانات نهائياً. مش هتقدر ترجعها."
  },
  "crm.graveyard_purged_ok": {
    en: "Successfully purged {count} products.",
    masry: "تم مسح {count} منتج بنجاح."
  },
  "crm.graveyard_empty": {
    en: "No ghost products found. Database is clean!",
    masry: "مفيش منتجات أشباح. قاعدة البيانات نظيفة!"
  },
  "crm.graveyard_subs": {
    en: "active subscribers",
    masry: "متابع نشط"
  },
  "crm.graveyard_delisted": {
    en: "Delisted",
    masry: "مش متوفر"
  },
  "crm.graveyard_all_missing": {
    en: "Missing in all conditions",
    masry: "مش موجود في أي حالة"
  },

  // ── Fallback Strings ─────────────────────────────────────────────────────
  "fallback.unknown_product": {
    en: "Unknown Product",
    masry: "منتج غير معروف"
  },
  "fallback.unknown_seller": {
    en: "Unknown",
    masry: "مش معروف"
  },
  "fallback.unknown_user": {
    en: "Unknown User ({id})",
    masry: "مستخدم غير معروف ({id})"
  },

  // ── Broadcast Strings ────────────────────────────────────────────────────
  "broadcast.snapshot": {
    en: "🚨 Snapshot 🚨",
    masry: "🚨 لقطة 🚨"
  },
  "broadcast.buy_here": {
    en: "🛒 Buy from here ←",
    masry: "🛒 اشتري من هنا ←"
  },
  "broadcast.catch_deal": {
    en: "👉 Catch the deal from here ←",
    masry: "👉 الحق العرض من هنا ←"
  },
  "broadcast.follow_more": {
    en: "🔗 Follow more deals",
    masry: "🔗 تابع عروض أكتر"
  },
  "broadcast.ad_disclosure": {
    en: "#ad",
    masry: "#إعلان"
  },
};

/**
 * Translation function — pure synchronous lookup.
 *
 * @param {string} key    - Flat key in the form "category.subkey"
 * @param {string} [lang] - Language code ('en' | 'masry'). Defaults to 'en'.
 * @param {object} [vars] - Key-value pairs for {placeholder} interpolation.
 * @returns {string} Translated string, or the key itself if not found.
 */
export function t(key, lang = 'en', vars = {}) {
  const entry = dict[key];
  if (!entry) {
    console.warn(`[i18n] Missing key: "${key}"`);
    return key;
  }
  let text = entry[lang] || entry['en'] || key;
  if (vars && typeof vars === 'object') {
    for (const [ph, val] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${ph}\\}`, 'g'), String(val));
    }
  }
  return text;
}

/**
 * Resolve Telegram language_code to supported i18n language.
 *
 * Maps any Arabic variant (ar, ar-EG, ar-SA, etc.) → 'masry'
 * Everything else → 'en'
 *
 * @param {string|null|undefined} languageCode - Telegram's message.from.language_code
 * @returns {string} 'masry' or 'en'
 */
export function resolveLanguageCode(languageCode) {
  if (!languageCode) return 'en';
  return languageCode.startsWith('ar') ? 'masry' : 'en';
}

/**
 * Get the full interpolated welcome message for a given language.
 *
 * @param {string} lang  - 'en' or 'masry'
 * @param {string} limit - Item limit value for interpolation
 * @returns {string} Complete welcome message HTML
 */
export function getWelcomeMessage(lang, limit) {
  const steps = [
    t('welcome.head', lang),
    '',
    t('welcome.step1', lang),
    '',
    t('welcome.step2', lang),
    '',
    t('welcome.step3', lang),
    '',
    t('welcome.step4', lang),
    '',
    t('welcome.step5', lang, { limit }),
    '',
    t('welcome.protip', lang),
    '',
    t('happy_shopping', lang),
    '',
    t('chrome.ad_disclaimer', lang)
  ];
  return steps.join('\n');
}
