// Connects Brain to the Mac's Calendar, Reminders, Contacts, Notes and Messages. Run on the Mac:
//   npm run apple:setup
// 1. Builds "Brain Helper.app" (helper/main.swift) into ~/Applications. macOS gives permissions to
//    apps, not to Node, so this small app holds them. Signed locally ("ad hoc"), no network.
// 2. Opens it once so macOS asks for each permission. Click "Allow" / "OK" on every window.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.ts';
import { APPLE_BUNDLE_ID, helperAppPath, legacyHelperAppPath, PERMISSION_NAMES, permissionHelp } from '../server/apple.ts';

const run = promisify(execFile);
const config = loadConfig();
const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'helper', 'main.swift');
const app = helperAppPath();
const binary = join(app, 'Contents', 'MacOS', 'BrainHelper');
const stamp = join(config.dataDir, 'apple-helper.sha');

const fail = (msg: string): never => {
  console.error(`\n✘ ${msg}\n`);
  process.exit(1);
};

console.log('\nחיבור בריין ליומן, לתזכורות, לאנשי הקשר, לפתקים ולהודעות של Apple\n');
if (process.platform !== 'darwin') fail('זה עובד רק במק.');

// ---- 1. build (only when the source changed: a new build makes macOS ask for the permissions again)
const code = await readFile(source, 'utf8');
const hash = createHash('sha256').update(code).digest('hex');
const built = existsSync(binary) && (await readFile(stamp, 'utf8').catch(() => '')) === hash;
if (built && !process.argv.includes('--rebuild')) {
  console.log(`✔ Brain Helper כבר בנוי (${app})`);
} else {
  const swiftc = await run('xcrun', ['--find', 'swiftc']).catch(() => null);
  if (!swiftc) {
    fail(
      'חסרים כלי הפיתוח של Apple (Command Line Tools).\n' +
        '  להריץ בטרמינל: xcode-select --install\n' +
        '  ללחוץ "התקן" בחלון שנפתח (כמה דקות), ואז להריץ שוב: npm run apple:setup',
    );
  }
  console.log('בונה את Brain Helper (פעם אחת, עד דקה)…');
  await rm(app, { recursive: true, force: true });
  await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  try {
    await run('xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', `${arch}-apple-macos14`, '-o', binary, source], {
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    console.error((e.stderr || e.message).split('\n').filter((l) => /error/.test(l)).slice(0, 15).join('\n'));
    fail('הבנייה נכשלה. העתק לי את השורות שלמעלה.');
  }
  const usage = 'בריין, העוזר האישי שלך, משתמש בזה רק כשאתה מבקש.';
  await writeFile(
    join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${APPLE_BUNDLE_ID}</string>
  <key>CFBundleName</key><string>Brain Helper</string>
  <key>CFBundleDisplayName</key><string>Brain Helper</string>
  <key>CFBundleExecutable</key><string>BrainHelper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSCalendarsFullAccessUsageDescription</key><string>${usage}</string>
  <key>NSCalendarsUsageDescription</key><string>${usage}</string>
  <key>NSRemindersFullAccessUsageDescription</key><string>${usage}</string>
  <key>NSRemindersUsageDescription</key><string>${usage}</string>
  <key>NSContactsUsageDescription</key><string>${usage}</string>
  <key>NSAppleEventsUsageDescription</key><string>${usage}</string>
</dict>
</plist>
`,
  );
  try {
    await run('codesign', ['--force', '--sign', '-', '--identifier', APPLE_BUNDLE_ID, app]);
  } catch (err) {
    fail(`החתימה נכשלה: ${(err as Error).message}`);
  }
  await writeFile(stamp, hash, { mode: 0o600 });
  console.log(`✔ Brain Helper נבנה: ${app}`);
}

// ---- 2. permissions
console.log('\nעכשיו macOS ישאל על כל הרשאה בחלון נפרד (עד 5 חלונות):');
console.log('  יומן, תזכורות, אנשי קשר, ואז "Brain Helper רוצה לשלוט ב־Notes" ו"…ב־Messages".');
console.log('  בכל חלון: "אפשר" / "Allow" / "OK".\n');
const out = join(tmpdir(), `brain-authorize-${process.pid}.json`);
await rm(out, { force: true });
try {
  await run('/usr/bin/open', ['-W', '-n', '-a', app, '--args', '--authorize', '--response', out], { timeout: 5 * 60_000 });
} catch (err) {
  fail(`לא הצלחתי לפתוח את Brain Helper: ${(err as Error).message}`);
}
const res = JSON.parse(await readFile(out, 'utf8').catch(() => '{}')) as { ok?: boolean; result?: Record<string, string> };
await rm(out, { force: true });
if (!res.ok || !res.result) fail('Brain Helper לא החזיר תשובה. נסה שוב: npm run apple:setup');

let missing = 0;
for (const [key, name] of Object.entries(PERMISSION_NAMES)) {
  const state = res.result![key] ?? 'unknown';
  if (state === 'full') console.log(`✔ ${name}`);
  else {
    missing++;
    console.log(`✘ ${name}: ${permissionHelp(key, state)}`);
  }
}
console.log(
  missing
    ? '\nאחרי שתתקן בהגדרות, הרץ שוב: npm run apple:setup (לא צריך להפעיל מחדש את בריין).\n'
    : '\n✔ הכל מחובר. אין צורך להפעיל מחדש את בריין.\n',
);
// Renamed from Felipe (0.15): the old helper is no longer used once the new one has its permissions.
if (!missing && existsSync(legacyHelperAppPath())) {
  console.log(`ℹ העוזר בשם הישן כבר לא בשימוש. אפשר להעביר אותו לסל: ${legacyHelperAppPath()}`);
  console.log('  ובהגדרות המערכת ← פרטיות ואבטחה אפשר לכבות את Felipe Helper בכל הרשימות.\n');
}
