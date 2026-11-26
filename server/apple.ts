/**
 * Calendar, Reminders, Contacts (EventKit / Contacts) and Notes, Messages (AppleScript) on this Mac,
 * through "Brain Helper.app" (helper/main.swift): macOS gives these permissions to apps, not to Node.
 * Each request starts the helper with `open` (so the permissions are the helper's own), passes a JSON
 * file and reads a JSON file back. Since the iPhone syncs with the Mac through iCloud, this is also
 * the iPhone's calendar, reminders, contacts and notes.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const APPLE_BUNDLE_ID = 'com.brain.helper';
export const helperAppPath = () => join(homedir(), 'Applications', 'Brain Helper.app');
/** The helper built before the rename. Used until `npm run apple:setup` builds the new one, so the permissions keep working. */
export const legacyHelperAppPath = () => join(homedir(), 'Applications', 'Felipe Helper.app');
const binaryOf = (appPath: string) => join(appPath, 'Contents', 'MacOS', appPath.endsWith('Felipe Helper.app') ? 'FelipeHelper' : 'BrainHelper');

export const PERMISSION_NAMES: Record<string, string> = {
  calendar: 'יומן',
  reminders: 'תזכורות',
  contacts: 'אנשי קשר',
  notes: 'פתקים',
  messages: 'הודעות (iMessage / SMS)',
  camera: 'מצלמה',
};

const PRIVACY = 'הגדרות מערכת ← פרטיות ואבטחה';
export function permissionHelp(key: string, state: string): string {
  if (state === 'notDetermined') return 'macOS עוד לא שאל. הרץ שוב npm run apple:setup ואשר בחלון.';
  if (state === 'writeOnly') return `יש רק הרשאת הוספה. ${PRIVACY} ← לוחות שנה ← Brain Helper ← "גישה מלאה".`;
  const where: Record<string, string> = {
    calendar: `${PRIVACY} ← לוחות שנה ← Brain Helper ← "גישה מלאה"`,
    reminders: `${PRIVACY} ← תזכורות ← Brain Helper ← "גישה מלאה"`,
    contacts: `${PRIVACY} ← אנשי קשר ← להדליק את Brain Helper`,
    notes: `${PRIVACY} ← אוטומציה ← Brain Helper ← להדליק את Notes`,
    messages: `${PRIVACY} ← אוטומציה ← Brain Helper ← להדליק את Messages`,
    camera: `${PRIVACY} ← מצלמה ← להדליק את Brain Helper`,
  };
  if (state.startsWith('error') && key === 'messages') return `אפליקציית Messages במק לא מוכנה (מחוברת ל־Apple ID?): ${state}`;
  if (state.startsWith('error')) return state;
  return where[key] ?? state;
}

export class AppleError extends Error {
  userMessage: string;
  code: string;
  constructor(code: string, userMessage: string) {
    super(code);
    this.code = code;
    this.userMessage = userMessage;
  }
}

const NOT_INSTALLED = 'היומן, התזכורות, אנשי הקשר והפתקים של Apple עוד לא מחוברים. במק: npm run apple:setup';

function errorFor(code: string, message: string): AppleError {
  const known: Record<string, string> = {
    'no-calendar-access': `אין לבריין גישה ליומן של המק. במק: npm run apple:setup`,
    'no-reminders-access': `אין לבריין גישה לתזכורות. במק: npm run apple:setup`,
    'no-contacts-access': `אין לבריין גישה לאנשי הקשר. במק: npm run apple:setup`,
    'automation-denied': `Brain Helper לא מורשה לשלוט באפליקציה הזו. ${PRIVACY} ← אוטומציה ← Brain Helper.`,
    'not-found': 'לא נמצא (אולי נמחק).',
    'no-calendar': 'אין יומן ברירת מחדל במק.',
    'no-list': 'אין רשימת תזכורות ברירת מחדל.',
    'camera-denied': `אין לבריין גישה למצלמה של המק. במק: npm run apple:setup, או ${PRIVACY} ← מצלמה ← Brain Helper.`,
    'camera-unavailable': 'המצלמה של המק לא זמינה. אולי המכסה סגור או שהמק ישן.',
    'camera-busy': 'המצלמה של המק תפוסה כרגע (אולי שיחת וידאו פתוחה במק).',
  };
  return new AppleError(code, known[code] ?? `שגיאה מ־Apple: ${message}`);
}

// ------------------------------------------------------------------ AppleScript (built here, run by the helper)

/** A safe AppleScript string expression for any text (quotes, backslashes and line breaks). */
export function asText(s: string): string {
  const lines = s.replace(/\r\n?/g, '\n').split('\n');
  return lines.map((l) => `"${l.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(' & linefeed & ');
}

const RS = '\u001e';
const US = '\u001f';

export function notesSearchScript(query: string): string {
  return `set q to ${asText(query)}
set out to {}
tell application "Notes"
  set found to (every note whose name contains q)
  if (count of found) < 10 then
    try
      set found to found & (every note whose plaintext contains q)
    end try
  end if
  set n to 0
  repeat with x in found
    set n to n + 1
    if n > 15 then exit repeat
    set t to plaintext of x
    if (length of t) > 200 then set t to text 1 thru 200 of t
    set end of out to (id of x) & (character id 31) & (name of x) & (character id 31) & ((modification date of x) as «class isot» as string) & (character id 31) & t
  end repeat
end tell
set AppleScript's text item delimiters to (character id 30)
return out as text`;
}

export function noteReadScript(id: string): string {
  return `tell application "Notes"
  set x to note id ${asText(id)}
  return (name of x) & (character id 31) & ((modification date of x) as «class isot» as string) & (character id 31) & (plaintext of x)
end tell`;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function noteCreateScript(title: string, body: string): string {
  const html =
    `<div><b>${escapeHtml(title)}</b></div>` +
    body
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l) => `<div>${l.trim() ? escapeHtml(l) : '<br>'}</div>`)
      .join('');
  return `tell application "Notes"
  set x to make new note with properties {body:${asText(html)}}
  return id of x
end tell`;
}

export function messageScript(to: string, text: string, service: 'iMessage' | 'SMS'): string {
  return `tell application "Messages"
  set svc to missing value
  try
    set svc to 1st account whose service type = ${service}
  end try
  if svc is missing value then error "no ${service} account" number 9001
  set p to participant ${asText(to)} of svc
  send ${asText(text)} to p
end tell
return "ok"`;
}

/** Israeli and international numbers to +972…; emails as they are (iMessage). */
export function normalizeRecipient(raw: string): string {
  const s = raw.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s;
  const digits = s.replace(/[\s\-().]/g, '');
  if (!/^\+?\d{7,15}$/.test(digits)) {
    throw new AppleError('bad-recipient', `"${raw}" זה לא מספר טלפון. צריך מספר (למשל 050-1234567) או כתובת iMessage.`);
  }
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('972')) return `+${digits}`;
  if (digits.startsWith('0')) return `+972${digits.slice(1)}`;
  return digits;
}

// ------------------------------------------------------------------ the client

export interface AppleCalendar {
  id: string;
  title: string;
  source: string;
  writable: boolean;
  default: boolean;
}
export interface AppleList {
  id: string;
  title: string;
  default: boolean;
}
export interface AppleStatus {
  installed: boolean;
  calendar: string;
  reminders: string;
  contacts: string;
  /** The Mac's camera: "full" once allowed (older helpers don't report it). */
  camera?: string;
  calendars: AppleCalendar[];
  lists: AppleList[];
}
export interface AppleEvent {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  calendar: string;
}
export interface AppleReminder {
  id: string;
  title: string;
  due: string;
  list: string;
  notes: string;
}
export interface AppleContact {
  name: string;
  nickname: string;
  phones: { label: string; number: string }[];
  emails: { label: string; email: string }[];
}

export type HelperRun = (request: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;

export interface AppleOptions {
  dataDir: string;
  platform: string;
  /** Replaces the helper (tests). */
  run?: HelperRun;
  appPath?: string;
}

export function createApple(o: AppleOptions) {
  const appPath =
    o.appPath ?? (!existsSync(helperAppPath()) && existsSync(legacyHelperAppPath()) ? legacyHelperAppPath() : helperAppPath());
  const binary = binaryOf(appPath);
  const installed = () => Boolean(o.run) || (o.platform === 'darwin' && existsSync(binary));

  const viaHelper: HelperRun = async (request, timeoutMs) => {
    const dir = join(o.dataDir, 'apple-io');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const reqPath = join(dir, `${id}.req.json`);
    const resPath = join(dir, `${id}.res.json`);
    await writeFile(reqPath, JSON.stringify(request), { mode: 0o600 });
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          '/usr/bin/open',
          ['-W', '-n', '-g', '-j', '-a', appPath, '--args', '--request', reqPath, '--response', resPath],
          { timeout: timeoutMs },
          (err) => (err ? reject(err) : resolve()),
        );
      }).catch(() => {
        throw new AppleError('timeout', 'המק לא ענה בזמן. אולי macOS מחכה לאישור הרשאה על המסך של המק.');
      });
      const out = JSON.parse(await readFile(resPath, 'utf8').catch(() => '{}')) as {
        ok?: boolean; result?: unknown; code?: string; message?: string;
      };
      if (out.ok) return out.result;
      if (!out.code) throw new AppleError('no-answer', 'Brain Helper לא ענה. במק: npm run apple:setup');
      throw errorFor(out.code, out.message ?? '');
    } finally {
      await rm(reqPath, { force: true });
      await rm(resPath, { force: true });
    }
  };
  const run = o.run ?? viaHelper;

  async function call<T>(op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (!installed()) throw new AppleError('not-installed', NOT_INSTALLED);
    return (await run({ op, ...args }, timeoutMs)) as T;
  }

  // ---- status: cached, so deciding which tools to offer costs nothing most of the time
  const empty: AppleStatus = { installed: false, calendar: 'none', reminders: 'none', contacts: 'none', calendars: [], lists: [] };
  let cached: AppleStatus = empty;
  let checkedAt = 0;
  let checking: Promise<AppleStatus> | undefined;
  async function status(force = false): Promise<AppleStatus> {
    if (!installed()) return (cached = empty);
    if (checking) return checking;
    if (!force && Date.now() - checkedAt < 60_000) return cached;
    checking = call<Partial<AppleStatus>>('status', {}, 20_000)
      .then(s => ({ ...empty, ...s, installed: true, calendars: s.calendars ?? [], lists: s.lists ?? [] }))
      .catch((): AppleStatus => ({ ...empty, installed: true, calendar: 'error', reminders: 'error', contacts: 'error' }))
      .then(s => { checkedAt = Date.now(); return (cached = s); })
      .finally(() => { checking = undefined; });
    return checking;
  }
  /** Last known status (sync, for approval cards). */
  const known = () => cached;
  /** Can Brain use this, as far as we know? Notes and Messages are only known when used. */
  async function has(kind: 'calendar' | 'reminders' | 'contacts' | 'notes' | 'messages' | 'camera'): Promise<boolean> {
    if (kind === 'notes' || kind === 'messages') return installed();
    return (await status())[kind] === 'full';
  }

  // ---- camera (the green light next to it is on while it's used)
  /** One photo, saved as JPEG at `output`. */
  async function cameraPhoto(output: string): Promise<void> {
    await call('cameraPhoto', { output }, 25_000);
  }
  /**
   * Live view: the helper keeps the newest frame in `dir`/frame.jpg until `dir`/stop appears, `dir`/alive
   * goes stale, or `maxSeconds` pass. Resolves when it has stopped.
   */
  async function cameraLive(dir: string, maxSeconds: number, fps = 5): Promise<{ frames: number; seconds: number }> {
    return call('cameraLive', { dir, maxSeconds, fps }, (maxSeconds + 40) * 1000);
  }

  // ---- calendar
  async function events(from: string, to: string) {
    const r = await call<{ events: AppleEvent[]; calendars: AppleCalendar[] }>('events', { from, to });
    if (r.calendars) cached = { ...cached, calendars: r.calendars };
    return r.events;
  }
  async function createEvent(e: { title: string; date: string; start?: string; end?: string; location?: string; calendarId?: string; notes?: string }) {
    const req: Record<string, unknown> = { title: e.title, location: e.location ?? '', notes: e.notes ?? '', calendar: e.calendarId ?? '' };
    if (e.start) Object.assign(req, { start: `${e.date}T${e.start}`, end: `${e.date}T${e.end}` });
    else Object.assign(req, { allDay: true, date: e.date });
    return call<{ id: string; calendar: string }>('createEvent', req);
  }

  // ---- reminders
  async function reminders(listId?: string) {
    const r = await call<{ reminders: AppleReminder[]; lists: AppleList[] }>('reminders', { list: listId ?? '' });
    if (r.lists) cached = { ...cached, lists: r.lists };
    return r.reminders;
  }
  const createReminder = (r: { title: string; due?: string; listId?: string; notes?: string }) =>
    call<{ id: string; list: string }>('createReminder', { title: r.title, due: r.due ?? '', list: r.listId ?? '', notes: r.notes ?? '' });
  const completeReminder = (id: string) => call<{ title: string }>('completeReminder', { id });

  // ---- contacts
  async function contacts(name: string) {
    return (await call<{ contacts: AppleContact[] }>('contacts', { name })).contacts;
  }

  // ---- notes and messages (AppleScript)
  const script = async (source: string, timeoutMs = 45_000) => (await call<{ output: string }>('applescript', { source }, timeoutMs)).output;

  async function searchNotes(query: string) {
    const out = await script(notesSearchScript(query));
    const seen = new Set<string>();
    return out
      .split(RS)
      .filter(Boolean)
      .map((rec) => {
        const [id, name, modified, snippet] = rec.split(US);
        return { id, name, modified, snippet: (snippet ?? '').replace(/\s+/g, ' ').trim() };
      })
      .filter((n) => n.id && !seen.has(n.id) && seen.add(n.id));
  }
  async function readNote(id: string) {
    const [name, modified, ...rest] = (await script(noteReadScript(id))).split(US);
    return { id, name, modified, text: rest.join(US) };
  }
  const createNote = (title: string, body: string) => script(noteCreateScript(title, body));

  async function sendMessage(to: string, text: string) {
    const target = normalizeRecipient(to);
    try {
      await script(messageScript(target, text, 'iMessage'));
      return { to: target, via: 'iMessage' };
    } catch (err) {
      // No iMessage account on this Mac: try SMS through the iPhone (Text Message Forwarding).
      if (err instanceof AppleError && /9001/.test(err.userMessage + err.message) && !target.includes('@')) {
        await script(messageScript(target, text, 'SMS'));
        return { to: target, via: 'SMS' };
      }
      throw err;
    }
  }

  return {
    installed, status, known, has,
    events, createEvent, reminders, createReminder, completeReminder, contacts,
    searchNotes, readNote, createNote, sendMessage,
    cameraPhoto, cameraLive,
  };
}

export type Apple = ReturnType<typeof createApple>;
