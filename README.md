# JB-DriveBot

> ربات تلگرام حرفه‌ای برای مدیریت کامل Google Drive — Node.js + TypeScript + grammY + Drive API v3

JB-DriveBot یک File Manager کامل داخل تلگرام است: فایل می‌فرستید و در Drive آپلود می‌شود، لینک می‌فرستید و دانلود می‌شود، پوشه می‌سازید، جستجو می‌کنید، آرشیو می‌سازید و آمار می‌گیرید. همه عملیات سنگین در صف پس‌زمینه پایدار اجرا می‌شوند و با ری‌استارت سرور از بین نمی‌روند.

> **نکته مهم درباره این تحویل:** این پروژه کد کامل و اجراشدنی است، اما برای اینکه واقعاً به حساب Google و ربات شما وصل شود، سه چیز لازم است که فقط شما می‌توانید تهیه کنید: توکن BotFather، پروژه Google Cloud با Client ID/Secret، و مقادیر محیطی روی Altare. هیچ‌کدام از این‌ها را نمی‌توان از پیش در کد قرار داد (و نباید قرار داد). مراحل دقیق در ادامه آمده است. وضعیت دقیق «چه چیزی تست شده و چه چیزی تست نشده» در [`docs/STATUS.md`](docs/STATUS.md) آمده است — آن را قبل از اتکا به پروژه بخوانید.

---

## فهرست

1. [ویژگی‌ها](#ویژگیها)
2. [معماری در یک نگاه](#معماری-در-یک-نگاه)
3. [پیش‌نیازها](#پیشنیازها)
4. [گام ۱: ساخت ربات با BotFather](#گام-۱-ساخت-ربات-با-botfather)
5. [گام ۲: پروژه Google Cloud و فعال‌سازی Drive API](#گام-۲-پروژه-google-cloud-و-فعالسازی-drive-api)
6. [گام ۳: ساخت OAuth Desktop Client](#گام-۳-ساخت-oauth-desktop-client)
7. [گام ۴: اجرای ابزار JB-Drive Authenticator](#گام-۴-اجرای-ابزار-jb-drive-authenticator)
8. [گام ۵: متغیرهای محیطی](#گام-۵-متغیرهای-محیطی)
9. [گام ۶: راه‌اندازی دیتابیس](#گام-۶-راهاندازی-دیتابیس)
10. [گام ۷: اجرای محلی](#گام-۷-اجرای-محلی)
11. [گام ۸: استقرار روی Altare](#گام-۸-استقرار-روی-altare)
12. [گام ۹: استقرار با Docker](#گام-۹-استقرار-با-docker)
13. [اجرای تست‌ها](#اجرای-تستها)
14. [دستورات ربات](#دستورات-ربات)
15. [محدودیت‌های واقعی (بدون بزرگ‌نمایی)](#محدودیتهای-واقعی-بدون-بزرگنمایی)
16. [امنیت](#امنیت)
17. [ساختار پروژه](#ساختار-پروژه)
18. [عیب‌یابی](#عیبیابی)
19. [مستندات بیشتر](#مستندات-بیشتر)

---

## ویژگی‌ها

**آپلود**
- ارسال فایل/عکس/ویدیو/صدا از تلگرام → آپلود Resumable در Drive
- استریم کامل: فایل هیچ‌وقت به‌طور کامل در RAM بارگذاری نمی‌شود (حافظه مصرفی مستقل از حجم فایل)
- نمایش Progress Bar، درصد، سرعت و زمان تقریبی باقی‌مانده در یک پیام (بدون اسپم)
- جلوگیری از آپلود تکراری با هش SHA-256
- تأیید یکپارچگی پس از آپلود با MD5 که خود Drive برمی‌گرداند
- ادامه آپلود نیمه‌تمام بعد از قطعی/ری‌استارت (session URI در دیتابیس ذخیره می‌شود)
- تاریخچه کامل آپلودها با پوشه، Drive ID و لینک

**دانلود از لینک**
- لینک مستقیم HTTP/HTTPS، Google Drive، Dropbox، OneDrive، GitHub Releases/raw
- تشخیص نام و حجم فایل قبل از دانلود (HEAD + Content-Disposition)
- محافظت SSRF: بلاک IP خصوصی/لوپ‌بک/لینک-لوکال/متادیتای ابری، اعتبارسنجی مجدد هر Redirect، پین‌کردن IP در سطح اتصال TCP
- تشخیص صفحه ورود/کپچا و امتناع از ذخیره آن به‌عنوان فایل
- yt-dlp اختیاری (پیش‌فرض خاموش)

**مدیریت**
- `/folders` `/mkdir` `/rename` `/move` `/delete` `/search` `/recent` `/storage` `/stats` `/history` `/queue` `/settings`
- مرورگر پوشه با Inline Keyboard + انتخاب پوشه پیش‌فرض
- دسته‌بندی خودکار: `JB-DriveBot/Videos/2026/November` (قابل تنظیم: type-date / type / extension / date / none)
- جستجوی پیشرفته با زبان کوچک: `ext:pdf type:image size:>10mb after:2026-01-01`
- صفحات بعدی/قبلی با دکمه‌های امضاشده

**آرشیو**
- ساخت ZIP از چند فایل، استخراج ZIP
- محافظت در برابر Path Traversal، symlink، Zip Bomb و آرشیو با ورودی زیاد
- تأیید صریح قبل از استخراج

**عملیات و پایداری**
- صف پایدار در دیتابیس: اولویت، محدودیت هم‌زمانی، Retry با Exponential Backoff، لغو، بازیابی پس از ری‌استارت
- Idempotency Key برای جلوگیری از عملیات تکراری
- آمار واقعی از دیتابیس و Google Drive (بدون عدد ساختگی)

**امنیت**
- فقط `ADMIN_USER_IDS` دسترسی دارند؛ بقیه هیچ اطلاعاتی نمی‌گیرند
- تمام Callback Data با HMAC-SHA256 امضا و دارای انقضا هستند (دکمه جعلی/فوروارد‌شده کار نمی‌کند)
- Refresh Token با AES-256-GCM و کلید مشتق‌شده (HKDF) رمزنگاری می‌شود
- OAuth با PKCE (S256) + State + loopback callback روی `127.0.0.1`
- جفت‌سازی با کد یک‌بارمصرف، هش‌شده، دارای TTL و محدودیت تلاش
- اشتراک عمومی فقط با تأیید صریح؛ پیش‌فرض همه فایل‌ها خصوصی
- Redaction خودکار توکن‌ها در لاگ‌ها
- Rate Limiting روی همه به‌روزرسانی‌ها

---

## معماری در یک نگاه

```
┌──────────────────┐        HTTPS (همه تماس‌ها خروجی)         ┌─────────────────────┐
│  تلگرام (Bot API)│◀───────────────────────────────────────▶│                     │
└──────────────────┘        Long Polling                     │   JB-DriveBot       │
                                                             │   (Altare App)      │
┌──────────────────┐   کد جفت‌سازی + (اختیاری) توکن مهرشده    │                     │
│ JB-Drive         │────────────────────────────────────────▶│  ┌───────────────┐  │
│ Authenticator    │        POST /api/pair/complete           │  │ Fastify-like  │  │
│ (کامپیوتر شما)   │                                          │  │ node:http     │  │
└────────┬─────────┘                                          │  └───────────────┘  │
         │ loopback callback 127.0.0.1:8765                   │  ┌───────────────┐  │
         ▼                                                    │  │ Job Queue     │  │
┌──────────────────┐                                          │  │ (DB-backed)   │  │
│ مرورگر: Google   │◀─── کد مجوز + PKCE ─────────────────────▶│  └───────────────┘  │
│ OAuth 2.0        │                                          │  ┌───────────────┐  │
└──────────────────┘                                          │  │ SQLite/PG     │  │
                                                              │  └───────────────┘  │
                                                              └──────────┬──────────┘
                                                                         │ Drive API v3
                                                                         ▼
                                                              ┌─────────────────────┐
                                                              │  Google Drive شما   │
                                                              └─────────────────────┘
```

چرا Long Polling؟ چون روی Altare App Hosting فقط یک پورت عمومی دارید و همان پورت را سرویس جفت‌سازی می‌گیرد. Polling هیچ نیازی به دامنه/وب‌هوک/گواهی ندارد و از پشت هر پروکسی کار می‌کند. حالت Webhook هم پیاده‌سازی شده (روی همان پورت، مسیر `/telegram/webhook/<secret>`) اگر ترجیح می‌دهید.

جزئیات: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

---

## پیش‌نیازها

| مورد | نسخه | توضیح |
|---|---|---|
| Node.js | ۲۰ یا بالاتر | `node -v` |
| حساب Google | — | همان حسابی که Drive آن مدیریت می‌شود |
| ربات تلگرام | — | از BotFather |
| حساب Altare | — | `docs/ALTARE.md` |

```bash
git clone <repo> JB-DriveBot   # یا فایل‌ها را کپی کنید
cd JB-DriveBot
npm install
cp .env.example .env
chmod 600 .env
```

---

## گام ۱: ساخت ربات با BotFather

1. در تلگرام به [@BotFather](https://t.me/BotFather) پیام دهید.
2. `/newbot` → یک نام نمایشی (مثلاً `JB DriveBot`) و یک یوزرنیم یکتا (مثلاً `jb_drive_bot`) بدهید.
3. توکن را بگیرید؛ شکل آن: `123456789:AAH...` → در `.env`:

```env
TELEGRAM_BOT_TOKEN=123456789:AAH...
```

4. **آیدی عددی خودتان** را بگیرید (به [@userinfobot](https://t.me/userinfobot) پیام دهید یا بعد از اجرا `/id` بزنید) و تنظیم کنید:

```env
ADMIN_USER_IDS=123456789
```

> اگر چند آیدی با کاما بدهید، همه دسترسی مدیریتی دارند و **اولین آیدی مالک** است (پیام «اتصال موفق» برای او ارسال می‌شود).

5. اختیاری ولی مفید: در BotFather → `/setprivacy` → `Disable` تا ربات بتواند پیام‌های گروه را بخواند (برای استفاده شخصی لازم نیست). همچنین `/setcommands` تا منوی دستورات زیبا شود (ربات خودش در استارتاپ با `setMyCommands` این کار را می‌کند).

---

## گام ۲: پروژه Google Cloud و فعال‌سازی Drive API

1. برو به <https://console.cloud.google.com/> → **New Project** (مثلاً `jb-drivebot`).
2. **APIs & Services → Library** → جستجوی **Google Drive API** → **Enable**.
3. (برای خواندن ایمیل حساب در زمان اتصال) **Google People API** هم Enable کنید — اختیاری؛ کد بدون آن هم کار می‌کند و ایمیل را از `id_token` می‌خواند.
4. **APIs & Services → OAuth consent screen**:
   - User Type: **External** (مگر Workspace داشته باشید → Internal)
   - نام اپ، ایمیل پشتیبانی، ایمیل توسعه‌دهنده را پر کنید.
   - **Scopes**: همان اسکوپ‌هایی که در `docs/SCOPES.md` آمده را اضافه کنید (حداقل `.../auth/drive.file` و `openid` و `.../auth/userinfo.email`).
   - در حالت **Testing**، حساب Google خودتان را در **Test users** اضافه کنید. این کار لازم است وگرنه Google اجازه نمی‌دهد.
   - اگر اپ را در حالت Testing نگه دارید، Refresh Token بعد از ۷ روز باطل می‌شود. برای استفاده دائمی، اپ را **Publish** کنید (برای اپ شخصی با اسکوپ‌های حساس، ممکن است Google درخواست Verification بدهد؛ با `drive.file` معمولاً لازم نیست).

---

## گام ۳: ساخت OAuth Desktop Client

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. **Application type: Desktop app** ← مهم است. نوع «Web application» برای این معماری غلط است.
3. یک نام بدهید و بسازید. سپس:
   - **Client ID**: چیزی مثل `1234-abc.apps.googleusercontent.com`
   - **Client Secret**: چیزی مثل `GOCSPX-...`

```env
GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

> در OAuth نوع Desktop، Client Secret «محرمانه» محسوب نمی‌شود (Google خودش این را می‌گوید) اما باز هم آن را در Git نگذارید. Redirect URI لازم نیست دستی ثبت شود؛ Google برای Desktop فقط `http://127.0.0.1:<پورت>` را می‌پذیرد و همین چیزی است که این پروژه استفاده می‌کند. **توجه:** `http://localhost` پذیرفته نمی‌شود؛ حتماً `127.0.0.1` باشد.

---

## گام ۴: اجرای ابزار JB-Drive Authenticator

این ابزار **روی کامپیوتر خودتان** اجرا می‌شود، نه روی Altare. دلیلش ساده است: Callback گوگل به `127.0.0.1` می‌رود و `127.0.0.1` روی سرور Altare، خودِ سرور است نه مرورگر شما. پس کد مجوز را باید همان‌جا که مرورگر باز می‌شود تحویل بگیریم.

### روش کار

1. در تلگرام `/connect` بزنید → ربات یک **کد یک‌بارمصرف** مثل `K7QP-3MZX` می‌دهد و دستور آماده را نشان می‌دهد.
2. روی کامپیوتر خودتان (با Node 20+):

```bash
npx tsx auth-local/src/cli.ts --server https://your-app.altare.app --code K7QP-3MZX
```

3. ابزار:
   - `/api/pair/prepare` را صدا می‌زند تا Client ID و اسکوپ‌های موردانتظار را از سرور بگیرد.
   - یک سرور HTTP روی `127.0.0.1:8765` بالا می‌آورد.
   - مرورگر پیش‌فرض را باز می‌کند.
4. حساب Google را انتخاب و دسترسی را تأیید می‌کنید.
5. گوگل شما را به `http://127.0.0.1:8765/oauth2callback?code=...&state=...` برمی‌گرداند.
6. ابزار `state` را با مقدار اصلی مقایسه می‌کند (ضد CSRF) و کد + `code_verifier` را روی TLS به سرور می‌فرستد.
7. **سرور** با Google تبادل می‌کند، Refresh Token را رمزنگاری و ذخیره می‌کند، پوشه `JB-DriveBot` را می‌سازد و در تلگرام پیام «متصل شد» می‌فرستد.
8. در تلگرام `/status` بزنید.

### دو حالت انتقال

| حالت | توضیح | توصیه |
|---|---|---|
| `server-exchange` (پیش‌فرض) | تبادل کد روی سرور انجام می‌شود؛ Refresh Token **هیچ‌وقت** از کامپیوتر شما خارج نمی‌شود | ✅ همین را استفاده کنید |
| `local-exchange` | تبادل روی کامپیوتر شما انجام می‌شود و Refresh Token مهرشده (AES-256-GCM با کلید مشتق از کد جفت‌سازی) به سرور می‌رسد. `--client-secret` لازم دارد | اگر سیاست شما «تبادل محلی» است |

```bash
# حالت محلی
npx tsx auth-local/src/cli.ts --server https://... --code XXXX-XXXX \
  --mode local-exchange --client-secret GOCSPX-...
```

### گزینه‌های ابزار

```
--server <url>        آدرس سرویس ربات (اجباری)
--code <code>         کد یک‌بارمصرف (اجباری)
--port <n>            پورت Callback (پیش‌فرض 8765)
--mode <mode>         server-exchange | local-exchange
--client-id <id>      اگر لازم شد
--client-secret <s>   فقط برای local-exchange
--allow-insecure      اجازه http فقط برای 127.0.0.1 (تست محلی)
--no-browser          لینک را چاپ کن
--check               فقط بررسی دسترسی به سرور
--help
```

> ابزار **هیچ توکنی را چاپ، ذخیره یا لاگ نمی‌کند**. فقط پیام موفقیت و ایمیل حساب را نشان می‌دهد.

### قطع و اتصال مجدد

- `/disconnect` → تأیید → توکن روی سرور حذف و از سمت Google هم revoke می‌شود. فایل‌های Drive دست‌نخورده می‌مانند.
- سپس دوباره `/connect` و ابزار محلی.
- اگر می‌خواهید دسترسی را دستی ببندید: <https://myaccount.google.com/permissions>

---

## گام ۵: متغیرهای محیطی

فایل کامل با توضیح در [`.env.example`](.env.example) است. حداقلِ لازم:

```env
NODE_ENV=production
TELEGRAM_BOT_TOKEN=...
ADMIN_USER_IDS=123456789
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
APP_ENCRYPTION_KEY=<openssl rand -base64 32>
PUBLIC_BASE_URL=https://your-app.altare.app
```

ساخت کلید رمزنگاری:

```bash
openssl rand -base64 32
```

> ⚠️ `APP_ENCRYPTION_KEY` را گم نکنید. بدون آن، Refresh Token ذخیره‌شده قابل بازگشایی نیست و باید از نو `/connect` کنید. آن را در یک Password Manager نگه دارید. تغییر آن = قطع اتصال Google.

بررسی صحت پیکربندی بدون اجرای ربات:

```bash
npm run smoke
```

خروجی مطلوب: `12/12 checks passed`.

---

## گام ۶: راه‌اندازی دیتابیس

### گزینه A — SQLite (پیش‌فرض، ساده)

هیچ کاری لازم نیست؛ فایل در `data/jb-drivebot.sqlite` ساخته می‌شود.

```env
DB_DRIVER=sqlite
SQLITE_PATH=./data/jb-drivebot.sqlite
```

مزیت: صفر پیکربندی. ریسک: اگر روی پلتفرم شما دیسک بین دیپلوی‌ها پاک شود، تاریخچه/صف از بین می‌رود (خود فایل‌های Drive سالم‌اند).

### گزینه B — PostgreSQL (توصیه‌شده برای Altare)

Altare دیتابیس Postgres مدیریت‌شده دارد (در پلن رایگان: ۲۵۶MB RAM / ۱GB دیسک). یک دیتابیس بسازید و Connection String را بگیرید:

```env
DB_DRIVER=postgres
DATABASE_URL=postgres://user:pass@host:5432/db?sslmode=require
```

مهاجرت‌ها (Migration) در اولین استارت خودکار اجرا می‌شوند. برای اجرای دستی:

```bash
npm run migrate
```

فایل‌های SQL خام هم موجود است: `migrations/sqlite/001_init.sql` و `migrations/postgres/001_init.sql` (یک تست تضمین می‌کند با کد هم‌خوان باشند).

> تفاوت رفتاری دو درایور: SQLite تک‌پروسه‌ای است (مناسب همین ربات)، Postgres چند اتصال هم‌زمان می‌دهد. کد برای هر دو یکی است؛ فقط `claim` صف در SQLite داخل تراکنش `BEGIN IMMEDIATE` قفل می‌شود.

---

## گام ۷: اجرای محلی

```bash
# 1) بررسی پیکربندی و سیم‌کشی کل سیستم (بدون تلگرام و گوگل)
npm run smoke

# 2) اجرا در حالت توسعه
npm run dev

# 3) یا ساخت و اجرای نسخه production
npm run build && npm start
```

برای اتصال محلی، `PUBLIC_BASE_URL` را `http://127.0.0.1:8080` بگذارید و ابزار محلی را با `--allow-insecure` اجرا کنید:

```bash
npx tsx auth-local/src/cli.ts --server http://127.0.0.1:8080 --code XXXX-XXXX --allow-insecure
```

> `--allow-insecure` فقط برای `127.0.0.1` و `localhost` و فقط بیرون از `NODE_ENV=production` کار می‌کند.

---

## گام ۸: استقرار روی Altare

خلاصه‌ی بررسی مستندات رسمی (جزئیات و منابع در [`docs/ALTARE.md`](docs/ALTARE.md)):

- **App Hosting**: اپ را از GitHub دیپلوی می‌کند، Node.js/Bun/Python/Go را اجرا می‌کند، لاگ و cron دارد. اپ باید روی `0.0.0.0:$PORT` گوش بدهد و TLS را پلتفرم تأمین می‌کند. ← **همین را برای این پروژه انتخاب کرده‌ایم.**
- **Sandboxes / Altare Go**: برای Docker مناسب نیستند (Go موقتی/ephemeral است) و برای یک ربات ۲۴/۷ گزینه درستی نیستند.
- **Docker Apps** وجود دارد، ولی برای این پروژه لازم نیست؛ فقط اگر بخواهید yt-dlp/ffmpeg داشته باشید جذاب می‌شود.
- **Postgres مدیریتی** موجود است (توصیه‌شده برای صف/تاریخچه).
- **پلن رایگان**: ۶GB RAM، ۱۵۰٪ CPU، ۱۰GB دیسک، ۴ سرور، ۱۰GB آبجکت استوریج (U3)، Postgres ۲۵۶MB/۱GB.

### مراحل

1. کد را در یک ریپوی GitHub بگذارید (`.env` را **نه**؛ در `.gitignore` هست).
2. در کنسول Altare → **App Hosting** → **New App** → ریپو و برنچ را وصل کنید.
3. تنظیمات build/start:
   - Install: `npm ci`
   - Build: `npm run build`
   - Start: `npm start`  (یعنی `node dist/src/index.js`)
   - Port: `8080` (پلتفرم `PORT` را تزریق می‌کند؛ کد از همان استفاده می‌کند)
4. **Environment Variables** را در کنسول اضافه کنید (همان کلیدهای `.env.example`). حداقل‌ها:
   `NODE_ENV`, `TELEGRAM_BOT_TOKEN`, `ADMIN_USER_IDS`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_ENCRYPTION_KEY`, `PUBLIC_BASE_URL`, `DB_DRIVER`, `DATABASE_URL` (اگر Postgres).
5. دامنه عمومی اپ را بردارید (مثل `https://jb-drivebot.altare.app`) و `PUBLIC_BASE_URL` را همان بگذارید. **این مقدار باید HTTPS باشد تا ابزار محلی حاضر به ارسال کد جفت‌سازی شود.**
6. دیپلوی کنید. لاگ‌ها: `starting JB-DriveBot` و `http server listening` و `started long polling`.
7. سلامت: `curl https://<app>/health` → `{"ok":true,...}`
8. `/connect` در تلگرام و اجرای ابزار محلی روی کامپیوتر خودتان.

### درباره فضای پایدار

Altare برای App Hosting دیسک پایدار ارائه می‌دهد، اما مستندات در بعضی محصولات هشدار می‌دهد که «فرض نکنید فایل‌سیستم کانتینر بین دیپلوی‌ها می‌ماند». بنابراین:

- **داده‌ی حیاتی (توکن‌ها، صف، تاریخچه) را در Postgres مدیریتی نگه دارید** (گزینه B بالا).
- دیسک محلی فقط برای فایل‌های موقت (که ماهیتاً دورریختنی هستند) و بکاپ استفاده می‌شود.
- فایل‌های واقعی شما همیشه در Google Drive هستند، نه روی سرور. یعنی حتی اگر کل سرور پاک شود، هیچ فایل کاربری از دست نمی‌رود.

---

## گام ۹: استقرار با Docker

```bash
cp .env.example .env   # پر کنید (DB_DRIVER=postgres)
docker compose up -d --build
docker compose logs -f app
```

- ایمیج multi-stage است، با کاربر غیر root (`node`) اجرا می‌شود و `tini` برای shutdown درست دارد.
- `HEALTHCHECK` روی `/health` تنظیم شده.
- yt-dlp/ffmpeg به‌صورت پیش‌فرض نصب **نمی‌شوند** (حجم ایمیج دو برابر می‌شود). برای فعال‌سازی، خط مربوطه در `Dockerfile` را از کامنت خارج کنید و `ENABLE_YTDLP=true` بگذارید.

---

## اجرای تست‌ها

```bash
npm test              # همه تست‌ها
npm run test:unit
npm run test:integration
npm run typecheck     # tsc --noEmit
npm run smoke         # بوت واقعی سیستم بدون تلگرام/گوگل
```

پوشش تست (۱۶۱ تست):

| فایل | چه چیزی را واقعاً تست می‌کند |
|---|---|
| `unit/crypto` | رمزنگاری AES-GCM، جداسازی کلید، تشخیص دستکاری، امضای Callback و انقضا |
| `unit/ssrf` | بلاک لیست IP، متادیتای ابری، DNS rebinding، پین‌کردن آدرس در زمان اتصال |
| `unit/classify` | دسته‌بندی، الگوهای پوشه، Smart Rename، MIME |
| `unit/sanitize` | Path traversal، نام‌های مخرب، کاراکترهای کنترلی |
| `unit/rate-limit` | Token bucket و Backoff |
| `unit/search-parse` | زبان جستجو و ساخت `q` امن |
| `unit/pairing-compat` | سازگاری بایت‌به‌بایت ابزار محلی و سرور |
| `integration/database` | مهاجرت، همه ریپازیتوری‌ها، Idempotency، بازیابی Job |
| `integration/queue` | اجرا، هم‌زمانی، اولویت، Retry، لغو، بازیابی پس از کرش |
| `integration/drive-upload` | پروتکل Resumable واقعی (initiate → 308 → resume → 200)، MD5، Abort |
| `integration/download` | دانلود واقعی روی HTTP، Redirect، SSRF، HTML جعلی، سقف حجم |
| `integration/zip` | ساخت/استخراج، traversal، symlink، Zip Bomb واقعی (نسبت فشرده‌سازی) |
| `integration/oauth-pairing` | **کل جریان OAuth**: PKCE، State، تبادل کد، ذخیره رمزنگاری‌شده، مصرف یک‌بار‌مصرف کد |
| `integration/transfer` | خط لوله آپلود: پوشه‌سازی، دسته‌بندی، Dedupe، ثبت در تاریخچه و آمار |
| `integration/boot` | **نقطه ورود production**: بوت واقعی، `/health`، Long Polling، redaction توکن، خاموشی تمیز با SIGTERM |

تست‌ها با سرور جعلی Drive/Google کار می‌کنند؛ اینکه چرا و چه چیزی پوشش داده **نمی‌شود** در [`docs/STATUS.md`](docs/STATUS.md) توضیح داده شده است.

---

## دستورات ربات

| دستور | کار |
|---|---|
| `/start` `/menu` | منوی اصلی با دکمه‌های Inline |
| `/connect` | کد جفت‌سازی یک‌بارمصرف + دستور ابزار محلی |
| `/disconnect` | قطع اتصال Google (با تأیید) |
| `/status` | وضعیت اتصال، سطح دسترسی، صف |
| `/folders` | مرور پوشه‌ها با دکمه |
| `/mkdir نام` یا `/mkdir a/b` | ساخت پوشه (تودرتو) |
| `/search عبارت` | جستجو با فیلتر (`ext:` `type:` `size:` `after:` `before:`) |
| `/recent` | آخرین فایل‌ها |
| `/storage` | فضای حساب، بزرگ‌ترین/قدیمی‌ترین فایل‌ها، تکراری‌ها |
| `/stats` | آمار کامل |
| `/history` | تاریخچه آپلود |
| `/queue` | صف عملیات + لغو با دکمه |
| `/cancel` | لغو عملیات در حال اجرا |
| `/delete نام` | حذف با تأیید (به سطل زباله) |
| `/rename قدیمی \| جدید` | تغییر نام |
| `/move نام` | انتقال با انتخاب پوشه |
| `/get نام` | ارسال فایل از Drive به تلگرام |
| `/extract نام` | استخراج ZIP (با تأیید) |
| `/zip` | ساخت آرشیو از فایل‌های انتخاب‌شده |
| `/organize` / `/organize run` | پیش‌نمایش / اجرای مرتب‌سازی |
| `/dupes` | فایل‌های تکراری بر اساس هش |
| `/backup` | پشتیبان‌گیری JSON (بدون توکن) |
| `/cleanup` | پاک‌سازی فایل‌های موقت |
| `/settings` | تنظیمات با دکمه |
| `/help` `/id` | راهنما / نمایش آیدی |

**روش‌های آپلود:** فایل را بفرستید · لینک بفرستید · روی پیامی که لینک دارد **Reply** کنید و چیزی بنویسید.

---

## محدودیت‌های واقعی (بدون بزرگ‌نمایی)

این‌ها محدودیت‌های خودِ سرویس‌دهنده‌ها هستند، نه انتخاب ما. همه بررسی شده‌اند و راه‌حل واقعی دارند:

### ۱) دریافت فایل از تلگرام: ۲۰ مگابایت

Bot API ابری اجازه نمی‌دهد ربات فایل بزرگ‌تر از **۲۰MB** را دانلود کند. این محدودیت در سطح خود تلگرام است و با هیچ تنظیمی در کد ما تغییر نمی‌کند. سه راه:

1. **لینک بفرستید**: مسیر دانلود از لینک اصلاً از Bot API رد نمی‌شود؛ سقف آن `MAX_LINK_DOWNLOAD_BYTES` است (پیش‌فرض ۴GB).
2. **Local Bot API Server** راه بیندازید ([telegram-bot-api](https://github.com/tdlib/telegram-bot-api)) و `TELEGRAM_API_ROOT` را به آن بدهید → سقف دانلود به **۲۰۰۰MB** می‌رسد. کد برای این کار آماده است (فقط متغیر محیطی)، اما خودِ سرور را باید خودتان راه بیندازید؛ روی پلن رایگان Altare و بدون آیدی/هش API تلگرام ممکن نیست.
3. فایل را در Drive خودتان بگذارید و از آنجا با ربات مدیریت کنید.

### ۲) ارسال فایل به تلگرام: ۵۰ مگابایت

برای `/get` و دکمه «ارسال به تلگرام». بالاتر از آن، ربات پیام می‌دهد و شما از لینک Drive استفاده می‌کنید. با Local Bot API Server تا ۲۰۰۰MB می‌شود.

### ۳) اسکوپ Drive

با `drive.file` (پیش‌فرض) ربات فقط فایل‌های **ساخته‌شده توسط خودش** را می‌بیند. یعنی «My Drive» فقط پوشه `JB-DriveBot` و محتوای آن را نشان می‌دهد، نه کل Drive شما. برای دیدن/جستجوی کل Drive و آمار فضای حساب، `GOOGLE_SCOPES_MODE=readonly`، و برای تغییر/حذف فایل‌های قدیمی، `full`. تفصیل کامل: [`docs/SCOPES.md`](docs/SCOPES.md).

ربات این وضعیت را تشخیص می‌دهد: اگر قابلیتی با اسکوپ فعلی ممکن نباشد، پیام روشن می‌دهد (مثلاً «برای مشاهده فضای حساب به دسترسی drive نیاز است»).

### ۴) دانلود ویدیو (yt-dlp)

پیش‌فرض **خاموش** است. دلایل: باینری باید در ایمیج باشد، `ffmpeg` لازم است، و قانونی/شرایط سرویس سایت مقصد را باید خودتان بررسی کنید. اگر می‌خواهید فعال کنید: `ENABLE_YTDLP=true` و باینری‌ها را در ایمیج نصب کنید.

### ۵) Altare و دیسک

جزئیات و توصیه‌های پایداری در `docs/ALTARE.md`. خلاصه: برای داده‌ی مهم از Postgres مدیریتی استفاده کنید، فایل‌های موقت را دورریختنی بدانید.

---

## امنیت

خلاصه؛ کامل در [`docs/SECURITY.md`](docs/SECURITY.md):

- **فقط مالک**: هر به‌روزرسانی از کاربر غیرمجاز بدون هیچ اطلاعاتی رد می‌شود (حتی پیام خطا).
- **Callback امضاشده**: هر دکمه `payload|exp|HMAC` دارد؛ دکمه قدیمی یا جعلی رد می‌شود. TTL پیش‌فرض ۱۵ دقیقه.
- **توکن‌ها**: Refresh Token و Access Token با AES-256-GCM، کلید جداگانه به ازای هر نوع داده (HKDF)، با AAD. در دیتابیس هرگز به‌صورت متن نیست.
- **کدهای جفت‌سازی**: فقط هش ذخیره می‌شود، TTL ۱۰ دقیقه، یک‌بارمصرف، حداکثر ۵ تلاش، Rate Limit روی IP.
- **OAuth**: PKCE S256 + State + فقط loopback روی `127.0.0.1`. هیچ‌وقت `client_secret` به مرورگر نمی‌رود.
- **SSRF**: بلاک لیست کامل + اعتبارسنجی مجدد هر Redirect + کنترل IP در سطح اتصال (DNS rebinding).
- **مخرب‌ها**: حذف/عمومی‌کردن فقط با تأیید صریح + ثبت در Audit Log. هیچ فایلی خودکار عمومی نمی‌شود.
- **ZIP**: Path traversal، symlink، نسبت فشرده‌سازی و تعداد ورودی‌ها کنترل می‌شود.
- **لاگ**: توکن، کد، `code_verifier` و Authorization به‌صورت خودکار `[REDACTED]` می‌شوند.
- **Rate Limiting**: Token bucket روی هر کاربر.

---

## ساختار پروژه

```
JB-DriveBot/
├── src/
│   ├── index.ts                 نقطه ورود (polling/webhook + HTTP + صف)
│   ├── config/                  اعتبارسنجی env با zod
│   ├── utils/                   لاگر با redaction، بایت/سرعت، backoff، خطاها، id
│   ├── security/                crypto (AES-GCM/HKDF)، signer، SSRF، rate limit، sanitize
│   ├── database/                درایور dual (sqlite|postgres)، schema، repositories
│   ├── oauth/                   PKCE، تبادل/تمدید/revoke، TokenManager، اسکوپ‌ها
│   ├── google-drive/            کلاینت REST + Resumable Upload + دانلود استریمی + دسترسی‌ها
│   ├── downloader/              resolve لینک‌ها، دانلود ضد-SSRF، yt-dlp اختیاری
│   ├── uploader/                منبع فایل تلگرام (استریم + هش)
│   ├── services/                context، خط لوله انتقال، folders، search، progress، temp
│   ├── queue/                   صف پایدار + هندلرهای job
│   ├── organizer/               دسته‌بندی و الگوی پوشه
│   ├── archive/                 ZIP با محافظت‌ها
│   ├── bot/ views/ keyboards/   UI، منوها، رفرنس‌های کوتاه، فرمت پیام
│   ├── commands/ handlers/      دستورات و هندلرهای پیام/Callback
│   └── server/                  endpoint جفت‌سازی (node:http)
├── auth-local/                  ابزار مستقل JB-Drive Authenticator
├── migrations/{sqlite,postgres} SQL خام (هم‌خوان با کد)
├── tests/{unit,integration}     ۱۶۱ تست
├── scripts/                     smoke، migrate، sync-schema
├── docs/                        معماری، Altare، امنیت، اسکوپ، بهره‌برداری، وضعیت
├── Dockerfile · docker-compose.yml · .env.example
```

---

## عیب‌یابی

| نشانه | علت و راه‌حل |
|---|---|
| `Invalid configuration: ... is required` | یک متغیر env خالی است. `npm run smoke` می‌گوید کدام. |
| ربات به هیچ پیامی جواب نمی‌دهد | `ADMIN_USER_IDS` اشتباه است (آیدی عددی، نه یوزرنیم). با `/id` یا @userinfobot چک کنید. |
| `/connect` می‌گوید «سرویس جفت‌سازی فعال نیست» | `ENABLE_PAIRING_SERVER=true` و پورت باز باشد. `curl https://<app>/health` |
| ابزار محلی: `زمان انتظار ... تمام شد` | مرورگر باز نشد یا پورت ۸۷۶۵ اشغال است. `--no-browser` و `--port` دیگر. |
| `state mismatch` | دو پنجره/دو تلاش هم‌زمان؛ یا افزونه مرورگر. یک‌بار دیگر تلاش کنید. |
| `no_refresh_token` | دسترسی قبلی هنوز فعال است. در myaccount.google.com/permissions حذف کنید و دوباره `/connect`. |
| `reauth_required` بعد از چند روز | اپ Google Cloud در حالت **Testing** است (Refresh Token بعد از ۷ روز باطل می‌شود). اپ را Publish کنید. |
| `برای مشاهده فضای حساب به دسترسی drive نیاز است` | اسکوپ `file` است؛ `GOOGLE_SCOPES_MODE=readonly` و اتصال مجدد. |
| `حجم فایل از سقف دریافت بیشتر است` | محدودیت ۲۰MB تلگرام. لینک بفرستید یا Local Bot API Server. |
| `سرور به‌جای فایل صفحه HTML برگرداند` | لینک، دانلود مستقیم نیست (صفحه ورود/تأیید). لینک مستقیم لازم است. |
| `این لینک پشتیبانی نمی‌شود` | پوشه Drive یا صفحه HTML است. لینک فایل بفرستید. |
| `code_used` / `code_expired` | کد یک‌بارمصرف/۱۰ دقیقه است. `/connect` دوباره. |
| آپلود نیمه‌کاره ماند | خودش Retry می‌شود و از همان نقطه ادامه می‌دهد. `/queue` را ببینید. |
| `reference ... expired` روی دکمه | دکمه‌ها ۱ ساعت زنده‌اند. فایل را دوباره باز کنید. |
| دیسک پر شد | `/cleanup` و `TEMP_QUOTA_BYTES` را تنظیم کنید. |

لاگ‌ها JSON هستند و در Altare از پنل اپ دیده می‌شوند. برای دیباگ موقت: `LOG_LEVEL=debug`.

---

## مستندات بیشتر

| فایل | محتوا |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | تصمیم‌های معماری، جریان داده، مدل داده، چرا هر انتخاب |
| [`docs/ALTARE.md`](docs/ALTARE.md) | بررسی مستندات Altare، محدودیت‌ها، بهترین topology، دیپلوی گام‌به‌گام |
| [`docs/SECURITY.md`](docs/SECURITY.md) | مدل تهدید، کنترل‌ها، چک‌لیست بهره‌برداری |
| [`docs/SCOPES.md`](docs/SCOPES.md) | مقایسه دقیق `drive.file` / `drive.readonly` / `drive` |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | بکاپ، مانیتورینگ، لاگ، روتین نگهداری، بازیابی |
| [`docs/TESTING.md`](docs/TESTING.md) | چه تستی چه چیزی را اثبات می‌کند |
| [`docs/STATUS.md`](docs/STATUS.md) | **گزارش صادقانه: پیاده‌سازی‌شده / تست‌شده / تست‌نشده** |

---

## مجوز و مسئولیت

این پروژه برای استفاده شخصی ساخته شده است. مسئولیت رعایت قوانین، شرایط سرویس Google و تلگرام، و محتوایی که آپلود/دانلود می‌کنید با شماست. هیچ فایلی به‌صورت خودکار حذف یا عمومی نمی‌شود؛ تمام عملیات مخرب نیازمند تأیید صریح شما هستند.
