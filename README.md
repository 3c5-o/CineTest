# CineTest

تجربة تطبيق أفلام ومسلسلات مرتبط بـ Telegram + Supabase.

## البنية
- `index.html`: تطبيق المستخدم، متوافق مع الهاتف.
- `supabase/schema.sql`: قاعدة البيانات وسياسات RLS.
- `supabase/functions/telegram-gateway/index.ts`: بوت الإدارة + بوابة عرض ملفات Telegram.
- Telegram Private Channel: أرشيف الصور والفيديوهات.
- Supabase: بيانات الأفلام والمسلسلات والمواسم والحلقات.

## الأمان
لا يتم وضع Telegram Bot Token داخل GitHub أو JavaScript.

أنشئ في Supabase > Edge Functions > Secrets:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_SECRET`

ثم انشر الدالة `telegram-gateway` مع تعطيل JWT verification لأنها تستقبل Telegram webhook وتتحقق من `X-Telegram-Bot-Api-Secret-Token` داخل الكود.

## إعداد الـ webhook
بعد حفظ الـ Secrets ونشر الدالة، افتح:
`https://uaphmjpnxrzvvhalpobr.supabase.co/functions/v1/telegram-gateway?setup=YOUR_TELEGRAM_BOT_SECRET`

مرة واحدة فقط.

## الإدارة
أرسل للبوت `/start`.

الحساب المسموح للإدارة:
`8407394858`

قناة التخزين:
`-1004457227800`

## ملاحظة الاختبار
Telegram Bot API العادي يسمح للدالة بتنزيل ملفات حتى 20MB عبر getFile. لذلك النسخة التجريبية تقبل فيديو أقل من 20MB. البنية قابلة لاحقًا لاستبدال طبقة الفيديو بتخزين/CDN مناسب للفيديوهات الكبيرة دون تغيير واجهة الإدارة أو قاعدة البيانات.
