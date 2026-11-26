// Notifications to the phone: sealed on the Mac for this device only (RFC 8291), signed (RFC 8292),
// and sent only to the real push services.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { createApp } from '../server/app.ts';
import { clipText, encrypt, generateVapidKeys, validSubscription, vapidAuth } from '../server/push.ts';

const b64 = (b: Buffer) => b.toString('base64url');

/** What the phone does with a push: open it with its own private key. */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(asPublic), auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const data = body.subarray(21 + idlen);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(-16));
  const plain = Buffer.concat([d.update(data.subarray(0, -16)), d.final()]);
  assert.equal(plain.at(-1), 2, 'a single, last record');
  return plain.subarray(0, -1).toString('utf8');
}

function phone() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    priv: ecdh.getPrivateKey(),
    auth,
    sub: { endpoint: `https://web.push.apple.com/QF${b64(randomBytes(20))}`, keys: { p256dh: b64(ecdh.getPublicKey()), auth: b64(auth) } },
  };
}

test('encryption matches the example in RFC 8291, byte for byte', () => {
  const out = encrypt(
    Buffer.from('When I grow up, I want to be a watermelon'),
    { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), privateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url') },
  );
  assert.equal(
    b64(out),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
});

test('every message is sealed anew, and only that phone opens it', () => {
  const p = phone();
  const a = encrypt(Buffer.from('שלום מבריין'), p.sub.keys);
  const b = encrypt(Buffer.from('שלום מבריין'), p.sub.keys);
  assert.notDeepEqual(a, b, 'new salt and key every time');
  assert.equal(decrypt(a, p.priv, p.auth), 'שלום מבריין');
  const other = phone();
  assert.throws(() => decrypt(a, other.priv, other.auth), 'another device cannot open it');
});

test('the signature (VAPID): for that push service, verified by the Mac\'s public key, short-lived', () => {
  const keys = generateVapidKeys();
  const now = Date.now();
  const header = vapidAuth('https://web.push.apple.com/abc', keys, 'mailto:me@example.com', now);
  const m = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/)!;
  assert.ok(m);
  assert.equal(m[4], keys.publicKey);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'mailto:me@example.com');
  assert.ok(claims.exp > now / 1000 && claims.exp <= now / 1000 + 24 * 3600, 'Apple accepts at most a day');
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33)) }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
});

test('a subscription can only point at a real push service', () => {
  const { sub } = phone();
  assert.ok(validSubscription(sub));
  assert.ok(validSubscription({ ...sub, endpoint: 'https://fcm.googleapis.com/fcm/send/x' }));
  for (const endpoint of [
    'http://web.push.apple.com/x',
    'https://web.push.apple.com.evil.example/x',
    'https://127.0.0.1/x',
    'https://localhost/x',
    'https://web.push.apple.com:8443/x',
    'https://user@web.push.apple.com/x',
    'file:///etc/passwd',
  ]) {
    assert.equal(validSubscription({ ...sub, endpoint }), null, endpoint);
  }
  assert.equal(validSubscription({ ...sub, keys: { ...sub.keys, auth: b64(randomBytes(8)) } }), null);
  assert.equal(validSubscription({ ...sub, keys: { ...sub.keys, p256dh: b64(randomBytes(65)) } }), null);
  assert.equal(validSubscription(null), null);
});

test('text for the lock screen: one line, no markdown, cut on a word', () => {
  assert.equal(clipText('**שלום**\n\nמה   נשמע', 50), 'שלום מה נשמע');
  assert.equal(clipText('אחת שתיים שלוש ארבע חמש', 16), 'אחת שתיים שלוש…');
});

// ---------------------------------------------------------------- the app, with a fake Apple push service
let slowMs = 300;
const line = (o: unknown) => JSON.stringify(o) + '\n';
const ollama = createServer(async (req, res) => {
  for await (const _ of req);
  if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'gemma4:e4b' }] }));
  if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion', 'tools'] }));
  if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  res.write(line({ message: { content: 'הנה **הסיכום** ' }, done: false }));
  await new Promise((r) => setTimeout(r, slowMs));
  res.end(line({ message: { content: 'של היום.' }, done: true }));
});
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
let pushStatus = 201;
const fakePush = (async (url: string | URL, init?: RequestInit) => {
  sent.push({ url: String(url), headers: init!.headers as Record<string, string>, body: Buffer.from(init!.body as Buffer) });
  return new Response(null, { status: pushStatus });
}) as typeof fetch;

let base = '';
let server: Server;
let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
const pair = async (name: string) => {
  const { code } = app.auth.newPairingCode();
  const r = (await (await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceName: name }) })).json()) as { token: string; device: { id: string } };
  return { token: r.token, id: r.device.id, H: { authorization: `Bearer ${r.token}`, 'content-type': 'application/json' } };
};
let me: Awaited<ReturnType<typeof pair>>;

before(async () => {
  const ollamaUrl = `http://127.0.0.1:${await listen(ollama)}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'brain-push-'));
  db = openDb(join(dataDir, 'brain.db'));
  app = createApp(loadConfig({ dataDir, ollamaUrl, localModel: 'gemma4:e4b', port: 0 }), db, { platform: 'linux', google: null, autoWarm: false, pushFetch: fakePush });
  server = app.server;
  base = `http://127.0.0.1:${await listen(server)}`;
  me = await pair('אייפון');
});
after(() => {
  server.close();
  ollama.close();
  db.close();
});

function sendAndLeave(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/api/chat`, { method: 'POST', headers: me.H }, (res) => {
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
    req.end(JSON.stringify({ text }));
    setTimeout(() => reject(new Error('no meta')), 3000);
  });
}
const waitFor = async (n: number) => {
  for (let i = 0; i < 100 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 20));
};

const p = phone();

test('turning notifications on: the Mac\'s public key, then this device\'s subscription', async () => {
  const info = (await (await fetch(`${base}/api/push`, { headers: me.H })).json()) as { publicKey: string; subscribed: boolean; preview: boolean };
  assert.equal(Buffer.from(info.publicKey, 'base64url').length, 65);
  assert.equal(info.subscribed, false);
  assert.equal(info.preview, true);
  const bad = await fetch(`${base}/api/push`, { method: 'POST', headers: me.H, body: JSON.stringify({ subscription: { ...p.sub, endpoint: 'https://evil.example/x' } }) });
  assert.equal(bad.status, 400);
  const ok = await fetch(`${base}/api/push`, { method: 'POST', headers: me.H, body: JSON.stringify({ subscription: p.sub }) });
  assert.equal(ok.status, 200);
  assert.equal(((await (await fetch(`${base}/api/push`, { headers: me.H })).json()) as { subscribed: boolean }).subscribed, true);
  assert.equal((await fetch(`${base}/api/push`)).status, 401, 'only a paired device');
});

test('a test notification reaches this device, signed and sealed', async () => {
  sent.length = 0;
  const r = (await (await fetch(`${base}/api/push/test`, { method: 'POST', headers: me.H })).json()) as { delivered: number };
  assert.equal(r.delivered, 1);
  const s = sent[0];
  assert.equal(s.url, p.sub.endpoint);
  assert.equal(s.headers['content-encoding'], 'aes128gcm');
  assert.match(s.headers.authorization, /^vapid t=.+, k=.+$/);
  const msg = JSON.parse(decrypt(s.body, p.priv, p.auth));
  assert.equal(msg.title, 'בריין');
  assert.match(msg.body, /ההתראות עובדות/);
});

test('leaving the app mid-answer: a notification with the answer, that opens the conversation', async () => {
  sent.length = 0;
  const id = await sendAndLeave('תסכם לי את היום');
  await waitFor(1);
  assert.equal(sent.length, 1);
  const msg = JSON.parse(decrypt(sent[0].body, p.priv, p.auth));
  assert.equal(msg.body, 'הנה הסיכום של היום.');
  assert.equal(msg.url, `/?c=${id}`);
  assert.equal(msg.tag, id);
});

test('staying in the app: no notification', async () => {
  sent.length = 0;
  slowMs = 10;
  const raw = await (await fetch(`${base}/api/chat`, { method: 'POST', headers: me.H, body: JSON.stringify({ text: 'מה נשמע' }) })).text();
  assert.match(raw, /event: done/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 0);
});

test('"show content" off: the notification only says something is ready', async () => {
  await fetch(`${base}/api/push`, { method: 'PUT', headers: me.H, body: JSON.stringify({ preview: false }) });
  sent.length = 0;
  slowMs = 300;
  await sendAndLeave('עוד סיכום');
  await waitFor(1);
  const msg = JSON.parse(decrypt(sent[0].body, p.priv, p.auth));
  assert.doesNotMatch(msg.body, /סיכום/);
  assert.equal(msg.body, 'פתח את בריין כדי לראות.');
  await fetch(`${base}/api/push`, { method: 'PUT', headers: me.H, body: JSON.stringify({ preview: true }) });
});

test('a subscription the phone dropped (410) is forgotten', async () => {
  pushStatus = 410;
  sent.length = 0;
  const r = (await (await fetch(`${base}/api/push/test`, { method: 'POST', headers: me.H })).json()) as { delivered: number };
  assert.equal(r.delivered, 0);
  assert.equal(((await (await fetch(`${base}/api/push`, { headers: me.H })).json()) as { subscribed: boolean }).subscribed, false);
  pushStatus = 201;
});

test('a disconnected device gets nothing, and its subscription is removed', async () => {
  const other = await pair('אייפד');
  const q = phone();
  await fetch(`${base}/api/push`, { method: 'POST', headers: other.H, body: JSON.stringify({ subscription: q.sub }) });
  await fetch(`${base}/api/push`, { method: 'POST', headers: me.H, body: JSON.stringify({ subscription: p.sub }) });
  await fetch(`${base}/api/devices/${other.id}`, { method: 'DELETE', headers: me.H });
  sent.length = 0;
  slowMs = 300;
  await sendAndLeave('ועוד אחד');
  await waitFor(1);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(sent.map((s) => s.url), [p.sub.endpoint], 'only the device still paired');
  const subs = db.getSetting<{ deviceId: string }[]>('push.subscriptions', []);
  assert.ok(!subs.some((s) => s.deviceId === other.id));
});

test('turning them off on this device', async () => {
  await fetch(`${base}/api/push`, { method: 'DELETE', headers: me.H });
  sent.length = 0;
  const r = (await (await fetch(`${base}/api/push/test`, { method: 'POST', headers: me.H })).json()) as { delivered: number };
  assert.equal(r.delivered, 0);
  assert.equal(sent.length, 0);
});
