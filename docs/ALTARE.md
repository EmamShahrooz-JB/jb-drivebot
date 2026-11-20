# استقرار روی Altare — بررسی و راهنمای عملی

## آنچه از مستندات Altare بررسی شد

منابع: <https://altare.gg> ، <https://docs.altare.gg> ، صفحه Pricing و Help.

| موضوع | یافته | نتیجه برای این پروژه |
|---|---|---|
| App Hosting | «Deploy apps from GitHub, with previews, logs and cron jobs»؛ Node.js/Bun/Python/Go و Docker | ✅ انتخاب اصلی |
| الزام شبکه | اپ باید روی `0.0.0.0:$PORT` گوش بدهد؛ TLS از سمت پلتفرم | کد از `HOST=0.0.0.0` و `PORT` (تزریقی) استفاده می‌کند |
| Sandboxes / Altare Go | Go موقتی (ephemeral) است؛ Sandbox برای Docker مناسب نیست | ❌ برای ربات ۲۴/۷ مناسب نیست |
| Docker Apps | پشتیبانی می‌شود | اختیاری؛ فقط اگر yt-dlp/ffmpeg بخواهید |
| Postgres | PostgreSQL 17 مدیریتی با بکاپ شبانه؛ پلن رایگان ۲۵۶MB RAM / ۱GB | ✅ توصیه‌شده برای صف/تاریخچه/توکن |
| MySQL / Valkey / Queues / U3 | موجود | لازم نیست؛ صف داخلی داریم (کم‌وابستگی‌تر) |
| پلن Always Free | ۶GB RAM، ۱۵۰٪ CPU، ۱۰GB دیسک، ۴ سرور، ۱۰GB U3 | برای این ربات بیش از کافی |
| Bot Hosting | برای Discord/Telegram ۲۴/۷ | گزینه جایگزین، ولی برای endpoint جفت‌سازی به HTTP نیاز داریم → App Hosting |
| نکته پایداری | هشدار رسمی: «فرض نکنید فایل‌سیستم کانتینر بین دیپلوی‌ها می‌ماند» | داده‌ی حیاتی در Postgres؛ دیسک فقط برای temp/بکاپ |

> این‌ها بر اساس آنچه در مستندات/صفحات عمومی Altare در زمان نگارش قابل مشاهده بود جمع‌آوری شده است. پلن‌ها و جزئیات پنل ممکن است تغییر کنند؛ پیش از دیپلوی نهایی یک نگاه به کنسول خودتان بیندازید.

## Topology توصیه‌شده

```
            ┌──────────────────────────────────────┐
Internet ──▶│ Altare App Hosting (Node.js 20)      │
            │  • Long Polling تلگرام               │
            │  • GET  /health                      │
            │  • POST /api/pair/complete           │
            │  • GET  /api/pair/prepare            │
            │  (اختیاری) POST /telegram/webhook/…  │
            └───────────────┬──────────────────────┘
                            │ sslmode=require
                            ▼
            ┌──────────────────────────────────────┐
            │ Altare Postgres 17 (مدیریتی)         │
            │  accounts · jobs · uploads · stats   │
            └──────────────────────────────────────┘
```

دیسک محلی (`/app/data`) فقط: فایل‌های موقت دانلود/آپلود و نسخه JSON بکاپ. هر دو دورریختنی هستند.

## دیپلوی گام‌به‌گام

### ۱. آماده‌سازی ریپو
```bash
git init && git add -A && git commit -m "JB-DriveBot"
git remote add origin git@github.com:<you>/JB-DriveBot.git
git push -u origin main
```
`.env` را کامیت نکنید (در `.gitignore` هست).

### ۲. ساخت دیتابیس
کنسول Altare → **Postgres** → New → نسخه ۱۷ → Connection String با `sslmode=require` را کپی کنید.

### ۳. ساخت اپ
**App Hosting** → New App → اتصال ریپو/برنچ:

| فیلد | مقدار |
|---|---|
| Runtime | Node.js 20 (یا بالاتر) |
| Install | `npm ci` |
| Build | `npm run build` |
| Start | `npm start` |
| Port | `8080` |

### ۴. متغیرهای محیطی
```
NODE_ENV=production
LOG_LEVEL=info
TELEGRAM_BOT_TOKEN=...
ADMIN_USER_IDS=<id شما>
TELEGRAM_TRANSPORT=polling
PORT=8080
HOST=0.0.0.0
PUBLIC_BASE_URL=https://<app>.altare.app
ENABLE_PAIRING_SERVER=true
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_SCOPES_MODE=file
APP_ENCRYPTION_KEY=<openssl rand -base64 32>
DB_DRIVER=postgres
DATABASE_URL=postgres://...?sslmode=require
DATA_DIR=/app/data
```
> `PORT` را معمولاً خود پلتفرم تزریق می‌کند؛ اگر اجازه‌ی override دارید همان ۸۰۸۰ را بگذارید.

### ۵. دیپلوی و بررسی
```bash
curl -s https://<app>.altare.app/health
# {"ok":true,"service":"jb-drivebot","uptime":12}
```
در لاگ باید ببینید:
```
{"msg":"database migrated",...}
{"msg":"job queue started",...}
{"msg":"http server listening","port":8080}
{"msg":"started long polling"}
```

### ۶. اتصال حساب
`/connect` در تلگرام → کد را در ابزار محلی بزنید:
```bash
npx tsx auth-local/src/cli.ts --server https://<app>.altare.app --code XXXX-XXXX
```

## محدودیت‌ها و راهکارهای واقعی

| محدودیت | اثر | راهکار |
|---|---|---|
| دریافت ۲۰MB از Bot API | ارسال فایل بزرگ از تلگرام ممکن نیست | لینک بفرستید، یا Local Bot API Server + `TELEGRAM_API_ROOT` |
| یک پورت عمومی | webhook و pairing هم‌زمان | polling پیش‌فرض؛ webhook روی همان پورت mount می‌شود |
| دیسک ۱۰GB (رایگان) | فایل موقت بزرگ | `TEMP_QUOTA_BYTES`، پاک‌سازی خودکار، جریان استریم (RAM مهم نیست) |
| ری‌استارت/دیپلوی | jobهای نیمه‌کاره | صف پایدار + `recoverOrphans` + ازسرگیری Resumable Upload |
| دیسک ممکن است بین دیپلوی‌ها نماند | از دست رفتن تاریخچه در SQLite | Postgres مدیریتی |
| اجرای Docker در Sandbox ممنوع | باینری‌های اضافی | Docker App یا App Hosting بدون yt-dlp |

## چرا Long Polling و نه Webhook

- Webhook به URL عمومی HTTPS، ثبت secret و مدیریت خطای تلگرام نیاز دارد و اگر آدرس تغییر کند باید دوباره ثبت شود.
- Polling با یک فرآیند و یک اتصال خروجی کار می‌کند و از پشت هر پروکسی/Firewall عبور می‌کند.
- تأخیر polling در این کد ~۱ ثانیه است، یعنی عملاً محسوس نیست.

اگر webhook می‌خواهید:
```
TELEGRAM_TRANSPORT=webhook
WEBHOOK_PUBLIC_URL=https://<app>.altare.app
WEBHOOK_SECRET=<رشته تصادفی ≥۱۶ کاراکتر>
```
مسیر: `POST https://<app>.altare.app/telegram/webhook/<secret>` با بررسی هدر `X-Telegram-Bot-Api-Secret-Token` (توسط grammY).

## اگر Docker App را انتخاب کردید

```bash
# روی سرور یا هر جا Docker دارید
docker compose up -d --build
```
و `ENABLE_YTDLP=true` را با باز کردن خط نصب `ffmpeg`/`python3` در `Dockerfile` ترکیب کنید.
