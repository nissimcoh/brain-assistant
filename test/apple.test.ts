// Apple: calendar, reminders, contacts, notes, messages, with a fake Brain Helper (no Mac needed).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, systemPrompt } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { createApp } from '../server/app.ts';
import { INTENTS } from '../server/agent.ts';
import { AppleError, asText, createApple, messageScript, normalizeRecipient, noteCreateScript } from '../server/apple.ts';
import type { Google } from '../server/google.ts';
import { resolveDays } from '../server/google.ts';

// ---------------------------------------------------------------- fake helper
const calls: Record<string, unknown>[] = [];
let noIMessage = false;
const CALS = [
  { id: 'c1', title: 'בית', source: 'iCloud', writable: true, default: true },
  { id: 'c2', title: 'עבודה', source: 'iCloud', writable: true, default: false },
  { id: 'c3', title: 'חגים בישראל', source: 'Other', writable: false, default: false },
];
const LISTS = [
  { id: 'l1', title: 'תזכורות', default: true },
  { id: 'l2', title: 'קניות', default: false },
];
const tomorrow = resolveDays('מחר')!.from;
async function fakeRun(req: Record<string, unknown>) {
  calls.push(req);
  switch (req.op) {
    case 'status':
      return { calendar: 'full', reminders: 'full', contacts: 'full', calendars: CALS, lists: LISTS };
    case 'events':
      return {
        calendars: CALS,
        events: [
          { title: 'רופא שיניים', start: `${tomorrow}T10:00:00+02:00`, end: `${tomorrow}T11:00:00+02:00`, allDay: false, location: 'הרצל 5', calendar: 'בית' },
          { title: 'חנוכה', start: tomorrow, end: tomorrow, allDay: true, location: '', calendar: 'חגים בישראל' },
          { title: 'ישיבת צוות', start: `${tomorrow}T09:00:00+02:00`, end: `${tomorrow}T09:30:00+02:00`, allDay: false, location: '', calendar: 'עבודה' },
        ],
      };
    case 'createEvent':
      return { id: 'e1', calendar: CALS.find((c) => c.id === req.calendar)?.title ?? 'בית' };
    case 'reminders':
      return { lists: LISTS, reminders: [{ id: 'r1', title: 'לקנות חלב', due: `${tomorrow}T08:00:00+02:00`, list: 'קניות', notes: '' }] };
    case 'createReminder':
      return { id: 'r2', list: LISTS.find((l) => l.id === req.list)?.title ?? 'תזכורות' };
    case 'completeReminder':
      return { title: 'לקנות חלב' };
    case 'contacts':
      return {
        contacts: [
          { name: 'דני כהן', nickname: '', phones: [{ label: 'נייד', number: '050-1234567' }], emails: [{ label: 'בית', email: 'danny@example.com' }] },
        ],
      };
    case 'applescript': {
      const src = String(req.source);
      if (src.includes('every note whose')) return { output: ['x-coredata://n1\u001fקניות\u001f2026-11-20T10:00:00\u001fחלב, לחם'].join('\u001e') };
      if (src.includes('note id')) return { output: 'קניות\u001f2026-11-20T10:00:00\u001fחלב\nלחם' };
      if (src.includes('make new note')) return { output: 'x-coredata://n2' };
      if (src.includes('Messages')) {
        if (noIMessage && src.includes('= iMessage')) throw new AppleError('applescript', 'שגיאה מ־Apple: 9001: no iMessage account');
        return { output: 'ok' };
      }
      return { output: '' };
    }
  }
  throw new AppleError('bad-request', 'unknown');
}
const fakeApple = () => createApple({ dataDir: tmpdir(), platform: 'darwin', run: fakeRun });

/** A connected Google with one calendar event that duplicates the Apple one, and one contact. */
function fakeGoogle(): Google {
  const g = {
    available: async () => true,
    knownAccounts: () => [{ key: '1', label: 'אישי', email: 'me@gmail.com', refreshToken: '' }],
    cardAccount: () => '',
    listEvents: async () => ({
      events: [
        { title: 'רופא שיניים', start: `${tomorrow}T10:00:00+02:00`, end: `${tomorrow}T11:00:00+02:00`, allDay: false, location: '', calendar: '', link: '' },
        { title: 'משחק כדורגל', start: `${tomorrow}T20:00:00+02:00`, end: `${tomorrow}T22:00:00+02:00`, allDay: false, location: '', calendar: '', link: '' },
      ],
      problems: [],
    }),
    findContacts: async () => [{ name: 'Danny Work', email: 'danny@company.com' }, { name: 'דני', email: 'DANNY@example.com' }],
    createEvent: async (e: Record<string, unknown>) => {
      calls.push({ op: 'google.createEvent', ...e });
      return { id: 'g1', link: '', guests: e.guests ? [String(e.guests)] : [], account: '' };
    },
  };
  return g as unknown as Google;
}

// ---------------------------------------------------------------- fake Ollama
interface OllamaRequest {
  tools?: { function: { name: string } }[];
  messages: { role: string; content: string }[];
}
const requests: OllamaRequest[] = [];
const line = (o: unknown) => JSON.stringify(o) + '\n';
const ollama = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'gemma4:e4b' }] }));
  if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion', 'tools'] }));
  if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
  const r = JSON.parse(body) as OllamaRequest;
  requests.push(r);
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const say = (t: string) => {
    res.write(line({ message: { content: t }, done: false }));
    res.end(line({ message: { content: '' }, done: true }));
  };
  const call = (name: string, args: Record<string, unknown>) => {
    res.write(line({ message: { content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: false }));
    res.end(line({ message: { content: '' }, done: true }));
  };
  const last = r.messages.at(-1)!;
  if (last.role === 'tool') return say(`דיווח: ${last.content}`);
  const t = last.content;
  if (t.includes('ביומן') && t.startsWith('מה')) return call('calendar_events', { when: 'מחר' });
  if (t.includes('תקבע')) {
    return call('calendar_create', {
      title: 'רופא', date: 'מחר', start: '10:00',
      ...(t.includes('גוגל') ? { calendar: 'גוגל' } : {}),
      ...(t.includes('עבודה') ? { calendar: 'עבודה' } : {}),
      ...(t.includes('מוזמן') ? { guests: 'a@b.com' } : {}),
    });
  }
  if (t.includes('תזכיר') && t.includes('בשמונה')) return call('reminder_create', { title: 'להתקשר לבנק', time: '8' });
  if (t.includes('תזכיר')) return call('reminder_create', { title: 'להתקשר לבנק', date: 'מחר', time: '8', list: 'קניות' });
  if (t.includes('תזכורות')) return call('reminders_list', {});
  if (t.includes('פתק')) return call('note_create', { title: 'קניות', body: 'חלב\nלחם "טרי"' });
  if (t.includes('הודעה')) return call('message_send', { to: '050-1234567', text: 'אני מגיע', name: 'דני' });
  if (t.includes('טלפון של')) return call('find_contact', { name: 'דני' });
  say('בסדר.');
});

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
let ollamaUrl = '';
const servers: { server: Server; db: ReturnType<typeof openDb> }[] = [];

async function brain(opts: { apple?: ReturnType<typeof createApple> | null; google?: Google | null }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'brain-apple-'));
  const db = openDb(join(dataDir, 'brain.db'));
  const app = createApp(loadConfig({ dataDir, ollamaUrl, localModel: 'gemma4:e4b', port: 0 }), db, {
    platform: 'darwin', exec: async () => ({ stdout: '', stderr: '' }), autoWarm: false,
    apple: opts.apple ?? null, google: opts.google ?? null,
  });
  servers.push({ server: app.server, db });
  const base = `http://127.0.0.1:${await listen(app.server)}`;
  const { code } = app.auth.newPairingCode();
  const { token } = (await (await fetch(`${base}/api/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceName: 'בדיקות' }),
  })).json()) as { token: string };
  const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const chat = async (text: string, conversationId?: string) => {
    const raw = await (await fetch(`${base}/api/chat`, { method: 'POST', headers: H, body: JSON.stringify({ text, conversationId }) })).text();
    return raw.split('\n\n').filter(Boolean).map((f) => ({
      event: f.match(/^event: (.+)$/m)?.[1] ?? '',
      data: JSON.parse(f.match(/^data: (.+)$/m)?.[1] ?? 'null'),
    }));
  };
  const approve = async (id: string, args?: Record<string, string>) =>
    (await fetch(`${base}/api/actions/${id}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'approve', args }) })).text();
  return { base, H, chat, approve };
}
const card = (evs: { event: string; data: any }[]) => evs.find((e) => e.event === 'approval')?.data;
const toolNames = (r: OllamaRequest) => (r.tools ?? []).map((t) => t.function.name);

before(async () => {
  ollamaUrl = `http://127.0.0.1:${await listen(ollama)}`;
});
after(() => {
  for (const s of servers) {
    s.server.close();
    s.db.close();
  }
  ollama.close();
});
beforeEach(() => {
  calls.length = 0;
  requests.length = 0;
  noIMessage = false;
});

// ================================================================ pieces
test('AppleScript text is always one safe string', () => {
  assert.equal(asText('שלום'), '"שלום"');
  assert.equal(asText('a "b" \\ c'), '"a \\"b\\" \\\\ c"');
  assert.equal(asText('שורה 1\nשורה 2'), '"שורה 1" & linefeed & "שורה 2"');
  const evil = 'x" & (do shell script "rm -rf ~") & "';
  assert.ok(messageScript('+972501234567', evil, 'iMessage').includes('send "x\\" & (do shell script \\"rm -rf ~\\") & \\"" to p'));
  assert.ok(noteCreateScript('<b>', 'a & b').includes('&lt;b&gt;'), 'HTML in a note is escaped');
});

test('phone numbers become +972…', () => {
  assert.equal(normalizeRecipient('050-123-4567'), '+972501234567');
  assert.equal(normalizeRecipient('(02) 6543210'), '+97226543210');
  assert.equal(normalizeRecipient('972501234567'), '+972501234567');
  assert.equal(normalizeRecipient('+1 415 555 0100'), '+14155550100');
  assert.equal(normalizeRecipient('dana@icloud.com'), 'dana@icloud.com');
  assert.throws(() => normalizeRecipient('דני'), (e: AppleError) => /זה לא מספר טלפון/.test(e.userMessage));
});

test('not set up: a clear message, and nothing runs', async () => {
  const a = createApple({ dataDir: tmpdir(), platform: 'darwin', appPath: '/nonexistent/Brain Helper.app' });
  assert.equal(a.installed(), false);
  assert.equal(await a.has('calendar'), false);
  await assert.rejects(a.events('2026-11-22', '2026-11-23'), (e: AppleError) => /npm run apple:setup/.test(e.userMessage));
});

test('which words bring which tools', () => {
  const groups = (t: string) => Object.entries(INTENTS).filter(([, re]) => re.test(t)).map(([g]) => g);
  assert.deepEqual(groups('תזכיר לי מחר ב-8 להתקשר לבנק'), ['reminders']);
  assert.deepEqual(groups('תרשום לי פתק עם רשימת קניות'), ['notes']);
  assert.deepEqual(groups('תשלח הודעה לדני שאני מגיע'), ['messages']);
  assert.deepEqual(groups('מה הטלפון של דני?'), ['contacts']);
  assert.deepEqual(groups('מה יש לי מחר?'), ['calendar']);
  assert.deepEqual(groups('יש לי מיילים חדשים?'), ['mail']);
  assert.deepEqual(groups('מה השעה?'), []);
  // Writing to someone, even without the word "הודעה" (and with a typo in "iMessage").
  assert.deepEqual(groups('תשלח ליואב אחי שאני בדרך אליו'), ['messages']);
  assert.deepEqual(groups('תכתוב לו דרך imassage'), ['messages']);
  assert.deepEqual(groups('תגיד לאמא שאני מאחר'), ['messages']);
  assert.deepEqual(groups('תכתוב לי שיר על הים'), [], '"לי" is the user');
  assert.deepEqual(groups('תשלח לי את הקובץ'), []);
  assert.deepEqual(groups('תזכור שאני אוהב קפה'), [], '"תזכור" (memory) is not a reminder');
});

// ================================================================ in Brain
test('the calendar: Apple and Google together, each event once, calendars named', async () => {
  const { chat } = await brain({ apple: fakeApple(), google: fakeGoogle() });
  await chat('מה יש לי מחר ביומן?');
  const result = requests.at(-1)!.messages.at(-1)!.content;
  assert.match(result, /09:00–09:30 · ישיבת צוות \(עבודה\)/);
  assert.match(result, /10:00–11:00 · רופא שיניים · הרצל 5 \(בית\)/);
  assert.match(result, /20:00–22:00 · משחק כדורגל \(Google\)/);
  assert.equal(result.match(/רופא שיניים/g)!.length, 1, 'the same event in Apple and Google is listed once');
  assert.match(result, /כל היום · חנוכה/);
  const events = calls.find((c) => c.op === 'events')!;
  assert.deepEqual([events.from, events.to], [tomorrow, resolveDays('מחרתיים')!.from], 'the whole day, Israel time');
});

test('a new event goes to the Mac calendar; the card shows which, and it can be changed', async () => {
  const { chat, approve } = await brain({ apple: fakeApple(), google: fakeGoogle() });
  const c = card(await chat('תקבע לי רופא מחר ב-10'));
  assert.equal(c.fields[0].label, 'ביומן');
  assert.equal(c.fields[0].value, 'בית', 'the default calendar');
  await approve(c.id, { calendar: 'עבודה' });
  const made = calls.find((x) => x.op === 'createEvent')!;
  assert.deepEqual([made.calendar, made.start, made.end, made.title], ['c2', `${tomorrow}T10:00`, `${tomorrow}T11:00`, 'רופא']);

  const g = card(await chat('תקבע לי רופא מחר ב-10 ביומן גוגל'));
  assert.equal(g.fields[0].value, 'Google');
  await approve(g.id);
  assert.ok(calls.some((x) => x.op === 'google.createEvent'), '"ביומן גוגל" goes to Google');

  const evs = await chat('תקבע לי רופא מחר ב-10 עם מוזמן');
  assert.equal(card(evs), undefined, 'guests can only be invited in Google');
  assert.match(requests.find((r) => r.messages.at(-1)!.role === 'tool' && /מוזמנים/.test(r.messages.at(-1)!.content))!.messages.at(-1)!.content, /רק ביומן Google/);
});

test('a reminder: the card, the list, and the time that makes the iPhone ring', async () => {
  const { chat, approve } = await brain({ apple: fakeApple() });
  const evs = await chat('תזכיר לי מחר ב-8 להתקשר לבנק');
  assert.ok(toolNames(requests[0]).includes('reminder_create'));
  assert.ok(!toolNames(requests[0]).includes('message_send'), 'only the reminders group joined');
  assert.match(requests[0].messages[0].content, /תזכורת עם שעה מצלצלת באייפון/);
  const c = card(evs);
  assert.deepEqual(c.fields.map((f: { label: string }) => f.label), ['תזכורת', 'תאריך', 'שעה', 'רשימה']);
  assert.match(c.summary, /ב־08:00 \(יצלצל באייפון\) ברשימה קניות/);
  await approve(c.id);
  const made = calls.find((x) => x.op === 'createReminder')!;
  assert.deepEqual([made.title, made.due, made.list], ['להתקשר לבנק', `${tomorrow}T08:00`, 'l2']);
});

test('a reminder with a time and no day: today if still ahead, otherwise tomorrow', async () => {
  const { chat } = await brain({ apple: fakeApple() });
  const c = card(await chat('תזכיר לי בשמונה להתקשר לבנק'));
  const date = c.fields.find((f: { key: string }) => f.key === 'date').value;
  assert.ok([resolveDays('היום')!.from, tomorrow].includes(date));
});

test('open reminders are listed with their day and list', async () => {
  const { chat } = await brain({ apple: fakeApple() });
  await chat('מה התזכורות שלי?');
  assert.match(requests.at(-1)!.messages.at(-1)!.content, /• לקנות חלב · .*08:00/);
});

test('a note is created only after approval, with its text intact', async () => {
  const { chat, approve } = await brain({ apple: fakeApple() });
  const c = card(await chat('תרשום לי פתק קניות'));
  assert.ok(!calls.some((x) => x.op === 'applescript'), 'nothing before approval');
  await approve(c.id);
  const src = String(calls.find((x) => x.op === 'applescript')!.source);
  assert.match(src, /make new note with properties \{body:"<div><b>קניות<\/b><\/div><div>חלב<\/div><div>לחם \\"טרי\\"<\/div>"\}/);
});

test('a message: number from the card, iMessage first, SMS when there is no iMessage', async () => {
  const { chat, approve } = await brain({ apple: fakeApple() });
  const evs = await chat('תשלח הודעה לדני שאני מגיע');
  assert.ok(toolNames(requests[0]).includes('find_contact'), 'messages bring contacts along');
  const c = card(evs);
  assert.equal(c.fields[0].value, '+972501234567');
  assert.match(c.summary, /לשלוח הודעה לדני/);
  noIMessage = true;
  const raw = await approve(c.id, { text: 'אני מגיע בעוד רבע שעה' });
  assert.match(raw, /נשלחה ב־SMS/);
  const sent = calls.filter((x) => x.op === 'applescript').map((x) => String(x.source));
  assert.equal(sent.length, 2);
  assert.match(sent[1], /service type = SMS/);
  assert.match(sent[1], /participant "\+972501234567"/);
  assert.match(sent[1], /send "אני מגיע בעוד רבע שעה" to p/);
});

test('"תשלח ליואב ש…" without the word "הודעה": the message tools are offered, and the model is told it can send', async () => {
  const { chat } = await brain({ apple: fakeApple() });
  requests.length = 0;
  await chat('תשלח ליואב אחי שאני בדרך אליו');
  const names = toolNames(requests[0]);
  assert.ok(names.includes('message_send') && names.includes('find_contact'));
  const system = requests[0].messages[0].content;
  assert.match(system, /הודעה רגילה \(iMessage או SMS\) מהמק עם message_send/);
  assert.doesNotMatch(system, /אין לך גישה להודעות\. אם מבקשים/);
});

test('contacts: phone from the Mac, email from Google, no duplicates', async () => {
  const { chat } = await brain({ apple: fakeApple(), google: fakeGoogle() });
  await chat('מה הטלפון של דני?');
  const result = requests.at(-1)!.messages.at(-1)!.content;
  assert.match(result, /דני כהן · נייד: 050-1234567 · מייל: danny@example\.com/);
  assert.match(result, /Danny Work · מייל: danny@company\.com/);
  assert.equal(result.match(/danny@example\.com/gi)!.length, 1);
});

test('not set up: the model is told how to connect', async () => {
  const { chat } = await brain({ apple: null });
  await chat('תזכיר לי מחר ב-8 להתקשר לבנק');
  assert.ok(!toolNames(requests[0]).includes('reminder_create'));
  assert.match(requests[0].messages[0].content, /אין לך גישה לתזכורות.*npm run apple:setup/);
});

test('the start of the instructions never changes with these lines', () => {
  const plain = systemPrompt(new Date(), []);
  assert.ok(systemPrompt(new Date(), [], { groups: ['calendar', 'reminders'], off: ['notes'] }).startsWith(plain));
});

test('simultaneous Apple permission checks share one helper launch', async () => {
  let calls = 0;
  const apple = createApple({ dataDir: tmpdir(), platform: 'darwin', run: async () => {
    calls++;
    return { calendar: 'full', reminders: 'full', contacts: 'full' };
  } });
  assert.equal(await apple.has('notes'), true);
  assert.equal(calls, 0);
  assert.deepEqual(await Promise.all([apple.has('contacts'), apple.has('reminders'), apple.has('calendar')]), [true, true, true]);
  assert.equal(calls, 1);
  await apple.status(true);
  assert.equal(calls, 2);
});

test('calendar streams each pending provider and goes back to the model before writing', async () => {
  const { chat } = await brain({ apple: fakeApple(), google: fakeGoogle() });
  const events = await chat('מה יש לי ביומן מחר?');
  const labels = events.filter(e => e.event === 'progress').map(e => e.data.label as string);
  assert.ok(labels.some(s => s.includes('Apple') && s.includes('Google')));
  assert.ok(labels.some(s => s.includes('Google') && !s.includes('Apple')) || labels.some(s => s.includes('Apple') && !s.includes('Google')));
  assert.equal(labels.at(-1), 'כותב תשובה…');
  assert.ok(labels.at(-2)?.includes('מודל'));
});
