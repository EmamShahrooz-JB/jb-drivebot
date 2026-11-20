# وضعیت پروژه — گزارش صادقانه

تاریخ: ۲۰۲۶-۱۱-۲۰ · نسخه ۱.۰.۰ · ۱۶۱ تست خودکار، همه پاس

این فایل جدا می‌کند: (الف) چه چیزی واقعاً پیاده‌سازی شده، (ب) چه چیزی با تست خودکار اثبات شده، (ج) چه چیزی پیاده شده اما تست نشده، (د) چه چیزی عمداً پیاده نشده است.

---

## الف) پیاده‌سازی‌شده و با تست اثبات‌شده

| قابلیت | تست |
|---|---|
| رمزنگاری Refresh/Access Token با AES-256-GCM + جداسازی کلید | `unit/crypto` |
| امضای Callback Data + انقضا + رد جعل | `unit/crypto` |
| SSRF: بلاک IP خصوصی/متادیتا/ULA، DNS rebinding، پین آدرس | `unit/ssrf` |
| دسته‌بندی خودکار فایل + الگوهای پوشه (۵ حالت) | `unit/classify`, `integration/transfer` |
| پاک‌سازی نام فایل و جلوگیری از Path Traversal | `unit/sanitize`, `integration/zip` |
| Rate Limiting و Backoff نمایی | `unit/rate-limit`, `integration/queue` |
| زبان جستجو (`ext:`/`type:`/`size:`/`after:`) + escape امن کوئری Drive | `unit/search-parse` |
| سازگاری رمزنگاری ابزار محلی ↔ سرور | `unit/pairing-compat` |
| مهاجرت دیتابیس (idempotent) + هم‌خوانی فایل‌های SQL با کد | `integration/database` |
| تمام ریپازیتوری‌ها (accounts/uploads/jobs/settings/pairing/stats/audit) | `integration/database` |
| صف: اولویت، هم‌زمانی، Retry، لغو، بازیابی orphan، Idempotency | `integration/queue`, `integration/database` |
| Resumable Upload چند‌تکه + **ازسرگیری بعد از قطع** + MD5 | `integration/drive-upload` |
| دانلود از لینک: Redirect، سقف حجم، HTML جعلی، MD5، بدون content-length | `integration/download` |
| تشخیص لینک Drive/Dropbox/OneDrive/GitHub | `integration/download` |
| ZIP: ساخت، فهرست، استخراج، ضد Zip Slip/symlink/Bomb | `integration/zip` |
| جریان کامل OAuth: PKCE، State، تبادل کد، ذخیره رمزنگاری‌شده، کد یک‌بارمصرف | `integration/oauth-pairing` |
| تمدید خودکار Access Token + کش | `integration/oauth-pairing` |
| خط لوله آپلود: پوشه ریشه، مسیر دسته‌بندی، Dedupe با هش، ثبت تاریخچه و آمار | `integration/transfer` |
| بوت کامل سیستم (config → DB → صف → HTTP → bot) | `npm run smoke` (۱۲ بررسی) |
| نقطه ورود production: HTTP، polling، redaction، SIGTERM | `integration/boot` |
| کامپایل TypeScript در حالت strict | `npm run typecheck`, `npm run build` |

---

## ب) پیاده‌سازی‌شده، اما تست خودکار ندارد

این‌ها کد دارند و typecheck می‌شوند، ولی بدون اعتبارنامه/محیط واقعی قابل اجرا نبودند:

| مورد | چه چیزی کم است | ریسک | اولین کاری که باید بکنید |
|---|---|---|---|
| تماس واقعی با Google Drive API | Client ID/Secret و حساب شما | متوسط — مسیر کد و پروتکل شبیه‌سازی شده | یک آپلود کوچک + `/status` بعد از اتصال |
| Bot API واقعی تلگرام (ارسال/دریافت فایل، کلیک دکمه) | توکن BotFather | متوسط — wiring و polling با stub تست شده، ولی تعامل واقعی نه | `/start`، آپلود یک فایل کوچک، `/queue` |
| درایور **Postgres** | سرویس Postgres در این محیط | **بالا** — فقط SQLite یکپارچه تست شده | `npm run migrate` روی Postgres + یک آپلود + `/queue` |
| حالت `local-exchange` (انتقال توکن مهرشده) | فقط سازگاری رمزنگاری تست شده | کم-متوسط | یک‌بار با `--mode local-exchange` |
| yt-dlp | باینری و ffmpeg | متوسط — فقط شاخه اختیاری است | `ENABLE_YTDLP=true` در ایمیج Docker |
| حالت Webhook | ثبت واقعی روی تلگرام | کم — polling پیش‌فرض است | اگر لازم شد، `WEBHOOK_*` را ست کنید |
| Local Bot API Server | راه‌اندازی سرور تلگرام | کم — فقط `TELEGRAM_API_ROOT` | اگر فایل >۲۰MB از تلگرام می‌خواهید |
| فایل‌های چند‌گیگابایتی | محیط/شبکه واقعی | متوسط | یک آپلود ۵۰۰MB+ با `/queue` و لاگ‌ها |
| رندر پیام‌ها/دکمه‌ها در کلاینت تلگرام | کلاینت واقعی | کم — ولی تجربه بصری دیده نشده | منوها را یک‌بار بزنید |

---

## ج) عمداً پیاده نشده (با دلیل)

| مورد | چرا |
|---|---|
| ورود/کوکی سرویس‌های ثالث (لینک‌های خصوصی) | اپراتور نباید رمز سرویس‌های دیگر را در اختیار بات بگذارد؛ فقط روش‌های عمومی و رسمی |
| حذف خودکار فایل‌های تکراری/قدیمی | خلاف الزام «هیچ حذفی بدون تأیید» |
| دانلود پوشه Google Drive از طریق لینک | Drive API برای پوشه لینک دانلود مستقیم نمی‌دهد؛ پیام روشن داده می‌شود |
| فشرده‌سازی یک پوشه کامل Drive در ZIP | نیازمند پیمایش بازگشتی و فضای موقت زیاد؛ فعلاً انتخاب چند فایل پشتیبانی می‌شود |
| چرخش `APP_ENCRYPTION_KEY` بدون قطع اتصال | پیاده‌سازی نیازمند نسخه‌بندی کلید (key ring) است |
| انتشار عمومی/چند‌کاربره | طراحی صریحاً تک‌اپراتور است |
| Bulk Move / Bulk Delete در UI | زیرساخت (basket) هست و ZIP از آن استفاده می‌کند؛ UI گروهی برای حذف عمداً ساخته نشد |

---

## د) تصمیم‌های مهمی که باید بدانید

1. **`drive.file` پیش‌فرض است.** یعنی «My Drive» در ابتدا فقط پوشه `JB-DriveBot` را نشان می‌دهد. اگر دنبال مدیریت کل Drive هستید، `GOOGLE_SCOPES_MODE=readonly` یا `full` را ببینید (`docs/SCOPES.md`).
2. **دریافت فایل از تلگرام ۲۰MB است.** این محدودیت تلگرام است، نه کد. راه‌حل واقعی: لینک، یا Local Bot API Server.
3. **صف داخلی است، نه Redis.** برای یک اپراتور کافی و کم‌وابستگی‌تر است؛ اما اگر روزی چند اپ instance هم‌زمان اجرا کنید، باید صف را به Redis منتقل کنید (الان `claimNext` برای تک‌فرآیند طراحی شده است؛ در Postgres هم به‌خاطر تراکنش امن است، اما دو instance توصیه نمی‌شود).
4. **حالت جفت‌سازی پیش‌فرض `server-exchange`** است: Refresh Token هیچ‌وقت روی کامپیوتر شما ذخیره نمی‌شود. این از درخواست اولیه («انتقال امن Refresh Token به سرور») امن‌تر است و همان هدف را برآورده می‌کند؛ حالت دوم هم برای کسانی که صریحاً می‌خواهند تبادل محلی باشد موجود است.
5. **بدون اعتبارنامه شما هیچ تست end-to-end واقعی ممکن نیست.** به همین دلیل تست‌ها به‌جای mock کردن کد ما، Drive و Google را با سرور HTTP واقعی و پروتکل‌محور شبیه‌سازی می‌کنند.

---

## ه) کارهای بعدی پیشنهادی (به ترتیب اولویت)

1. روی Postgres یک آپلود و یک لغو/بازیابی را امتحان کنید (تنها ریسک بالای باقی‌مانده).
2. `GOOGLE_SCOPES_MODE` را با نیاز واقعی‌تان تنظیم کنید.
3. یک بکاپ `/backup` بگیرید و محتوای JSON را sanity-check کنید.
4. اگر فایل بزرگ از تلگرام لازم دارید: Local Bot API Server.
5. اگر ویدیو دانلود می‌کنید: ایمیج Docker با `yt-dlp` + `ffmpeg`.
