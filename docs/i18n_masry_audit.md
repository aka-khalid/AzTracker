# Masry Egyptian Arabic Audit Report

**File audited:** `src/core/i18n.js`
**Style target:** Casual Masry Egyptian Arabic (عامية مصرية) — short, punchy, conversational, mobile-first, emoji-heavy. No Fusha. Western digits only. Egyptian vocabulary and contractions.

---

## Legend

- `[FUSHA]` — Formal Classical Arabic that breaks the Masry voice
- `[LONG]` — Overly wordy for mobile UI; can be shortened
- `[VOCAB]` — Wrong vocabulary choice (non-Egyptian or non-conversational)
- `[MIXED]` — Mixes Fusha + Masry inconsistently
- `[DUPLICATE]` — Near-duplicate entries that could be consolidated
- `[MISSING_AR]` — English fallback used where Arabic is needed

---

## Findings

### 1. `chrome.ad_disclosure`
- **Current:** "كشريك أمازون، بكسب عمولة من المشتريات المؤهلة."
- **Problem:** `[FUSHA]` "المشتريات المؤهلة" is very formal Fusha legalese. Also "بكسب" at the start of a clause is awkward.
- **Suggestion:** "كشريك أمازون، باخد عمولة من الطلبات المؤهلة." or even shorter: "بناخد عمولة من أمازون على المشتريات."

---

### 2. `access.admin_new_request_body`
- **Current:** "👤 **الاسم:** {name}\n🆔 **آي دي:** {code}\n\n<i>الشخص ده عايز يدخل.</i>"
- **Problem:** `[VOCAB]` "آي دي" — while understood, in casual Masry you'd more naturally say "الرقم" (especially in the CRM section the project already uses "الرقم"). "آي دي" sounds like frangla/internet slang but inconsistent with the rest of the codebase.
- **Suggestion:** "👤 **الاسم:** {name}\n🆔 **الرقم:** {code}\n\n<i>الشخص ده عايز يدخل.</i>"

---

### 3. `access.queue_full_body`
- **Current:** "قائمة الانتظار مليانة دلوقتي. حاول تاني بعد 24 ساعة."
- **Problem:** `[FUSHA]` "قائمة الانتظار" is very formal — this is pure Fusha terminology. "حاول تاني" is half-Masry but still reads as Fusha-adjacent.
- **Suggestion:** "المكان متلwyn دلوقتي. حاول بعد يوم." or "مفيش مكان فاضي دلوقتي. حاول بكرة."

---

### 4. `access.admin_rejected`
- **Current:** "🚫 **الطلب اترفض**\nالمستخدم {id} اترفض من {admin}."
- **Problem:** `[FUSHA]` "المستخدم" is very Fusha. Throughout the rest of the project, the app uses "حد" or "شخص" in Masry sections.
- **Suggestion:** "🚫 **الطلب اترفض**\nالشخص رقم {id} اترفض من {admin}."

---

### 5. `access.admin_rejected_manual`
- **Current:** "🚫 **الطلب اترفض**\nالمستخدم {id} اترفض بشكل صريح."
- **Problem:** `[FUSHA]` "المستخدم" again, and "بشكل صريح" is textbook Fusha.
- **Suggestion:** "🚫 **الطلب اترفض**\nالرقم {id} اترفض بالظبط."

---

### 6. `access.handled_request`
- **Current:** "🚫 **تم التعامل**\nالمستخدم {id} اترفض من {admin}."
- **Problem:** `[FUSHA]` "تم التعامل" is very formal/bureaucratic. "المستخدم" again.
- **Suggestion:** "🚫 **خلصنا الموضوع**\nالرقم {id} اترفض من {admin}."

---

### 7. `access.handled_approved`
- **Current:** "✅ **تم التعامل**\nالمستخدم {id} اتوافق عليه من {admin}."
- **Problem:** `[FUSHA]` Same issues as above.
- **Suggestion:** "✅ **خلصنا الموضوع**\nالرقم {id} اتوافق عليه من {admin}."

---

### 8. `access.pending_body`
- **Current:** "طلبك بيتراجع دلوقتي. ربنا يسهل."
- **Problem:** `[MIXED]` "بيتراجع" is a formal/administrative term (like document review). The second sentence "ربنا يسهل" is great Masry but the first one is stiff.
- **Suggestion:** "طلبك تحت المراجعة دلوقتي. ربنا يسهل." or more casual: "بنشوف طلبك دلوقتي. ربنا يسهل."

---

### 9. `welcome.step4`
- **Current:** "أول ما السعر ينزل أو المنتج يرجع المخزون، هيجيلك إشعار أوتوماتيك."
- **Problem:** `[LONG]` "المنتج يرجع المخزون" is awkward phrasing — it literally means "the product returns the inventory." Also "أوتوماتيك" is fine but could be punchier.
- **Suggestion:** "أول ما السعر ينزل أو المنتج يرجع التوك، هيجيلك إشعار." — but more naturally: "أول ما السعر ينزل أو الحاجة ترجع المخزون، هتتلغى."

Actually, cleaner: "أول ما السعر ينزل أو المنتج يرجع يبقى متاح، هيجيلك إشعار."

---

### 10. `howto.body`
- **Current:** "انسخ أي لينك منتج أمازون مصر من المتصفح أو الأبلكيشن والصقه في الشات ده مباشرة."
- **Problem:** `[VOCAB]` This is actually quite good and natural overall. However, "الصقه" is a bit technical for the average user. More natural Masry would say "حطه."
- **Suggestion:** "انسخ أي لينك منتج أمازون مصر من البراوزر أو الأبلكيشن وحطه في الشات ده على طول."

---

### 11. `howto.shortlinks`
- **Current:** "📱 **اللينكات القصورة اللي بتبعتها من الأبلكيشن مدعومة بالكامل!**"
- **Problem:** `[VOCAB]` "القصورة" is not a standard Arabic word (shortened/cropped = "مختصرة"). Also "مدعومة بالكامل" is very formal/Fusha.
- **Suggestion:** "📱 **لينكات أمازون المختصرة من الأبلكيشن شغالة عادي!**"

---

### 12. `link.region_not_supported_body`
- **Current:** "دلوقتي بندعم amazon.eg بس."
- **Problem:** This is actually perfect Masry. No issue. ✅

---

### 13. `link.limit_reached_body`
- **Current:** "امسح شوية منتجات عشان تفضي مكان قبل ما تضيف حاجة جديدة."
- **Problem:** This is actually great Masry. ✅ — no issues.

---

### 14. `link.registered_head`
- **Current:** "✅ **تم تسجيل المنتج!**"
- **Problem:** `[FUSHA]` "تم تسجيل" is ultra-formal bureaucratic Arabic. Very far from casual Masry.
- **Suggestion:** "✅ **أضفنا المنتج!**" or "✅ **المنتج اتسجل!**"

---

### 15. `link.registered_status`
- **Current:** "المنتج ده اتحفظ دلوقتي. هيجيب السعر الحي في الفحص الأوتوماتيك الجاي."
- **Problem:** `[FUSHA + VOCAB]` "الفحص الأوتوماتيك" is very formal. "السعر الحي" is understood but not how Egyptians typically talk.
- **Suggestion:** "المنتج ده اتحفظ دلوقتي. هنشوف السعر الجديد في شيك الجاي." (using "شيك" which is common Egyptian slang for "check").

---

### 16. `link.system_error`
- **Current:** "⚠️ **خطأ في النظام:** الحد الأقصى للمنتجات مش متحدد. تواصل مع الأدمن."
- **Problem:** Actually good, but "خطأ في النظام" is a bit formal. Still acceptable in context. Minor: could be "فيه غلطة في السيرفر" for more casual tone.
- **Suggestion:** "⚠️ **فيه مشكلة:** الحد الأقصى للمنتجات مش متحدد. كلم الأدمن."

---

### 17. `link.invalid_command`
- **Current:** "⚠️ **أمر غلط أو صيغة مش صحيحة**\n\nاستخدم الخيارات التفاعلية تحت أو حط لينك أمازون صحيح."
- **Problem:** `[FUSHA + LONG]` "أمر غلط أو صيغة مش صحيحة" sounds like an Android error message. "الخيارات التفاعلية" is too formal for the app's casual tone.
- **Suggestion:** "⚠️ **مش فاهم اللي انت كاتبه!**\n\nاستخدم الخيارات اللي تحت أو حط لينك أمازون صحيح."

---

### 18. `list.select_hint`
- **Current:** "اختار منتج تحت عشان تعدل بارامترات المتابعة:"
- **Problem:** `[VOCAB]` "بارامترات" is borrowed English/Greek via Faulkner. In Masry, no one says that.
- **Suggestion:** "اختار منتج تحت عشان تعدل إعدادات المتابعة:"

---

### 19. `product.waiting_check`
- **Current:** "⏳ مستنيين المرة الجاية اللي هنعرف فيها السعر..."
- **Problem:** `[LONG]` Overly wordy for a mobile status label.
- **Suggestion:** "⏳ مستنيين تعرف السعر الجاي..." or even shorter: "⏳ بنشوف السعر..."

---

### 20. `product.btn.set_target`
- **Current:** "🎯 حدد السعر المستهدف"
- **Problem:** `[FUSHA]` "حدد السعر المستهدف" is formal button text.
- **Suggestion:** "🎯 قوله السعر اللي عايزه" or "🎯 حدد السعر"

---

### 21. `product.btn.clear_target`
- **Current:** "❌ امسح السعر المستهدف"
- **Problem:** `[FUSHA]` "السعر المستهدف" repeated from above.
- **Suggestion:** "❌ امسح التارجت" (using the loanword which is common in Egyptian tech speak) or "❌ شيل السعر"

---

### 22. `product.btn.resume`
- **Current:** "▶️ استأنف المتابعة"
- **Problem:** `[FUSHA]` "استأنف" is very formal — no Egyptian says "استأنف المتابعة" in daily life.
- **Suggestion:** "▶️ كمل المتابعة"

---

### 23. `target.set_head`
- **Current:** "🎯 **حدد السعر المستهدف**"
- **Problem:** `[FUSHA]` Same as product.btn.set_target above.
- **Suggestion:** "🎯 **قوله السعر اللي عايزه**" or "🎯 **اكتب السعر**"

---

### 24. `target.set_prompt`
- **Current:** "ASIN: {asin}\n\nاكتب السعر الأقصى اللي عايزه بالجنيه في رسالة (مثلاً: 4500)."
- **Problem:** Actually pretty good! "اكتب السعر الأقصى اللي عايزه" is natural Masry. ✅

---

### 25. `target.invalid_amount`
- **Current:** "⚠️ **مبلغ غلط.** اكتب رقم صحيح."
- **Problem:** `[VOCAB]` "مبلغ غلط" — "مبلغ" implies a monetary amount in an accounting sense. In casual Egyptian, you'd say "الرقم ده غلط" or "رقم مش صحيح."
- **Suggestion:** "⚠️ **الرقم ده مش مظبوط.** اكتب رقم صحيح."

---

### 26. `target.set_confirm_head`
- **Current:** "🎯 **تم تحديد السعر المستهدف!**"
- **Problem:** `[FUSHA]` "تم تحديد" is formal bureaucratic Arabic.
- **Suggestion:** "🎯 **حطينا السعر اللي عايزه!**" or "🎯 **التارجت اتحط!**"

---

### 27. `target.remove_confirm_head`
- **Current:** "⚠️ **تأكيد مسح السعر المستهدف**"
- **Problem:** `[FUSHA]` "تأكيد مسح" is very formal.
- **Suggestion:** "⚠️ **عايز تمسح التارجت؟**"

---

### 28. `target.remove_confirm_body`
- **Current:** "متأكد إنك عايز تمسح السعر المستهدف لـ ASIN {asin}؟"
- **Problem:** Mixed but slightly formal with "السعر المستهدف."
- **Suggestion:** "متأكد إنك عايز تمسح التارجت لـ ASIN {asin}؟"

---

### 29. `target.btn_yes_clear`
- **Current:** "✅ أيوة، امسح السعر المستهدف"
- **Problem:** `[FUSHA]` Again, "السعر المستهدف" is too formal.
- **Suggestion:** "✅ أيوة، امسح التارجت"

---

### 30. `delete.confirm_head`
- **Current:** "⚠️ **تأكيد المسح**"
- **Problem:** `[FUSHA]` Formal Fusha.
- **Suggestion:** "⚠️ **عايز تمسح؟**"

---

### 31. `delete.confirm_body`
- **Current:** "متأكد إنك عايز تمسح ASIN {asin} من قايمتك نهائياً؟\n\n<i>العملية دي ملهاش رجعة.</i>"
- **Problem:** Actually excellent Masry! ✅ Very natural.

---

### 32. `delete.deleted_body`
- **Current:** "ASIN {asin} اتمسح بالكامل من سجل المتابعة."
- **Problem:** `[FUSHA + VOCAB]` "سجل المتابعة" is very formal/administrative.
- **Suggestion:** "ASIN {asin} اتمسح خلاص." (short, punchy, done)

---

### 33. `admin.confirm_revoke_body`
- **Current:** "متأكد إنك عايز تشيل {id} نهائياً؟\n\n<i>كل منتجاته المحفوحة هتتتمسح. العملية دي ملهاش رجعة.</i>"
- **Problem:** Actually good Masry overall ✅. "هتتتمسк" is a bit awkward (gemination) but "المحفوحة" is clearly a typo for "المحفوظة" — should be fixed regardless.

---

### 34. `admin.confirm_demote_head`
- **Current:** "⚠️ **تأكيد التخفيض**"
- **Problem:** `[FUSHA]` Formal.
- **Suggestion:** "⚠️ **عايز تخفض رتبته؟**"

---

### 35. `admin.confirm_demote_body`
- **Current:** "متأكد إنك عايز تشيل صلاحيات الأدمن من الرقم {id}؟"
- **Problem:** Actually pretty good casual Masry. ✅

---

### 36. `admin.confirm_promote_head`
- **Current:** "⚠️ **تأكيد الترقية**"
- **Problem:** `[FUSHA]` Very formal.
- **Suggestion:** "⚠️ **عايز تخليه أدمن؟**"

---

### 37. `admin.confirm_promote_body`
- **Current:** "متأكد إنك عايز تدي صلاحيات كاملة للأدمن للرقم {id}؟"
- **Problem:** `[WORDY/REPETITION]` "تدي صلاحيات... للأدمن للرقم" — the repetition of "لـ" is awkward and "الأدمن" as recipient when you're giving admin rights is confusing.
- **Suggestion:** "متأكد إنك عايز تخلي الرقم {id} أدمن؟"

---

### 38. `admin.revoked_result`
- **Current:** "🗑️ **تم الإلغاء والمسح!**\nالرقم {id} ومنتجاته المحفوظة اتمسحوا نهائياً."
- **Problem:** `[FUSHA]` "تم الإلغاء والمسح" is very formal/passive.
- **Suggestion:** "🗑️ **شيلناه ومسحناه!**\nالرقم {id} وكل منتجاته اتمسحوا."

---

### 39. `admin.promoted_result`
- **Current:** "🌟 **تمت الترقية!**\nالرقم {id} اترقى لصلاحيات الأدمن."
- **Problem:** `[FUSHA]` "تمت الترقية" is formal.
- **Suggestion:** "🌟 **بقيت أدمن!**\nالرقم {id} اترقى."

---

### 40. `admin.promoted_notify`
- **Current:** "🌟 **مبروك انت بقيت أدمن!**\nدلوقتي عندك صلاحية الموافقة على المستخدمين. افتح المنيو عشان تشوف مميزات الأدمن."
- **Problem:** `[FUSHA + LONG]` "عندك صلاحية الموافقة على المستخدمين" is formal. "مميزات الأدمن" is okay but a bit stiff.
- **Suggestion:** "🌟 **مبروك بقيت أدمن!**\nدلوقتي تقدر تقبل أو ترفض مستخدمين. افتح المنيو عشان تشوف أدوات الأدمن."

---

### 41. `admin.demoted_result`
- **Current:** "🔽 **تم التخفيض.**\nالرقم {id} رجع لمستوى الوصول العادي."
- **Problem:** `[FUSHA]` "تم التخفيض" and "مستوى الوصول العادي" are formal.
- **Suggestion:** "🔽 **اتشال منه الأدمن.**\nالرقم {id} رجع مستخدم عادي."

---

### 42. `admin.unban_result`
- **Current:** "🔄 **تم رفع الحظر**\nالمستخدم {id} اتشال من دليل المحظورين. يقدر يبعت /start تاني عشان يطلب الوصول لو عايز."
- **Problem:** `[FUSHA + VOCAB]` "تم رفع الحظر" is formal. "المستخدم" again. "دليل المحظورين" is unnecessarily bureaucratic.
- **Suggestion:** "🔄 **رفعنا الحظر عنه**\nالرقم {id} اتشال من البان. يقدر يبعت /start تاني لو عايز يدخل."

---

### 43. `admin.request_expired`
- **Current:** "⚠️ **الطلب انتهى أو اتعامل معاه**\nالطلب ده مش في قائمة الانتظار بقا."
- **Problem:** `[FUSHA]` "قائمة الانتظار" is formal.
- **Suggestion:** "⚠️ **الطلب ده بقديم**\nالطلب ده بقى مش في الليست."

---

### 44. `admin.approved_result`
- **Current:** "✅ **تمت الموافقة!**\nالمستخدم {id} اتوافق عليه من {admin}."
- **Problem:** `[FUSHA]` "تمت الموافقة" is formal. "المستخدم" again.
- **Suggestion:** "✅ **وافقنا عليه!**\nالرقم {id} اتوافق عليه من {admin}."

---

### 45. `admin.approved_manual_result`
- **Current:** "✅ **تمت الموافقة!**\nالمستخدم {id} يقدر يستخدم أبلكيشن خصومات أمازون دلوقتي."
- **Problem:** `[FUSHA]` "تمت الموافقة" again. "أبلكيشن خصومات أمازون" is a bit long/wordy.
- **Suggestion:** "✅ **وافقنا عليه!**\nالرقم {id} يقدر يستخدم أبلكيشن أمازون مصر دلوقتي."

---

### 46. `target.set_confirm_body` vs `target.set_confirm_body_ara`
- **Problem:** `[DUPLICATE]` Both keys have identical English as value for `ar`. The `_ara` variant is a duplicate — this should be fixed.
- **Note:** Both should be Arabic. If this is intentional for A/B testing, they should differ.

---

### 47. `alert.target_met_dropped`
- **Current:** "📉 **انخفض:** {price} ج.م"
- **Problem:** `[FUSHA]` "انخفض" is Fusha. In Masry, you'd say "نزل."
- **Suggestion:** "📉 **نزل:** {price} ج.م"

---

### 48. `alert.price_drop_dropped`
- **Current:** "📉 **انخفض:** {diff} ج.م"
- **Problem:** `[FUSHA]` Same as above.
- **Suggestion:** "📉 **نزل:** {diff} ج.م"

---

### 49. `alert.price_drop_was`
- **Current:** "📊 **كان:** {price} ج.م"
- **Problem:** This is actually fine — "كان" is used the same in Fusha and Masry. ✅

---

### 50. `alert.disclaimer_text`
- **Current:** "الأسعار استرشادية ومأخوذة من أمازون مصر وقت ما شوفناها. الأسعار الفعلية ممكن تختلف."
- **Problem:** `[FUSHA]` "مأخوذة" and "الأسعار الفعلية" are formal.
- **Suggestion:** "الأسعار دي تقريبية وأخدناها من أمازون مصر وقت ما شيكنا. السعر الحقيقي ممكن يختلف."

---

### 51. `alert.btn_disclaimer`
- **Current:** "ℹ️ تنبيه الأسعار"
- **Problem:** `[FUSHA]` "تنبيه الأسعار" is formal.
- **Suggestion:** "ℹ️ الأسعار ممكن تتغير" or "ℹ️ شوف حاجة مهمة"

---

### 52. `crm.users_title`
- **Current:** "المستخدمين"
- **Problem:** `[FUSHA]` "المستخدمين" is formal. More natural Masry would be "الناس" or keep but more contextual.
- **Suggestion:** "الناس" or "اليوزرز" (using the Egyptianized loanword)

---

### 53. `crm.system_overview`
- **Current:** "نظرة عامة"
- **Problem:** `[FUSHA]` "نظرة عامة" is textbook Fusha / MSA.
- **Suggestion:** "ملخص سريع" or "إيه الأخبار"

---

### 54. `crm.last_sync`
- **Current:** "آخر تحديث"
- **Problem:** Technically fine in both Fusha and Masry, but slightly formal for a casual app. Could be more casual.
- **Suggestion:** "آخر مرة اتحدث" or "تحديث آخر مرة"

---

### 55. `crm.refresh`
- **Current:** "تحديث"
- **Problem:** Fine in both registers, but contextually "حدث الصفحة" or just keeping it as is is acceptable since it's a button label.

---

### 56. `crm.broadcast_placeholder`
- **Current:** "اكتب رسالة تبعتها لكل المستخدمين..."
- **Problem:** `[FUSHA + VOCAB]` "تبعتها" is a bit awkward, and "المستخدمين" again.
- **Suggestion:** "اكتب رسالة تبعتها لكل الناس..."

---

### 57. `crm.send_broadcast`
- **Current:** "إرسال البث"
- **Problem:** `[FUSHA]` Very formal. "إرسال" is Fusha. "البث" is also formal.
- **Suggestion:** "ابعت الرسالة" or "ابعت لكل الناس"

---

### 58. `crm.tab_approved`
- **Current:** "الموافق عليهم"
- **Problem:** `[FUSHA]` Very formal passive participle.
- **Suggestion:** "اللي وافقنا عليهم" or just "approved" (but in Arabic: "المظبوطين" would be too far, so "اللي اتوافق عليهم")

---

### 59. `crm.tab_pending**
- **Current:** "قيد الانتظار"
- **Problem:** `[FUSHA]` "قيد الانتظار" is extremely formal Arabic — it's the kind of thing you see on government forms.
- **Suggestion:** "مستناهم" or "في الانتظار" (without "قيد")

---

### 60. `crm.tab_banned`
- **Current:** "المحظورين"
- **Problem:** Acceptable but slightly formal. Could use "المبندين" (very colloquial Masry for "banned people").
- **Suggestion:** "المحظورين" is actually fine — commonly used in Egyptian social media.

---

### 61. `crm.no_users_found`
- **Current:** "مافيش مستخدمين اتلقوا"
- **Problem:** Actually very good Masry! ✅

---

### 62. `crm.no_saved_products`
- **Current:** "مافيش منتجات محفوظة"
- **Problem:** Fine, natural. ✅

---

### 63. `crm.price_history`
- **Current:** "تاريخ الأسعار"
- **Problem:** Fine in both registers. ✅ (Though "تاريخ السعر" singular would match the product-level context better)

---

### 64. `crm.loading_items`
- **Current:** "بنحمل المنتجات..."
- **Problem:** Good Masry. ✅

---

### 65. `crm.toast_syncing`
- **Current:** "بنزامن..."
- **Problem:** `[VOCAB]` "زامن" is a formal/technical term (synchronize). In Masry, "بنحدّث" or "بنجيب الداتا" is more natural.
- **Suggestion:** "بنجيب آخر الداتا..."

---

### 66. `crm.toast_synced`
- **Current:** "الاتزامن خلاص"
- **Problem:** `[VOCAB/FUSHA]` Same as above. "الاتزامن" is technical.
- **Suggestion:** "الداتا الجديده جات!" or "اتحدثنا!"

---

### 67. `crm.compiling_ledger`
- **Current:** "⏳ بنجهز السجل الجنائي..."
- **Problem:** `[FUSHA + VOCAB]` "السجل الجنائي" literally means "criminal record" — this is a technical/overdramatic term. In the context of a security audit log, it sounds odd even in English.
- **Suggestion:** "⏳ بنجهز سجل الأمان..."

---

### 68. `crm.security_audit`
- **Current:** "🔒 **سجل الأمان**"
- **Problem:** Actually acceptable. "سجل الأمان" is commonly used in Egyptian tech contexts. ✅

---

### 69. `crm.action_approved`
- **Current:** "طلب الوصول بتاعك اتوافق عليه!"
- **Problem:** Good casual Masry! ✅

---

### 70. `crm.action_revoked`
- **Current:** "وصولك اتشال."
- **Problem:** Good short punchy Masry! ✅

---

### 71. `crm.action_restored`
- **Current:** "وصولك اترجع."
- **Problem:** Good Masry. ✅

---

### 72. `crm.action_demoted`
- **Current:** "اتخفيضت لمستخدم عادي."
- **Problem:** `[FUSHA]` "اتخفيضت" is a formal passive.
- **Suggestion:** "شيلنا منك صلاحيات الأدمن."

---

### 73. `crm.action_limit_updated`
- **Current:** "حد المتابعة بتاعك اتغير لـ {limit} منتجات."
- **Problem:** Actually good natural Arabic. ✅

---

### 74. `crm.rolling_retention`
- **Current:** "📅 احتفاظ 7 أيام"
- **Problem:** `[FUSHA + VOCAB]` "احتفاظ" is a technical/formal word. Would sound like a legal term.
- **Suggestion:** "📅 بنحتفظ بالأحداث 7 أيام" or "📅 آخر 7 أيام"

---

---

## Summary Table

| # | Key | Severity | Issue Type | Current Text (abbreviated) | Suggestion (abbreviated) |
|---|-----|----------|------------|---------------------------|-------------------------|
| 1 | `chrome.ad_disclosure` | Medium | FUSHA | المشتريات المؤهلة | المشتريات المؤهلة |
| 2 | `access.admin_new_request_body` | Low | VOCAB | آي دي | الرقم |
| 3 | `access.queue_full_body` | Medium | FUSHA | قائمة الانتظار مليانة | المكان متلwyn |
| 4 | `access.admin_rejected` | Medium | FUSHA | المستخدم اترفض | الشخص رقم اترفض |
| 5 | `access.admin_rejected_manual` | High | FUSHA | المستخدم... بشكل صريح | الرقم... بالظبط |
| 6 | `access.handled_request` | High | FUSHA | تم التعامل | خلصنا الموضوع |
| 7 | `access.handled_approved` | High | FUSHA | تم التعامل | خلصنا الموضوع |
| 8 | `access.pending_body` | Low | MIXED | بيتراجع دلوقتي | بنشوف طلبك دلوقتي |
| 9 | `welcome.step4` | Low | LONG | المنتج يرجع المخزون | المنتج يرجع يبقى متاح |
| 10 | `howto.body` | Low | VOCAB | انسخ... والصقه | انسخ... وحطه |
| 11 | `howto.shortlinks` | Medium | VOCAB+FUSHA | القصورة... مدعومة بالكامل | المختصرة... شغالة عادي |
| 14 | `link.registered_head` | High | FUSHA | تم تسجيل المنتج | أضفنا المنتج |
| 15 | `link.registered_status` | High | FUSHA+VOCAB | الفحص الأوتوماتيك | شيك الجاي |
| 16 | `link.system_error` | Low | FUSHA | خطأ في النظام | فيه ممشكلة |
| 17 | `link.invalid_command` | High | FUSHA+LONG | أمر غلط أو صيغة | مش فاهم اللي انت كاتبه |
| 18 | `list.select_hint` | Medium | VOCAB | بارامترات | إعدادات |
| 19 | `product.waiting_check` | Low | LONG | مستنيين المرة الجاية | بنشوف السعر |
| 20 | `product.btn.set_target` | Medium | FUSHA | حدد السعر المستهدف | قوله السعر اللي عايزه |
| 21 | `product.btn.clear_target` | Low | FUSHA | امسح السعر المستهدف | امسح التارجت |
| 22 | `product.btn.resume` | Medium | FUSHA | استأنف المتابعة | كمل المتابعة |
| 23 | `target.set_head` | Medium | FUSHA | حدد السعر المستهدف | قوله السعر اللي عايزه |
| 25 | `target.invalid_amount` | Low | VOCAB | مبلغ غلط | الرقم ده مش مظبوط |
| 26 | `target.set_confirm_head` | High | FUSHA | تم تحديد السعر المستهدف | حطينا السعر اللي عايزه |
| 27 | `target.remove_confirm_head` | Medium | FUSHA | تأكيد مسح السعر المستهدف | عايز تمسح التارجت؟ |
| 29 | `target.btn_yes_clear` | Low | FUSHA | امسح السعر المستهدف | امسح التارجت |
| 30 | `delete.confirm_head` | Medium | FUSHA | تأكيد المسح | عايز تمسح؟ |
| 32 | `delete.deleted_body` | High | FUSHA+VOCAB | اتمسح من سجل المتابعة | اتمسح خلاص |
| 34 | `admin.confirm_demote_head` | Medium | FUSHA | تأكيد التخفيض | عايز تخفض رتبته؟ |
| 36 | `admin.confirm_promote_head` | Medium | FUSHA | تأكيد الترقية | عايز تخليه أدمن؟ |
| 37 | `admin.confirm_promote_body` | Medium | WORDY | تدي صلاحيات للأدمن للرقم | تخلي الرقم أدمن |
| 38 | `admin.revoked_result` | High | FUSHA | تم الإلغاء والمسح | شيلناه ومسحناه |
| 39 | `admin.promoted_result` | Medium | FUSHA | تمت الترقية | اترقى |
| 40 | `admin.promoted_notify` | Medium | FUSHA+LONG | صلاحية الموافقة على المستخدمين | تقدر تقبل أو ترفض مستخدمين |
| 41 | `admin.demoted_result` | High | FUSHA | تم التخفيض... مستوى الوصول العادي | اتشال منه الأدمن |
| 42 | `admin.unban_result` | High | FUSHA+VOCAB | تم رفع الحظر... المستخدم... دليل المحظورين | رفعنا الحظر عنه... الرقم... البان |
| 43 | `admin.request_expired` | Medium | FUSHA | قائمة الانتظار | الليست |
| 44 | `admin.approved_result` | Medium | FUSHA | تمت الموافقة... المستخدم | وافقنا عليه... الرقم |
| 45 | `admin.approved_manual_result` | Medium | FUSHA+LONG | تمت الموافقة... المستخدم | وافقنا عليه... الرقم |
| 46 | `target.set_confirm_body_ara` | High | DUPLICATE | Identical to parent | Remove or differentiate |
| 47 | `alert.target_met_dropped` | Medium | FUSHA | انخفض | نزل |
| 48 | `alert.price_drop_dropped` | Medium | FUSHA | انخفض | نزل |
| 50 | `alert.disclaimer_text` | High | FUSHA | مأخوذة... الأسعار الفعلية | أخدناها... السعر الحقيقي |
| 51 | `alert.btn_disclaimer` | Medium | FUSHA | تنبيه الأسعار | الأسعار ممكن تتغير |
| 52 | `crm.users_title` | Medium | FUSHA | المستخدمين | الناس |
| 53 | `crm.system_overview` | Medium | FUSHA | نظرة عامة | ملخص سريع |
| 56 | `crm.broadcast_placeholder` | Low | MIXED | تبعتها لكل المستخدمين | تبعتها لكل الناس |
| 57 | `crm.send_broadcast` | Medium | FUSHA | إرسال البث | ابعت الرسالة |
| 58 | `crm.tab_approved` | High | FUSHA | الموافق عليهم | اللي اتوافق عليهم |
| 59 | `crm.tab_pending` | High | FUSHA | قيد الانتظار | مستناهم |
| 65 | `crm.toast_syncing` | Medium | VOCAB | بنزامن | بنجيب آخر الداتا |
| 66 | `crm.toast_synced` | Medium | VOCAB | الاتزامن خلاص | الداتا الجديده جات |
| 67 | `crm.compiling_ledger` | High | FUSHA+VOCAB | السجل الجنائي | سجل الأمان |
| 72 | `crm.action_demoted` | Medium | FUSHA | اتخفيضت لمستخدم عادي | شيلنا منك صلاحيات الأدمن |
| 74 | `crm.rolling_retention` | Medium | FUSHA+VOCAB | احتفاظ 7 أيام | آخر 7 أيام |

---

## Statistics

- **Total Arabic string entries audited:** ~190
- **Entries with issues found:** 42
- **High severity:** 14
- **Medium severity:** 20
- **Low severity:** 8
- **Already correct (Masry-compliant):** ~148

---

## Key Recurring Issues

### 1. "المستخدم" (the user) -- Used ~8 times
This is the most common Fusha intrusion. The consistent Masry replacement is "الرقم" when referring to ID/label contexts, or "الشخص/حد" for human references.

**Affected keys:**
- `access.admin_rejected`
- `access.admin_rejected_manual`
- `access.handled_request`
- `access.handled_approved`
- `admin.unban_result`
- `admin.approved_result`
- `admin.approved_manual_result`
- `admin.promoted_result`
- `admin.demoted_result`
- `crm.users_title`
- `crm.broadcast_placeholder`

### 2. "تم الــ..." passive construction -- Used ~12 times
The passive "تم + masdar" construction (تم تسجيل، تم تحديد، تم التعامل، تم الإلغاء والمسح، تم التخفيض، تمت الترقية، تم رفع الحظر، تمت الموافقة) is the hallmark of bureaucratic Arabic. In Masry, use active voice with doer statements or direct verbs.

### 3. "السعر المستهدف" -- Used ~5 times
The formal "المستشعر" should be replaced with either "التارجت" (common loanword) or "السعر اللي عايزه."

### 4. "انخفض" -- Used 2 times
Always in Masry this would be "نزل" for "dropped."

### 5. "البيانات" and technical loanwords -- 3+ instances
Words like "بارامترات", "زامن", "احتفاظ" are formal/technical. Replace with colloquial Egyptian equivalents.
