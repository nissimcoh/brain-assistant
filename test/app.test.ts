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

// ---------- fake Ollama ----------
let lastOllamaRequest: { model: string; messages: { role: string; content: string }[] } | null = null;
let ollamaMode: 'ok' | 'missing-model' = 'ok';

const fakeOllama = createServer(async (req, res) => {
  if (req.url === '/api/tags') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'test-model' }] }));
    return;
  }
  if (req.url === '/api/show') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ capabilities: ['completion', 'tools', 'thinking'] }));
    return;
  }
  if (req.url === '/api/chat') {
    let body = '';
    for await (const c of req) body += c;
    lastOllamaRequest = JSON.parse(body);
    if (ollamaMode === 'missing-model') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `model "${lastOllamaRequest!.model}" not found, try pulling it first` }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    for (const piece of ['שלום', ', ', 'מה ', 'שלומך?']) {
      res.write(JSON.stringify({ message: { role: 'assistant', content: piece }, done: false }) + '\n');
    }
    res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, eval_count: 4, eval_duration: 1e8 }) + '\n');
    return;
  }
  res.writeHead(404).end();
});

// ---------- Brain under test ----------
let brain: Server;
let base = '';
let db: ReturnType<typeof openDb>;
let auth: ReturnType<typeof createApp>['auth'];

const listen = (s: Server) =>
  new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));

before(async () => {
  const ollamaPort = await listen(fakeOllama);
  const dataDir = mkdtempSync(join(tmpdir(), 'brain-test-'));
  const config = loadConfig({ dataDir, ollamaUrl: `http://127.0.0.1:${ollamaPort}`, localModel: 'test-model', port: 0 });
  db = openDb(join(dataDir, 'brain.db'));
  const app = createApp(config, db);
  brain = app.server;
  auth = app.auth;
  base = `http://127.0.0.1:${await listen(brain)}`;
});

after(() => {
  brain.close();
  fakeOllama.close();
  db.close();
});

async function pairDevice(name = 'אייפון בדיקה'): Promise<string> {
  const { code } = auth.newPairingCode();
  const res = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: `${code.slice(0, 4)}-${code.slice(4)}`, deviceName: name }),
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { token: string }).token;
}

async function readSse(res: Response) {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const data = JSON.parse(frame.match(/^data: (.+)$/m)?.[1] ?? 'null');
      return { event, data };
    });
}

test('health is public and reports Ollama', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; ollama: boolean };
  assert.equal(body.ok, true);
  assert.equal(body.ollama, true);
});

test('API rejects requests without a device token', async () => {
  for (const path of ['/api/status', '/api/conversations', '/api/audit']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 401, path);
  }
  const forged = await fetch(`${base}/api/status`, { headers: { authorization: 'Bearer ' + 'x'.repeat(43) } });
  assert.equal(forged.status, 401);
});

test('pairing code works once only', async () => {
  const { code } = auth.newPairingCode();
  const first = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'א' }),
  });
  assert.equal(first.status, 200);
  const second = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'ב' }),
  });
  assert.equal(second.status, 401);
});

test('five wrong codes invalidate outstanding codes', async () => {
  const { code } = auth.newPairingCode();
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '00000000', deviceName: 'תוקף' }),
    });
    assert.equal(res.status, 401);
  }
  const res = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'אמיתי' }),
  });
  assert.equal(res.status, 401, 'the real code must be dead after the lockout');
});

test('chat streams a Hebrew reply, stores history and keeps context', async () => {
  const token = await pairDevice();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const res = await fetch(`${base}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ text: 'היי, מה נשמע?' }) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const events = await readSse(res);
  const meta = events.find((e) => e.event === 'meta')!.data;
  assert.equal(meta.engine, 'local');
  assert.equal(meta.model, 'test-model');
  const reply = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
  assert.equal(reply, 'שלום, מה שלומך?');
  const done = events.find((e) => e.event === 'done')!.data;
  assert.equal(done.engine, 'local');

  // Second message in the same conversation carries the earlier turns to the model.
  const res2 = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ conversationId: meta.conversationId, text: 'ומה איתך?' }),
  });
  await readSse(res2);
  const raw = lastOllamaRequest as unknown as { keep_alive?: string; think?: boolean };
  assert.equal(raw.keep_alive, '2h', 'model stays loaded between questions');
  assert.equal(raw.think, false, 'thinking is off for everyday chat');
  assert.ok(typeof done.totalMs === 'number', 'reply time is reported');
  const sent = lastOllamaRequest!.messages;
  assert.equal(sent[0].role, 'system');
  assert.deepEqual(
    sent.slice(1).map((m) => m.content),
    ['היי, מה נשמע?', 'שלום, מה שלומך?', 'ומה איתך?'],
  );

  const conv = (await (await fetch(`${base}/api/conversations/${meta.conversationId}`, { headers })).json()) as {
    messages: { role: string; model: string | null }[];
  };
  assert.equal(conv.messages.length, 4);
  assert.equal(conv.messages[1].model, 'test-model');

  const audit = (await (await fetch(`${base}/api/audit`, { headers })).json()) as { kind: string; detail: { sentToCloud?: boolean } }[];
  const chats = audit.filter((a) => a.kind === 'chat');
  assert.ok(chats.length >= 2);
  assert.ok(chats.every((a) => a.detail.sentToCloud === false));

  const del = await fetch(`${base}/api/conversations/${meta.conversationId}`, { method: 'DELETE', headers });
  assert.equal(del.status, 200);
  const gone = await fetch(`${base}/api/conversations/${meta.conversationId}`, { headers });
  assert.equal(gone.status, 404);
});

test('missing model gives a Hebrew instruction', async () => {
  const token = await pairDevice();
  ollamaMode = 'missing-model';
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'בדיקה' }),
    });
    const events = await readSse(res);
    const error = events.find((e) => e.event === 'error');
    assert.ok(error, 'expected an error event');
    assert.match(error!.data.message, /ollama pull test-model/);
  } finally {
    ollamaMode = 'ok';
  }
});

test('revoked device loses access', async () => {
  const token = await pairDevice('ישן');
  const headers = { authorization: `Bearer ${token}` };
  const status = (await (await fetch(`${base}/api/status`, { headers })).json()) as { device: { id: string } };
  const del = await fetch(`${base}/api/devices/${status.device.id}`, { method: 'DELETE', headers });
  assert.equal(del.status, 200);
  const after = await fetch(`${base}/api/status`, { headers });
  assert.equal(after.status, 401);
});

test('static files are served and path traversal is blocked', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /dir="rtl"/);
  assert.ok(index.headers.get('content-security-policy'));
  const traversal = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.notEqual(traversal.status, 200);
  const traversal2 = await fetch(`${base}/%2e%2e/server/db.ts`);
  assert.notEqual(traversal2.status, 200);
});
