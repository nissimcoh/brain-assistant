import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { createApp } from '../server/app.ts';

interface Req {
  url: string;
  body: { messages?: { role: string; content: string }[]; tools?: unknown[]; options?: Record<string, number> };
}
const seen: Req[] = [];
let ollamaUp = false;
let loaded = false;
const line = (o: unknown) => JSON.stringify(o) + '\n';

const fakeOllama = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (!ollamaUp) {
    res.statusCode = 503;
    return res.end();
  }
  seen.push({ url: req.url ?? '', body: body ? JSON.parse(body) : {} });
  if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'gemma4:12b' }] }));
  if (req.url === '/api/ps') return res.end(JSON.stringify({ models: loaded ? [{ name: 'gemma4:12b' }] : [] }));
  if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['tools'] }));
  if (req.url === '/api/generate') {
    loaded = true;
    return res.end('{}');
  }
  res.end(line({ message: { content: 'שלום!' } }) + line({ done: true, prompt_eval_count: 900, prompt_eval_duration: 7e9 }));
});

let brain: Server;
let base = '';
let token = '';
let db: ReturnType<typeof openDb>;
const listen = (s: Server) =>
  new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));
const wait = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
};

before(async () => {
  const port = await listen(fakeOllama);
  const dataDir = mkdtempSync(join(tmpdir(), 'brain-warm-'));
  const config = loadConfig({ dataDir, ollamaUrl: `http://127.0.0.1:${port}`, localModel: 'gemma4:12b', port: 0 });
  db = openDb(join(dataDir, 'brain.db'));
  const app = createApp(config, db, { platform: 'darwin', exec: async () => ({ stdout: '', stderr: '' }), autoWarm: true });
  brain = app.server;
  base = `http://127.0.0.1:${await listen(brain)}`;
  const { code } = app.auth.newPairingCode();
  const res = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceName: 'בדיקות' }) });
  token = ((await res.json()) as { token: string }).token;
});
after(() => {
  brain.close();
  fakeOllama.close();
  db.close();
});
const H = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

test('when Ollama comes up after Brain (e.g. after a restart), the model is loaded right away', async () => {
  await fetch(`${base}/api/health`); // Ollama is still down
  assert.equal(loaded, false);
  ollamaUp = true;
  await new Promise((r) => setTimeout(r, 10_100)); // health re-checks Ollama after 10 s
  await fetch(`${base}/api/health`);
  await wait(() => loaded && seen.some((r) => r.url === '/api/chat'));
  assert.equal(loaded, true, 'the model was loaded without waiting for a question');
});

test('a new conversation is read ahead exactly as the first message will send it', async () => {
  await new Promise((r) => setTimeout(r, 20_100)); // past the 20 s spacing between warm-ups
  seen.length = 0;
  const r = await fetch(`${base}/api/warm`, { method: 'POST', headers: H(), body: JSON.stringify({ newConversation: true }) });
  assert.equal(r.status, 202);
  await wait(() => seen.some((x) => x.url === '/api/chat'));
  const warmReq = seen.find((x) => x.url === '/api/chat')!;
  assert.equal(warmReq.body.options?.num_predict, 1, 'no real answer is generated');

  seen.length = 0;
  await (await fetch(`${base}/api/chat`, { method: 'POST', headers: H(), body: JSON.stringify({ text: 'מה שלומך?' }) })).text();
  const real = seen.find((x) => x.url === '/api/chat')!;
  assert.equal(real.body.messages![0].content, warmReq.body.messages![0].content, 'same instructions');
  assert.deepEqual(real.body.tools, warmReq.body.tools, 'same tools');
  assert.equal(real.body.options?.num_ctx, warmReq.body.options?.num_ctx, 'same context size (no model reload)');
  assert.equal(db.listConversations().length, 1, 'the warm-up saved nothing');
});

test('opening an ongoing conversation only makes sure the model is loaded (its cache is left alone)', async () => {
  seen.length = 0;
  await fetch(`${base}/api/warm`, { method: 'POST', headers: H(), body: JSON.stringify({ newConversation: false }) });
  await wait(() => seen.some((x) => x.url === '/api/ps'));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!seen.some((x) => x.url === '/api/chat'));
});

test('leaving a conversation for a new one names it (once), and a name the user chose is never replaced', async () => {
  const conv = db.listConversations()[0];
  assert.equal(conv.title_source, 'first');
  await new Promise((r) => setTimeout(r, 20_100));
  seen.length = 0;
  await fetch(`${base}/api/warm`, { method: 'POST', headers: H(), body: JSON.stringify({ newConversation: true }) });
  await wait(() => seen.filter((x) => x.url === '/api/chat').length >= 2);
  const chats = seen.filter((x) => x.url === '/api/chat');
  assert.match(chats[0].body.messages![0].content, /שמות קצרים לשיחות/, 'naming comes first');
  assert.equal(chats[0].body.tools, undefined);
  assert.equal(chats.at(-1)!.body.options?.num_predict, 1, 'the new conversation is read last');
  const named = db.getConversation(conv.id)!;
  assert.equal(named.title, 'שלום', 'quotes and the final "!" are removed');
  assert.equal(named.title_source, 'auto');

  const bad = await fetch(`${base}/api/conversations/${conv.id}`, { method: 'PATCH', headers: H(), body: JSON.stringify({ title: '  ' }) });
  assert.equal(bad.status, 400);
  await fetch(`${base}/api/conversations/${conv.id}`, { method: 'PATCH', headers: H(), body: JSON.stringify({ title: 'השם שלי' }) });
  assert.equal(db.renameConversation(conv.id, 'שם אוטומטי', 'auto'), false);
  assert.equal(db.getConversation(conv.id)!.title, 'השם שלי');
});

test('pinned conversations stay at the top', async () => {
  const a = db.createConversation('ראשונה');
  await new Promise((r) => setTimeout(r, 5));
  const b = db.createConversation('שנייה');
  assert.equal(db.listConversations()[0].id, b.id);
  const r = await fetch(`${base}/api/conversations/${a.id}`, { method: 'PATCH', headers: H(), body: JSON.stringify({ pinned: true }) });
  assert.equal(r.status, 200);
  const list = (await (await fetch(`${base}/api/conversations`, { headers: H() })).json()) as { id: string; pinned: number }[];
  assert.equal(list[0].id, a.id);
  assert.equal(list[0].pinned, 1);
  await fetch(`${base}/api/conversations/${a.id}`, { method: 'PATCH', headers: H(), body: JSON.stringify({ pinned: false }) });
  assert.equal(db.listConversations()[0].id, b.id);
});
