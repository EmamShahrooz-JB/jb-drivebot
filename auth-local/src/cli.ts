#!/usr/bin/env node
/**
 * JB-Drive Authenticator — runs on the operator's own computer.
 *
 * It starts a loopback HTTP server on 127.0.0.1, opens the system browser for
 * Google consent, validates state + PKCE, and then hands the result to the bot
 * on Altare using a one-time pairing code.
 *
 * It never prints, logs or stores a token.
 */
import { runFlow, fetchPrepare } from './flow.js';

interface Args {
  server?: string;
  code?: string;
  port: number;
  mode: 'server-exchange' | 'local-exchange';
  clientId?: string;
  clientSecret?: string;
  allowInsecure: boolean;
  browser: boolean;
  check: boolean;
  help: boolean;
}

const HELP = `
JB-Drive Authenticator — ابزار محلی اتصال Google Drive به ربات JB-DriveBot

استفاده:
  npx tsx auth-local/src/cli.ts --server https://<app>.altare.app --code XXXX-XXXX

گزینه‌ها:
  --server <url>        آدرس سرویس ربات روی Altare (اجباری)
  --code <code>         کد یک‌بارمصرف که ربات با /connect می‌دهد (اجباری)
  --port <n>            پورت سرور محلی Callback (پیش‌فرض 8765)
  --mode <mode>         server-exchange (پیش‌فرض) یا local-exchange
  --client-id <id>      اگر سرور آن را برنگرداند
  --client-secret <s>   فقط برای local-exchange لازم است
  --allow-insecure      اجازه http فقط برای 127.0.0.1 (تست محلی)
  --no-browser          لینک را چاپ کن، مرورگر را باز نکن
  --check               فقط بررسی دسترسی به سرور
  --help                همین راهنما

متغیرهای محیطی معادل: JBD_SERVER, JBD_CODE, JBD_CLIENT_ID, JBD_CLIENT_SECRET
`;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    port: 8765,
    mode: 'server-exchange',
    allowInsecure: false,
    browser: true,
    check: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (!v) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--server':
        args.server = next();
        break;
      case '--code':
        args.code = next();
        break;
      case '--port':
        args.port = Number(next());
        break;
      case '--mode': {
        const m = next();
        if (m !== 'server-exchange' && m !== 'local-exchange') throw new Error('mode must be server-exchange or local-exchange');
        args.mode = m;
        break;
      }
      case '--client-id':
        args.clientId = next();
        break;
      case '--client-secret':
        args.clientSecret = next();
        break;
      case '--allow-insecure':
        args.allowInsecure = true;
        break;
      case '--no-browser':
        args.browser = false;
        break;
      case '--check':
        args.check = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`unknown option: ${a}`);
    }
  }
  args.server = args.server ?? process.env.JBD_SERVER;
  args.code = args.code ?? process.env.JBD_CODE;
  args.clientId = args.clientId ?? process.env.JBD_CLIENT_ID;
  return args;
}

const color = {
  green: (s: string) => `\u001b[32m${s}\u001b[0m`,
  red: (s: string) => `\u001b[31m${s}\u001b[0m`,
  yellow: (s: string) => `\u001b[33m${s}\u001b[0m`,
  dim: (s: string) => `\u001b[2m${s}\u001b[0m`,
};

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(color.red(String(err instanceof Error ? err.message : err)));
    console.error(HELP);
    return 2;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (!args.server) {
    console.error(color.red('--server لازم است.'));
    console.error(HELP);
    return 2;
  }
  if (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65535) {
    console.error(color.red('--port باید عددی بین 1024 تا 65535 باشد.'));
    return 2;
  }

  if (args.check) {
    try {
      const health = await fetch(new URL('/health', args.server));
      const body = (await health.json()) as { ok?: boolean; service?: string };
      console.log(body.ok ? color.green(`✓ سرور در دسترس است (${body.service})`) : color.red('✗ پاسخ سرور نامعتبر است'));
      return body.ok ? 0 : 1;
    } catch (err) {
      console.error(color.red(`✗ دسترسی به سرور ممکن نشد: ${err instanceof Error ? err.message : String(err)}`));
      return 1;
    }
  }

  if (!args.code) {
    console.error(color.red('--code لازم است. در تلگرام /connect را اجرا کنید.'));
    return 2;
  }

  console.log(color.dim('JB-Drive Authenticator'));
  console.log(color.dim(`سرور: ${args.server}`));
  console.log(color.dim(`حالت: ${args.mode}  |  Callback: http://127.0.0.1:${args.port}/oauth2callback`));
  console.log('');

  try {
    const prepare = await fetchPrepare({
      serverUrl: args.server,
      pairingCode: args.code,
      allowInsecure: args.allowInsecure,
      ...(args.clientId ? { clientId: args.clientId } : {}),
    });
    console.log(color.dim(`اسکوپ‌های مورد انتظار: ${prepare.scopes.length} مورد`));
    if (prepare.expectedEmail) console.log(color.dim(`حساب هدف: ${prepare.expectedEmail}`));
    console.log('');

    const result = await runFlow({
      serverUrl: args.server,
      pairingCode: args.code,
      port: args.port,
      mode: args.mode,
      allowInsecure: args.allowInsecure,
      openBrowser: args.browser,
      onStatus: (m) => console.log(color.yellow(`• ${m}`)),
      ...(prepare.clientId ? { clientId: prepare.clientId } : {}),
      ...(args.clientSecret ? { clientSecret: args.clientSecret } : {}),
    });

    console.log('');
    console.log(color.green('✅ اتصال با موفقیت برقرار شد'));
    if (result.email) console.log(`   حساب: ${result.email}`);
    if (result.rootFolder) console.log(`   پوشه ربات: ${result.rootFolder}`);
    console.log(`   تعداد دسترسی‌ها: ${result.scopes.length}`);
    console.log('');
    console.log(color.dim('حالا در تلگرام /status را بزنید. هیچ توکنی روی این دستگاه ذخیره نشد.'));
    return 0;
  } catch (err) {
    console.error('');
    console.error(color.red(`✗ اتصال ناموفق: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(color.red(`✗ خطای غیرمنتظره: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  });
