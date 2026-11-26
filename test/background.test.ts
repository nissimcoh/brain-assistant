// Leaving the app doesn't stop Brain: the answer is finished on the Mac and is there when you come back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { createApp } from '../server/app.ts';

let slowMs = 600;
let aborted = 0;
const line = (o: unknown) => JSON.stringify(o) + '\n';
const ollama = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'gemma4:e4b' }] }));
  if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion', 'tools'] }));
  if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  req.on('close', () => {
    if (!res.writableEnded) aborted++;
  });
  res.write(line({ message: { content: 'מתחיל, ' }, done: false }));
  await new Promise((r) => setTimeout(r, slowMs));
  if (res.destroyed) return;
  res.write(line({ message: { content: 'וסיימתי.' }, done: false }));
  res.end(line({ message: { content: '' }, done: true }));
});

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
let base = '';
let token = '';
let server: Server;
let db: ReturnType<typeof openDb>;

before(async () => {
  const ollamaUrl = `http://127.0.0.1:${await listen(ollama)}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'brain-bg-'));
  db = openDb(join(dataDir, 'brain.db'));
  const app = createApp(loadConfig({ dataDir, ollamaUrl, localModel: 'gemma4:e4b', port: 0 }), db, { platform: 'linux', google: null, autoWarm: false });
  server = app.server;
  base = `http://127.0.0.1:${await listen(server)}`;
  const { code } = app.auth.newPairingCode();
  token = ((await (await fetch(`${base}/api/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceName: 'בדיקות' }),
  })).json()) as { token: string }).token;
});
after(() => {
  server.close();
  ollama.close();
  db.close();
});

/** Sends a message and hangs up as soon as the conversation id arrives, like an iPhone app sent to the background. */
function sendAndLeave(text: string, conversationId?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/api/chat`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        const id = buf.match(/"conversationId":"([0-9a-f-]{36})"/)?.[1];
        if (id) {
          req.destroy();
          resolve(id);
        }
      });
    });
    req.on('error', () => {});
    req.end(JSON.stringify({ text, conversationId }));
    setTimeout(() => reject(new Error('no meta')), 3000);
  });
}
const H = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const getConv = async (id: string) =>
  (await (await fetch(`${base}/api/conversations/${id}`, { headers: H() })).json()) as { running: boolean; messages: { role: string; content: string }[] };

test('leaving the app: the answer is still finished and saved', async () => {
  slowMs = 600;
  const id = await sendAndLeave('תעשה משהו ארוך');
  assert.equal((await getConv(id)).running, true, 'still working after the phone left');
  const poll = await (await fetch(base + '/api/conversations/' + id + '?view=run', { headers: H() })).json();
  assert.equal(poll.running, true);
  assert.ok(typeof poll.progress === 'string' && poll.progress.length);
  assert.equal(poll.messages, undefined);
  await new Promise((r) => setTimeout(r, 900));
  const c = await getConv(id);
  assert.equal(c.running, false);
  assert.equal(c.messages.at(-1)!.content, 'מתחיל, וסיימתי.');
  assert.equal(aborted, 0, 'Ollama was not interrupted');
});

test('the stop button still stops it', async () => {
  slowMs = 6000;
  const id = await sendAndLeave('עוד משהו ארוך');
  await new Promise((r) => setTimeout(r, 200));
  const r = (await (await fetch(`${base}/api/conversations/${id}/stop`, { method: 'POST', headers: H() })).json()) as { stopped: boolean };
  assert.equal(r.stopped, true);
  const c = await getConv(id);
  assert.equal(c.running, false);
  assert.notEqual(c.messages.at(-1)!.content, 'מתחיל, וסיימתי.', 'it did not finish');
  if (c.messages.at(-1)!.role === 'assistant') assert.equal(c.messages.at(-1)!.content, 'מתחיל, ', 'what was written so far is kept');
});

test('a new message in the same conversation replaces the one still running', async () => {
  slowMs = 6000;
  const id = await sendAndLeave('ראשונה');
  await new Promise((r) => setTimeout(r, 200));
  slowMs = 100;
  const raw = await (await fetch(`${base}/api/chat`, { method: 'POST', headers: H(), body: JSON.stringify({ text: 'שנייה', conversationId: id }) })).text();
  assert.match(raw, /event: done/);
  const roles = (await getConv(id)).messages.map((m) => `${m.role}:${m.content}`);
  assert.deepEqual(roles.filter((r) => r !== 'assistant:מתחיל, '), ['user:ראשונה', 'user:שנייה', 'assistant:מתחיל, וסיימתי.']);
});

test('run polling omits history and chat restoration keeps action calls without tool bodies', async () => {
  const c = db.createConversation('fixture');
  db.addMessage(c.id, 'user', 'first');
  const call = db.addMessage(c.id, 'assistant', '', { toolCalls: [{ name: 'get_datetime', arguments: {} }] });
  db.addMessage(c.id, 'tool', 'synthetic tool output', { toolName: 'get_datetime' });
  const last = db.addMessage(c.id, 'assistant', 'reply');
  const get = async (query: string) => (await fetch(base + '/api/conversations/' + c.id + query, { headers: H() })).json();
  assert.deepEqual(await get('?view=run'), { running: false });
  const full = await get('');
  const chat = await get('?view=chat');
  assert.deepEqual(chat.messages, full.messages.filter((m: { role: string }) => m.role !== 'tool'));
  assert.deepEqual(chat.actions, full.actions);
  assert.deepEqual(db.listMessages(c.id, call.id).map(m => m.id), full.messages.slice(1).map((m: { id: string }) => m.id));
  assert.deepEqual(db.listMessages(c.id, 'missing'), db.listMessages(c.id));
  assert.equal(db.lastUserText(c.id), 'first');
  assert.equal(db.listMessages(c.id, last.id).length, 1);
});
