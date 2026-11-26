/**
 * Notifications to the iPhone (Web Push), with nothing but node:crypto.
 *
 * The Mac encrypts every notification for the phone's own key (RFC 8291, aes128gcm) and signs the
 * request with its own key (VAPID, RFC 8292). Apple's push service only passes the sealed message on:
 * it can't read it. Subscriptions belong to paired devices; a revoked device gets nothing.
 */
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';

export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface StoredSubscription extends Subscription {
  deviceId: string;
  createdAt: number;
}
export interface VapidKeys {
  /** Uncompressed P-256 point, base64url (what the app passes to pushManager.subscribe). */
  publicKey: string;
  /** The 32-byte private scalar, base64url. Never leaves the Mac. */
  privateKey: string;
}
export interface Notice {
  title: string;
  body: string;
  /** Opened when the notification is tapped (an in-app path, e.g. /?c=<conversation>). */
  url?: string;
  /** A newer notification with the same tag replaces the older one. */
  tag?: string;
}

/** Only the real push services: a subscription can't make the Mac send requests anywhere else. */
const PUSH_HOSTS = [
  /^web\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];
const RECORD_SIZE = 4096;
const MAX_PAYLOAD = 3000;
const MAX_SUBSCRIPTIONS = 10;
const unb64 = (s: string) => Buffer.from(s, 'base64url');

export function validSubscription(x: unknown): Subscription | null {
  if (!x || typeof x !== 'object') return null;
  const s = x as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof s.endpoint !== 'string' || s.endpoint.length > 1000) return null;
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !PUSH_HOSTS.some((h) => h.test(url.hostname))) return null;
  const p256dh = typeof s.keys?.p256dh === 'string' ? s.keys.p256dh : '';
  const auth = typeof s.keys?.auth === 'string' ? s.keys.auth : '';
  if (!/^[A-Za-z0-9_-]+$/.test(p256dh) || !/^[A-Za-z0-9_-]+$/.test(auth)) return null;
  const key = unb64(p256dh);
  if (key.length !== 65 || key[0] !== 4 || unb64(auth).length !== 16) return null;
  // A real P-256 public key, not just 65 bytes that look like one.
  try {
    const probe = createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(key);
  } catch {
    return null;
  }
  return { endpoint: s.endpoint, keys: { p256dh, auth } };
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') };
}

/** The Authorization header for one push service (RFC 8292). */
export function vapidAuth(endpoint: string, keys: VapidKeys, contact: string, now = Date.now()): string {
  const pub = unb64(keys.publicKey);
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') },
    format: 'jwk',
  });
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: contact })}`;
  const signature = sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `vapid t=${data}.${signature}, k=${keys.publicKey}`;
}

/**
 * Seals a message for one subscription (RFC 8291 / RFC 8188, a single aes128gcm record).
 * `fixed` is only for the RFC's test vector: normally the salt and the sending key are new every time.
 */
export function encrypt(payload: Buffer, sub: Subscription['keys'], fixed?: { salt: Buffer; privateKey: Buffer }): Buffer {
  if (payload.length > MAX_PAYLOAD) throw new Error('payload too large');
  const uaPublic = unb64(sub.p256dh);
  const authSecret = unb64(sub.auth);
  const ecdh = createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = fixed?.salt ?? randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02: the last (and only) record, no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** Cuts text to a notification's length, on a word if possible. */
export function clipText(text: string, max: number): string {
  const one = text.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

export interface PushOptions {
  subscriptions: { load(): StoredSubscription[]; save(list: StoredSubscription[]): void };
  keys: { load(): VapidKeys | null; save(keys: VapidKeys): void };
  /** Which paired devices are still allowed (revoked ones get nothing). */
  activeDevices: () => Set<string>;
  /** Who runs this Brain, for the push service (a mailto: or https: address). */
  contact?: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (event: string, details: Record<string, unknown>) => void;
}

export function createPush(opts: PushOptions) {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const contact = opts.contact ?? 'https://github.com/nissimcoh/brain-assistant';

  function keys(): VapidKeys {
    let k = opts.keys.load();
    if (!k?.publicKey || !k.privateKey) {
      k = generateVapidKeys();
      opts.keys.save(k);
    }
    return k;
  }

  /** One subscription per device: a new one replaces the device's old one. */
  function subscribe(deviceId: string, sub: Subscription) {
    const list = opts.subscriptions.load().filter((s) => s.deviceId !== deviceId && s.endpoint !== sub.endpoint);
    list.push({ ...sub, deviceId, createdAt: now() });
    opts.subscriptions.save(list.slice(-MAX_SUBSCRIPTIONS));
  }

  function unsubscribe(deviceId: string): boolean {
    const list = opts.subscriptions.load();
    const left = list.filter((s) => s.deviceId !== deviceId);
    opts.subscriptions.save(left);
    return left.length !== list.length;
  }

  const has = (deviceId: string) => opts.subscriptions.load().some((s) => s.deviceId === deviceId);

  /** Sends to every allowed device (or just one). Returns how many push services accepted it. */
  async function send(notice: Notice, only?: { deviceId?: string; urgent?: boolean }): Promise<number> {
    const active = opts.activeDevices();
    const targets = opts.subscriptions.load().filter((s) => active.has(s.deviceId) && (!only?.deviceId || s.deviceId === only.deviceId));
    if (!targets.length) return 0;
    const k = keys();
    const payload = Buffer.from(
      JSON.stringify({ title: clipText(notice.title, 60), body: clipText(notice.body, 180), url: notice.url ?? '/', tag: notice.tag }),
    );
    const gone: string[] = [];
    let delivered = 0;
    await Promise.all(
      targets.map(async (s) => {
        try {
          const res = await doFetch(s.endpoint, {
            method: 'POST',
            headers: {
              authorization: vapidAuth(s.endpoint, k, contact, now()),
              'content-encoding': 'aes128gcm',
              'content-type': 'application/octet-stream',
              ttl: '86400',
              urgency: only?.urgent ? 'high' : 'normal',
            },
            body: new Uint8Array(encrypt(payload, s.keys)),
            signal: AbortSignal.timeout(15_000),
          });
          if (res.ok) delivered++;
          // The phone dropped this subscription (app removed, notifications turned off).
          else if (res.status === 404 || res.status === 410) gone.push(s.endpoint);
          else opts.log?.('push.failed', { deviceId: s.deviceId, status: res.status, reason: (await res.text().catch(() => '')).slice(0, 200) });
        } catch (err) {
          opts.log?.('push.failed', { deviceId: s.deviceId, error: (err as Error).message });
        }
      }),
    );
    if (gone.length) {
      opts.subscriptions.save(opts.subscriptions.load().filter((s) => !gone.includes(s.endpoint)));
      opts.log?.('push.expired', { count: gone.length });
    }
    return delivered;
  }

  return { publicKey: () => keys().publicKey, subscribe, unsubscribe, has, send };
}

export type Push = ReturnType<typeof createPush>;
