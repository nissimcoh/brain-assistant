// Stage 2 (hybrid): the cloud engine (OpenAI / Anthropic), when it's used, and what it may see.
// Against fake providers: no key, no network, no cost.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { createApp } from '../server/app.ts';
import {
  CLOUD_ASK, cloudSettings, estimateCost, isComplex, LOCAL_ASK, pairCalls, streamCloud, toAnthropic, toOpenAI,
} from '../server/cloud.ts';
import type { ChatMessage } from '../server/ollama.ts';

// ---------------------------------------------------------------- conversation shapes
const convo: ChatMessage[] = [
  { role: 'system', content: 'הוראות' },
  { role: 'user', content: 'מה יש בשולחן העבודה ותזכיר לי' },
  { role: 'assistant', content: '', tool_calls: [
    { function: { name: 'list_folder', arguments: { path: 'Desktop' } } },
    { function: { name: 'reminder_create', arguments: { title: 'x' } } },
  ] },
  { role: 'tool', content: 'a.txt', tool_name: 'list_folder' },
  { role: 'user', content: 'תודה' },
];

test('every call gets an answer by id, also one that never ran', () => {
  const turns = pairCalls(convo);
  const tools = turns.filter((t) => t.role === 'tool') as { id: string; name: string; content: string }[];
  assert.deepEqual(tools.map((t) => [t.name, t.content]), [['list_folder', 'a.txt'], ['reminder_create', 'לא בוצע.']]);
  const oa = toOpenAI(convo) as { role: string; tool_calls?: { id: string; function: { arguments: string } }[]; tool_call_id?: string }[];
  const ids = oa[2].tool_calls!.map((c) => c.id);
  assert.deepEqual(oa.filter((m) => m.role === 'tool').map((m) => m.tool_call_id), ids);
  assert.equal(oa[2].tool_calls![0].function.arguments, '{"path":"Desktop"}');
});

test('Anthropic: instructions apart, results and the next question in one user turn', () => {
  const { system, messages } = toAnthropic(convo);
  assert.equal(system, 'הוראות');
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(messages[2].content.map((b) => b.type), ['tool_result', 'tool_result', 'text']);
  assert.deepEqual(messages[1].content.map((b) => b.type), ['tool_use', 'tool_use']);
});

// ---------------------------------------------------------------- fake providers
interface Sent { url: string; headers: Record<string, string>; body: Record<string, any>; raw: string }
const sent: Sent[] = [];
const sse = (frames: unknown[], named = false) =>
  frames.map((f) => (f === '[DONE]' ? 'data: [DONE]\n\n' : `${named ? `event: ${(f as { type: string }).type}\n` : ''}data: ${JSON.stringify(f)}\n\n`)).join('');

/** What the fake model says: a tool call when asked to trash, a report after a tool, otherwise a fixed answer. */
function decide(lastUser: string, afterTool: boolean): { text?: string; call?: { name: string; args: Record<string, unknown> } } {
  if (afterTool) return { text: 'סיכום מהענן' };
  if (lastUser.includes('תעביר לסל')) return { call: { name: 'trash_file', args: { path: trashTarget } } };
  return { text: 'תשובה מהענן' };
}

let failWith = 0;
const fakeCloud: typeof fetch = async (url, init) => {
  const raw = String(init?.body ?? '');
  const body = JSON.parse(raw);
  sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body, raw });
  if (failWith) return new Response('{"error":{"message":"bad key"}}', { status: failWith });
  if (String(url).includes('openai')) {
    const last = body.messages.at(-1);
    const lastUser = [...body.messages].reverse().find((m: { role: string }) => m.role === 'user')?.content ?? '';
    const r = decide(lastUser, last.role === 'tool');
    const frames: unknown[] = [];
    if (r.text) for (const piece of [r.text.slice(0, 4), r.text.slice(4)]) frames.push({ choices: [{ delta: { content: piece } }] });
    if (r.call) {
      const args = JSON.stringify(r.call.args);
      frames.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: r.call.name, arguments: args.slice(0, 5) } }] } }] });
      frames.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] } }] });
    }
    frames.push({ choices: [], usage: { prompt_tokens: 2000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 1000 } } });
    frames.push('[DONE]');
    return new Response(sse(frames), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  const last = body.messages.at(-1);
  const blocks = last.content as { type: string; text?: string }[];
  const userText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  const r = decide(userText, blocks.at(-1)?.type === 'tool_result');
  const frames: unknown[] = [{ type: 'message_start', message: { usage: { input_tokens: 1500, cache_read_input_tokens: 500 } } }];
  if (r.text) {
    frames.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    frames.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: r.text } });
  }
  if (r.call) {
    frames.push({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: r.call.name, input: {} } });
    const args = JSON.stringify(r.call.args);
    frames.push({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: args.slice(0, 3) } });
    frames.push({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: args.slice(3) } });
  }
  frames.push({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 80 } });
  frames.push({ type: 'message_stop' });
  return new Response(sse(frames, true), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

test('OpenAI stream: text pieces, a call split in pieces, cost', async () => {
  sent.length = 0;
  const g = streamCloud({ provider: 'openai', model: 'gpt-6-luna', key: 'sk-test', fetch: fakeCloud }, [{ role: 'user', content: 'תעביר לסל' }], {
    tools: [{ type: 'function', function: { name: 'trash_file', description: 'x', parameters: {} } }],
  });
  const events = [];
  let n = await g.next();
  while (!n.done) { events.push(n.value); n = await g.next(); }
  assert.deepEqual(events, [{ type: 'tool_calls', calls: [{ name: 'trash_file', arguments: { path: trashTarget } }] }]);
  assert.equal(n.value.outputTokens, 100);
  assert.equal(n.value.cachedTokens, 1000);
  assert.ok(Math.abs(n.value.costUsd! - estimateCost('gpt-6-luna', 1000, 1000, 100)!) < 1e-12);
  assert.equal(sent[0].headers.authorization, 'Bearer sk-test');
  assert.equal(sent[0].body.reasoning_effort, 'none', 'GPT-6 calls tools in Chat Completions only without reasoning');
});

test('Anthropic stream: text, a call, cached instructions', async () => {
  sent.length = 0;
  const g = streamCloud({ provider: 'anthropic', model: 'claude-haiku-5-5', key: 'sk-ant-test', fetch: fakeCloud }, [
    { role: 'system', content: 'הוראות' },
    { role: 'user', content: 'שלום' },
  ]);
  let text = '';
  let n = await g.next();
  while (!n.done) { if (n.value.type === 'text') text += n.value.text; n = await g.next(); }
  assert.equal(text, 'תשובה מהענן');
  assert.equal(n.value.outputTokens, 80);
  assert.equal(sent[0].headers['x-api-key'], 'sk-ant-test');
  assert.deepEqual(sent[0].body.system[0].cache_control, { type: 'ephemeral' });
});

test('a rejected key says how to fix it', async () => {
  failWith = 401;
  try {
    const g = streamCloud({ provider: 'openai', model: 'gpt-6-luna', key: 'sk-bad', fetch: fakeCloud }, [{ role: 'user', content: 'x' }]);
    await assert.rejects(g.next(), (e: { userMessage?: string }) => /npm run cloud:key -- openai/.test(e.userMessage ?? ''));
  } finally {
    failWith = 0;
  }
});

test('asking for the cloud, the Mac, and what counts as complex', () => {
  for (const t of ['תעבור לענן', 'תענה על זה בענן', 'תשתמש בענן בבקשה', 'ענן: מה בירת צרפת?', 'תענה עם GPT', 'תשתמש בקלוד']) {
    assert.ok(CLOUD_ASK.test(t), t);
  }
  for (const t of ['מה יש לי בענן של אפל?', 'יורד גשם, יש עננים', 'תמצא קובץ בתיקייה', 'מה עם קלוד? הוא סיים?']) assert.ok(!CLOUD_ASK.test(t), t);
  for (const t of ['תחזור למק', 'תענה במק', 'בלי ענן הפעם', 'מקומי בלבד']) assert.ok(LOCAL_ASK.test(t), t);
  assert.ok(!LOCAL_ASK.test('מה מצב המקרר'));
  for (const t of ['תסכם לי את המייל', 'תנתח את הנתונים', 'תכתוב לי מכתב לבעל הבית', 'תשווה בין שתי ההצעות']) assert.ok(isComplex(t), t);
  for (const t of ['מה השעה?', 'מה בירת צרפת?', 'כמה זה שווה?']) assert.ok(!isComplex(t), t);
});

// ---------------------------------------------------------------- Brain, end to end
const ollamaCalls: { messages: { role: string; content: string }[] }[] = [];
let folder = '';
let trashTarget = '';
const line = (o: unknown) => JSON.stringify(o) + '\n';
const fakeOllama = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'gemma4:e4b' }] }));
  if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion', 'tools'] }));
  if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
  if (req.url !== '/api/chat') return res.writeHead(404).end();
  const r = JSON.parse(body);
  ollamaCalls.push(r);
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const last = r.messages.at(-1);
  if (last.role === 'user' && last.content.includes('בתיקייה')) {
    res.write(line({ message: { content: '', tool_calls: [{ function: { name: 'list_folder', arguments: { folder } } }] }, done: false }));
    return res.end(line({ message: { content: '' }, done: true }));
  }
  const said = last.role === 'tool' ? `דיווח מהמק: ${last.content.slice(0, 2000)}` : last.content.includes('לדני') ? 'שלחתי לדני את ההודעה.' : 'תשובה מהמק';
  res.write(line({ message: { content: said }, done: false }));
  res.end(line({ message: { content: '' }, done: true, eval_count: 3, eval_duration: 1e8 }));
});
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
const apps: { server: Server; db: ReturnType<typeof openDb> }[] = [];
let ollamaUrl = '';

async function brain(
  keys: { openaiKey?: string; anthropicKey?: string } = { openaiKey: 'sk-test', anthropicKey: 'sk-ant-test' },
  mode: 'ask' | 'cloud' | 'local' = 'ask',
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'brain-cloud-'));
  const config = loadConfig({ dataDir, ollamaUrl, localModel: 'gemma4:e4b', port: 0, extraFileRoots: [folder], openaiKey: '', anthropicKey: '', ...keys });
  const db = openDb(join(dataDir, 'brain.db'));
  db.setSetting('cloud', { mode });
  const app = createApp(config, db, { platform: 'darwin', exec: (async () => ({ stdout: '', stderr: '' })) as never, google: null, apple: null, web: null, autoWarm: false, cloudFetch: fakeCloud });
  apps.push({ server: app.server, db });
  const base = `http://127.0.0.1:${await listen(app.server)}`;
  const { code } = app.auth.newPairingCode();
  const { token } = (await (await fetch(`${base}/api/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceName: 'בדיקות' }),
  })).json()) as { token: string };
  const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const events = (raw: string) => raw.split('\n\n').filter(Boolean).map((f) => ({
    event: f.match(/^event: (.+)$/m)?.[1] ?? '',
    data: JSON.parse(f.match(/^data: (.+)$/m)?.[1] ?? 'null'),
  }));
  const chat = async (text: string, conversationId?: string, engine?: string) => {
    const evs = events(await (await fetch(`${base}/api/chat`, { method: 'POST', headers: H, body: JSON.stringify({ text, conversationId, engine }) })).text());
    const done = evs.find((e) => e.event === 'done')?.data;
    return { evs, done, id: evs.find((e) => e.event === 'meta')?.data.conversationId as string, text: evs.filter((e) => e.event === 'delta').map((e) => e.data.text).join('') };
  };
  const put = async (cloud: Record<string, unknown>) =>
    (await fetch(`${base}/api/settings`, { method: 'PUT', headers: H, body: JSON.stringify({ cloud }) })).json();
  const engine = async (id: string, body: Record<string, unknown>) => {
    const res = await fetch(`${base}/api/conversations/${id}/engine`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    return { status: res.status, evs: res.headers.get('content-type')?.includes('event-stream') ? events(await res.text()) : [], json: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
  };
  return { base, H, chat, put, engine, db };
}

before(async () => {
  folder = mkdtempSync(join(tmpdir(), 'brain-cloud-files-'));
  writeFileSync(join(folder, 'חוזה-סודי-מאוד.txt'), 'x');
  mkdirSync(join(folder, 'old'));
  trashTarget = join(folder, 'old');
  ollamaUrl = `http://127.0.0.1:${await listen(fakeOllama)}`;
});
after(() => {
  for (const a of apps) { a.server.close(); a.db.close(); }
  fakeOllama.close();
});
beforeEach(() => {
  sent.length = 0;
  ollamaCalls.length = 0;
});

test('asked for: the cloud answers, stays for the conversation, and "back to the Mac" returns', async () => {
  const f = await brain();
  const a = await f.chat('תעבור לענן: מה בירת צרפת?');
  assert.equal(a.text, 'תשובה מהענן');
  assert.equal(a.done.engine, 'cloud');
  assert.equal(a.done.model, 'gpt-6-luna');
  assert.equal(sent.length, 1);
  assert.equal(ollamaCalls.length, 0, 'nothing went to the local model');
  const saved = f.db.listMessages(a.id).find((m) => m.role === 'assistant')!;
  assert.equal(saved.engine, 'cloud');

  const b = await f.chat('ומה בירת ספרד?', a.id);
  assert.equal(b.done.engine, 'cloud', 'the conversation stays in the cloud');
  assert.equal(sent.length, 2);

  const c = await f.chat('תחזור למק בבקשה', a.id);
  assert.equal(c.done.engine, 'local');
  assert.equal(c.text, 'תשובה מהמק');
  assert.equal(sent.length, 2);

  const log = f.db.listAudit(50).filter((e) => e.kind === 'chat');
  assert.equal(log.filter((e) => e.detail.sentToCloud).length, 2);
  const settings = await (await fetch(`${f.base}/api/settings`, { headers: f.H })).json();
  assert.ok(settings.cloud.monthUsd > 0, 'this month\'s spending is counted');
});

test('the switch in the app, and Claude as the provider', async () => {
  const f = await brain();
  await f.put({ provider: 'anthropic' });
  const a = await f.chat('שלום', undefined, 'cloud');
  assert.equal(a.done.engine, 'cloud');
  assert.equal(a.done.model, 'claude-sonnet-5-5');
  assert.match(sent[0].url, /anthropic/);
  const conv = await (await fetch(`${f.base}/api/conversations/${a.id}?view=chat`, { headers: f.H })).json();
  assert.equal(conv.engine, 'cloud');
  const r = await f.engine(a.id, { engine: 'local' });
  assert.equal(r.json.engine, 'local');
  const b = await f.chat('ועוד משהו', a.id);
  assert.equal(b.done.engine, 'local');
});

test('a complex request: a card first, nothing sent anywhere until the user chooses', async () => {
  const f = await brain();
  const a = await f.chat('תסכם לי בבקשה את ההבדלים בין ריבית קבועה למשתנה');
  const choice = a.evs.find((e) => e.event === 'choice');
  assert.ok(choice, 'a "move to the cloud?" card');
  assert.equal(choice!.data.model, 'GPT-6 Luna');
  assert.equal(a.done.awaitingChoice, true);
  assert.equal(sent.length + ollamaCalls.length, 0);

  // The card stays in the conversation (for the app), never in what a model reads.
  const shown = await (await fetch(`${f.base}/api/conversations/${a.id}?view=chat`, { headers: f.H })).json();
  assert.equal(shown.messages.find((m: { tool_name: string }) => m.tool_name === 'cloud_choice').display.status, 'pending');

  const r = await f.engine(a.id, { engine: 'cloud', run: true, fromCard: true });
  assert.equal(r.evs.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), 'תשובה מהענן');
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].raw.includes('cloud_choice'));
  assert.equal((f.db.listMessages(a.id).find((m) => m.tool_name === 'cloud_choice')!.display as { status: string }).status, 'cloud');

  // "On the Mac" on a card: answered locally, and not asked again in this conversation.
  const b = await f.chat('תנתח את זה לעומק');
  await f.engine(b.id, { engine: 'local', run: true, fromCard: true });
  assert.equal(ollamaCalls.length, 1);
  const c = await f.chat('ועכשיו תשווה ביניהם', b.id);
  assert.ok(!c.evs.some((e) => e.event === 'choice'));
  assert.equal(c.done.engine, 'local');
});

test('local only: nothing goes to the cloud, even when asked', async () => {
  const f = await brain();
  await f.put({ mode: 'local' });
  const a = await f.chat('תעבור לענן ותענה');
  assert.match(a.evs.find((e) => e.event === 'notice')!.data.text, /מקומי בלבד/);
  assert.equal(a.done.engine, 'local');
  const b = await f.chat('תסכם לי את כל זה');
  assert.ok(!b.evs.some((e) => e.event === 'choice'), 'no suggestion either');
  assert.equal(sent.length, 0);
});

test('no key for the chosen provider: says so, and answers on the Mac', async () => {
  const f = await brain({ openaiKey: 'sk-test' });
  await f.put({ provider: 'anthropic' });
  const a = await f.chat('תעבור לענן');
  assert.match(a.evs.find((e) => e.event === 'notice')!.data.text, /npm run cloud:key -- anthropic/);
  assert.equal(sent.length, 0);
  const conv = await f.chat('שלום');
  const r = await f.engine(conv.id, { engine: 'cloud' });
  assert.equal(r.status, 409);
});

test('privacy: what the user turned off never reaches the cloud', async () => {
  const f = await brain();
  f.db.addMemory('קוראים לי יוסי ואשתי מיכל', 'manual');
  // On the Mac: list a folder (a file name goes into the conversation), and the answer repeats it.
  const a = await f.chat('מה יש בתיקייה?');
  assert.match(a.text, /חוזה-סודי-מאוד/);
  await f.put({ allow: { files: false, memory: false } });

  const b = await f.chat('תעבור לענן: מה עוד אפשר לעשות?', a.id);
  assert.equal(b.done.engine, 'cloud');
  const req = sent[0];
  assert.ok(!req.raw.includes('חוזה-סודי-מאוד'), 'neither the file name nor the answer that repeated it');
  assert.ok(!req.raw.includes('מיכל'), 'nor the memory');
  assert.ok(req.raw.includes('לא נשלח לענן לפי הגדרות הפרטיות'));
  assert.ok(req.raw.includes('תשובה שנכתבה במק ממידע שלא נשלח לענן'));
  const offered = (req.body.tools ?? []).map((t: { function: { name: string } }) => t.function.name);
  for (const name of ['list_folder', 'read_file', 'search_files', 'remember', 'search_history']) assert.ok(!offered.includes(name), name);
  assert.ok(offered.includes('web_search') || offered.includes('get_datetime'));
  assert.match(req.body.messages[0].content, /לא נשלחים לענן: הזיכרון עליך ושיחות קודמות; קבצים, תיקיות ושיחות עם סוכני קוד/);

  // Allowed again: the same conversation does reach the cloud as it is.
  await f.put({ allow: { files: true, memory: true } });
  await f.chat('ועכשיו?', a.id);
  assert.ok(sent[1].raw.includes('חוזה-סודי-מאוד'));
  assert.ok(sent[1].raw.includes('מיכל'));
});

test('in the cloud too, changes wait for approval, and the Mac does them', async () => {
  const f = await brain();
  const a = await f.chat('תעבור לענן ותעביר לסל את התיקייה הישנה');
  const card = a.evs.find((e) => e.event === 'approval')!.data;
  assert.equal(card.tool, 'trash_file');
  assert.equal(a.done.awaitingApproval, true);
  assert.ok(existsSync(trashTarget), 'nothing happened before approval');
  const res = await fetch(`${f.base}/api/actions/${card.id}`, { method: 'POST', headers: f.H, body: JSON.stringify({ decision: 'reject' }) });
  assert.equal(res.status, 200);
  await res.text();
  assert.ok(existsSync(trashTarget));
  // The next turn in the cloud sees the call answered (rejected), so the provider accepts the history.
  await f.chat('בסדר, עזוב', a.id);
  const last = sent.at(-1)!.body.messages as { role: string; tool_call_id?: string; content: string }[];
  const result = last.find((m) => m.role === 'tool')!;
  assert.match(result.content, /ביטל/);
});

test('settings: mode, provider and privacy switches are checked and kept', async () => {
  const f = await brain();
  const s = await f.put({ mode: 'local', allow: { mail: false } });
  assert.equal(s.cloud.mode, 'local');
  assert.equal(s.cloud.allow.mail, false);
  assert.equal(s.cloud.allow.files, true);
  assert.deepEqual(s.cloud.providers.map((p: { id: string; hasKey: boolean }) => [p.id, p.hasKey]), [['openai', true], ['anthropic', true]]);
  const bad = await fetch(`${f.base}/api/settings`, { method: 'PUT', headers: f.H, body: JSON.stringify({ cloud: { allow: { passwords: true } } }) });
  assert.equal(bad.status, 400);
  const status = await (await fetch(`${f.base}/api/status`, { headers: f.H })).json();
  assert.equal(status.cloud.ready, false);
});

test('a new message instead of an answer on the card: the card is retired', async () => {
  const f = await brain();
  const a = await f.chat('תכתוב לי מכתב לבעל הבית על המזגן');
  assert.ok(a.evs.some((e) => e.event === 'choice'));
  const b = await f.chat('עזוב, מה השעה?', a.id);
  assert.equal(b.done.engine, 'local');
  assert.equal((f.db.listMessages(a.id).find((m) => m.tool_name === 'cloud_choice')!.display as { status: string }).status, 'expired');
  // Nothing to run any more: choosing now only switches the conversation.
  const r = await f.engine(a.id, { engine: 'cloud', run: true, fromCard: true });
  assert.equal(r.json.engine, 'cloud');
  assert.equal(sent.length, 0);
});

test('a reply that says "sent" when nothing ran gets a warning, kept with the reply', async () => {
  const f = await brain();
  const a = await f.chat('תשלח הודעה לדני שאני מאחר');
  assert.match(a.text, /^שלחתי לדני את ההודעה\.\n\n⚠ לא בוצעה שום פעולה/);
  const saved = f.db.listMessages(a.id).find((m) => m.role === 'assistant')!;
  assert.match(saved.content, /לא בוצעה שום פעולה/);
  // After a real tool, "sent"-style words are left alone.
  const b = await f.chat('מה יש בתיקייה?');
  assert.ok(!b.text.includes('לא בוצעה'));
});

test('always in the cloud: every conversation, complex or not; the Mac when asked', async () => {
  const f = await brain(undefined, 'cloud');
  const a = await f.chat('מה השעה בטוקיו?');
  assert.equal(a.done.engine, 'cloud');
  assert.match(sent[0].body.messages[0].content, /אתה עונה עכשיו דרך GPT-6 Luna בענן/);
  const b = await f.chat('תסכם לי את ההבדלים בין שתי ההצעות');
  assert.ok(!b.evs.some((e) => e.event === 'choice'), 'no card: already in the cloud');
  assert.equal(b.done.engine, 'cloud');
  const c = await f.chat('תחזור למק', b.id);
  assert.equal(c.done.engine, 'local');
  const d = await f.chat('ועוד שאלה', b.id);
  assert.equal(d.done.engine, 'local', 'that conversation stays on the Mac');
  const status = await (await fetch(`${f.base}/api/status`, { headers: f.H })).json();
  assert.equal(status.cloud.mode, 'cloud');
});

test('always in the cloud, and the cloud is down: the Mac answers, and says why', async () => {
  const f = await brain(undefined, 'cloud');
  failWith = 503;
  try {
    const a = await f.chat('מה בירת צרפת?');
    assert.equal(a.text, 'תשובה מהמק');
    assert.equal(a.done.engine, 'local');
    assert.match(a.evs.find((e) => e.event === 'notice')!.data.text, /לא זמין כרגע.*עניתי מהמק/);
    assert.equal(f.db.listMessages(a.id).find((m) => m.role === 'assistant')!.engine, 'local');
  } finally {
    failWith = 0;
  }
  const b = await f.chat('ועכשיו?');
  assert.equal(b.done.engine, 'cloud', 'back in the cloud when it answers again');
});

test('by default the Mac answers: the cloud only when asked or approved', () => {
  assert.equal(cloudSettings(undefined).mode, 'ask');
  assert.equal(cloudSettings({ mode: 'bogus' as never }).mode, 'ask');
  assert.deepEqual(cloudSettings(undefined).allow, { memory: true, personal: true, files: true, mail: true });
});
