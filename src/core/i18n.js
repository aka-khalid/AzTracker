/**
 * i18n.js — Professional Masry Egyptian Arabic Localization Engine
 *
 * Flat key structure: t('category.key', lang) → string
 * Supported languages: 'en' (English), 'ar' (Professional Masry Egyptian Arabic)
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
    ar: "أز تريكر"
  },
  "chrome.ad_disclaimer": {
    en: "As an Amazon Associate I earn from qualifying purchases.",
    ar: "كشريك أمازون بكسب عمولة من المشتريات المؤهلة."
  },
  "chrome.currency_egp": {
    en: "EGP",
    ar: "ج.م"
  },

  // ── Access Control / Onboarding ───────────────────────────────────────────
  "access.denied_head": {
    en: "⛔ <b>Access Denied</b>",
    ar: "⛔ <b>الوصول مرفوض</b>"
  },
  "access.denied_body_private": {
    en: "This is a private Amazon deals server. You are not authorized to use it.",
    ar: "ده سيرفر خاص بخصومات أمازون. مش مسموحلك تستخدمه."
  },
  "access.denied_hint_start": {
    en: "Send /start to request access.",
    ar: "ابعت /start عشان تطلب アクセス."
  },
  "access.request_btn": {
    en: "✋ Request Access",
    ar: "✋ طلب الوصول"
  },
  "access.pending_head": {
    en: "⏳ <b>Request Pending</b>",
    ar: "⏳ <b>الطلب قيد المراجعة</b>"
  },
  "access.pending_body": {
    en: "Your application is currently under review by an administrator. Please wait.",
    ar: "طلبك بيتراجع دلوقتي من الأدمن. استنى من فضلك."
  },
  "access.request_sent": {
    en: "⏳ <b>Request Sent.</b>\n\nPlease wait for an administrator to review your application.",
    ar: "⏳ <b>تم إرسال الطلب.</b>\n\nاستني الأدمن يراجع طلبك."
  },
  "access.queue_full_head": {
    en: "⚠️ <b>Queue Full</b>",
    ar: "⚠️ <b>القائمة مليانة</b>"
  },
  "access.queue_full_body": {
    en: "The access queue is currently full. Please try again in 24 hours.",
    ar: "قائمة الانتظار مليانة دلوقتي. حاول تاني بعد ٢٤ ساعة."
  },
  "access.admin_new_request_head": {
    en: "🔔 <b>New Access Request</b>",
    ar: "🔔 <b>طلب وصول جديد</b>"
  },
  "access.admin_new_request_body": {
    en: "👤 <b>Name:</b> {name}\n🆔 <b>ID:</b> <code>{id}</code>\n\n<i>This user is requesting authorization to access the server.</i>",
    ar: "👤 <b>الاسم:</b> {name}\n🆔 <b>الرقم:</b> <code>{id}</code>\n\n<i>المستخدم ده بيطلب إذن الوصول للسيرفر.</i>"
  },
  "access.admin_new_request_btn_approve": {
    en: "✅ Approve",
    ar: "✅ موافقة"
  },
  "access.admin_new_request_btn_reject": {
    en: "❌ Reject",
    ar: "❌ رفض"
  },
  "access.denied_notify": {
    en: "⛔ <b>Access Request Denied</b>\n\nYour request to join the server has been declined by an administrator.",
    ar: "⛔ <b>طلب الوصول اترفض</b>\n\nطلبك للانضمام للسيرفر اترفض من الأدمن."
  },
  "access.admin_rejected": {
    en: "🚫 <b>Request Rejected</b>\nUser <code>{id}</code> has been denied access by {admin}.",
    ar: "🚫 <b>تم رفض الطلب</b>\nالمستخدم <code>{id}</code> اترفض من {admin}."
  },
  "access.admin_rejected_manual": {
    en: "🚫 <b>Request Rejected</b>\nUser <code>{id}</code> has been explicitly denied access.",
    ar: "🚫 <b>تم رفض الطلب</b>\nالمستخدم <code>{id}</code> اترفض بشكل صريح."
  },
  "access.handled_request": {
    en: "🚫 <b>Request Handled</b>\nUser <code>{id}</code> was rejected by {admin}.",
    ar: "🚫 <b>تم التعامل مع الطلب</b>\nالمستخدم <code>{id}</code> اترفض من {admin}."
  },
  "access.handled_approved": {
    en: "✅ <b>Request Handled</b>\nUser <code>{id}</code> was approved by {admin}.",
    ar: "✅ <b>تم التعامل مع الطلب</b>\nالمستخدم <code>{id}</code> اتوافق عليه من {admin}."
  },

  // ── Welcome Message ───────────────────────────────────────────────────────
  "welcome.head": {
    en: "🎉 <b>You have been approved! Welcome!</b>",
    ar: "🎉 <b>تم قبولك! أهلاً وسهلاً!</b>"
  },
  "welcome.step1": {
    en: "<b>1️⃣ Find your item</b>\nOpen the Amazon app or website and find the product you want to buy.",
    ar: "<b>١️⃣ دور على المنتج</b>\nافتح تطبيق أمازون أو الموقع ولقّى المنتج اللي عايز تشتريه."
  },
  "welcome.step2": {
    en: "<b>2️⃣ Share the link</b>\nThe easiest way: In the Amazon app, hit the <b>Share</b> button, select Telegram, and send it directly to this bot! (You can also just copy and paste the link into the chat).",
    ar: "<b>٢️⃣ ابعت اللينك</b>\nأسهل طريقة: في تطبيق أمازون، دوس على زرار <b>مشاركة</b>، اختار تيليجرام، ابعته للبوت ده مباشرة! (أو انسخ والصق اللينك في الشات)."
  },
  "welcome.step3": {
    en: "<b>3️⃣ Set a Target Price (Optional)</b>\nIf you only want alerts for a specific price, click the <i>🎯 Set Target</i> button after adding your item. The bot will stay quiet until the price drops to or below your exact target!",
    ar: "<b>٣️⃣ حدد السعر المستهدف (اختياري)</b>\nلو عايز إشعارات بس لسعر معين، دوس على زرار <i>🎯 تحديد السعر</i> بعد ما تضيف المنتج. البوت هيسكت لحد السعر ما ينزل للسعر اللي انت محدده!"
  },
  "welcome.step4": {
    en: "<b>4️⃣ Relax & Wait</b>\nThe bot will continuously monitor the market in the background. It will automatically notify you of major price drops, restocks, and even cheaper Amazon Resale (Used) alternatives.",
    ar: "<b>٤️⃣ استرخي واستنى</b>\nالبوت هيتابع السوق باستمرار في الخلفية. هيبلغك أوتوماتيك بانخفاضات الأسعار، وإعادة التخزين، وبدائل أمازون ريزيل (مستعمل) الأرخص."
  },
  "welcome.step5": {
    en: "<b>5️⃣ The Item Limit</b>\nTo keep the servers from catching fire, everyone starts with a limit of <b>{limit}</b> saved items. If you desperately need to save more, you'll have to secretly bribe whichever admin invited you (coffee and a good shawarma usually do the trick 😉).",
    ar: "<b>٥️⃣ حد المنتجات</b>\nعشان السيرفرات ما تحترقش، كل واحد بيبدأ بحد <b>{limit}</b> منتجات محفوظة. لو محتاج تحفظ أكتر بأي طريقة، تتوسط الأدمن اللي ضافك (قهوة وشاورما كويسة بتفرق 😉)."
  },
  "welcome.protip": {
    en: "💡 <i>Pro-Tip: You can always click \"📦 My Products\" from the Main Menu to view beautiful price history charts for your items or pause checking on things you've already bought.</i>",
    ar: "💡 <i>نصيحة: تقدر تدوس على \"📦 منتجاتي\" من القائمة الرئيسية عشان تشوف رسومات بيانية لتاريخ الأسعار أو توقف المتابعة للمنتجات اللي اشتريتها.</i>"
  },

  // ── Language Command ──────────────────────────────────────────────────────
  "lang.head": {
    en: "🌐 <b>Language Settings</b>",
    ar: "🌐 <b>إعدادات اللغة</b>"
  },
  "lang.choose": {
    en: "Please select your preferred language:\n\n<i>اختار اللغة المفضلة بتاعتك:</i>",
    ar: "اختار اللغة المفضلة بتاعتك:\n\n<i>Please select your preferred language:</i>"
  },
  "lang.btn_en": {
    en: "🇬🇧 English",
    ar: "🇬🇧 الإنجليزية"
  },
  "lang.btn_ar": {
    en: "🇪🇬 العربية (مصرية)",
    ar: "🇪🇬 العربية (مصرية)"
  },
  "lang.changed": {
    en: "✅ Language changed to <b>English</b>.",
    ar: "✅ تم تغيير اللغة لـ <b>العربية</b>."
  },

  // ── Main Menu ─────────────────────────────────────────────────────────────
  "menu.deals_dashboard": {
    en: "🏠 <b>Deals Dashboard</b>",
    ar: "🏠 <b>لوحة العروض</b>"
  },
  "menu.your_saved_items": {
    en: "📦 <b>Your Saved Items:</b>",
    ar: "📦 <b>منتجاتك المحفوظة:</b>"
  },
  "menu.active": {
    en: "⚡ <b>Active:</b>",
    ar: "⚡ <b>نشط:</b>"
  },
  "menu.paused": {
    en: "⏸️ <b>Paused:</b>",
    ar: "⏸️ <b>متوقف:</b>"
  },
  "menu.select_option": {
    en: "Select an operative option below:",
    ar: "اختار من الخيارات تحت:"
  },
  "menu.btn_my_products": {
    en: "📦 My Products",
    ar: "📦 منتجاتي"
  },
  "menu.btn_how_to_add": {
    en: "➕ How to Add Products",
    ar: "➕ إزاي تضيف منتجات"
  },
  "menu.btn_admin_panel": {
    en: "👑 Admin Panel",
    ar: "👑 لوحة الأدمن"
  },
  "menu.btn_language": {
    en: "🌐 Language / اللغة",
    ar: "🌐 اللغة / Language"
  },

  // ── How to Add ────────────────────────────────────────────────────────────
  "howto.head": {
    en: "💡 <b>How to Add a Product:</b>",
    ar: "💡 <b>إزاي تضيف منتج:</b>"
  },
  "howto.body": {
    en: "Copy any Amazon.eg product link from your browser or app and paste it directly into this chat box as a message.",
    ar: "انسخ أي لينك منتج أمازون مصر من المتصفح أو التطبيق والصقه في الشات ده مباشرة."
  },
  "howto.shortlinks": {
    en: "📱 <b>Short links shared directly from the mobile app are fully supported!</b>",
    ar: "📱 <b>اللينكات القصورة اللي بتتبعتها من التطبيق مدعومة بالكامل!</b>"
  },

  // ── Product Link Processing ───────────────────────────────────────────────
  "link.processing": {
    en: "⏳ <b>Processing Amazon link...</b>",
    ar: "⏳ <b>بنجهز لينك أمازون...</b>"
  },
  "link.region_not_supported_head": {
    en: "❌ <b>Region Not Supported</b>",
    ar: "❌ <b>المنطقة مش مدعومة</b>"
  },
  "link.region_not_supported_body": {
    en: "Currently, we only support <code>amazon.eg</code>.",
    ar: "دلوقتي بندعم <code>amazon.eg</code> بس."
  },
  "link.could_not_parse": {
    en: "❌ <b>Could not parse a valid 10-digit ASIN.</b>",
    ar: "❌ <b>مش قادرين نطلع ASIN صحيح من ١٠ أرقام.</b>"
  },
  "link.system_error": {
    en: "⚠️ <b>System Error:</b> Global item limit is unconfigured. Please contact an admin.",
    ar: "⚠️ <b>خطأ في النظام:</b> الحد الأقصى للمنتجات مش متحدد. تواصل مع الأدمن."
  },
  "link.limit_reached_head": {
    en: "⛔ <b>Limit Reached</b>",
    ar: "⛔ <b>وصلت للحد</b>"
  },
  "link.limit_reached_body": {
    en: "You have saved {used} items, but your current limit is {limit}.\n\nPlease delete some products to free up space before adding new ones.",
    ar: "عندك {used} منتجات محفوظة، بس حدك الحالي {limit}.\n\nامسح شوية منتجات عشان تفضي مكان قبل ما تضيف حاجة جديدة."
  },
  "link.manage_products": {
    en: "📦 Manage My Products",
    ar: "📦 إدارة منتجاتي"
  },
  "link.already_exists": {
    en: "⚠️ <b>You have already saved this product!</b>",
    ar: "⚠️ <b>المنتج ده محفوظ بالفعل!</b>"
  },
  "link.registered_head": {
    en: "✅ <b>Product Registered!</b>",
    ar: "✅ <b>تم تسجيل المنتج!</b>"
  },
  "link.registered_status": {
    en: "This item is now saved. It will pull the live price during the next automated check.",
    ar: "المنتج ده اتحفظ دلوقتي. هيجيب السعر الحي في الفحص الأوتوماتيك الجاي."
  },
  "link.pending_scan": {
    en: "⏳ Pending initial scan...",
    ar: "⏳ في انتظار الشيك الأول..."
  },
  "link.invalid_command": {
    en: "⚠️ <b>Invalid Command or Input Structure</b>\n\nPlease use the interactive options below or drop a valid Amazon item link.",
    ar: "⚠️ <b>أمر غلط أو صيغة مش صحيحة</b>\n\nاستخدم الخيارات التفاعلية تحت أو حط لينك أمازون صحيح."
  },

  // ── Product List ──────────────────────────────────────────────────────────
  "list.my_saved_products": {
    en: "📦 <b>My Saved Products</b>",
    ar: "📦 <b>منتجاتي المحفوظة</b>"
  },
  "list.page_of": {
    en: "Page {page} of {total}",
    ar: "صفحة {page} من {total}"
  },
  "list.empty_head": {
    en: "❌ <b>Your saved list is empty.</b>",
    ar: "❌ <b>قائمة منتجاتك فاضية.</b>"
  },
  "list.empty_hint": {
    en: "Paste an Amazon.eg link in the chat box to add it to your list.",
    ar: "الصق لينك أمازون مصر في الشات عشان تضيفه لقايمتك."
  },
  "list.select_hint": {
    en: "Select an item below to modify its checking parameters:",
    ar: "اختار منتج تحت عشان تعدل بارامترات المتابعة:"
  },
  "list.prev": {
    en: "⬅️ Prev",
    ar: "⬅️ السابق"
  },
  "list.next": {
    en: "Next ➡️",
    ar: "التالي ➡️"
  },

  // ── Product View ──────────────────────────────────────────────────────────
  "product.price_label": {
    en: "💰 <b>Price:</b>",
    ar: "💰 <b>السعر:</b>"
  },
  "product.target_label": {
    en: "🎯 <b>Target:</b>",
    ar: "🎯 <b>السعر المستهدف:</b>"
  },
  "product.seller_label": {
    en: "🏬 <b>Seller:</b>",
    ar: "🏬 <b>البائع:</b>"
  },
  "product.status_label": {
    en: "📡 <b>Status:</b>",
    ar: "📡 <b>الحالة:</b>"
  },
  "product.status_active": {
    en: "✅ Active",
    ar: "✅ نشط"
  },
  "product.status_paused": {
    en: "⏸️ Paused",
    ar: "⏸️ متوقف"
  },
  "product.waiting_check": {
    en: "⏳ Waiting for next automated check...",
    ar: "⏳ بنستنى الشيك الأوتوماتيك الجاي..."
  },
  "product.out_of_stock": {
    en: "❌ Out of Stock",
    ar: "❌ غير متوفر"
  },
  "product.checked_today": {
    en: "(Checked: Today at {time})",
    ar: "(آخر شيك: النهارده الساعة {time})"
  },
  "product.checked_date": {
    en: "(Checked: {date} {time})",
    ar: "(آخر شيك: {date} {time})"
  },
  "product.used_tag": {
    en: "(Used)",
    ar: "(مستعمل)"
  },
  "product.other_options_head": {
    en: "💡 <b>Other Options:</b>",
    ar: "💡 <b>خيارات تانية:</b>"
  },
  "product.amazon_eg_label": {
    en: "Amazon.eg",
    ar: "أمازون مصر"
  },
  "product.resale_label": {
    en: "Amazon Resale",
    ar: "أمازون ريزيل"
  },
  "product.check_stock": {
    en: "(Check Stock)",
    ar: "(شيك على المخزون)"
  },

  // ── Product View Buttons ──────────────────────────────────────────────────
  "product.btn.open_amazon": {
    en: "🛒 Open in Amazon.eg",
    ar: "🛒 افتح أمازون مصر"
  },
  "product.btn.set_target": {
    en: "🎯 Set Target",
    ar: "🎯 حدد السعر المستهدف"
  },
  "product.btn.clear_target": {
    en: "❌ Clear Target",
    ar: "❌ امسح السعر المستهدف"
  },
  "product.btn.pause": {
    en: "⏸️ Pause Checking",
    ar: "⏸️ وقف المتابعة"
  },
  "product.btn.resume": {
    en: "▶️ Resume Checking",
    ar: "▶️ استأنف المتابعة"
  },
  "product.btn.delete": {
    en: "🗑️ Delete Product",
    ar: "🗑️ امسح المنتج"
  },
  "product.btn.back_to_products": {
    en: "⬅️ Back to Products",
    ar: "⬅️ رجوع للمنتجات"
  },
  "product.btn.main_menu": {
    en: "🏠 Main Menu",
    ar: "🏠 القائمة الرئيسية"
  },

  // ── Set Target Flow ───────────────────────────────────────────────────────
  "target.set_head": {
    en: "🎯 <b>Set Target Price</b>",
    ar: "🎯 <b>حدد السعر المستهدف</b>"
  },
  "target.set_prompt": {
    en: "ASIN: <code>{asin}</code>\n\nPlease type your desired maximum price in EGP as a message (e.g., <code>4500</code>).",
    ar: "ASIN: <code>{asin}</code>\n\nاكتب السعر الأقصى اللي عايزه بالجنيه في رسالة (مثلاً: <code>4500</code>)."
  },
  "target.cancel": {
    en: "❌ Cancel",
    ar: "❌ إلغاء"
  },
  "target.invalid_amount": {
    en: "⚠️ <b>Invalid amount.</b> Please enter a valid number.",
    ar: "⚠️ <b>مبلغ غلط.</b> اكتب رقم صحيح."
  },
  "target.set_confirm_head": {
    en: "🎯 <b>Target Price Set!</b>",
    ar: "🎯 <b>تم تحديد السعر المستهدف!</b>"
  },
  "target.set_confirm_body": {
    en: "You will only be notified when ASIN <code>{asin}</code> drops to or below <b>{price}</b>.",
    ar: "هتتجابل إشعار بس لما ASIN <code>{asin}</code> ينزل لـ <b>{price}</b> أو أقل."
  },
  "target.set_confirm_body_ara": {
    en: "You will only be notified when ASIN <code>{asin}</code> drops to or below <b>{price}</b>.",
    ar: "هتتجابل إشعار بس لما ASIN <code>{asin}</code> ينزل لـ <b>{price}</b> أو أقل."
  },

  // ── Confirm Target Removal ────────────────────────────────────────────────
  "target.remove_confirm_head": {
    en: "⚠️ <b>Confirm Target Removal</b>",
    ar: "⚠️ <b>تأكيد مسح السعر المستهدف</b>"
  },
  "target.remove_confirm_body": {
    en: "Are you sure you want to clear the target price for ASIN <code>{asin}</code>?",
    ar: "متأكد إنك عايز تمسح السعر المستهدف لـ ASIN <code>{asin}</code>؟"
  },
  "target.btn_yes_clear": {
    en: "✅ Yes, Clear Target",
    ar: "✅ أيوه، امسح السعر المستهدف"
  },
  "target.remove_cancelled": {
    en: "❌ Cancel",
    ar: "❌ إلغاء"
  },

  // ── Confirm Deletion ─────────────────────────────────────────────────────
  "delete.confirm_head": {
    en: "⚠️ <b>Confirm Deletion</b>",
    ar: "⚠️ <b>تأكيد المسح</b>"
  },
  "delete.confirm_body": {
    en: "Are you sure you want to permanently delete ASIN <code>{asin}</code> from your saved list?\n\n<i>This action cannot be undone.</i>",
    ar: "متأكد إنك عايز تمسح ASIN <code>{asin}</code> من قايمتك نهائياً؟\n\n<i>العملية دي ملهاش رجعة.</i>"
  },
  "delete.btn_yes_delete": {
    en: "✅ Yes, Delete",
    ar: "✅ أيوه، امسح"
  },
  "delete.deleted_head": {
    en: "🗑️ <b>Product Deleted</b>",
    ar: "🗑️ <b>تم مسح المنتج</b>"
  },
  "delete.deleted_body": {
    en: "ASIN <code>{asin}</code> has been completely removed from your active register.",
    ar: "ASIN <code>{asin}</code> اتمسح بالكامل من سجل المتابعة."
  },

  // ── Admin: Confirm Revocation ─────────────────────────────────────────────
  "admin.confirm_revoke_head": {
    en: "⚠️ <b>Confirm Revocation</b>",
    ar: "⚠️ <b>تأكيد إلغاء الوصول</b>"
  },
  "admin.confirm_revoke_body": {
    en: "Are you sure you want to permanently revoke ID <code>{id}</code>?\n\n<i>Their entire saved list will be erased. This cannot be undone.</i>",
    ar: "متأكد إنك عايز تلغي وصول الرقم <code>{id}</code> نهائياً؟\n\n<i>كل قايمته المحفوحة هتتتمسح. العملية دي ملهاش رجعة.</i>"
  },
  "admin.btn_revoke": {
    en: "✅ Yes, Revoke",
    ar: "✅ أيوه، ألغي"
  },
  "admin.btn_cancel": {
    en: "❌ Cancel",
    ar: "❌ إلغاء"
  },

  // ── Admin: Confirm Demotion ───────────────────────────────────────────────
  "admin.confirm_demote_head": {
    en: "⚠️ <b>Confirm Demotion</b>",
    ar: "⚠️ <b>تأكيد التخفيض</b>"
  },
  "admin.confirm_demote_body": {
    en: "Are you sure you want to strip Admin privileges from ID <code>{id}</code>?",
    ar: "متأكد إنك عايز تشيل صلاحيات الأدمن من الرقم <code>{id}</code>؟"
  },
  "admin.btn_demote": {
    en: "✅ Yes, Demote",
    ar: "✅ أيواه، خفض"
  },

  // ── Admin: Confirm Promotion ──────────────────────────────────────────────
  "admin.confirm_promote_head": {
    en: "⚠️ <b>Confirm Promotion</b>",
    ar: "⚠️ <b>تأكيد الترقية</b>"
  },
  "admin.confirm_promote_body": {
    en: "Are you sure you want to grant full Admin privileges to ID <code>{id}</code>?",
    ar: "متأكد إنك عايز تدي صلاحيات كاملة للأدمن للرقم <code>{id}</code>؟"
  },
  "admin.btn_promote": {
    en: "✅ Yes, Promote",
    ar: "✅ أيوه، روّج"
  },

  // ── Admin: Revoked ────────────────────────────────────────────────────────
  "admin.revoked_result": {
    en: "🗑️ <b>Revoked & Purged!</b>\nID <code>{id}</code> and their entire saved list have been permanently erased.",
    ar: "🗑️ <b>تم الإلغاء والمسح!</b>\nالرقم <code>{id}</code> وكايمته المحفوظة اتمسحوا نهائياً."
  },

  // ── Admin: Promoted ──────────────────────────────────────────────────────
  "admin.promoted_result": {
    en: "🌟 <b>Promoted!</b>\nID <code>{id}</code> has been elevated to Admin privileges.",
    ar: "🌟 <b>تمت الترقية!</b>\nالرقم <code>{id}</code> اترقى لصلاحيات الأدمن."
  },
  "admin.promoted_notify": {
    en: "🌟 <b>You have been promoted to Admin!</b>\nYou now have authorization to approve users. Run /start to see the admin features.",
    ar: "🌟 <b>اترقيت لأدمن!</b>\nدلوقتي عندك صلاحية الموافقة على المستخدمين. شغّل /start عشان تشوف مميزات الأدمن."
  },
  "admin.back_to_directory": {
    en: "⬅️ Back to Directory",
    ar: "⬅️ رجوع للدليل"
  },

  // ── Admin: Demoted ──────────────────────────────────────────────────────
  "admin.demoted_result": {
    en: "🔽 <b>Demoted.</b>\nID <code>{id}</code> has returned to standard access tier.",
    ar: "🔽 <b>تم التخفيض.</b>\nالرقم <code>{id}</code> رجع لمستوى الوصول العادي."
  },

  // ── Admin: Unban ────────────────────────────────────────────────────────
  "admin.unban_result": {
    en: "🔄 <b>User Unbanned</b>\nUser <code>{id}</code> has been removed from the Banned Directory. They can now send /start to request access again if they wish.",
    ar: "🔄 <b>تم رفع الحظر</b>\nالمستخدم <code>{id}</code> اتشال من دليل المحظورين. يقدر يبعت /start تاني عشان يطلب الوصول لو عايز."
  },

  // ── Admin: Reference expired/handled ──────────────────────────────────────
  "admin.request_expired": {
    en: "⚠️ <b>Request Expired or Handled</b>\nThis application is no longer in the pending queue.",
    ar: "⚠️ <b>الطلب انتهى أو اتعامل معاه</b>\nالطلب ده مش في قائمة الانتظار بقا."
  },
  "admin.approved_result": {
    en: "✅ <b>Approved!</b>\nUser <code>{id}</code> was approved by {admin}.",
    ar: "✅ <b>تمت الموافقة!</b>\nالمستخدم <code>{id}</code> اتوافق عليه من {admin}."
  },
  "admin.approved_manual_result": {
    en: "✅ <b>Approved!</b>\nUser <code>{id}</code> can now use the Amazon deals application.",
    ar: "✅ <b>تمت الموافقة!</b>\nالمستخدم <code>{id}</code> يقدر يستخدم تطبيق خصومات أمازون دلوقتي."
  },

  // ── Navigation ────────────────────────────────────────────────────────────
  "nav.main_menu": {
    en: "🏠 Main Menu",
    ar: "🏠 القائمة الرئيسية"
  },
  "nav.back": {
    en: "⬅️ Back",
    ar: "⬅️ رجوع"
  },
  "nav.open_menu": {
    en: "🏠 Open Main Menu",
    ar: "🏠 افتح القائمة الرئيسية"
  },
  "nav.back_to_product": {
    en: "⬅️ Back to Product",
    ar: "⬅️ رجوع للمنتج"
  },

  // ── Scraper Alerts ─────────────────────────────────────────────────────────
  "alert.target_met_head": {
    en: "🎯 <b>TARGET MET!</b>",
    ar: "🎯 <b>السعر وصل للمستهدف!</b>"
  },
  "alert.target_met_current": {
    en: "💰 <b>Current Price:</b> {price} EGP",
    ar: "💰 <b>السعر الحالي:</b> {price} ج.م"
  },
  "alert.target_met_target": {
    en: "🎯 <b>Target:</b> {price} EGP",
    ar: "🎯 <b>المستهدف:</b> {price} ج.م"
  },
  "alert.target_met_dropped": {
    en: "📉 <b>Dropped:</b> {price} EGP",
    ar: "📉 <b>انخفض:</b> {price} ج.م"
  },
  "alert.target_met_seller": {
    en: "🏬 <b>Seller:</b> {seller}",
    ar: "🏬 <b>البائع:</b> {seller}"
  },

  "alert.restock_head": {
    en: "🔄 <b>RESTOCK ALERT</b>",
    ar: "🔄 <b>تنبيه إعادة تخزين</b>"
  },
  "alert.restock_price": {
    en: "💰 <b>Price:</b> {price} EGP",
    ar: "💰 <b>السعر:</b> {price} ج.م"
  },
  "alert.restock_seller": {
    en: "🏬 <b>Seller:</b> {seller}",
    ar: "🏬 <b>البائع:</b> {seller}"
  },

  "alert.price_drop_head": {
    en: "📉 <b>PRICE DROP ALERT</b>",
    ar: "📉 <b>تنبيه انخفاض السعر</b>"
  },
  "alert.price_drop_new": {
    en: "💰 <b>New Price:</b> {price} EGP",
    ar: "💰 <b>السعر الجديد:</b> {price} ج.م"
  },
  "alert.price_drop_dropped": {
    en: "📉 <b>Dropped:</b> {diff} EGP",
    ar: "📉 <b>انخفض:</b> {diff} ج.م"
  },
  "alert.price_drop_was": {
    en: "📊 <b>Was:</b> {price} EGP",
    ar: "📊 <b>كان:</b> {price} ج.م"
  },
  "alert.price_drop_seller": {
    en: "🏬 <b>Seller:</b> {seller}",
    ar: "🏬 <b>البائع:</b> {seller}"
  },

  "alert.missing_head": {
    en: "🚨 <b>Item Missing!</b>",
    ar: "🚨 <b>المنتج اختفى!</b>"
  },
  "alert.missing_body": {
    en: "ASIN <code>{asin}</code> has been Out of Stock for > 24 hours. Tracking paused automatically.",
    ar: "ASIN <code>{asin}</code> غير متوفر من المخزن أكتر من ٢٤ ساعة. المتابعة اتوقفت أوتوماتيك."
  },
  "alert.missing_body_ara": {
    en: "ASIN <code>{asin}</code> has been Out of Stock for > 24 hours. Tracking paused automatically.",
    ar: "ASIN <code>{asin}</code> غير متوفر من المخزن أكتر من ٢٤ ساعة. المتابعة اتوقفت أوتوماتيك."
  },

  "alert.stale_target_head": {
    en: "⏰ <b>STALE TARGET RETIRED</b>",
    ar: "⏰ <b>المستهدف القديم اتشال</b>"
  },
  "alert.stale_target_with_price": {
    en: "Your target of <b>{target} EGP</b> for <b>{days}</b> days without being met has been retired. You will now resume receiving standard price alerts.",
    ar: "المستهدف بتاعك <b>{target} ج.م</b> من <b>{days}</b> يوم من غير ما يتحقق اتشال. هترجع تاني تستقبل إشعارات السعر العادية."
  },
  "alert.stale_target_no_price": {
    en: "You had no target set for {asin}, but tracking has been inactive for <b>{days}</b> days without activity. Standard price alerts have been resumed.",
    ar: "ما كانش عندك سعر مستهدف لـ {asin}، بس المتابعة كانت مش نشطة لمدة <b>{days}</b> يوم. إشعارات السعر العادية اتعادت."
  },

  "alert.tracking_expired_head": {
    en: "⏰ <b>TRACKING EXPIRED</b>",
    ar: "⏰ <b>المتابعة انتهت</b>"
  },
  "alert.tracking_expired_body": {
    en: "Your subscription for ASIN <code>{asin}</code> has been retired after <b>{days}</b> days without activity. If you still want to track this item, please re-add it.",
    ar: "اشتراكك في ASIN <code>{asin}</code> اتشال بعد <b>{days}</b> يوم من غير أي نشاط. لسه عايز تتابع المنتج ده، أضفه من جديد."
  },

  "alert.btn_open_new": {
    en: "🛒 Open in Amazon.eg",
    ar: "🛒 افتح أمازون مصر"
  },
  "alert.btn_open_resale": {
    en: "📦 Open Amazon Resale",
    ar: "📦 افتح أمازون ريزيل"
  },
  "alert.btn_disclaimer": {
    en: "ℹ️ Price Disclaimer",
    ar: "ℹ️ تنبيه الأسعار"
  },
  "alert.disclaimer_text": {
    en: "Prices are indicative and sourced from Amazon.eg at the time of check. Actual prices may vary.",
    ar: "الأسعار استرشادية وماخوذة من أمازون مصر وقت الشيك. الأسعار الفعلية ممكن تختلف."
  },
  "alert.boosted_label": {
    en: "#ad",
    ar: "#إعلان"
  },
  "alert.historical_new": {
    en: "Amazon.eg:",
    ar: "أمازون مصر:"
  },
  "alert.historical_resale": {
    en: "Amazon Resale:",
    ar: "أمازون ريزيل:"
  },

  // ── Scraper: Analytical Stale Target (shared between variants) ────────────
  "alert.stale_days": {
    en: "{days} days",
    ar: "{days} يوم"
  },

  // ── Broadcast ─────────────────────────────────────────────────────────────
  "broadcast.atl_head": {
    en: "⏬ <b>ALL-TIME LOW</b> ⏬",
    ar: "⏬ <b>أقل سعر في التاريخ</b> ⏬"
  },
  "broadcast.exceptional_head": {
    en: "🔥 <b>EXCEPTIONAL DEAL</b> 🔥",
    ar: "🔥 <b>صفقة استثنائية</b> 🔥"
  },
  "broadcast.cta_shop": {
    en: "🛒 Click here to grab the deal →",
    ar: "🛒 دوس هنا عشان تاخد الصفقة →"
  },
  "broadcast.cta_more": {
    en: "🔍 Find more exceptional deals →",
    ar: "🔍 لمزيد من الصفقات الاستثنائية →"
  },
  "broadcast.price_as_of": {
    en: "📅 Price as of {date}",
    ar: "📅 السعر بتاريخ {date}"
  },
  "broadcast.btn_open": {
    en: "🛒 Open in Amazon.eg",
    ar: "🛒 افتح أمازون مصر"
  },

  // ── CRM Dashboard ──────────────────────────────────────────────────────────
  // ── Shared Misc ───────────────────────────────────────────────────────────
  "happy_shopping": {
    en: "🛍️ Happy shopping!",
    ar: "🛍️ تسوق سعيد!"
  },

  // ── CRM Dashboard ──────────────────────────────────────────────────────────
  "crm.hub_title": {
    en: "AzTracker Hub",
    ar: "أز تريكر هب"
  },
  "crm.users_title": {
    en: "Users",
    ar: "المستخدمين"
  },
  "crm.products_title": {
    en: "Active Tracked Products",
    ar: "المنتجات المتتبعة النشطة"
  },
  "crm.system_overview": {
    en: "System Overview",
    ar: "نظرة عامة على النظام"
  },
  "crm.last_sync": {
    en: "Last Sync",
    ar: "آخر مزامنة"
  },
  "crm.restore_products": {
    en: "Restore Products",
    ar: "استعادة المنتجات"
  },
  "crm.force_check": {
    en: "Force Check",
    ar: "إجبار الشيك"
  },
  "crm.system_broadcast": {
    en: "System Broadcast",
    ar: "بث عام"
  },
  "crm.broadcast_placeholder": {
    en: "Enter message to blast to all users...",
    ar: "اكتب رسالة تبعتها لكل المستخدمين..."
  },
  "crm.send_broadcast": {
    en: "Send Broadcast",
    ar: "إرسال البث"
  },
  "crm.tab_approved": {
    en: "Approved",
    ar: "المُوافق عليهم"
  },
  "crm.tab_pending": {
    en: "Pending",
    ar: "قيد الانتظار"
  },
  "crm.tab_banned": {
    en: "Banned",
    ar: "المحظورين"
  },
  "crm.tab_admins": {
    en: "Admins",
    ar: "الأدمنز"
  },
  "crm.search_placeholder": {
    en: "Search Name, @username or ID...",
    ar: "دور بالاسم، @يوزر نيم أو رقم..."
  },
  "crm.no_pending": {
    en: "No pending requests",
    ar: "مافيش طلبات معلقة"
  },
  "crm.no_users_found": {
    en: "No users found",
    ar: "مافيش مستخدمين اتلقوا"
  },
  "crm.no_saved_products": {
    en: "No saved products",
    ar: "مافيش منتجات محفوظة"
  },
  "crm.price_history": {
    en: "Price History",
    ar: "تاريخ الأسعار"
  },
  "crm.loading_chart": {
    en: "Loading chart data...",
    ar: "بنحمل بيانات الرسم البياني..."
  },
  "crm.no_price_history": {
    en: "No price history available yet.",
    ar: "مافيش تاريخ أسعار لسه."
  },
  "crm.ath": {
    en: "ATH",
    ar: "أعلى سعر"
  },
  "crm.atl": {
    en: "ATL",
    ar: "أقل سعر"
  },
  "crm.avg": {
    en: "Avg",
    ar: "المتوسط"
  },
  "crm.new_price": {
    en: "New (EGP)",
    ar: "جديد (ج.م)"
  },
  "crm.used_price": {
    en: "Used (EGP)",
    ar: "مستعمل (ج.م)"
  },
  "crm.no_audit": {
    en: "No administrative actions logged in the past 7 days.",
    ar: "مافيش أحداث أدمن اتسجلت في آخر ٧ أيام."
  },
  "crm.user_products": {
    en: "User Products",
    ar: "منتجات المستخدم"
  },
  "crm.user_id_label": {
    en: "ID:",
    ar: "الرقم:"
  },
  "crm.loading_items": {
    en: "Loading items...",
    ar: "بنحمل المنتجات..."
  },
  "crm.user_paused": {
    en: "Paused",
    ar: "متوقف"
  },
  "crm.user_active": {
    en: "Active",
    ar: "نشط"
  },
  "crm.user_used_only": {
    en: "Used Only",
    ar: "مستعمل بس"
  },
  "crm.user_out_of_stock": {
    en: "Out of Stock",
    ar: "غير متوفر"
  },
  "crm.btn_resume": {
    en: "Resume",
    ar: "استأنف"
  },
  "crm.btn_pause_drawer": {
    en: "Pause",
    ar: "وقف"
  },
  "crm.btn_chart": {
    en: "Chart",
    ar: "رسم بياني"
  },
  "crm.btn_delete_drawer": {
    en: "Delete",
    ar: "امسح"
  },
  "crm.btn_view_items": {
    en: "View Items",
    ar: "شوف المنتجات"
  },
  "crm.btn_message": {
    en: "Message",
    ar: "رسالة"
  },
  "crm.btn_edit": {
    en: "Edit",
    ar: "تعديل"
  },
  "crm.btn_promote": {
    en: "Promote",
    ar: "روّج"
  },
  "crm.btn_demote_drawer": {
    en: "Demote",
    ar: "خفض"
  },
  "crm.btn_unban": {
    en: "Unban User",
    ar: "ارفع الحظر"
  },
  "crm.toast_syncing": {
    en: "Syncing...",
    ar: "بنزامن..."
  },
  "crm.toast_synced": {
    en: "Data synchronized",
    ar: "البيانات اتزامنت"
  },
  "crm.toast_network_error": {
    en: "Network Error",
    ar: "خطأ في الشبكة"
  },
  "crm.toast_action_queued": {
    en: "Action queued in background",
    ar: "الإجراء في قائمة الانتظار"
  },
  "crm.toast_success": {
    en: "Success",
    ar: "تم بنجاح"
  },
  "crm.toast_processing": {
    en: "Processing...",
    ar: "بنجهز..."
  },
  "crm.action_approved": {
    en: "Your access request has been <b>APPROVED</b>!",
    ar: "طلب الوصول بتاعك اتوافق عليه!"
  },
  "crm.action_rejected": {
    en: "Your access request was <b>REJECTED</b>.",
    ar: "طلب الوصول بتاعك اترفض."
  },
  "crm.action_revoked": {
    en: "Your access has been <b>REVOKED</b>.",
    ar: "وصولك اتشال."
  },
  "crm.action_restored": {
    en: "Your access has been <b>RESTORED</b>.",
    ar: "وصولك اترجع."
  },
  "crm.action_promoted": {
    en: "You have been <b>PROMOTED</b> to Admin!",
    ar: "اترقيت لأدمن!"
  },
  "crm.action_demoted": {
    en: "You have been <b>DEMOTED</b> to standard user.",
    ar: "اتخفيضت لمستخدم عادي."
  },
  "crm.action_limit_updated": {
    en: "Your tracking limit has been updated to <b>{limit}</b> items.",
    ar: "حد المتابعة بتاعك اتغير لـ <b>{limit}</b> منتجات."
  },
  "crm.action_message_from": {
    en: "📬 <b>Message from Admin:</b>",
    ar: "📬 <b>رسالة من الأدمن:</b>"
  },
  "crm.action_restoration_complete": {
    en: "✅ <b>Restoration Complete</b>",
    ar: "✅ <b>الاستعادة تمت</b>"
  },
  "crm.action_force_scrape_ok": {
    en: "✅ <b>Force Scrape Completed</b>",
    ar: "✅ <b>الشيك الإجباري تم</b>"
  },
  "crm.action_force_scrape_fail": {
    en: "❌ <b>Force Scrape Failed</b>",
    ar: "❌ <b>الشيك الإجباري فشل</b>"
  },
  "crm.action_global_broadcast": {
    en: "📢 <b>Global Broadcast</b>",
    ar: "📢 <b>بث عام</b>"
  },
  "crm.security_audit": {
    en: "🔒 <b>Security Audit Log</b>",
    ar: "🔒 <b>سجل التدقيق الأمني</b>"
  },
  "crm.rolling_retention": {
    en: "📅 7-Day Rolling Retention",
    ar: "📅 احتفاظ ٧ أيام"
  },
  "crm.compiling_ledger": {
    en: "⏳ Compiling forensic ledger...",
    ar: "⏳ بنجهز السجل الجنائي..."
  },
  "crm.refresh": {
    en: "Refresh",
    ar: "تحديث"
  },
};

/**
 * Translation function — pure synchronous lookup.
 *
 * @param {string} key    - Flat key in the form "category.subkey"
 * @param {string} [lang] - Language code ('en' | 'ar'). Defaults to 'en'.
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
 * Maps any Arabic variant (ar, ar-EG, ar-SA, etc.) → 'ar'
 * Everything else → 'en'
 *
 * @param {string|null|undefined} languageCode - Telegram's message.from.language_code
 * @returns {string} 'ar' or 'en'
 */
export function resolveLanguageCode(languageCode) {
  if (!languageCode) return 'en';
  return languageCode.startsWith('ar') ? 'ar' : 'en';
}

/**
 * Get the full interpolated welcome message for a given language.
 *
 * @param {string} lang  - 'en' or 'ar'
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
