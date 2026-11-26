/**
 * Gmail, Google Calendar and Google Contacts, straight from the Mac (no server in between).
 * - Login: OAuth for desktop apps (scripts/google-connect.ts). The refresh token is kept in the macOS
 *   Keychain; the client id/secret (not secret for desktop apps) in ~/.brain/google-client.json.
 * - Reading is free; sending mail and creating events happen only through approval cards (tools.ts).
 * - Mail content is untrusted: it is returned as data, never as instructions.
 */
import { readFile, writeFile, unlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type { Exec } from './tools.ts';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  // Marking mail as read (labels only). Asked for since version 0.9.0: older connections need npm run google:connect.
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
];

export const TZ = 'Asia/Jerusalem';

export interface GoogleEndpoints {
  auth: string;
  token: string;
  revoke: string;
  gmail: string;
  calendar: string;
  people: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  gmail: 'https://gmail.googleapis.com/gmail/v1/users/me',
  calendar: 'https://www.googleapis.com/calendar/v3',
  people: 'https://people.googleapis.com/v1',
};

export class GoogleError extends Error {
  userMessage: string;
  constructor(message: string, userMessage: string) {
    super(message);
    this.userMessage = userMessage;
  }
}

const NOT_CONNECTED = 'Google לא מחובר. כדי לחבר, הרץ במק: npm run google:connect';

// ------------------------------------------------------------------ secrets

export interface ClientConfig {
  clientId: string;
  clientSecret: string;
}
/** One connected Google account. `key` is short and stable: it prefixes mail ids ("2:18c…"). */
export interface Account {
  key: string;
  email: string;
  /** What the user calls it: "אישי", "עבודה"… */
  label: string;
  refreshToken: string;
  /** When this permission was given (ms). In Testing mode Google cancels it after 7 days. */
  connectedAt?: number;
}
export interface Stored {
  accounts: Account[];
  /** Keys are never reused, so a mail id from an old conversation never points to another mailbox. */
  next?: number;
}
export interface SecretStore {
  get(): Promise<Stored | null>;
  set(s: Stored): Promise<'keychain' | 'file'>;
  clear(): Promise<void>;
  where(): Promise<'keychain' | 'file' | null>;
}

const KEYCHAIN_SERVICE = 'brain.google';
/** Where versions before the rename (Felipe) kept the connection: read once, then moved to the new name. */
const LEGACY_KEYCHAIN_SERVICE = 'felipe.google';

/** Accepts the stored value, including the one-account format of version 0.8.0. */
export function normalizeStored(raw: unknown, legacyTime?: number): Stored | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { refreshToken?: string; email?: string; accounts?: Partial<Account>[]; next?: number };
  if (r.refreshToken) {
    return { accounts: [{ key: '1', label: 'אישי', email: r.email ?? '', refreshToken: r.refreshToken, ...(legacyTime ? { connectedAt: legacyTime } : {}) }] };
  }
  const accounts = (r.accounts ?? [])
    .filter((a): a is Account => Boolean(a && a.refreshToken && a.key))
    .map((a) => ({
      key: String(a.key), email: a.email ?? '', label: a.label || a.email || 'Google', refreshToken: a.refreshToken,
      ...(a.connectedAt ? { connectedAt: a.connectedAt } : {}),
    }));
  return accounts.length ? { accounts, ...(r.next ? { next: r.next } : {}) } : null;
}

/** macOS Keychain (login keychain), readable without a prompt by /usr/bin/security; a 0600 file elsewhere. */
export function keychainStore(exec: Exec, platform: string, dataDir: string): SecretStore {
  const file = join(dataDir, 'google-token.json');
  const fromFile = async (): Promise<Stored | null> => {
    try {
      return normalizeStored(JSON.parse(await readFile(file, 'utf8')));
    } catch {
      return null;
    }
  };
  const fromKeychain = async (service = KEYCHAIN_SERVICE): Promise<Stored | null> => {
    if (platform !== 'darwin') return null;
    try {
      const { stdout } = await exec('/usr/bin/security', ['find-generic-password', '-s', service, '-a', 'connection', '-w']);
      let out = stdout.trim();
      // `security -w` prints the value as hex when it holds bytes outside plain ASCII (Hebrew labels).
      if (!out.startsWith('{') && /^[0-9a-f]+$/i.test(out)) out = Buffer.from(out, 'hex').toString('utf8');
      const raw = JSON.parse(out) as { refreshToken?: string };
      // Saved by version 0.8.0 (one account, no date): the Keychain item's own date is when it was given.
      let legacyTime: number | undefined;
      if (raw.refreshToken) {
        const info = await exec('/usr/bin/security', ['find-generic-password', '-s', service, '-a', 'connection']).catch(() => ({ stdout: '' }));
        const m = info.stdout.match(/"mdat"<timedate>=0x[0-9A-F]+\s+"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/);
        if (m) legacyTime = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      }
      return normalizeStored(raw, legacyTime);
    } catch {
      return null;
    }
  };
  /** The connection saved under the old name (before the rename): moved to the new one, once. */
  const fromLegacy = async (): Promise<Stored | null> => {
    const old = await fromKeychain(LEGACY_KEYCHAIN_SERVICE);
    if (!old) return null;
    if ((await store.set(old)) === 'keychain') {
      await exec('/usr/bin/security', ['delete-generic-password', '-s', LEGACY_KEYCHAIN_SERVICE, '-a', 'connection']).catch(() => {});
    }
    return old;
  };
  const store: SecretStore = {
    async get() {
      return (await fromKeychain()) ?? (await fromLegacy()) ?? (await fromFile());
    },
    async set(v) {
      const value = JSON.stringify(v);
      if (platform === 'darwin') {
        try {
          await exec('/usr/bin/security', [
            'add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', 'connection',
            '-l', 'Brain – Google', '-T', '/usr/bin/security', '-w', value,
          ]);
          await unlink(file).catch(() => {});
          return 'keychain';
        } catch {
          // fall through to the file
        }
      }
      await writeFile(file, value, { mode: 0o600 });
      await chmod(file, 0o600);
      return 'file';
    },
    async clear() {
      if (platform === 'darwin') {
        await exec('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'connection']).catch(() => {});
      }
      await unlink(file).catch(() => {});
    },
    async where() {
      if ((await fromKeychain()) ?? (await fromLegacy())) return 'keychain';
      if (await fromFile()) return 'file';
      return null;
    },
  };
  return store;
}

/** For tests. Accepts the old one-account shape too. */
export function memoryStore(initial: unknown = null): SecretStore {
  let v = normalizeStored(initial);
  return {
    get: async () => (v ? structuredClone(v) : null),
    set: async (x) => {
      v = structuredClone(x);
      return 'file';
    },
    clear: async () => {
      v = null;
    },
    where: async () => (v ? 'file' : null),
  };
}

/** "עבודה", "העבודה", "work", "work@gmail.com", "עבודה (work@gmail.com)", "המייל של העבודה" → the account. */
export function matchAccount(accounts: Account[], name: string): Account | undefined {
  const raw = name.trim().toLowerCase();
  if (!raw) return undefined;
  const email = raw.match(/[^\s<>()]+@[^\s<>()]+/)?.[0];
  if (email) return accounts.find((a) => a.email.toLowerCase() === email);
  const aliases: Record<string, string[]> = {
    אישי: ['personal', 'private', 'פרטי', 'הפרטי', 'האישי'],
    עבודה: ['work', 'job', 'העבודה', 'משרד', 'המשרד'],
  };
  const words = (a: Account) =>
    [a.label.toLowerCase(), a.email.toLowerCase(), a.email.split('@')[0].toLowerCase(), ...(aliases[a.label] ?? [])].filter((w) => w.length >= 2);
  const plain = raw.replace(/^(?:מה|ב|מ|ל|ה)(?=\S{3})/, '');
  const exact = accounts.find((a) => words(a).includes(raw) || words(a).includes(plain));
  if (exact) return exact;
  // Otherwise the account whose name appears in the text; the longest match wins ("המייל של העבודה").
  let best: Account | undefined;
  let bestLen = 0;
  for (const a of accounts) {
    for (const w of words(a)) {
      if (w.length >= 3 && raw.includes(w) && w.length > bestLen) {
        best = a;
        bestLen = w.length;
      }
    }
  }
  return best;
}

export const accountName = (a: Account) => (a.email ? `${a.label} (${a.email})` : a.label);

export async function readClientConfig(dataDir: string): Promise<ClientConfig | null> {
  try {
    const raw = JSON.parse(await readFile(join(dataDir, 'google-client.json'), 'utf8')) as Record<string, unknown>;
    const c = (raw.installed ?? raw.web ?? raw) as { client_id?: string; client_secret?: string };
    return c.client_id && c.client_secret ? { clientId: c.client_id, clientSecret: c.client_secret } : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ dates (Israel time)

const pad = (n: number) => String(n).padStart(2, '0');
const israelOffset = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' });
const israelDate = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/** Today's date in Israel as YYYY-MM-DD. */
export function israelToday(now = new Date()): string {
  const p = Object.fromEntries(
    israelDate
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

export const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekday = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();

/** UTC instant of a wall-clock time in Israel (handles summer/winter time). */
export function israelInstant(ymd: string, hm = '00:00'): Date {
  const [y, mo, d] = ymd.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const off = israelOffset
      .formatToParts(new Date(guess))
      .find((p) => p.type === 'timeZoneName')!
      .value.match(/GMT([+-]\d{2}):?(\d{2})?/);
    const minutes = off ? Number(off[1]) * 60 + Math.sign(Number(off[1])) * Number(off[2] ?? 0) : 0;
    guess = Date.UTC(y, mo - 1, d, h, mi) - minutes * 60_000;
  }
  return new Date(guess);
}

/**
 * Hebrew (and simple) day words → a date range in Israel. The model passes the user's words
 * ("מחר", "ביום שלישי", "השבוע", "22.11"); the server, not the model, does the calendar math.
 */
export function resolveDays(input: string, now = new Date()): { from: string; to: string } | null {
  const today = israelToday(now);
  const t = input.trim().replace(/^(ב|ל)?(יום\s+)?/, '').replace(/["'״׳]/g, '').trim();
  const one = (d: string) => ({ from: d, to: d });
  if (/^(היום|today)$/i.test(t)) return one(today);
  if (/^(מחר|tomorrow)$/i.test(t)) return one(addDays(today, 1));
  if (/^(מחרתיים)$/.test(t)) return one(addDays(today, 2));
  if (/^(אתמול|yesterday)$/i.test(t)) return one(addDays(today, -1));
  if (/^(השבוע|this week)$/i.test(t)) return { from: today, to: addDays(today, 6 - weekday(today)) };
  if (/^(שבוע הבא|בשבוע הבא|next week)$/i.test(t)) {
    const sunday = addDays(today, 7 - weekday(today));
    return { from: sunday, to: addDays(sunday, 6) };
  }
  const dayIdx = DAY_NAMES.findIndex((n) => t === n || t === `${n} הבא` || t === `${n} הקרוב`);
  if (dayIdx >= 0) {
    let diff = (dayIdx - weekday(today) + 7) % 7;
    if (/הבא$/.test(t) && diff === 0) diff = 7;
    return one(addDays(today, diff));
  }
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return one(`${m[1]}-${pad(+m[2])}-${pad(+m[3])}`);
  m = t.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/);
  if (m) {
    const [, d, mo, y] = m;
    let year = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : Number(today.slice(0, 4));
    let ymd = `${year}-${pad(+mo)}-${pad(+d)}`;
    if (!y && ymd < today) ymd = `${++year}-${pad(+mo)}-${pad(+d)}`; // "5.1" in December means next year
    return one(ymd);
  }
  return null;
}

export function validTime(hm: string): string | null {
  const m = hm.trim().match(/^(\d{1,2})(?:[:.](\d{2}))?(?::\d{2})?$/);
  if (!m || Number(m[1]) > 23 || Number(m[2] ?? 0) > 59) return null;
  return `${pad(Number(m[1]))}:${m[2] ?? '00'}`;
}

/** "יום ראשון, 22.11" */
export function heDay(ymd: string): string {
  const [, mo, d] = ymd.split('-');
  return `יום ${DAY_NAMES[weekday(ymd)]}, ${Number(d)}.${Number(mo)}`;
}

// ------------------------------------------------------------------ mail parsing / building

interface Part {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: Part[];
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const header = (p: Part | undefined, name: string) =>
  p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

function decodeText(data: string, contentType: string): string {
  const charset = contentType.match(/charset="?([\w-]+)"?/i)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(b64url(data));
  } catch {
    return new TextDecoder('utf-8').decode(b64url(data));
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d|table)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain text of a Gmail message payload (text/plain preferred, else HTML converted), plus attachment names. */
export function messageText(payload: Part): { text: string; attachments: string[] } {
  let plain = '';
  let html = '';
  const attachments: string[] = [];
  const walk = (p: Part) => {
    const type = (p.mimeType ?? '').toLowerCase();
    if (p.filename) attachments.push(p.filename);
    else if (type === 'text/plain' && p.body?.data && !plain) plain = decodeText(p.body.data, header(p, 'Content-Type'));
    else if (type === 'text/html' && p.body?.data && !html) html = decodeText(p.body.data, header(p, 'Content-Type'));
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return { text: (plain || htmlToText(html)).replace(/\r\n/g, '\n').trim(), attachments };
}

/** RFC 2047 encoded-words for a Hebrew header, split so no word is too long. */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}

const EMAIL = /^[^\s@<>(),;:"\[\]]+@[^\s@<>(),;:"\[\]]+\.[^\s@<>(),;:"\[\]]+$/;

/** Splits "a@b.com, c@d.co.il" into checked addresses. Throws a Hebrew message for anything else. */
export function parseRecipients(raw: string): string[] {
  const list = raw.split(/[,;\s]+/).map((s) => s.trim().replace(/^<|>$/g, '')).filter(Boolean);
  if (!list.length) throw new GoogleError('no recipient', 'חסרה כתובת מייל של הנמען.');
  for (const a of list) {
    if (!EMAIL.test(a)) throw new GoogleError(`bad address ${a}`, `"${a}" היא לא כתובת מייל. צריך כתובת מלאה, למשל name@gmail.com.`);
  }
  return list;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();

/** A complete MIME message: plain text + right-to-left HTML, UTF-8, safe headers. */
export function buildMime(m: { to: string[]; subject: string; body: string; inReplyTo?: string; references?: string }): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
  const boundary = `brain-${Math.random().toString(36).slice(2)}`;
  const html = `<div dir="rtl" style="text-align:right">${escapeHtml(m.body).replace(/\r?\n/g, '<br>')}</div>`;
  const lines = [
    `To: ${m.to.join(', ')}`,
    `Subject: ${encodeHeader(clean(m.subject))}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${clean(m.inReplyTo)}`, `References: ${clean(m.references || m.inReplyTo)}`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(m.body).toString('base64')),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(html).toString('base64')),
    `--${boundary}--`,
    '',
  ];
  return lines.join('\r\n');
}

// ------------------------------------------------------------------ the client

export interface MailSummary {
  id: string;
  threadId: string;
  /** Label of the account, when more than one is connected. */
  account: string;
  from: string;
  subject: string;
  date: string;
  time: number;
  snippet: string;
  unread: boolean;
}
export interface CalendarEvent {
  title: string;
  start: string; // "YYYY-MM-DD" (all day) or ISO
  end: string;
  allDay: boolean;
  location: string;
  calendar: string;
  link: string;
}

export interface GoogleOptions {
  dataDir: string;
  exec: Exec;
  platform: string;
  store?: SecretStore;
  endpoints?: Partial<GoogleEndpoints>;
  client?: ClientConfig | null;
  now?: () => Date;
  /** Days a permission lasts (Testing mode: 7). 0 = no limit. */
  renewDays?: number;
}

export function createGoogle(o: GoogleOptions) {
  const ep = { ...GOOGLE_ENDPOINTS, ...o.endpoints };
  const store = o.store ?? keychainStore(o.exec, o.platform, o.dataDir);
  const now = o.now ?? (() => new Date());
  const access = new Map<string, { token: string; refreshToken: string; expiresAt: number }>();
  const refreshing = new Map<string, Promise<string>>();
  let stored: Account[] | undefined; // undefined = not read yet
  let nextKey = 1;
  let checkedAt = 0;

  const clientConfig = async () => (o.client !== undefined ? o.client : readClientConfig(o.dataDir));

  /** The connected accounts. Re-read every 15 seconds, so connecting from the Terminal needs no restart. */
  async function accounts(): Promise<Account[]> {
    if (stored === undefined || Date.now() - checkedAt > 15_000) {
      const v = await store.get();
      stored = v?.accounts ?? [];
      nextKey = Math.max(v?.next ?? 1, ...stored.map((a) => (Number(a.key) || 0) + 1));
      checkedAt = Date.now();
    }
    return stored;
  }
  /** The last list read, for code that can't wait (approval cards). */
  const knownAccounts = () => stored ?? [];
  const many = () => knownAccounts().length > 1;

  async function accessToken(acc: Account): Promise<string> {
    const cached = access.get(acc.key);
    if (cached && cached.refreshToken === acc.refreshToken && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const key = JSON.stringify([acc.key, acc.refreshToken]);
    let request = refreshing.get(key);
    if (!request) {
      request = refreshToken(acc).finally(() => { refreshing.delete(key); });
      refreshing.set(key, request);
    }
    return request;
  }

  async function refreshToken(acc: Account): Promise<string> {
    const client = await clientConfig();
    if (!client) throw new GoogleError('not configured', NOT_CONNECTED);
    const res = await fetch(ep.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: acc.refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch((e) => {
      throw new GoogleError(String(e), 'אין חיבור ל־Google כרגע (אינטרנט?). נסה שוב עוד רגע.');
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    const which = many() ? ` של החשבון "${acc.label}"` : '';
    if (!res.ok || !data.access_token) {
      if (data.error === 'invalid_grant') {
        stored = undefined; // read again next time: the user may reconnect from the Terminal
        throw new GoogleError('invalid_grant', `ההרשאה${which} ב־Google פגה או בוטלה. כדי לחבר מחדש, הרץ במק: npm run google:connect${which ? ' ובחר את החשבון הזה' : ''}`);
      }
      throw new GoogleError(`token ${res.status} ${data.error}`, `Google לא אישר את הכניסה${which}. נסה שוב, ואם זה חוזר הרץ במק: npm run google:connect`);
    }
    if (knownAccounts().some(a => a.key === acc.key && a.refreshToken === acc.refreshToken)) {
      access.set(acc.key, { token: data.access_token, refreshToken: acc.refreshToken, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
    }
    return data.access_token;
  }

  async function api<T>(acc: Account, url: string, init: RequestInit = {}): Promise<T> {
    const token = await accessToken(acc);
    const res = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    }).catch((e) => {
      throw new GoogleError(String(e), 'אין חיבור ל־Google כרגע (אינטרנט?). נסה שוב עוד רגע.');
    });
    if (res.status === 401 && access.get(acc.key)?.token === token) access.delete(acc.key);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string } };
      const msg = body.error?.message ?? res.statusText;
      if (res.status === 403 && /scope|insufficient/i.test(msg + body.error?.status)) {
        throw new GoogleError(msg, 'חסרה הרשאה ב־Google לפעולה הזאת. הרץ במק: npm run google:connect ואשר את כל ההרשאות.');
      }
      if (res.status === 404) throw new GoogleError(msg, 'לא נמצא ב־Google (אולי נמחק).');
      throw new GoogleError(`${res.status} ${msg}`, `Google החזיר שגיאה: ${msg}`);
    }
    return (res.status === 204 ? {} : await res.json()) as T;
  }

  // ---- which account
  async function connected(): Promise<Account[]> {
    const list = await accounts();
    if (!list.length || !(await clientConfig())) throw new GoogleError('not connected', NOT_CONNECTED);
    return list;
  }
  const unknownAccount = (name: string, list: Account[]) =>
    new GoogleError('no such account', `אין חשבון מחובר בשם "${name}". החשבונות: ${list.map(accountName).join(', ')}.`);
  /** For reading: the named account, or all of them. */
  async function readFrom(name?: string): Promise<Account[]> {
    const list = await connected();
    if (!name?.trim()) return list;
    const a = matchAccount(list, name);
    if (!a) throw unknownAccount(name, list);
    return [a];
  }
  /** For sending and creating: the named account, or the first one connected. */
  async function writeFrom(name?: string): Promise<Account> {
    const list = await connected();
    if (!name?.trim()) return list[0];
    const a = matchAccount(list, name);
    if (!a) throw unknownAccount(name, list);
    return a;
  }
  /** "2:18c…" → account 2. Ids without a prefix (older conversations) belong to the first account. */
  async function byId(id: string): Promise<{ acc: Account; id: string }> {
    const list = await connected();
    const m = id.match(/^([^:]+):(.+)$/);
    const acc = m ? list.find((a) => a.key === m[1]) : list[0];
    if (!acc) throw new GoogleError('account gone', 'המייל הזה שייך לחשבון שכבר לא מחובר.');
    return { acc, id: m ? m[2] : id };
  }
  const labelOf = (acc: Account) => (many() ? acc.label : '');

  /** Runs on each account; a failing account is reported, not fatal (unless all fail). */
  async function everyAccount<T>(list: Account[], fn: (a: Account) => Promise<T[]>): Promise<{ items: T[]; problems: string[] }> {
    const results = await Promise.allSettled(list.map(fn));
    const items: T[] = [];
    const problems: string[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') items.push(...r.value);
      else {
        const msg = r.reason instanceof GoogleError ? r.reason.userMessage : String(r.reason);
        problems.push(list.length > 1 ? `${list[i].label}: ${msg}` : msg);
      }
    });
    if (problems.length === list.length && list.length) {
      const first = results[0] as PromiseRejectedResult;
      if (first.reason instanceof GoogleError && list.length === 1) throw first.reason;
      throw new GoogleError('all failed', problems.join('\n'));
    }
    return { items, problems };
  }

  // ---- mail
  async function searchMail(query: string, max = 10, account?: string) {
    const list = await readFrom(account);
    const { items, problems } = await everyAccount(list, async (acc) => {
      const found = await api<{ messages?: { id: string; threadId: string }[] }>(
        acc,
        `${ep.gmail}/messages?${new URLSearchParams({ q: query, maxResults: String(Math.min(max, 20)) })}`,
      );
      return Promise.all(
        (found.messages ?? []).map(async ({ id }): Promise<MailSummary> => {
          const m = await api<{ id: string; threadId: string; snippet?: string; labelIds?: string[]; internalDate?: string; payload?: Part }>(
            acc,
            `${ep.gmail}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          );
          const date = header(m.payload, 'Date');
          return {
            id: `${acc.key}:${m.id}`,
            threadId: m.threadId,
            account: labelOf(acc),
            from: header(m.payload, 'From'),
            subject: header(m.payload, 'Subject'),
            date,
            time: Number(m.internalDate) || Date.parse(date) || 0,
            snippet: (m.snippet ?? '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
            unread: (m.labelIds ?? []).includes('UNREAD'),
          };
        }),
      );
    });
    return { mails: items.sort((a, b) => b.time - a.time).slice(0, max), problems };
  }

  async function readMail(fullId: string) {
    const { acc, id } = await byId(fullId);
    const m = await api<{ id: string; threadId: string; payload: Part; labelIds?: string[] }>(
      acc,
      `${ep.gmail}/messages/${encodeURIComponent(id)}?format=full`,
    );
    const { text, attachments } = messageText(m.payload);
    return {
      id: `${acc.key}:${m.id}`,
      threadId: m.threadId,
      account: labelOf(acc),
      accountKey: acc.key,
      from: header(m.payload, 'From'),
      to: header(m.payload, 'To'),
      subject: header(m.payload, 'Subject'),
      date: header(m.payload, 'Date'),
      messageId: header(m.payload, 'Message-ID') || header(m.payload, 'Message-Id'),
      references: header(m.payload, 'References'),
      text,
      attachments,
    };
  }

  async function sendMail(m: { to: string; subject: string; body: string; replyTo?: string; account?: string }) {
    const to = parseRecipients(m.to);
    if (!m.body.trim()) throw new GoogleError('empty body', 'תוכן המייל ריק.');
    let threadId: string | undefined;
    let inReplyTo: string | undefined;
    let references: string | undefined;
    let subject = m.subject.trim();
    let from: Account | undefined;
    if (m.replyTo) {
      const orig = await readMail(m.replyTo);
      from = (await connected()).find((a) => a.key === orig.accountKey);
      inReplyTo = orig.messageId || undefined;
      references = [orig.references, orig.messageId].filter(Boolean).join(' ') || undefined;
      threadId = orig.threadId;
      if (!subject) subject = /^re:/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}`;
    }
    const sender = m.account?.trim() ? await writeFrom(m.account) : (from ?? (await writeFrom()));
    // A reply sent from another account can't join the thread there; the headers still link it.
    if (from && sender.key !== from.key) threadId = undefined;
    if (!subject) throw new GoogleError('empty subject', 'חסר נושא למייל.');
    const raw = Buffer.from(buildMime({ to, subject, body: m.body, inReplyTo, references })).toString('base64url');
    const sent = await api<{ id: string; threadId: string }>(sender, `${ep.gmail}/messages/send`, {
      method: 'POST',
      body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
    });
    return { id: sent.id, to, subject, from: sender.email };
  }

  /** Marks mail as read: the messages matching a Gmail search (in each account), or the given ids. */
  async function markRead(m: { query?: string; ids?: string[]; account?: string }) {
    const perAccount = new Map<Account, string[]>();
    if (m.ids?.length) {
      for (const full of m.ids) {
        const { acc, id } = await byId(full);
        perAccount.set(acc, [...(perAccount.get(acc) ?? []), id]);
      }
    } else if (m.query?.trim()) {
      for (const acc of await readFrom(m.account)) {
        const found: string[] = [];
        let pageToken = '';
        do {
          const page = await api<{ messages?: { id: string }[]; nextPageToken?: string }>(
            acc,
            `${ep.gmail}/messages?${new URLSearchParams({ q: m.query, maxResults: '500', ...(pageToken ? { pageToken } : {}) })}`,
          );
          found.push(...(page.messages ?? []).map((x) => x.id));
          pageToken = page.nextPageToken ?? '';
        } while (pageToken && found.length < 2000);
        if (found.length) perAccount.set(acc, found);
      }
    } else {
      throw new GoogleError('nothing to mark', 'לא צוין אילו מיילים לסמן.');
    }
    let count = 0;
    for (const [acc, ids] of perAccount) {
      for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        await api(acc, `${ep.gmail}/messages/batchModify`, { method: 'POST', body: JSON.stringify({ ids: chunk, removeLabelIds: ['UNREAD'] }) });
        count += chunk.length;
      }
    }
    return { count };
  }

  // ---- contacts (all accounts together)
  async function findContacts(name: string) {
    const readMask = 'names,emailAddresses';
    const q = encodeURIComponent(name.trim());
    type Person = { names?: { displayName?: string }[]; emailAddresses?: { value?: string }[] };
    type Found = { results?: { person: Person }[] };
    const { items } = await everyAccount(await connected(), async (acc) => {
      // The People API recommends a warm-up call with an empty query before searching.
      await api(acc, `${ep.people}/people:searchContacts?query=&readMask=${readMask}`).catch(() => {});
      const [saved, other] = await Promise.all([
        api<Found>(acc, `${ep.people}/people:searchContacts?query=${q}&readMask=${readMask}&pageSize=10`).catch(() => ({ results: [] }) as Found),
        api<Found>(acc, `${ep.people}/otherContacts:search?query=${q}&readMask=${readMask}&pageSize=10`).catch(() => ({ results: [] }) as Found),
      ]);
      return [...(saved.results ?? []), ...(other.results ?? [])];
    });
    const out: { name: string; email: string }[] = [];
    for (const r of items) {
      const display = r.person.names?.[0]?.displayName ?? '';
      for (const e of r.person.emailAddresses ?? []) {
        if (e.value && !out.some((x) => x.email.toLowerCase() === e.value!.toLowerCase())) out.push({ name: display, email: e.value });
      }
    }
    return out.slice(0, 8);
  }

  // ---- calendar
  async function listEvents(fromDay: string, toDay: string, account?: string) {
    const timeMin = israelInstant(fromDay).toISOString();
    const timeMax = israelInstant(addDays(toDay, 1)).toISOString();
    type Cal = { id: string; summary?: string; summaryOverride?: string; selected?: boolean; hidden?: boolean; primary?: boolean };
    type Ev = { summary?: string; location?: string; htmlLink?: string; status?: string; start: { date?: string; dateTime?: string }; end: { date?: string; dateTime?: string } };
    const { items, problems } = await everyAccount(await readFrom(account), async (acc) => {
      const cals = await api<{ items?: Cal[] }>(acc, `${ep.calendar}/users/me/calendarList?minAccessRole=reader`).catch(
        () => ({ items: [{ id: 'primary', summary: '', primary: true }] }) as { items?: Cal[] },
      );
      const chosen = (cals.items ?? []).filter((c) => c.primary || (c.selected && !c.hidden));
      const lists = await Promise.all(
        chosen.map(async (c) => {
          const r = await api<{ items?: Ev[] }>(
            acc,
            `${ep.calendar}/calendars/${encodeURIComponent(c.id)}/events?${new URLSearchParams({
              timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '50', timeZone: TZ,
            })}`,
          );
          const name = c.primary ? '' : (c.summaryOverride ?? c.summary ?? '');
          const calendar = [labelOf(acc), name].filter(Boolean).join(' · ');
          return (r.items ?? [])
            .filter((e) => e.status !== 'cancelled')
            .map((e): CalendarEvent => ({
              title: e.summary ?? '(בלי כותרת)',
              start: e.start.dateTime ?? e.start.date ?? '',
              end: e.end.dateTime ?? e.end.date ?? '',
              allDay: !e.start.dateTime,
              location: e.location ?? '',
              calendar,
              link: e.htmlLink ?? '',
            }));
        }),
      );
      return lists.flat();
    });
    const key = (e: CalendarEvent) => (e.allDay ? israelInstant(e.start).getTime() : new Date(e.start).getTime());
    // The same meeting in both calendars (an invitation to both accounts) is listed once.
    const seen = new Set<string>();
    const events = items
      .sort((a, b) => key(a) - key(b))
      .filter((e) => {
        const k = `${e.title}|${key(e)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    return { events, problems };
  }

  async function createEvent(e: { title: string; date: string; start?: string; end?: string; location?: string; guests?: string; account?: string }) {
    const acc = await writeFrom(e.account);
    const body: Record<string, unknown> = { summary: e.title, ...(e.location ? { location: e.location } : {}) };
    if (e.start) {
      const end = e.end ?? (() => {
        const [h, m] = e.start!.split(':').map(Number);
        const t = h * 60 + m + 60;
        return t >= 24 * 60 ? '23:59' : `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
      })();
      if (end <= e.start) throw new GoogleError('end before start', 'שעת הסיום צריכה להיות אחרי שעת ההתחלה.');
      body.start = { dateTime: `${e.date}T${e.start}:00`, timeZone: TZ };
      body.end = { dateTime: `${e.date}T${end}:00`, timeZone: TZ };
    } else {
      body.start = { date: e.date };
      body.end = { date: addDays(e.date, 1) };
    }
    const guests = e.guests ? parseRecipients(e.guests) : [];
    if (guests.length) body.attendees = guests.map((email) => ({ email }));
    const created = await api<{ id: string; htmlLink?: string }>(
      acc,
      `${ep.calendar}/calendars/primary/events?sendUpdates=${guests.length ? 'all' : 'none'}`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return { id: created.id, link: created.htmlLink ?? '', guests, account: labelOf(acc) };
  }

  // ---- connection
  async function status() {
    const [client, list] = await Promise.all([clientConfig(), accounts()]);
    return {
      configured: Boolean(client),
      connected: Boolean(client && list.length),
      email: list[0]?.email ?? null,
      accounts: list.map((a) => ({ key: a.key, email: a.email, label: a.label, renewBy: renewBy(a) })),
      where: list.length ? await store.where() : null,
    };
  }

  /** When the permission has to be given again (Testing mode), or null when it doesn't expire / isn't known. */
  function renewBy(a: Account): number | null {
    const days = o.renewDays ?? 7;
    return days > 0 && a.connectedAt ? a.connectedAt + days * 86_400_000 : null;
  }

  /** True when Google can be used (cheap: the list is cached). */
  async function available(): Promise<boolean> {
    return Boolean((await clientConfig()) && (await accounts()).length);
  }

  const revoke = (a: Account) =>
    fetch(`${ep.revoke}?${new URLSearchParams({ token: a.refreshToken })}`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => {});

  /** Disconnects one account (by key or email), or all of them. */
  async function disconnect(which?: string) {
    stored = undefined;
    const list = await accounts();
    const gone = which ? list.filter((a) => a.key === which || a.email.toLowerCase() === which.toLowerCase()) : list;
    await Promise.all(gone.map(revoke));
    const rest = list.filter((a) => !gone.includes(a));
    if (rest.length) await store.set({ accounts: rest, next: nextKey });
    else await store.clear();
    for (const a of gone) access.delete(a.key);
    stored = rest;
    checkedAt = Date.now();
    return gone.map((a) => a.email);
  }

  /** Called by google-connect after a successful login. Same email again = a new permission for it. */
  async function saveAccount(c: { refreshToken: string; email: string; label?: string }) {
    stored = undefined;
    const list = [...(await accounts())];
    const i = list.findIndex((a) => c.email && a.email.toLowerCase() === c.email.toLowerCase());
    let account: Account;
    if (i >= 0) {
      account = { ...list[i], refreshToken: c.refreshToken, label: c.label?.trim() || list[i].label, connectedAt: Date.now() };
      list[i] = account;
    } else {
      const key = String(nextKey++);
      account = { key, email: c.email, refreshToken: c.refreshToken, label: c.label?.trim() || defaultLabel(list.length, c.email), connectedAt: Date.now() };
      list.push(account);
    }
    const where = await store.set({ accounts: list, next: nextKey });
    stored = list;
    checkedAt = Date.now();
    access.delete(account.key);
    return { where, account: { key: account.key, email: account.email, label: account.label, renewBy: renewBy(account) }, replaced: i >= 0, count: list.length };
  }

  async function profileEmail(token: string): Promise<string> {
    const res = await fetch(`${ep.gmail}/profile`, { headers: { authorization: `Bearer ${token}` } });
    const data = (await res.json().catch(() => ({}))) as { emailAddress?: string };
    return data.emailAddress ?? '';
  }

  /** "עבודה (work@gmail.com)" for the account the model named, or the default; '' with one account. Sync: for approval cards. */
  function cardAccount(name: string | undefined, replyTo?: string): string {
    const list = knownAccounts();
    if (list.length < 2) {
      if (name?.trim() && list.length === 1 && !matchAccount(list, name)) throw unknownAccount(name, list);
      return '';
    }
    if (name?.trim()) {
      const a = matchAccount(list, name);
      if (!a) throw unknownAccount(name, list);
      return accountName(a);
    }
    const key = replyTo?.match(/^([^:]+):/)?.[1];
    return accountName(list.find((a) => a.key === key) ?? list[0]);
  }

  return {
    status, available, disconnect, saveAccount, profileEmail, knownAccounts, cardAccount,
    searchMail, readMail, sendMail, markRead, findContacts, listEvents, createEvent,
    endpoints: ep, now,
  };
}

export function defaultLabel(index: number, email: string) {
  return index === 0 ? 'אישי' : index === 1 ? 'עבודה' : email.split('@')[0] || `חשבון ${index + 1}`;
}

export type Google = ReturnType<typeof createGoogle>;
