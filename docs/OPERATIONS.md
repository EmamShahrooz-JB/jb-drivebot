# بهره‌برداری و نگهداری

## وضعیت و پایش

```bash
curl -s https://<app>/health
# {"ok":true,"service":"jb-drivebot","uptime":1234}
```
در تلگرام: `/status` (اتصال، اسکوپ، صف) و `/stats` (آمار امروز/ماه + فضای حساب).

لاگ‌ها JSON تک‌خطی هستند (`ts`, `level`, `msg`, `err`, `jobId`, …) و هیچ توکنی داخلشان نیست. سطوح: `LOG_LEVEL=trace|debug|info|warn|error`.

رویدادهای مهم: `job succeeded`, `job failed permanently`, `job failed, will retry`, `pairing completed`, `google access token refreshed`, `duplicate upload skipped`, `temp space purged`.

## بکاپ

| داده | روش |
|---|---|
| فایل‌ها | خودِ Google Drive (خارج از این سیستم) |
| دیتابیس | Postgres مدیریتی Altare بکاپ شبانه دارد |
| تنظیمات/تاریخچه | `/backup` → یک JSON در Drive می‌سازد (**بدون** Refresh Token و بدون کد جفت‌سازی) |
| کلید رمزنگاری | فقط در Password Manager شما |

> بکاپ JSON عمداً توکن ندارد؛ پس بازیابی روی نصب جدید نیاز به `/connect` مجدد دارد. این ویژگی است، نه نقص.

## روتین پیشنهادی

- **روزانه**: `/stats` را یک نگاه بیندازید.
- **هفتگی**: `/queue` (jobهای `failed`)، `/dupes` (نسخه‌های تکراری).
- **ماهانه**: `/storage`، `/cleanup`، بررسی myaccount.google.com/permissions.
- **هر بار تغییر اسکوپ**: `/disconnect` → `/connect`.

ربات خودش هر ۶ ساعت job `cleanup` می‌سازد: پاک‌سازی فایل موقت > ۶ ساعت، حذف jobهای تمام‌شده > ۳۰ روز، حذف کدهای جفت‌سازی منقضی.

## تنظیمات (در `/settings`)

| تنظیم | پیش‌فرض | توضیح |
|---|---|---|
| دسته‌بندی خودکار | روشن | آیا فایل‌ها در پوشه دسته/تاریخ بروند |
| حالت پوشه‌بندی | `type-date` | `type-date`, `type`, `extension`, `date`, `none` |
| تغییر نام هوشمند | خاموش | پیشنهاد نام مرتب (اختیاری) |
| تأیید عملیات حساس | روشن | **خاموش نکنید مگر بدانید چه می‌کنید** |
| نمایش پیشرفت | روشن | ویرایش پیام وضعیت |
| اشتراک پیش‌فرض | `private` | عمومی‌کردن همیشه تأیید می‌خواهد |

## بازیابی از خرابی

| سناریو | رفتار سیستم |
|---|---|
| ری‌استارت/دیپلوی وسط آپلود | job در بوت بعدی requeue می‌شود و Resumable Upload از offset ادامه می‌دهد |
| قطع اینترنت | خطاهای شبکه `retryable` هستند → backoff نمایی (تا ۴ تلاش) |
| توکن دسترسی منقضی (۱ ساعت) | `TokenManager` بی‌صدا تمدید می‌کند؛ درخواست‌های هم‌زمان یک refresh مشترک دارند |
| Refresh Token باطل | `reauth_required` → ربات پیام `/connect` می‌دهد |
| دیسک موقت پر | خطای `temp_quota` با پیام روشن + `/cleanup` |
| دیتابیس در دسترس نیست | استارتاپ fail می‌شود (بهتر از اجرای بدون حالت) و پلتفرم ری‌استارت می‌کند |
| پرشدن سهمیه Drive | خطای Drive به پیام روشن ترجمه می‌شود؛ هیچ فایلی حذف نمی‌شود |

## مهاجرت داده

- **SQLite → Postgres**: `001_init.sql` را روی Postgres اجرا کنید (اسکیمای یکسان)، سپس جدول‌ها را با ابزار دلخواه (`pgloader` یا اسکریپت) منتقل کنید. `seq` را دستی نگه دارید تا ترتیب درست بماند. هر دو دیالکت `BIGINT`/`TEXT` هستند، پس تبدیل نوع لازم نیست.

```bash
psql "$DATABASE_URL" -f migrations/postgres/001_init.sql
pgloader sqlite://data/jb-drivebot.sqlite postgresql://...
```

## به‌روزرسانی

1. `git pull`
2. `npm ci && npm run build`
3. `npm test && npm run smoke`
4. دیپلوی. مهاجرت‌ها خودکار اجرا می‌شوند (idempotent).
5. `/status` را چک کنید.
