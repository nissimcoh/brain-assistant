import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { createApp } from '../server/app.ts';
import { sensitiveReason } from '../server/tools.ts';

// ---------- scripted fake Ollama ----------
interface Req {
  messages: { role: string; content: string; tool_name?: string }[];
}
const requests: Req[] = [];
const line = (o: unknown) => JSON.stringify(o) + '\n';

const fakeOllama = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'gemma4:e4b' }] }));
  if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['tools'] }));
  const r = JSON.parse(body) as Req;
  requests.push(r);
  const last = r.messages.at(-1)!;
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const say = (t: string) => res.end(line({ message: { content: t } }) + line({ done: true }));
  const call = (name: string, args: Record<string, unknown>) =>
    res.end(line({ message: { content: '', tool_calls: [{ function: { name, arguments: args } }] } }) + line({ done: true }));

  if (last.role === 'tool') return say(`דיווח: ${last.content}`);
  const t = last.content;
  if (t.startsWith('תזכור')) return call('remember', { fact: t.replace(/^תזכור ש?/, '') });
  if (t.startsWith('תשכח')) {
    // The model reads the memory number from the system prompt.
    const id = r.messages[0].content.match(/\[#(\d+)\] [^\n]*מיכל/)?.[1];
    return call('forget', { id });
  }
  if (t.startsWith('מה דיברנו על')) return call('search_history', { query: t.replace('מה דיברנו על ', '').replace('?', '') });
  return say('בסדר');
});

let brain: Server;
let base = '';
let db: ReturnType<typeof openDb>;
let token = '';
const listen = (s: Server) =>
  new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));

before(async () => {
  const port = await listen(fakeOllama);
  const dataDir = mkdtempSync(join(tmpdir(), 'brain-mem-'));
  const config = loadConfig({ dataDir, ollamaUrl: `http://127.0.0.1:${port}`, localModel: 'gemma4:e4b', port: 0 });
  db = openDb(join(dataDir, 'brain.db'));
  const app = createApp(config, db, { platform: 'darwin', exec: async () => ({ stdout: '', stderr: '' }) });
  brain = app.server;
  base = `http://127.0.0.1:${await listen(brain)}`;
  const { code } = app.auth.newPairingCode();
  const res = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'בדיקות' }),
  });
  token = ((await res.json()) as { token: string }).token;
});
after(() => {
  brain.close();
  fakeOllama.close();
  db.close();
});
beforeEach(() => {
  requests.length = 0;
});

const H = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
async function events(res: Response) {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((f) => ({ event: f.match(/^event: (.+)$/m)?.[1] ?? '', data: JSON.parse(f.match(/^data: (.+)$/m)?.[1] ?? 'null') }));
}
const chat = async (text: string, conversationId?: string) =>
  events(await fetch(`${base}/api/chat`, { method: 'POST', headers: H(), body: JSON.stringify({ text, conversationId }) }));
const memories = async () => (await (await fetch(`${base}/api/memories`, { headers: H() })).json()) as { id: number; text: string; source: string }[];
const systemOf = (r: Req) => r.messages[0].content;

test('"remember" saves a fact and a new conversation knows it', async () => {
  const evs = await chat('תזכור שאשתי קוראים לה מיכל');
  const tool = evs.find((e) => e.event === 'tool')!.data;
  assert.equal(tool.tool, 'remember');
  assert.match(tool.chip, /🧠 נשמר בזיכרון: אשתי קוראים לה מיכל/);
  const list = await memories();
  assert.equal(list.length, 1);
  assert.equal(list[0].source, 'chat');

  await chat('היי'); // brand-new conversation
  assert.match(systemOf(requests.at(-1)!), /\[#\d+\] אשתי קוראים לה מיכל/);
});

test('the same fact is not stored twice', async () => {
  await chat('תזכור שאשתי קוראים לה מיכל');
  assert.equal((await memories()).length, 1);
});

test('secrets are refused even if the model tries to save them', async () => {
  const evs = await chat('תזכור שמספר הכרטיס שלי 4580 1234 5678 9012');
  const tool = evs.find((e) => e.event === 'tool')!.data;
  assert.equal(tool.ok, false);
  assert.match(tool.error, /כרטיס/);
  assert.ok(!(await memories()).some((m) => m.text.includes('4580')));
  assert.ok(sensitiveReason('הסיסמה למייל היא abc123'));
  assert.ok(sensitiveReason('ת"ז 123456789'));
  assert.equal(sensitiveReason('הבן שלי נולד ב־2019 ומשחק כדורגל'), null);
  assert.equal(sensitiveReason('הטלפון של אמא 050-1234567'), null);
});

test('manual add, edit and delete from the memory screen', async () => {
  const add = await fetch(`${base}/api/memories`, { method: 'POST', headers: H(), body: JSON.stringify({ text: 'אוהב קפה בלי סוכר' }) });
  assert.equal(add.status, 200);
  const m = (await add.json()) as { id: number; source: string };
  assert.equal(m.source, 'manual');

  const dup = await fetch(`${base}/api/memories`, { method: 'POST', headers: H(), body: JSON.stringify({ text: 'אוהב קפה בלי סוכר' }) });
  assert.equal(dup.status, 409);

  await fetch(`${base}/api/memories/${m.id}`, { method: 'PUT', headers: H(), body: JSON.stringify({ text: 'אוהב קפה עם חלב, בלי סוכר' }) });
  await chat('היי');
  assert.match(systemOf(requests.at(-1)!), /קפה עם חלב/);

  await fetch(`${base}/api/memories/${m.id}`, { method: 'DELETE', headers: H() });
  await chat('היי');
  assert.doesNotMatch(systemOf(requests.at(-1)!), /קפה/, 'a deleted fact is gone from the next conversation');

  const audit = (await (await fetch(`${base}/api/audit`, { headers: H() })).json()) as { kind: string }[];
  for (const kind of ['memory.added', 'memory.edited', 'memory.deleted']) assert.ok(audit.some((a) => a.kind === kind), kind);
});

test('"forget" asks for approval, then removes the fact', async () => {
  const evs = await chat('תשכח את השם של אשתי');
  const approval = evs.find((e) => e.event === 'approval')!.data;
  assert.equal(approval.tool, 'forget');
  assert.match(approval.summary, /למחוק מהזיכרון: "אשתי קוראים לה מיכל"/);
  assert.equal((await memories()).length, 1, 'nothing is deleted before approval');

  const res = await fetch(`${base}/api/actions/${approval.id}`, { method: 'POST', headers: H(), body: JSON.stringify({ decision: 'approve' }) });
  const after = await events(res);
  assert.equal(after.find((e) => e.event === 'action')!.data.status, 'done');
  assert.equal((await memories()).length, 0);
  await chat('היי');
  assert.doesNotMatch(systemOf(requests.at(-1)!), /מיכל/);
});

test('search finds Hebrew words inside longer words, and forgets deleted conversations', async () => {
  const evs = await chat('בשבוע הבא נוסעים לאילת עם הילדים');
  const conversationId = evs.find((e) => e.event === 'meta')!.data.conversationId;

  const hits = (await (await fetch(`${base}/api/search?q=${encodeURIComponent('אילת')}`, { headers: H() })).json()) as {
    conversationId: string;
    snippet: string;
  }[];
  assert.ok(hits.some((h) => h.conversationId === conversationId && h.snippet.includes('לאילת')));

  // The model can search too (from another conversation).
  const viaTool = await chat('מה דיברנו על אילת?');
  const report = viaTool.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
  assert.match(report, /נוסעים לאילת/);

  await fetch(`${base}/api/conversations/${conversationId}`, { method: 'DELETE', headers: H() });
  const after = (await (await fetch(`${base}/api/search?q=${encodeURIComponent('אילת')}`, { headers: H() })).json()) as {
    conversationId: string;
  }[];
  assert.ok(!after.some((h) => h.conversationId === conversationId), 'deleted conversations are not searchable');

  const short = (await (await fetch(`${base}/api/search?q=${encodeURIComponent('הי')}`, { headers: H() })).json()) as unknown[];
  assert.ok(Array.isArray(short));
});

test('facts brought from elsewhere: one per line, no secrets, no duplicates', async () => {
  const { planImport } = await import('../server/importer.ts');
  const plan = planImport(
    [
      '# מה ChatGPT יודע עליי',
      '- שמו יוסי לוי',
      '2. גר בישראל',
      '• אוהב קפה שחור',
      '',
      '* הסיסמה שלו לבנק היא 1234',
      '- גר בישראל',
      '- כבר שמור',
      `- ${'א'.repeat(301)}`,
    ].join('\n'),
    ['כבר שמור'],
  );
  assert.deepEqual(plan.add, ['שמו יוסי לוי', 'גר בישראל', 'אוהב קפה שחור']);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ['נראה כמו סיסמה או קוד', 'כבר בזיכרון', 'כבר בזיכרון', 'ארוך מ־300 תווים: לקצר או לפצל']);
});
