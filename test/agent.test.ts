import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { createApp } from '../server/app.ts';
import { LOCAL_MAX_TOKENS, quickAnswer, shouldThink, watchdog } from '../server/agent.ts';

// ---------- scripted fake Ollama ----------
interface OllamaRequest {
  model: string;
  think?: boolean;
  tools?: { function: { name: string } }[];
  messages: { role: string; content: string; tool_name?: string; tool_calls?: { function: { name: string } }[] }[];
  options?: { num_predict?: number };
}
const requests: OllamaRequest[] = [];
const INSTALLED = ['gemma4:e4b', 'other:1b'];

function line(obj: unknown) {
  return JSON.stringify(obj) + '\n';
}

const fakeOllama = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.url === '/api/tags') return res.end(JSON.stringify({ models: INSTALLED.map((name) => ({ name })) }));
  if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion', 'tools', 'thinking'] }));
  if (req.url !== '/api/chat') return res.writeHead(404).end();

  const r = JSON.parse(body) as OllamaRequest;
  requests.push(r);
  const last = r.messages.at(-1)!;
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const say = (text: string) => {
    for (const piece of text.match(/.{1,4}/gs) ?? []) res.write(line({ message: { content: piece }, done: false }));
    res.end(line({ message: { content: '' }, done: true, eval_count: 5, eval_duration: 1e8 }));
  };
  const call = (name: string, args: Record<string, unknown>) => {
    res.write(line({ message: { content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: false }));
    res.end(line({ message: { content: '' }, done: true }));
  };

  if (last.role === 'tool') return say(`דיווח: ${last.content}`);
  const text = last.content;
  if (text.includes('שעה')) return call('get_datetime', {});
  if (text.includes('התראה')) return call('mac_notification', { text: 'שלום', title: 'בדיקה' });
  if (text.includes('שבור')) return call('no_such_tool', {});
  // A model that runs on without showing anything (a tool call it never finishes): stops at the length limit.
  if (text.includes('תקוע')) return res.end(line({ message: { content: '' }, done: true, done_reason: 'length' }));
  if (text.includes('ארוך')) {
    res.write(line({ message: { content: 'התחלה של תשובה ארוכה' }, done: false }));
    return res.end(line({ message: { content: '' }, done: true, done_reason: 'length' }));
  }
  return say('שלום!');
});

// ---------- Brain ----------
let brain: Server;
let base = '';
let db: ReturnType<typeof openDb>;
let token = '';
const execCalls: { file: string; args: string[] }[] = [];

const listen = (s: Server) =>
  new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));

before(async () => {
  const ollamaPort = await listen(fakeOllama);
  const dataDir = mkdtempSync(join(tmpdir(), 'brain-agent-'));
  const config = loadConfig({ dataDir, ollamaUrl: `http://127.0.0.1:${ollamaPort}`, localModel: 'gemma4:e4b', port: 0 });
  db = openDb(join(dataDir, 'brain.db'));
  const app = createApp(config, db, {
    platform: 'darwin',
    exec: async (file, args) => {
      execCalls.push({ file, args });
      return { stdout: 'Now drawing from \'AC Power\'\n -InternalBattery-0 (id=1)\t84%; charging;', stderr: '' };
    },
  });
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
  execCalls.length = 0;
});

const headers = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

async function events(res: Response) {
  assert.equal(res.status, 200, await res.clone().text());
  const text = await res.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => ({
      event: frame.match(/^event: (.+)$/m)?.[1] ?? '',
      data: JSON.parse(frame.match(/^data: (.+)$/m)?.[1] ?? 'null'),
    }));
}
const textOf = (evs: { event: string; data: { text?: string } }[]) =>
  evs.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');

async function chat(text: string, conversationId?: string) {
  return events(await fetch(`${base}/api/chat`, { method: 'POST', headers: headers(), body: JSON.stringify({ text, conversationId }) }));
}
async function decide(actionId: string, decision: 'approve' | 'reject', args?: Record<string, string>) {
  return fetch(`${base}/api/actions/${actionId}`, { method: 'POST', headers: headers(), body: JSON.stringify({ decision, args }) });
}

test('thinking policy', () => {
  assert.equal(shouldThink('auto', 'תשלח לדני שאני מאחר'), false, 'auto starts without thinking');
  assert.equal(shouldThink('off', 'תשלח לדני'), false);
  assert.equal(shouldThink('on', 'היי'), true);
});

/** True when request b starts with exactly what request a sent (so Ollama can reuse its cache). */
const extends_ = (a: OllamaRequest, b: OllamaRequest) =>
  JSON.stringify(a.tools) === JSON.stringify(b.tools) &&
  JSON.stringify(a.messages) === JSON.stringify(b.messages.slice(0, a.messages.length));

test('speed rule: every request in a conversation extends the previous one exactly', async () => {
  const first = await chat('היי');
  const id = first.find((e) => e.event === 'meta')!.data.conversationId;
  await chat('מה השעה בטוקיו?', id); // a tool call and its result: two model requests
  // A fact added in the middle of the conversation must not change what was already sent.
  await fetch(`${base}/api/memories`, { method: 'POST', headers: headers(), body: JSON.stringify({ text: 'המשתמש אוהב קפה שחור' }) });
  await chat('ומה עוד?', id);
  await chat('תציג לי התראה במק', id); // waits for approval
  await chat('לא משנה', id); // expires the pending action
  assert.ok(requests.length >= 6);
  for (let i = 1; i < requests.length; i++) assert.ok(extends_(requests[i - 1], requests[i]), `request ${i + 1} rewrote earlier content`);
  assert.ok(requests.every((r) => r.tools?.length === requests[0].tools!.length), 'the same tools every time');
  assert.ok(!requests.at(-1)!.messages[0].content.includes('קפה שחור'), 'memory snapshot from the conversation start');

  requests.length = 0;
  await chat('היי');
  assert.match(requests[0].messages[0].content, /קפה שחור/, 'a new conversation sees the new fact');
});

test('speed rule: a long conversation drops old messages rarely, in one step', async () => {
  const id = (await chat('היי')).find((e) => e.event === 'meta')!.data.conversationId;
  for (let i = 0; i < 30; i++) await chat(`שורה ${i}`, id);
  let breaks = 0;
  for (let i = 1; i < requests.length; i++) if (!extends_(requests[i - 1], requests[i])) breaks++;
  // 31 turns = 62 messages; the 40-message limit is crossed once, and half the history goes at once.
  assert.equal(breaks, 1, 'exactly one re-read in 31 messages');
  assert.ok(requests.at(-1)!.messages.length <= 41, 'history stays within the limit');
  assert.equal(requests.at(-1)!.messages[1].role, 'user', 'the window starts at a user message');
});

test('"מה השעה?" is answered from the Mac\'s clock at once, without the model', async () => {
  requests.length = 0;
  const evs = await chat('מה השעה?');
  assert.equal(requests.length, 0, 'no model request');
  assert.equal(evs.find((e) => e.event === 'tool')?.data.tool, 'get_datetime');
  assert.match(textOf(evs), /^השעה \d{2}:\d{2}\.$/);
  const id = evs.find((e) => e.event === 'meta')!.data.conversationId;
  // Kept as a clock check in the history, so the model doesn't learn to guess the time.
  await chat('תודה', id);
  const msgs = requests.at(-1)!.messages;
  assert.ok(msgs.some((m) => m.role === 'assistant' && m.tool_calls?.[0]?.function.name === 'get_datetime'));
  assert.equal(quickAnswer('מה השעה עכשיו?', new Date('2026-11-23T19:27:00Z')), 'השעה 21:27.');
  assert.match(quickAnswer('איזה יום היום?', new Date('2026-11-23T19:27:00Z'))!, /^היום יום שני, 23 בנובמבר 2026\.$/);
  assert.equal(quickAnswer('מה השעה בטוקיו?'), null);
  assert.equal(quickAnswer('תזכיר לי בשעה 8'), null);
});

test('a local model that runs on without an answer ends in a clear message, not silence', async () => {
  const stuck = await chat('אתה תקוע?');
  const err = stuck.find((e) => e.event === 'error');
  assert.match(String(err?.data.message), /המודל המקומי נתקע/);
  assert.equal(requests.at(-1)!.options?.num_predict, LOCAL_MAX_TOKENS, 'a length limit on every local answer');
  const long = await chat('תכתוב משהו ארוך');
  assert.match(textOf(long), /^התחלה של תשובה ארוכה\n\n\(התשובה נקטעה/);
});

test('the watchdog stops a silent request, and a word resets it', async () => {
  const labels: string[] = [];
  const w = watchdog(new AbortController().signal, (l) => labels.push(l), false, { first: 40, silence: 40 });
  await new Promise((r) => setTimeout(r, 25));
  w.heard();
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(w.fired, false, 'a word came in time');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(w.fired, true);
  assert.equal(w.signal.aborted, true);
  w.stop();
  // Stopping by the user is not a stall.
  const user = new AbortController();
  const w2 = watchdog(user.signal, () => {}, false, { first: 1000, silence: 1000 });
  user.abort();
  assert.equal(w2.signal.aborted, true);
  assert.equal(w2.fired, false);
  w2.stop();
});

test('read-only tool runs by itself and the model reports the result', async () => {
  const evs = await chat('מה השעה עכשיו בטוקיו?');
  const tool = evs.find((e) => e.event === 'tool');
  assert.equal(tool?.data.tool, 'get_datetime');
  assert.equal(tool?.data.ok, true);
  assert.match(textOf(evs), /^דיווח: /);
  assert.ok(evs.some((e) => e.event === 'done'));
  const offered = requests[0].tools!.map((t) => t.function.name);
  assert.ok(offered.includes('get_datetime') && offered.includes('search_files'), 'every tool is offered, every time');

  const meta = evs.find((e) => e.event === 'meta')!.data;
  const conv = (await (await fetch(`${base}/api/conversations/${meta.conversationId}`, { headers: headers() })).json()) as {
    messages: { role: string; tool_calls: unknown; tool_name: string | null }[];
  };
  assert.deepEqual(conv.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(conv.messages[2].tool_name, 'get_datetime');
  // The second model request carried the tool call and its result.
  assert.equal(requests[1].messages.at(-1)!.role, 'tool');
  assert.ok(requests[1].messages.at(-2)!.tool_calls);
});

test('actions wait for approval, run with edits, and are logged', async () => {
  const evs = await chat('תציג לי התראה במק');
  assert.equal(requests[0].think, false, 'auto mode starts without thinking');
  const approval = evs.find((e) => e.event === 'approval')!.data;
  assert.equal(approval.tool, 'mac_notification');
  assert.equal(approval.status, 'pending');
  assert.deepEqual(
    approval.fields.map((f: { key: string; value: string }) => [f.key, f.value]),
    [
      ['title', 'בדיקה'],
      ['text', 'שלום'],
    ],
  );
  assert.equal(evs.find((e) => e.event === 'done')!.data.awaitingApproval, true);
  assert.equal(execCalls.length, 0, 'nothing runs before approval');

  const after = await events(await decide(approval.id, 'approve', { text: 'שלום עולם' }));
  const action = after.find((e) => e.event === 'action')!.data;
  assert.equal(action.status, 'done');
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].file, 'osascript');
  assert.ok(execCalls[0].args.includes('שלום עולם'), 'the edited text is what ran');
  assert.ok(!execCalls[0].args.some((a) => a.includes('שלום עולם') && a.includes('display')), 'text is passed as data, not code');
  assert.match(textOf(after), /דיווח: ההתראה הוצגה/);

  const again = await decide(approval.id, 'approve');
  assert.equal(again.status, 409, 'an action runs at most once');

  const audit = (await (await fetch(`${base}/api/audit`, { headers: headers() })).json()) as { kind: string; detail: { edited?: boolean } }[];
  const approved = audit.find((a) => a.kind === 'action.approved');
  assert.equal(approved?.detail.edited, true);
  assert.ok(audit.some((a) => a.kind === 'action.proposed'));
});

test('rejected actions never run', async () => {
  const evs = await chat('תציג התראה');
  const approval = evs.find((e) => e.event === 'approval')!.data;
  const res = await events(await decide(approval.id, 'reject'));
  assert.equal(res.find((e) => e.event === 'action')!.data.status, 'rejected');
  assert.equal(execCalls.length, 0);
});

test('a new message expires an action that was never approved', async () => {
  const evs = await chat('תציג התראה');
  const meta = evs.find((e) => e.event === 'meta')!.data;
  const approval = evs.find((e) => e.event === 'approval')!.data;
  await chat('בעצם עזוב', meta.conversationId);
  const late = await decide(approval.id, 'approve');
  assert.equal(late.status, 409);
  assert.equal(execCalls.length, 0);
});

test('an invalid tool call switches thinking on (auto mode)', async () => {
  const evs = await chat('משהו שבור');
  assert.equal(requests[0].think, false);
  assert.equal(requests[1].think, true);
  assert.ok(evs.some((e) => e.event === 'thinking'));
  assert.match(textOf(evs), /דיווח: קריאה לא תקינה/);
});

test('settings: choose an installed model and the thinking mode', async () => {
  const bad = await fetch(`${base}/api/settings`, { method: 'PUT', headers: headers(), body: JSON.stringify({ localModel: 'not-installed' }) });
  assert.equal(bad.status, 400);

  const ok = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ localModel: 'other:1b', thinking: 'off' }),
  });
  assert.equal(ok.status, 200);
  const evs = await chat('תציג התראה');
  assert.equal(requests[0].model, 'other:1b');
  assert.equal(requests[0].think, false);
  assert.equal(evs.find((e) => e.event === 'meta')!.data.model, 'other:1b');

  const got = (await (await fetch(`${base}/api/settings`, { headers: headers() })).json()) as { models: string[] };
  assert.deepEqual(got.models, INSTALLED);
  await fetch(`${base}/api/settings`, { method: 'PUT', headers: headers(), body: JSON.stringify({ localModel: 'gemma4:e4b', thinking: 'auto' }) });
});

test('mac_status reads battery through the injected exec', async () => {
  const { createToolRegistry } = await import('../server/tools.ts');
  const tool = createToolRegistry().get('mac_status')!;
  const out = await tool.run({}, {
    platform: 'darwin',
    exec: async () => ({ stdout: "'AC Power'\n 84%; charging;", stderr: '' }),
    memory: { list: () => [], get: () => undefined, find: () => undefined, add: () => { throw new Error('unused'); }, remove: () => false },
    search: () => [],
  });
  assert.match(out, /סוללה: 84%, מחובר לחשמל, נטען/);
  assert.match(out, /זיכרון/);
});

test('migration keeps stage-0 conversations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-mig-'));
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), content TEXT NOT NULL, model TEXT, engine TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX messages_by_conversation ON messages (conversation_id);
    INSERT INTO conversations VALUES ('c1', 'ישנה', 1, 1);
    INSERT INTO messages VALUES ('m1', 'c1', 'user', 'שלום', NULL, NULL, 1);
    INSERT INTO messages VALUES ('m2', 'c1', 'assistant', 'היי', 'gemma4:e4b', 'local', 2);
  `);
  old.close();

  const migrated = openDb(path);
  assert.equal(migrated.schemaVersion(), 6);
  assert.equal(migrated.listMessages('c1')[0].attachments, null, 'old messages have no attachments');
  const msgs = migrated.listMessages('c1');
  assert.deepEqual(msgs.map((m) => m.content), ['שלום', 'היי']);
  assert.equal(msgs[1].model, 'gemma4:e4b');
  assert.equal(migrated.getConversation('c1')!.title_source, 'first', 'old conversations will get a name later');
  migrated.addMessage('c1', 'tool', 'תוצאה', { toolName: 'get_datetime' });
  assert.equal(migrated.listMessages('c1').length, 3);
  migrated.close();
  // Opening again is a no-op.
  const again = openDb(path);
  assert.equal(again.schemaVersion(), 6);
  again.close();
});

test('conversation names from the model are cleaned up', async () => {
  const { cleanTitle } = await import('../server/agent.ts');
  assert.equal(cleanTitle('"קורות חיים באנגלית".'), 'קורות חיים באנגלית');
  assert.equal(cleanTitle('**שם:** בירת צרפת\nועוד שורה'), 'בירת צרפת');
  assert.equal(cleanTitle('\n\n'), '');
  assert.ok(cleanTitle('א'.repeat(100)).length <= 60);
});
