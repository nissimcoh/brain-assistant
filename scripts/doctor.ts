// Checks everything Brain needs on this Mac, and says how to fix what's missing.
// Usage: npm run doctor                       (general checks + a test notification)
//        npm run doctor -- ~/path/to/file.pdf  (also reads this file, the way Brain reads it)
// The file and notification checks go through the running service, because a background service
// on macOS behaves differently from the Terminal (iCloud files, notifications).
import { join } from 'node:path';
import { statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { createAuth } from '../server/auth.ts';
import { listModels, loadedModels } from '../server/ollama.ts';

const config = loadConfig();
const db = openDb(join(config.dataDir, 'brain.db'));
const model = db.getSetting('localModel', config.localModel);
const brain = `http://127.0.0.1:${config.port}`;
const fileArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
let problems = 0;

const ok = (msg: string) => console.log(`✔ ${msg}`);
const bad = (msg: string, fix: string) => {
  problems++;
  console.log(`✘ ${msg}\n    ← ${fix}`);
};
const run = (file: string, args: string[]) =>
  new Promise<string>((resolve) => execFile(file, args, { timeout: 8000 }, (err, out) => resolve(err ? '' : out)));

console.log('\nבדיקת בריין\n');

// 1. Disk
const fs = await statfs(homedir());
const freeGb = (fs.bavail * fs.bsize) / 1024 ** 3;
if (freeGb < 20) bad(`נשארו רק ${freeGb.toFixed(0)}GB פנויים בדיסק`, 'פנה מקום (לפחות 20GB). כשהדיסק מלא, המק נתקע כשהמודל עובד.');
else ok(`מקום פנוי בדיסק: ${freeGb.toFixed(0)}GB`);

// 2. Ollama and the model
const installed = await listModels(config.ollamaUrl);
if (installed === null) {
  bad('Ollama לא עונה', 'פתח את אפליקציית Ollama, והוסף אותה ב: הגדרות מערכת ← כללי ← פריטי התחברות.');
} else if (!installed.includes(model)) {
  bad(`המודל ${model} לא מותקן`, `הרץ: ollama pull ${model}`);
} else {
  ok(`Ollama עובד, המודל ${model} מותקן`);
  const loaded = (await loadedModels(config.ollamaUrl)) ?? [];
  if (loaded.includes(model)) ok('המודל טעון בזיכרון (התשובה הראשונה לא תחכה לטעינה)');
  else console.log('· המודל עוד לא טעון. בריין טוען אותו כשהאפליקציה נפתחת.');
}

// 3. The service
let health: { ok?: boolean; version?: string } | null = null;
try {
  health = (await (await fetch(`${brain}/api/health`, { signal: AbortSignal.timeout(3000) })).json()) as typeof health;
} catch {
  health = null;
}
if (!health?.ok) bad('בריין לא רץ במק', 'הרץ: npm run service:install');
else ok(`בריין רץ ברקע (גרסה ${health.version})`);

// 4. Remote access (Tailscale)
const ts = (await run('which', ['tailscale'])).trim() || '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const serve = await run(ts, ['serve', 'status']);
const url = serve.match(/https:\/\/\S+\.ts\.net\S*/)?.[0];
if (url) ok(`גישה מהטלפון: ${url}`);
else bad('הגישה מהטלפון לא פעילה (Tailscale)', 'פתח את Tailscale במק וודא שכתוב Connected, ואז הרץ: npm run remote:enable');

// 5. Checks inside the service
if (health?.ok) {
  const { code } = createAuth(db).newPairingCode();
  const pair = (await (
    await fetch(`${brain}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceName: 'בדיקת doctor' }) })
  ).json()) as { token: string; deviceId?: string };
  const H = { authorization: `Bearer ${pair.token}`, 'content-type': 'application/json' };
  const diag = async (body: object) =>
    (await (await fetch(`${brain}/api/diag`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json()) as Record<string, unknown>;

  const n = await diag({ action: 'notify' });
  if (!n.ok) bad(`הצגת התראה נכשלה: ${n.error}`, 'בדוק בהגדרות מערכת ← עדכונים את "עורך התסריטים".');
  else {
    ok('התראת בדיקה נשלחה למסך המק ("בדיקה מ־npm run doctor")');
    console.log('    אם היא לא הופיעה: הגדרות מערכת ← עדכונים ← "עורך התסריטים" (Script Editor) ← אפשר עדכונים, וגם לכבות "נא לא להפריע".');
  }

  if (fileArg) {
    console.log(`· קורא את ${fileArg} כמו שבריין קורא (אם הוא ב־iCloud, זה יכול לקחת עד דקה)…`);
    const r = await diag({ action: 'read', path: fileArg });
    if (!r.ok) bad(`קריאת הקובץ נכשלה: ${r.error}`, 'שלח לי את השורה הזאת.');
    else {
      ok(`הקובץ נקרא: ${r.chars} תווים, ${((r.ms as number) / 1000).toFixed(1)} שנ׳${r.downloaded ? ', הורד מ־iCloud' : ''}`);
      console.log(`    "${String(r.preview).replace(/\s+/g, ' ').slice(0, 100)}…"`);
    }
  }

  if (installed?.includes(model)) {
    const w = await diag({ action: 'warm' });
    if (!w.ok) bad(`קריאת ההוראות מראש נכשלה: ${w.error}`, 'שלח לי את השורה הזאת.');
    else {
      const tokens = w.promptTokens as number | undefined;
      ok(`גודל ההוראות והכלים: ${tokens ?? '?'} טוקנים (נקראו ב־${(((w.promptMs as number) ?? 0) / 1000).toFixed(1)} שנ׳)`);
      if (tokens && tokens > 1000) console.log('    מעל 1,000: שיחה חדשה תתחיל לאט יותר (בדרך כלל בגלל הרבה עובדות בזיכרון).');
    }
  }

  // Mail and calendar (stage 5). Not connected is fine: it's optional.
  const g = await diag({ action: 'google' });
  if (!g.ok) bad(`Google: ${g.error}`, 'אם כתוב להתחבר מחדש: npm run google:connect. אחרת שלח לי את השורה.');
  else if (!g.connected) {
    console.log(g.configured ? '  · Google: יש קובץ הרשאה אבל עדיין לא אושר. ← npm run google:connect' : '  · Google לא מחובר (לא חובה). לחיבור: TESTING.md, שלב 5.');
  } else {
    ok(`Google: ${g.accounts.length} ${g.accounts.length === 1 ? 'חשבון' : 'חשבונות'}, ההרשאה ב־${g.where === 'keychain' ? 'Keychain' : 'קובץ מוגן'}`);
    for (const c of g.checks as { label: string; email: string; ok: boolean; inboxSample?: number; eventsToday?: number; error?: string }[]) {
      if (c.ok) ok(`  ${c.label} (${c.email}): מייל נקרא מתוך השירות, ביומן ${c.eventsToday} אירועים היום`);
      else bad(`  ${c.label} (${c.email}): ${c.error}`, 'npm run google:connect ולבחור את החשבון הזה');
    }
  }

  // Apple: calendar, reminders, contacts (stage 6). Not set up is fine.
  const ap = await diag({ action: 'apple' });
  if (!ap.ok) bad(`Apple: ${ap.error}`, 'שלח לי את השורה.');
  else if (!ap.installed) console.log('  · יומן/תזכורות/אנשי קשר של Apple לא מחוברים (לא חובה). לחיבור: npm run apple:setup');
  else {
    for (const [key, name] of [['calendar', 'יומן'], ['reminders', 'תזכורות'], ['contacts', 'אנשי קשר']] as const) {
      const check = (ap.checks as Record<string, string>)[key];
      if (ap[key] !== 'full') bad(`Apple ${name}: אין הרשאה (${ap[key]})`, 'npm run apple:setup');
      else if (check?.startsWith('error')) bad(`Apple ${name}: ${check.slice(7)}`, 'שלח לי את השורה.');
      else ok(`Apple ${name}: ${check?.slice(4) ?? 'מחובר'}`);
    }
  }

  // The temporary device is removed at the end (also leftovers from an interrupted run).
  for (const d of db.listDevices().filter((x) => x.name === 'בדיקת doctor' && !x.revoked)) {
    await fetch(`${brain}/api/devices/${d.id}`, { method: 'DELETE', headers: H });
  }
}

console.log(problems ? `\nנמצאו ${problems} בעיות. תקן לפי החצים ← והרץ שוב.\n` : '\nהכל תקין.\n');
db.close();
