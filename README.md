# CineTest

منصة أفلام ومسلسلات تجريبية تعتمد على Telegram كتخزين دائم للوسائط، Supabase للبيانات والإدارة، وTelegram MTProto Gateway لبث الفيديو عبر HTTP Range.

## المكونات

- `index.html`: تطبيق المستخدم المتوافق مع الهاتف.
- `supabase/schema.sql`: قاعدة البيانات وRLS.
- `supabase/functions/telegram-gateway/index.ts`: Telegram Bot + API الطلبات + توجيه الفيديو إلى الـGateway.
- `gateway/app.py`: FastAPI + Telethon لبث ملفات Telegram الكبيرة مع Range Requests.
- `Dockerfile`: تشغيل الـGateway على خدمة Containers.

## الإصدار الحالي

- حد الفيديو في الإدارة: **500MB**.
- تخزين الفيديو والبوسترات: Telegram.
- تشغيل الفيديو: Gateway مباشر من Telegram بالقطع، وليس تحميل الفيلم كاملًا في RAM.
- IDs منظمة: `MOV-000001`, `SER-000001`, `SER-000001-S01-E01`.
- إدارة متعددة الصلاحيات: Owner, Secondary Admin, Content Manager, Requests Manager, Moderator.
- سجل عمليات إدارية.
- إخفاء/إظهار المحتوى بدل الحذف المباشر.
- طلب فيلم/مسلسل من التطبيق مع رقم `REQ-xxxxxx` ومتابعة الحالة.
- قائمة مفضلة محلية + متابعة المشاهدة + حفظ سرعة التشغيل.
- مشغل يدعم Range/Seek وPiP وFullscreen وRetry و±10 ثوانٍ.

## قنوات Telegram

النظام يعمل حاليًا مع `default_storage`. وهو جاهز لإضافة قنوات منفصلة لاحقًا بهذه المفاتيح:

- `movies_storage`
- `movies_info`
- `series_storage`
- `series_info`
- `requests`

إذا لم توجد قناة مخصصة، التخزين يرجع تلقائيًا إلى القناة الافتراضية حتى لا يتوقف النظام. قناة الطلبات لا تستخدم fallback حتى لا تختلط الطلبات بملفات التخزين.

## الأمان

لا تضع Telegram Bot Token أو API Hash داخل GitHub أو JavaScript. القيم الحساسة تبقى في Secrets/Environment Variables فقط.

Secrets الخاصة بـSupabase Edge Function:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_SECRET`
- اختياري لاحقًا: `TELEGRAM_STREAM_ACCESS_KEY`

Environment Variables الخاصة بالـGateway:
- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHANNEL_ID`
- اختياري: `MAX_CONCURRENT_STREAMS` (الافتراضي 4)
- اختياري لاحقًا: `STREAM_ACCESS_KEY`

## ملاحظة النشر

Supabase Edge Function منشورة مباشرة من المشروع. أما خدمة Back4app الحالية فـAuto Deploy فيها متوقف، لذلك أي تعديل جديد في `gateway/app.py` يحتاج **Redeploy / Deploy latest commit** من Back4app حتى يصبح فعالًا.

التخزين الدائم يبقى Telegram؛ الـGateway مجرد طبقة بث ولا يحتفظ بالفيلم كنسخة دائمة.
