// Realistic speed and accuracy check: runs Brain itself (on a temporary database, not your real one)
// against the real model, through a sequence like real use.
// Mail and calendar use made-up data (your real Google account is not touched).
// About 8 minutes. Usage: npm run speed -- [model]     (default: the model chosen in the app). Don't use Brain while it runs.
// A cloud model: npm run speed -- openai:gpt-6-luna   or   anthropic:claude-haiku-5-5 (needs npm run cloud:key; costs cents).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { createApp } from '../server/app.ts';
import { listModels } from '../server/ollama.ts';
import type { Google } from '../server/google.ts';
import { createApple } from '../server/apple.ts';
import type { Web } from '../server/web.ts';

/** A made-up Mac calendar, reminders, contacts and notes (the real ones are not touched). */
function fakeApple(dataDir: string) {
  const day = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  return createApple({
    dataDir,
    platform: 'darwin',
    run: async (req) => {
      switch (req.op) {
        case 'status':
          return {
            calendar: 'full', reminders: 'full', contacts: 'full',
            calendars: [{ id: 'c1', title: 'בית', source: 'iCloud', writable: true, default: true }],
            lists: [{ id: 'l1', title: 'תזכורות', default: true }],
          };
        case 'events':
          return { calendars: [], events: [{ title: 'ארוחת ערב משפחתית', start: day(26), end: day(28), allDay: false, location: '', calendar: 'בית' }] };
        case 'reminders':
          return { lists: [], reminders: [{ id: 'r1', title: 'לשלם חשבון חשמל', due: day(30), list: 'תזכורות', notes: '' }] };
        case 'contacts':
          return { contacts: [{ name: 'דני כהן', nickname: '', phones: [{ label: 'נייד', number: '050-1234567' }], emails: [] }] };
        case 'applescript':
          return { output: 'x-coredata://n1\u001fקניות\u001f2026-11-20T10:00:00\u001fחלב, לחם, ביצים' };
        default:
          return { id: 'x', list: 'תזכורות', calendar: 'בית', title: 'x' };
      }
    },
  });
}

/** Made-up mail, contacts and calendar, so the model can be tested on them without a real account. */
function fakeGoogle(): Google {
  const later = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  const accounts = [
    { key: '1', label: 'אישי', email: 'test@example.com', refreshToken: '' },
    { key: '2', label: 'עבודה', email: 'work@example.com', refreshToken: '' },
  ];
  const fake = {
    status: async () => ({ configured: true, connected: true, email: 'test@example.com', accounts, where: 'file' as const }),
    available: async () => true,
    knownAccounts: () => accounts,
    cardAccount: (name?: string) => (/עבוד|work/i.test(name ?? '') ? 'עבודה (work@example.com)' : 'אישי (test@example.com)'),
    searchMail: async () => ({
      mails: [
        { id: '1:m1', threadId: 't1', account: 'אישי', from: 'בנק לאומי <info@leumi.co.il>', subject: 'חיוב בכרטיס האשראי', date: new Date().toUTCString(), time: Date.now(), snippet: 'חויבת ב־420 ש"ח בסופר', unread: true },
        { id: '2:w1', threadId: 'w1', account: 'עבודה', from: 'HR <hr@company.com>', subject: 'זימון לראיון', date: new Date().toUTCString(), time: Date.now() - 1, snippet: 'נשמח לקבוע ראיון ביום שלישי', unread: true },
        { id: '1:m2', threadId: 't2', account: 'אישי', from: 'הגן <gan@example.com>', subject: 'מסיבת חנוכה', date: new Date().toUTCString(), time: Date.now() - 2, snippet: 'ביום חמישי בעשר', unread: false },
      ],
      problems: [],
    }),
    readMail: async () => ({ id: '1:m1', threadId: 't1', account: 'אישי', accountKey: '1', from: 'בנק לאומי <info@leumi.co.il>', to: 'test@example.com', subject: 'חיוב בכרטיס האשראי', date: new Date().toUTCString(), messageId: '', references: '', text: 'שלום, חויבת ב־420 ש"ח בסופר.', attachments: [] }),
    findContacts: async () => [{ name: 'דני כהן', email: 'danny@example.com' }],
    listEvents: async () => ({
      events: [
        { title: 'רופא שיניים', start: later(20), end: later(21), allDay: false, location: 'הרצל 5', calendar: 'אישי', link: '' },
        { title: 'ראיון עבודה', start: later(23), end: later(24), allDay: false, location: '', calendar: 'עבודה', link: '' },
      ],
      problems: [],
    }),
    sendMail: async () => ({ id: 'x', to: ['danny@example.com'], subject: 'x', from: 'test@example.com' }),
    createEvent: async () => ({ id: 'x', link: '', guests: [], account: '' }),
  };
  return fake as unknown as Google;
}

const real = loadConfig();
const realDb = openDb(join(real.dataDir, 'brain.db'));
const model = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? realDb.getSetting('localModel', real.localModel);
realDb.close();

// "openai:gpt-6-luna": the same checks against a cloud model (made-up data only, as below).
const cloudModel = model.match(/^(openai|anthropic):(.+)$/);
const provider = cloudModel?.[1] as 'openai' | 'anthropic' | undefined;
if (provider) {
  if (!(provider === 'openai' ? real.openaiKey : real.anthropicKey)) {
    console.error(`אין מפתח של ${provider}. במק: npm run cloud:key -- ${provider}`);
    process.exit(1);
  }
} else {
  const installed = (await listModels(real.ollamaUrl)) ?? [];
  if (!installed.includes(model)) {
    console.error(installed.length ? `${model}: לא מותקן` : 'Ollama לא זמין.');
    process.exit(1);
  }
}

// A separate Brain with an empty temporary database.
const dataDir = mkdtempSync(join(tmpdir(), 'brain-speed-'));
const config = loadConfig({
  dataDir,
  ollamaUrl: real.ollamaUrl,
  localModel: provider ? real.localModel : model,
  port: 0,
  openaiKey: real.openaiKey,
  anthropicKey: real.anthropicKey,
  cloudModels: { ...real.cloudModels, ...(provider ? { [provider]: cloudModel![2] } : {}) },
});
const db = openDb(join(dataDir, 'brain.db'));
if (provider) db.setSetting('cloud', { mode: 'ask', provider, allow: { memory: true, personal: true, files: true, mail: true } });
// Made-up search results too: the test is about choosing the tool, not about today's news.
const fakeWeb = {
  via: () => 'test',
  search: async () => ({
    via: 'test',
    results: [{ title: 'LaLiga – טבלה', url: 'https://example.com/laliga', snippet: 'ריאל מדריד מובילה עם 35 נקודות, ברצלונה שנייה עם 33, אתלטיקו שלישית עם 30.' }],
  }),
  fetchPage: async (url: string) => ({ url, title: 'LaLiga', text: '1. ריאל מדריד 35\n2. ברצלונה 33\n3. אתלטיקו מדריד 30' }),
} as unknown as Web;
// In the cloud run, the local model stays idle (no naming or warming in the background).
const app = createApp(config, db, { google: fakeGoogle(), apple: fakeApple(config.dataDir), web: fakeWeb, ...(provider ? { autoWarm: false } : {}) });
await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
const { code } = app.auth.newPairingCode();
const { token } = (await (
  await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceName: 'בדיקת מהירות' }) })
).json()) as { token: string };

interface Turn {
  conversationId: string;
  text: string;
  tool: string;
  approval?: { tool: string; fields: { key: string; value: string }[] };
  readSec: number;
  totalSec: number;
}
async function send(text: string, conversationId?: string): Promise<Turn> {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    // A new conversation starts in the cloud for a cloud model (and then stays there).
    body: JSON.stringify({ text, conversationId, engine: provider && !conversationId ? 'cloud' : undefined }),
  });
  const evs = (await res.text())
    .split('\n\n')
    .filter(Boolean)
    .map((f) => ({ event: f.match(/^event: (.+)$/m)?.[1] ?? '', data: JSON.parse(f.match(/^data: (.+)$/m)?.[1] ?? 'null') }));
  // An error in one question is reported as its answer, and the run goes on.
  const err = evs.find((e) => e.event === 'error');
  const done = evs.find((e) => e.event === 'done')?.data ?? {};
  const tool = evs.find((e) => e.event === 'tool' || e.event === 'approval')?.data.tool ?? '';
  const approval = evs.find((e) => e.event === 'approval')?.data;
  return {
    conversationId: evs.find((e) => e.event === 'meta')?.data.conversationId ?? conversationId ?? '',
    text: err ? `⚠ שגיאה: ${err.data.message}` : evs.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''),
    tool: err ? 'שגיאה' : tool,
    approval,
    readSec: (done.readMs ?? 0) / 1000,
    totalSec: (done.totalMs ?? 0) / 1000,
  };
}
const s = (x: number) => `${x.toFixed(1)} שנ׳`;

console.log(`\n=== ${model} ===`);
console.log('טוען את המודל…');
await send('היי');

// ---------- 1. a realistic sequence ----------
console.log('\n## 1. מהירות בשימוש אמיתי');
console.log('| # | הודעה | מה מיוחד | קריאת הוראות | סה"כ | כלי |');
console.log('| --- | --- | --- | --- | --- | --- |');
let a = '';
let b = '';
const flow: [string, string, () => string | undefined, (id: string) => void][] = [
  ['היי, מה שלומך?', 'שיחה חדשה', () => undefined, (id) => (a = id)],
  ['מה השעה עכשיו?', 'כלי', () => a, () => {}],
  ['תזכור שאני אוהב קפה שחור', 'שמירה בזיכרון', () => a, () => {}],
  ['תמליץ לי על משקה לבוקר', '', () => a, () => {}],
  ['תמצא לי קבצים עם המילה חוזה', 'כלי קבצים', () => a, () => {}],
  ['תודה. איך מזג האוויר בירושלים בחורף, בדרך כלל?', '', () => a, () => {}],
  ['מה יש לי מחר ביומן?', 'יומן נכנס לשיחה', () => a, () => {}],
  ['ויש לי מיילים חדשים?', 'מייל, אחרי היומן', () => a, () => {}],
  ['שלום', 'שיחה חדשה', () => undefined, (id) => (b = id)],
  ['כמה זה 17 כפול 23?', '', () => b, () => {}],
  ['מה אמרת לי על המשקה?', 'חזרה לשיחה הראשונה', () => a, () => {}],
  ['תודה', '', () => a, () => {}],
];
const rows: (Turn & { note: string })[] = [];
for (const [i, [text, note, conv, remember]] of flow.entries()) {
  const t = await send(text, conv());
  remember(t.conversationId);
  rows.push({ ...t, note });
  console.log(`| ${i + 1} | ${text} | ${note} | ${s(t.readSec)} | ${s(t.totalSec)} | ${t.tool || '—'} |`);
}

// ---------- 2. does each request pick the right tool? ----------
console.log('\n## 2. דיוק: האם נבחר הכלי הנכון (כל שאלה 3 פעמים, כל פעם בשיחה חדשה)');
const cases: [string, string][] = [
  ['מה השעה עכשיו?', 'get_datetime'],
  ['כמה סוללה נשארה למק?', 'mac_status'],
  ['תציג התראה במק: לצאת לאסוף את הילדים', 'mac_notification'],
  ['תזכור שהבת שלי לומדת בגן שושנה', 'remember'],
  ['מה דיברנו פעם על משכנתא?', 'search_history'],
  ['תמצא לי את קורות החיים שלי', 'search_files'],
  ['מה בירת צרפת?', ''],
  ['כמה זה 17 כפול 23?', ''],
  ['כתוב הודעת וואטסאפ קצרה לגננת שהבן שלי חולה היום ולא יגיע', ''],
  ['מי מקום ראשון בליגה הספרדית כרגע?', 'web_search'],
  ['מה מזג האוויר מחר בתל אביב?', 'web_search'],
  ['מה יש לי על שולחן העבודה?', 'list_folder'],
];
// Each question 3 times: one run can be luck, either way.
const RUNS = 3;
let ok = 0;
const samples: string[] = [];
for (const [text, expected] of cases) {
  const got: string[] = [];
  let reply = '';
  for (let r = 0; r < RUNS; r++) {
    const t = await send(text);
    got.push(t.tool);
    if (t.tool !== expected) reply ||= t.text;
    if (!expected && t.text.length > 40) samples.push(t.text);
  }
  const passed = got.filter((g) => g === expected).length;
  ok += passed;
  const wrong = got.find((g) => g !== expected);
  console.log(
    `${passed === RUNS ? '✔' : '✘'} ${passed}/${RUNS}  ${text}` +
      (wrong === undefined ? '' : `  →  ${wrong || 'בלי כלי'} (ציפיתי: ${expected || 'בלי כלי'}). ענה: ${reply.replace(/\s+/g, ' ').slice(0, 80)}`),
  );
}
console.log(`\nדיוק: ${ok}/${cases.length * RUNS}`);
console.log('\nדוגמת כתיבה (לשיפוט שלך: גרסה אחת, פנייה בלשון זכר):');
console.log(`  ${(samples.at(-1) ?? '').replace(/\n+/g, '\n  ')}`);

// ---------- 3. mail and calendar ----------
console.log('\n## 3. מייל, יומן, תזכורות, פתקים והודעות (נתונים מומצאים, כל שאלה 3 פעמים בשיחה חדשה)');
const gcases: [string, string][] = [
  ['יש לי מיילים חדשים מהבנק?', 'gmail_search'],
  ['מה כתוב במייל האחרון מהגן?', 'gmail_search'],
  ['מה יש לי מחר ביומן?', 'calendar_events'],
  ['מתי אני פנוי ביום שלישי?', 'calendar_events'],
  ['תקבע לי ביומן רופא שיניים ביום שלישי ב-10', 'calendar_create'],
  ['תשלח מייל לדני שאני מאחר בעשר דקות', 'find_contact'],
  ['יש לי מיילים חדשים בעבודה?', 'gmail_search'],
  ['תזכיר לי מחר ב-8 להתקשר לבנק', 'reminder_create'],
  ['מה התזכורות שלי?', 'reminders_list'],
  ['תרשום לי פתק: לקנות חלב ולחם', 'note_create'],
  ['מה כתוב בפתק של הקניות?', 'notes_search'],
  ['מה הטלפון של דני?', 'find_contact'],
  ['תשלח הודעה לדני שאני מגיע בעוד רבע שעה', 'find_contact'],
];
let gok = 0;
for (const [text, expected] of gcases) {
  const got: string[] = [];
  let reply = '';
  for (let r = 0; r < RUNS; r++) {
    const t = await send(text);
    got.push(t.tool);
    if (t.tool !== expected) reply ||= t.text;
  }
  const passed = got.filter((g) => g === expected).length;
  gok += passed;
  const wrong = got.find((g) => g !== expected);
  console.log(
    `${passed === RUNS ? '✔' : '✘'} ${passed}/${RUNS}  ${text}` +
      (wrong === undefined ? '' : `  →  ${wrong || 'בלי כלי'} (ציפיתי: ${expected}). ענה: ${reply.replace(/\s+/g, ' ').slice(0, 80)}`),
  );
}
// The full mail flow: find the address, then a card with the right recipient (nothing is sent).
const flowTurn = await send('תשלח מייל לדני שאני מאחר בעשר דקות');
const card = flowTurn.approval;
const to = card?.fields.find((f) => f.key === 'to')?.value ?? '';
const body = card?.fields.find((f) => f.key === 'body')?.value ?? '';
console.log(
  card?.tool === 'gmail_send' && to === 'danny@example.com'
    ? `✔ מייל לדני: נמצאה הכתובת והוכן כרטיס לאישור. הנוסח: ${body.replace(/\s+/g, ' ').slice(0, 100)}`
    : `✘ מייל לדני: ${card ? `כרטיס ${card.tool} אל "${to}"` : `אין כרטיס. ענה: ${flowTurn.text.replace(/\s+/g, ' ').slice(0, 100)}`}`,
);
// Two accounts: the account the user names reaches the card.
const workTurn = await send('תשלח מהמייל של העבודה מייל לדני שאני מאחר');
const from = workTurn.approval?.fields.find((f) => f.key === 'account')?.value ?? '';
console.log(
  /עבודה/.test(from)
    ? '✔ "מהמייל של העבודה": הכרטיס מציג מאת: עבודה'
    : `✘ "מהמייל של העבודה": ${workTurn.approval ? `הכרטיס מציג מאת: ${from || '(ריק)'}` : `אין כרטיס. ענה: ${workTurn.text.replace(/\s+/g, ' ').slice(0, 100)}`}`,
);
// A message to a named person: find the number, then a card with it (nothing is sent).
const msgTurn = await send('תשלח הודעה לדני שאני מגיע בעוד רבע שעה');
const msgTo = msgTurn.approval?.fields.find((f) => f.key === 'to')?.value ?? '';
console.log(
  msgTurn.approval?.tool === 'message_send' && msgTo === '+972501234567'
    ? `✔ הודעה לדני: נמצא המספר והוכן כרטיס. הנוסח: ${(msgTurn.approval.fields.find((f) => f.key === 'text')?.value ?? '').slice(0, 80)}`
    : `✘ הודעה לדני: ${msgTurn.approval ? `כרטיס ${msgTurn.approval.tool} אל "${msgTo}"` : `אין כרטיס. ענה: ${msgTurn.text.replace(/\s+/g, ' ').slice(0, 100)}`}`,
);
console.log(`\nדיוק מייל, יומן ו־Apple: ${gok}/${gcases.length * RUNS}`);

// ---------- 4. Hebrew writing (for reading by a person; compare.ts puts models side by side) ----------
console.log('\n## 4. כתיבה בעברית');
const writing = [
  'תכתוב לי הודעה קצרה ומנומסת לבעל הבית שהמזגן התקלקל ואני מבקש שיבוא לתקן השבוע.',
  'תסביר לי בשלושה משפטים מה ההבדל בין משכנתא בריבית קבועה לריבית משתנה.',
  'תציע שלושה רעיונות לבילוי עם ילדים בשבת בירושלים כשיורד גשם.',
];
for (const text of writing) {
  const t = await send(text);
  console.log(`\n### ${text}\n${t.text.trim()}\n(${s(t.totalSec)})`);
}

// ---------- summary ----------
const fast = rows.filter((r) => !r.note.startsWith('שיחה חדשה') && !r.note.startsWith('חזרה') && !r.note.startsWith('יומן נכנס'));
const join_ = rows.find((r) => r.note.startsWith('יומן נכנס'));
const avg = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / Math.max(1, xs.length);
console.log('\n## סיכום');
console.log(`הודעה בתוך שיחה: קריאת הוראות ${s(avg(fast.map((r) => r.readSec)))} בממוצע, סה"כ ${s(avg(fast.map((r) => r.totalSec)))}.`);
console.log(`שיחה חדשה או מעבר בין שיחות: קריאת הוראות ${s(avg(rows.filter((r) => !fast.includes(r) && r !== join_).map((r) => r.readSec)))} בממוצע.`);
if (join_) console.log(`הפעם הראשונה ששיחה פונה למייל/יומן (קורא פעם אחת את כלי Google): ${s(join_.readSec)}.`);

if (provider) {
  const spent = db.getSetting<{ usd: number }>('cloud.spend', { usd: 0 }).usd;
  console.log(`עלות בענן: $${spent.toFixed(3)} (הערכה לפי מחירון)`);
}

app.server.close();
db.close();
process.exit(0);
