# معماری JB-DriveBot

## ۱. تصمیم‌های اصلی و دلیلشان

| تصمیم | انتخاب | چرا |
|---|---|---|
| زبان | TypeScript strict | نوع‌ها در کدی که پول/فایل کاربر را جابه‌جا می‌کند، جلوی کلاس‌های کاملی از باگ را می‌گیرند |
| کتابخانه ربات | **grammY** | تایپ‌های دقیق، پشتیبانی رسمی از `apiRoot` سفارشی (برای Local Bot API Server)، middleware تمیز |
| کلاینت Drive | **fetch خام + REST** | کنترل کامل روی Resumable Upload، chunk، Range، جریان استریم و خطاها. کتابخانه `googleapis` برای این نیازها abstraction اضافی و حافظه‌ی بیشتری تحمیل می‌کرد |
| انتقال ربات | **Long Polling** | یک پورت عمومی روی Altare داریم و همان را سرویس جفت‌سازی می‌گیرد؛ polling نه دامنه لازم دارد نه وب‌هوک. Webhook هم پیاده شده (روی همان پورت) |
| دیتابیس | **dual: SQLite / PostgreSQL** | SQLite برای شروع و تست بدون زیرساخت؛ Postgres مدیریتی Altare برای پایداری داده‌ی حیاتی |
| صف | **داخلی، مبتنی بر دیتابیس** | بدون Redis هم کار می‌کند، وضعیت در DB می‌ماند و بعد از ری‌استارت بازیابی می‌شود. برای یک اپراتور کافی است |
| رمزنگاری | **AES-256-GCM + HKDF** | AEAD استاندارد با کلید جدا برای هر نوع داده (توکن، کلید انتقال جفت‌سازی، امضای callback) |
| ابزار OAuth | **CLI مستقل بدون هیچ dependency** | باید روی لپ‌تاپ با فقط Node اجرا شود؛ اگر وابسته به کد سرور باشد، عملاً غیرقابل‌استفاده می‌شود |

## ۲. چرا Callback محلی جدا از سرور است

Google برای OAuth نوع *Desktop* فقط loopback را می‌پذیرد: `http://127.0.0.1:PORT/oauth2callback`.
اگر این سرور روی Altare بالا بیاید، `127.0.0.1` **سرور Altare** است، نه کامپیوتر شما؛ پس کد مجوز هیچ‌وقت به دست ربات نمی‌رسد. پس:

- **کد مجوز** در ابزار محلی گرفته می‌شود (سرور HTTP روی `127.0.0.1`).
- **تبادل کد** (در حالت پیش‌فرض) روی سرور انجام می‌شود؛ یعنی Refresh Token هیچ‌وقت روی کامپیوتر شما ذخیره یا ارسال نمی‌شود.
- ارتباط ابزار↔سرور روی HTTPS و با کد یک‌بارمصرف انجام می‌شود.

## ۳. جریان‌های اصلی

### آپلود از تلگرام
```
Telegram update (document)
  └─ auth + rate limit + size gate        (بدون تماس شبکه)
     └─ enqueue job upload_telegram (idempotency: file_unique_id)
        └─ worker:
           1) stream: api.telegram.org/file → tmp  (SHA-256 در همان عبور)
           2) temp quota check (پیش از اولین بایت)
           3) transferToDrive:
              a) dedupe با hash → اگر در Drive موجود است، پایان
              b) resolveDestination → ensurePath(root/Category/Year/Month)
              c) resumable upload (chunk = 8MB، حافظه مستقل از حجم فایل)
                 └─ session URI در DB ذخیره می‌شود (برای ازسرگیری)
              d) بررسی MD5 برگشتی Drive
              e) ثبت در uploads + آمار
           4) unlink فایل موقت
           5) ویرایش یک پیام وضعیت (نه ارسال چند پیام)
```

### دانلود از لینک
```
text contains URL (یا Reply به پیامی که URL دارد)
  └─ resolveLink → provider (direct/drive/dropbox/onedrive/github)
     └─ probe (HEAD) → نام/حجم/نوع  ← پیش از دانلود نمایش داده می‌شود
        └─ job download_link:
           1) SSRF validate → پین IP → GET با lookup گاردشده
           2) هر Redirect از نو validate می‌شود (حداکثر ۵)
           3) استریم به دیسک با سقف حجم و progress
           4) تشخیص HTML (صفحه ورود/کپچا) → خطای روشن
           5) transferToDrive (همان مسیر آپلود)
           6) پاک‌سازی فایل موقت
```

### ازسرگیری پس از ری‌استارت
```
job.status = running  ← پروسه مرد
boot → recoverOrphans() → status = queued
     → worker دوباره شروع می‌کند
     → upload.resume: PUT با Content-Range: bytes */total
       → 308 + Range → offset شناخته می‌شود → ادامه از همان‌جا
```

## ۴. مدل داده

```
accounts(id, email, scopes, refresh_token_enc, access_token_enc, access_token_expires_at,
         root_folder_id, status, connected_at, updated_at)

uploads(id, drive_file_id, name, size, mime, extension, folder_id, folder_path,
        sha256, source, source_ref, web_link, status, uploaded_at, duration_ms,
        budget_bytes, seq)                          ← seq برای ترتیب قطعی

jobs(id, type, priority, status, payload, idempotency_key, attempts, max_attempts,
     run_at, started_at, finished_at, last_error, progress, message,
     cancel_requested, result, session_uri, resume_offset, created_by, created_at, updated_at)

settings(key, value, updated_at)
pairing_codes(id, code_hash, created_by, created_at, expires_at, used_at, attempts, mode, transfer_key_enc)
audit_log(id, actor, action, target, meta, created_at, seq)
stats_daily(day, uploads, bytes_uploaded, downloads, bytes_downloaded, successes, failures)
```

نکات:
- هیچ ستونی توکن خام ندارد؛ فقط `*_enc`.
- زمان‌ها همه `BIGINT` (میلی‌ثانیه) هستند تا مقایسه و ایندکس در هر دو دیالکت یکسان باشد.
- `SQL` با placeholder `?` نوشته می‌شود و برای Postgres به `$n` ترجمه می‌شود (تست دارد).

## ۵. صف

- `claimNext()` داخل تراکنش: `SELECT` کاندید → `UPDATE ... WHERE status='queued'`؛ اگر `changes=0` یعنی کس دیگری برداشت. در SQLite با `BEGIN IMMEDIATE`.
- ترتیب: `priority DESC, created_at ASC`.
- هم‌زمانی per-type (`upload: 2`, `download: 2`, `other: 1`).
- Retry: فقط خطاهای گذرا (`ECONNRESET`, `429`, `5xx`, `EAGAIN`, …) با backoff نمایی و jitter.
- Timeout: اگر job از `JOB_TIMEOUT_MS` بگذرد، `cancel_requested` ست می‌شود و هندلر در next checkpoint می‌ایستد.
- انواع job: `upload_telegram`, `download_link`, `zip_create`, `zip_extract`, `organize`, `backup`, `cleanup`.

## ۶. استریم و حافظه

- آپلود: هر بار حداکثر یک chunk (پیش‌فرض ۸MB) خوانده می‌شود؛ هرگز کل فایل در RAM نیست.
- دانلود: `pipeline(response → meter → file)` با سقف حجم و abort.
- ZIP: `archiver` استریمی؛ استخراج `yauzl` با `lazyEntries`.
- سقف دیسک موقت: `TEMP_QUOTA_BYTES` با رزرو پیش از نوشتن و پاک‌سازی خودکار.

## ۷. UI تلگرام

- `callback_data` سقف ۶۴ بایت دارد، ولی Drive file id ‏۳۳–۴۴ کاراکتر است. پس **handlهای تصادفی ۶ کاراکتری** (`RefStore`، TTL ۱ ساعت) نگه می‌داریم و هر دکمه فقط به آن اشاره می‌کند. یک دکمه جعلی هم نمی‌تواند به فایل دلخواه اشاره کند.
- هر `callback_data` با HMAC امضا و دارای انقضاست (پیش‌فرض ۱۵ دقیقه).
- وضعیت عملیات با **ویرایش یک پیام** (throttle ۲.۵ ثانیه) نمایش داده می‌شود، نه ارسال پیام جدید.
- منوها: `views.ts` منبع واحد رندر هستند تا دکمه‌ها و دستورها همیشه یک چیز نشان دهند.

## ۸. خطاها

- خطاهای دامنه‌ای با `AppError(code, message, {retryable})`.
- پیام‌های Persian برای کاربر (قابل‌فهم، بدون stack).
- جزئیات فنی در لاگ JSON با redaction.
- هیچ‌جا `process.exit` وسط کار نیست؛ shutdown با SIGTERM/SIGINT مرتب انجام می‌شود (jobهای در حال اجرا `running` می‌مانند و در بوت بعدی requeue می‌شوند).
