// Connects Brain to a Google account (Gmail, Calendar, Contacts). Run on the Mac:
//   npm run google:connect                    (again for a second account, e.g. work)
//   npm run google:connect -- --label עבודה   (the name Brain uses for this account)
// 1. Uses the OAuth client file you downloaded from Google Cloud (found in ~/Downloads, kept in ~/.brain).
// 2. Opens the browser for your approval (OAuth for desktop apps, with PKCE, answered on 127.0.0.1).
// 3. Saves the long-lived permission in the macOS Keychain. Nothing leaves the Mac except to Google.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, stat, writeFile, chmod, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.ts';
import { defaultExec } from '../server/tools.ts';
import { accountName, createGoogle, defaultLabel, GOOGLE_ENDPOINTS, GOOGLE_SCOPES, readClientConfig } from '../server/google.ts';

const config = loadConfig();
const clientFile = join(config.dataDir, 'google-client.json');
const fail = (msg: string): never => {
  console.error(`\n✘ ${msg}\n`);
  process.exit(1);
};

console.log('\nחיבור בריין ל־Google (מייל, יומן ואנשי קשר)\n');
await mkdir(config.dataDir, { recursive: true });
const labelArg = (() => {
  const i = process.argv.indexOf('--label');
  return i > 0 ? (process.argv[i + 1] ?? '').trim() : '';
})();
const google = createGoogle({ dataDir: config.dataDir, exec: defaultExec, platform: process.platform, renewDays: config.googleRenewDays });
const before = (await google.status()).accounts;
if (before.length) {
  console.log(`מחוברים כבר: ${before.map((a) => `${a.label} (${a.email})`).join(', ')}.`);
  console.log('בדפדפן תוכל לבחור חשבון חדש כדי להוסיף אותו, או חשבון קיים כדי לחדש לו את ההרשאה.\n');
}

// ---- 1. the OAuth client file
let client = await readClientConfig(config.dataDir);
if (!client) {
  const downloads = join(homedir(), 'Downloads');
  const candidates = (await readdir(downloads).catch(() => [] as string[])).filter((f) => /^client_secret.*\.json$/i.test(f));
  const withTimes = await Promise.all(candidates.map(async (f) => ({ f, t: (await stat(join(downloads, f))).mtimeMs })));
  const newest = withTimes.sort((a, b) => b.t - a.t)[0];
  if (!newest) {
    fail(
      'לא מצאתי את קובץ ההרשאה מ־Google.\n' +
        '  צריך ליצור "OAuth client" מסוג Desktop app ב־Google Cloud ולהוריד את קובץ ה־JSON\n' +
        '  (הוא יישמר בהורדות בשם שמתחיל ב־client_secret). ההוראות המלאות ב־TESTING.md, שלב 5.',
    );
  }
  const raw = JSON.parse(await readFile(join(downloads, newest!.f), 'utf8')) as Record<string, unknown>;
  if (!raw.installed) {
    fail('הקובץ שהורד הוא לא מסוג "Desktop app". ב־Google Cloud צור Client חדש, ובסוג האפליקציה בחר Desktop app.');
  }
  await writeFile(clientFile, JSON.stringify(raw), { mode: 0o600 });
  await chmod(clientFile, 0o600);
  client = await readClientConfig(config.dataDir);
  console.log(`✔ קובץ ההרשאה נמצא (${newest!.f}) ונשמר ב־${clientFile}`);
}
if (!client) fail('קובץ ההרשאה לא תקין.');

// ---- 2. approval in the browser
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('hex');

const code = await new Promise<{ code: string; redirect: string }>((resolve) => {
  let redirect = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/') {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const page = (msg: string) =>
      `<!doctype html><html dir="rtl" lang="he"><body style="font:20px -apple-system,sans-serif;padding:40px">${msg}</body></html>`;
    if (url.searchParams.get('state') !== state) {
      res.end(page('הבקשה לא תואמת. אפשר לסגור את החלון ולהריץ שוב.'));
      return;
    }
    const err = url.searchParams.get('error');
    if (err) {
      res.end(page('הגישה לא אושרה. אפשר לסגור את החלון.'));
      server.close();
      fail(`Google לא אישר (${err}).`);
    }
    res.end(page('✔ החיבור אושר. אפשר לסגור את החלון ולחזור לטרמינל.'));
    server.close();
    resolve({ code: url.searchParams.get('code') ?? '', redirect });
  });
  server.listen(0, '127.0.0.1', () => {
    redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const auth = `${GOOGLE_ENDPOINTS.auth}?${new URLSearchParams({
      client_id: client!.clientId,
      redirect_uri: redirect,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent select_account',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    })}`;
    console.log('\nנפתח עכשיו דפדפן לאישור. אם לא נפתח, העתק את הכתובת הזו לדפדפן במק:\n');
    console.log(auth, '\n');
    console.log('בדפדפן: בחר את החשבון שלך. אם מופיע "Google hasn\'t verified this app": Advanced ← Go to … (unsafe).');
    console.log('בדף ההרשאות: סמן את כל התיבות, ואז Continue.\n');
    execFile('open', [auth], () => {});
  });
  setTimeout(() => fail('עברו 5 דקות בלי אישור. הרץ שוב כשתהיה מוכן.'), 5 * 60_000).unref();
});

// ---- 3. exchange, check, save
const res = await fetch(GOOGLE_ENDPOINTS.token, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code: code.code,
    client_id: client!.clientId,
    client_secret: client!.clientSecret,
    redirect_uri: code.redirect,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  }),
});
const tokens = (await res.json()) as { access_token?: string; refresh_token?: string; scope?: string; error?: string; error_description?: string };
if (!res.ok || !tokens.access_token) fail(`Google לא השלים את החיבור: ${tokens.error_description ?? tokens.error ?? res.status}`);
if (!tokens.refresh_token) fail('Google לא נתן הרשאה קבועה. הרץ שוב (הכתובת מבקשת אותה במפורש).');

const granted = new Set((tokens.scope ?? '').split(' '));
const missing = GOOGLE_SCOPES.filter((s) => !granted.has(s));
const names: Record<string, string> = {
  'gmail.readonly': 'קריאת מייל',
  'gmail.send': 'שליחת מייל',
  'gmail.modify': 'סימון מיילים כנקראו',
  'calendar.events': 'אירועים ביומן',
  'calendar.calendarlist.readonly': 'רשימת היומנים',
  'contacts.readonly': 'אנשי קשר',
  'contacts.other.readonly': 'אנשי קשר אחרים',
};

const email = await google.profileEmail(tokens.access_token!);
if (!email) fail('לא הצלחתי לזהות את החשבון. הרץ שוב, ובדף ההרשאות אשר גם את קריאת המייל.');

// The name Brain uses for this account ("אישי", "עבודה"…).
const existing = before.find((a) => a.email.toLowerCase() === email.toLowerCase());
let label = labelArg || existing?.label || '';
if (!label) {
  const suggested = defaultLabel(before.length, email);
  if (before.length && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    label = (await rl.question(`איך לקרוא לחשבון ${email}? (Enter = ${suggested}): `)).trim() || suggested;
    rl.close();
  } else {
    label = suggested;
  }
}
const saved = await google.saveAccount({ refreshToken: tokens.refresh_token!, email, label });
console.log(`✔ ${saved.replaced ? 'ההרשאה חודשה' : 'מחובר'}: ${accountName({ ...saved.account, refreshToken: '' })}`);
console.log(saved.where === 'keychain' ? '✔ ההרשאה נשמרה ב־Keychain של המק.' : `✔ ההרשאה נשמרה בקובץ מוגן ב־${config.dataDir}.`);
const all = (await google.status()).accounts;
if (all.length > 1) console.log(`✔ חשבונות מחוברים: ${all.map((a) => `${a.label} (${a.email})`).join(', ')}. שליחה ברירת מחדל מ־${all[0].label}.`);
if (saved.account.renewBy) {
  const until = new Date(saved.account.renewBy).toLocaleString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
  console.log(`ℹ כל עוד האפליקציה ב־Google במצב Testing, ההרשאה תקפה 7 ימים: עד ${until}. יום לפני תופיע תזכורת.`);
}
if (missing.length) {
  console.log(`\n⚠ לא אישרת: ${missing.map((s) => names[s.split('/').pop()!] ?? s).join(', ')}.`);
  console.log('  חלק מהיכולות לא יעבדו. כדי לתקן, הרץ שוב וסמן את כל התיבות.\n');
} else {
  console.log('✔ כל ההרשאות אושרו. אין צורך להפעיל מחדש את בריין.\n');
}
