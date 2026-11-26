import { randomBytes } from 'node:crypto';
import { open, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { constants, existsSync, realpathSync, statSync } from 'node:fs';

const statSyncIsDir = (p: string) => statSync(p).isDirectory();
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Exec } from './tools.ts';

/** st_flags bit for a file whose content is only in the cloud (macOS <sys/stat.h>). */
const SF_DATALESS = 0x40000000;
const ICLOUD_WAIT_MS = 60_000;
const ICLOUD_POLL_MS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What Brain may see on the Mac.
 * Everything under the roots is readable, except locations that hold secrets or Brain's own data.
 * Nothing in this module writes, moves or deletes files.
 */
export interface FilePolicy {
  /** Readable roots (absolute). Default: the home folder. */
  roots: string[];
  /** Never readable, even inside a root (absolute). */
  blocked: string[];
}

export function defaultPolicy(home = homedir(), dataDir = join(home, '.brain')): FilePolicy {
  const h = (p: string) => join(home, p);
  return {
    roots: [home],
    blocked: [
      dataDir,
      h('.ssh'),
      h('.gnupg'),
      h('.aws'),
      h('.claude'), h('.codex'), h('.ollama'), h('.config/op'), h('.local/share/keyrings'),
      h('.azure'),
      h('.kube'),
      h('.docker'),
      h('.netrc'),
      h('.npmrc'),
      h('.pypirc'),
      h('.git-credentials'),
      h('.config/gh'),
      h('.config/gcloud'),
      h('.password-store'),
      h('.Trash'),
      h('Library/Keychains'),
      h('Library/Cookies'),
      h('Library/Messages'),
      h('Library/Mail'),
      h('Library/Safari'),
      h('Library/Application Support/Google/Chrome'),
      h('Library/Application Support/Firefox'),
      h('Library/Application Support/1Password'),
      h('Library/Group Containers'),
      h('Library/Containers'),
    ],
  };
}

/** Folders worth checking for macOS privacy permission (Files and Folders / Full Disk Access). */
export function commonFolders(home = homedir()): { name: string; path: string }[] {
  return [
    { name: 'מסמכים (Documents)', path: join(home, 'Documents') },
    { name: 'שולחן עבודה (Desktop)', path: join(home, 'Desktop') },
    { name: 'הורדות (Downloads)', path: join(home, 'Downloads') },
    { name: 'iCloud Drive', path: join(home, 'Library/Mobile Documents/com~apple~CloudDocs') },
  ];
}

export class FileAccessError extends Error {}

/** What people call the usual folders → their place under the home folder. */
const FOLDER_ALIASES: Record<string, string> = {
  'שולחן העבודה': 'Desktop', 'שולחן עבודה': 'Desktop', desktop: 'Desktop',
  'הורדות': 'Downloads', downloads: 'Downloads',
  'מסמכים': 'Documents', documents: 'Documents',
  'icloud': 'Library/Mobile Documents/com~apple~CloudDocs', 'icloud drive': 'Library/Mobile Documents/com~apple~CloudDocs',
};
export function folderAlias(input: string): string | undefined {
  let k = input.trim().toLowerCase().replace(/^["']|["']$/g, '');
  for (let i = 0; i < 3; i++) {
    if (FOLDER_ALIASES[k]) return FOLDER_ALIASES[k];
    if (!/^[בהל]/.test(k)) break;
    k = k.slice(1);
  }
  return undefined;
}

/** Moves a file or folder to the Trash the way Finder does ("Put Back" works), without controlling Finder. */
const TRASH_JXA = `function run(argv) {
  ObjC.import('Foundation');
  var err = Ref();
  var ok = $.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[0]), null, err);
  if (!ok) throw new Error(err[0] ? ObjC.unwrap(err[0].localizedDescription) : 'failed');
  return 'ok';
}`;

/** A PDF page as a JPEG (PDFKit, built into every Mac), for phones that show only page 1 of a PDF. n < 0: page count. */
const PDF_PAGE_JXA = `function run(argv) {
  ObjC.import('Foundation'); ObjC.import('PDFKit'); ObjC.import('AppKit');
  var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) throw new Error('not a pdf');
  var n = parseInt(argv[1], 10);
  if (n < 0) return String(doc.pageCount);
  var page = doc.pageAtIndex(n);
  if (!page || page.isNil()) throw new Error('no such page');
  var box = page.boundsForBox(0);
  var w = box.size.width, h = box.size.height;
  if (page.rotation % 180 !== 0) { var t = w; w = h; h = t; }
  var scale = 1500 / Math.max(w, 1);
  var img = page.thumbnailOfSizeForBox({ width: Math.round(w * scale), height: Math.round(h * scale) }, 0);
  var rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
  var data = rep.representationUsingTypeProperties(3, $({}));
  if (!data.writeToFileAtomically(argv[2], true)) throw new Error('write failed');
  return 'ok';
}`;

export interface FolderEntry {
  name: string;
  path: string;
  display: string;
  isDir: boolean;
  size: number;
  modified: number;
}

const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.log', '.ini', '.conf',
  '.html', '.htm', '.css', '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs',
  '.rb', '.php', '.sh', '.sql', '.tex', '.bib', '.srt', '.vtt',
]);
const TEXTUTIL_EXT = new Set(['.docx', '.doc', '.rtf', '.rtfd', '.odt', '.wordml', '.webarchive', '.pages']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.npm', '.Trash', 'Library', '.venv', 'venv', '__pycache__', '.gradle', '.pub-cache', 'build', 'dist']);

const MAX_READ_BYTES = 25 * 1024 * 1024;
const MAX_SEND_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_TTL_MS = 15 * 60_000;

export interface FoundFile {
  path: string;
  /** Path shown to the user and the model: ~/Documents/… */
  display: string;
  name: string;
  size: number;
  modified: number;
}

export interface Download {
  path: string;
  name: string;
  size: number;
  expiresAt: number;
}

/** Real path of p; for a path that doesn't exist yet, the real path of its nearest existing parent plus the rest. */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(canonical(parent), basename(p));
  }
}

export function createFiles(policy: FilePolicy, exec: Exec, platform: string, home = homedir()) {
  const downloads = new Map<string, Download & { dev: number; ino: number; modified: number }>();

  // Paths are checked by their real location; a home reached through a link (macOS /var → /private/var)
  // is shown as ~ either way.
  let homeReal = home;
  try {
    homeReal = realpathSync(home);
  } catch {
    // a home that doesn't exist (tests): shown as given
  }
  const display = (p: string) =>
    within(p, home) ? `~${p.slice(home.length) || '/'}` : within(p, homeReal) ? `~${p.slice(homeReal.length) || '/'}` : p;

  // Folders in the policy can sit behind symlinks (on macOS, /var is really /private/var), while the files
  // we check are fully resolved. So each folder is compared both as written and as its real path.
  const both = (paths: string[]) => [...new Set(paths.flatMap((x) => [x, canonical(x)]))];
  const roots = both(policy.roots);
  const blocked = both(policy.blocked);

  function allowedPath(p: string): boolean {
    if (p.split(sep).some(part => /^(?:\.env(?:\..*)?|\.git|\.claude\.json|.*\.(?:p12|pfx|key|pem))$/i.test(part))) return false;
    return roots.some((r) => within(p, r)) && !blocked.some((b) => within(p, b));
  }

  /** What the user typed as an absolute path: "~/x", "x" (under home), or a folder name such as "שולחן העבודה". */
  function absolute(input: string): string {
    const alias = folderAlias(input);
    if (alias) return join(home, alias);
    let p = input.trim().replace(/^["']|["']$/g, '');
    if (p === '~' || p.startsWith('~/')) p = join(home, p.slice(1));
    if (!isAbsolute(p)) p = join(home, p);
    return p;
  }

  /** Same as resolveAllowed, for approval cards (which can't wait). */
  function resolveAllowedSync(input: string): string {
    const p = absolute(input);
    let real: string;
    try {
      real = realpathSync(resolve(p));
    } catch {
      throw new FileAccessError(`הקובץ לא נמצא: ${display(resolve(p))}`);
    }
    if (!allowedPath(real)) throw new FileAccessError(`אין לבריין גישה למיקום הזה: ${display(real)}`);
    return real;
  }

  /** Resolves what the model or the user typed into a real, allowed path. Follows symlinks before checking. */
  async function resolveAllowed(input: string): Promise<string> {
    const p = absolute(input);
    let real: string;
    try {
      real = await realpath(resolve(p));
    } catch {
      throw new FileAccessError(`הקובץ לא נמצא: ${display(resolve(p))}`);
    }
    if (!allowedPath(real)) throw new FileAccessError(`אין לבריין גישה למיקום הזה: ${display(real)}`);
    return real;
  }

  async function describe(path: string): Promise<FoundFile | null> {
    try {
      const s = await stat(path);
      if (!s.isFile()) return null;
      return { path, display: display(path), name: basename(path), size: s.size, modified: s.mtimeMs };
    } catch {
      return null;
    }
  }

  /** Name match walk, used when Spotlight is unavailable (non-Mac, or Spotlight disabled). */
  async function walk(query: string, limit: number): Promise<string[]> {
    const q = query.toLowerCase();
    const out: string[] = [];
    let visited = 0;
    const queue: { dir: string; depth: number }[] = policy.roots.map((r) => ({ dir: r, depth: 0 }));
    while (queue.length && out.length < limit && visited < 50_000) {
      const { dir, depth } = queue.shift()!;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        visited++;
        const full = join(dir, e.name);
        if (!allowedPath(full)) continue;
        if (e.isDirectory()) {
          if (depth < 8 && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) queue.push({ dir: full, depth: depth + 1 });
        } else if (e.isFile() && e.name.toLowerCase().includes(q)) {
          out.push(full);
          if (out.length >= limit) break;
        }
      }
    }
    return out;
  }

  async function spotlight(args: string[]): Promise<string[]> {
    const { stdout } = await exec('mdfind', args);
    return stdout.split('\n').filter(Boolean);
  }

  /**
   * Finds files by name and by content. On a Mac this uses Spotlight, which also reads inside documents.
   * Name matches come first, then newest first.
   */
  async function search(query: string, limit = 15): Promise<FoundFile[]> {
    const q = query.trim();
    if (!q) return [];
    let byName: string[] = [];
    let byContent: string[] = [];
    if (platform === 'darwin') {
      try {
        for (const root of policy.roots) {
          byName = byName.concat(await spotlight(['-onlyin', root, '-name', q]));
          byContent = byContent.concat(await spotlight(['-onlyin', root, q]));
        }
      } catch {
        byName = await walk(q, limit * 3);
      }
    } else {
      byName = await walk(q, limit * 3);
    }
    const seen = new Set<string>();
    const ordered: FoundFile[][] = [[], []];
    for (const [i, list] of [byName, byContent].entries()) {
      for (const p of list) {
        if (seen.has(p) || !allowedPath(p)) continue;
        seen.add(p);
        const f = await describe(p);
        if (f) ordered[i].push(f);
        if (seen.size > limit * 6) break;
      }
    }
    const newest = (a: FoundFile, b: FoundFile) => b.modified - a.modified;
    return [...ordered[0].sort(newest), ...ordered[1].sort(newest)].slice(0, limit);
  }

  /**
   * iCloud Drive (including Desktop and Documents when they sync) keeps some files only in the cloud:
   * the name and size are on the Mac, the content is not ("dataless"). A background service like
   * Brain gets "Resource deadlock avoided" when it reads one, so we ask macOS to download it first
   * (the official NSFileManager API) and wait until the content is local.
   */
  async function isDataless(path: string): Promise<boolean> {
    if (platform !== 'darwin') return false;
    try {
      const flags = parseInt((await exec('stat', ['-f', '%Xf', path])).stdout.trim(), 16);
      return (flags & SF_DATALESS) !== 0;
    } catch {
      return false;
    }
  }

  async function ensureLocal(path: string, waitMs = ICLOUD_WAIT_MS): Promise<{ downloaded: boolean }> {
    if (!(await isDataless(path))) return { downloaded: false };
    const script =
      "ObjC.import('Foundation'); function run(argv) { const err = Ref(); " +
      'const ok = $.NSFileManager.defaultManager.startDownloadingUbiquitousItemAtURLError($.NSURL.fileURLWithPath(argv[0]), err); ' +
      "return ok ? 'ok' : 'error: ' + ((err[0] && !err[0].isNil()) ? err[0].localizedDescription.js : 'unknown'); }";
    let answer = '';
    try {
      answer = (await exec('osascript', ['-l', 'JavaScript', '-e', script, path])).stdout.trim();
    } catch (e) {
      answer = `error: ${(e as Error).message}`;
    }
    if (!answer.startsWith('ok')) {
      throw new FileAccessError(`הקובץ שמור ב־iCloud ולא הצלחתי להוריד אותו למק (${answer.slice(7, 120)}). אפשר להוריד אותו ב־Finder: קליק ימני ← "הורד עכשיו".`);
    }
    for (let waited = 0; waited < waitMs; waited += ICLOUD_POLL_MS) {
      await sleep(ICLOUD_POLL_MS);
      if (!(await isDataless(path))) return { downloaded: true };
    }
    throw new FileAccessError('הקובץ שמור ב־iCloud, וההורדה שלו למק עוד לא הסתיימה. נסה שוב עוד דקה.');
  }

  /** Extracts readable text from a file. Throws FileAccessError with a Hebrew message. */
  async function readText(input: string): Promise<{ file: FoundFile; text: string; downloaded: boolean }> {
    const path = await resolveAllowed(input);
    const file = await describe(path);
    if (!file) throw new FileAccessError(`זו לא תיקייה שאפשר לקרוא כקובץ: ${display(path)}`);
    if (file.size > MAX_READ_BYTES) throw new FileAccessError(`הקובץ גדול מדי לקריאה (${formatSize(file.size)})`);
    const { downloaded } = await ensureLocal(path);
    const ext = extname(path).toLowerCase();
    let text: string;
    if (TEXT_EXT.has(ext) || ext === '') {
      const buf = await readFile(path);
      if (buf.subarray(0, 8000).includes(0)) throw new FileAccessError('זה קובץ בינארי, אין בו טקסט לקריאה');
      text = buf.toString('utf8');
    } else if (TEXTUTIL_EXT.has(ext)) {
      if (platform !== 'darwin') throw new FileAccessError('קריאת קבצי Word זמינה רק במק');
      text = (await exec('textutil', ['-convert', 'txt', '-stdout', path])).stdout;
    } else if (ext === '.pdf') {
      if (platform !== 'darwin') throw new FileAccessError('קריאת PDF זמינה רק במק');
      // PDFKit through JavaScript for Automation: built into every Mac, no installs.
      const script =
        "ObjC.import('PDFKit'); function run(argv) { const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0])); " +
        "if (!d || d.isNil()) return ''; const s = d.string; return (s && !s.isNil()) ? s.js : ''; }";
      text = (await exec('osascript', ['-l', 'JavaScript', '-e', script, path])).stdout;
      if (!text.trim()) throw new FileAccessError('ב־PDF הזה אין טקסט לקריאה (כנראה סריקה)');
    } else {
      throw new FileAccessError(`עדיין אין תמיכה בקריאת קבצי ${ext || 'ללא סיומת'}. אפשר לשלוח אותו לטלפון.`);
    }
    return { file, downloaded, text: text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() };
  }

  /** Creates a short-lived link for downloading the file on the phone. */
  async function share(input: string): Promise<{ file: FoundFile; token: string }> {
    const path = await resolveAllowed(input);
    const file = await describe(path);
    if (!file) throw new FileAccessError(`אפשר לשלוח רק קבצים, לא תיקיות: ${display(path)}`);
    if (file.size > MAX_SEND_BYTES) throw new FileAccessError(`הקובץ גדול מדי לשליחה (${formatSize(file.size)})`);
    await ensureLocal(path);
    const now = Date.now();
    for (const [t, d] of downloads) if (d.expiresAt < now) downloads.delete(t);
    const token = randomBytes(24).toString('base64url');
    const identity = await stat(path);
    if (!identity.isFile() || identity.size > MAX_SEND_BYTES) throw new FileAccessError('הקובץ השתנה. בקש לשלוח אותו שוב.');
    downloads.set(token, { path, name: file.name, size: identity.size, dev: identity.dev, ino: identity.ino, modified: identity.mtimeMs, expiresAt: now + DOWNLOAD_TTL_MS });
    return { file, token };
  }

  /** Looks up a download link and re-checks the policy at download time. */
  async function download(token: string) {
    const d = downloads.get(token);
    if (!d) return undefined;
    if (d.expiresAt < Date.now() || !allowedPath(d.path)) {
      downloads.delete(token);
      return undefined;
    }
    let handle;
    try {
      const current = await resolveAllowed(d.path);
      if (current !== d.path) return undefined;
      handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const s = await handle.stat();
      if (s.isFile() && s.dev === d.dev && s.ino === d.ino && s.size === d.size && s.mtimeMs === d.modified) {
        return { ...d, handle };
      }
    } catch { /* An unavailable or replaced file invalidates the link. */ }
    if (handle) await handle.close();
    downloads.delete(token);
    return undefined;
  }

  /** What is in a folder (newest first), like Finder. Hidden and blocked entries are left out. */
  async function listFolder(input: string, limit = 80): Promise<{ folder: string; items: FolderEntry[]; total: number }> {
    const dir = await resolveAllowed(input);
    if (!(await stat(dir)).isDirectory()) throw new FileAccessError(`זו לא תיקייה: ${display(dir)}`);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        throw new FileAccessError(`macOS לא נותן לבריין לקרוא את ${display(dir)}. במק: הגדרות מערכת ← פרטיות ואבטחה ← קבצים ותיקיות ← node.`);
      }
      throw err;
    }
    const items: FolderEntry[] = [];
    for (const name of names) {
      if (name.startsWith('.') || name === 'Icon\r') continue;
      const path = join(dir, name);
      if (!allowedPath(path)) continue;
      const st = await stat(path).catch(() => null);
      if (!st) continue;
      items.push({ name, path, display: display(path), isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, modified: st.mtimeMs });
    }
    items.sort((a, b) => b.modified - a.modified);
    return { folder: display(dir), items: items.slice(0, limit), total: items.length };
  }

  /** Checks a path before an approval card offers to move it to the Trash (sync: cards can't wait). */
  function trashCheck(input: string): { path: string; display: string; isDir: boolean } {
    const path = resolveAllowedSync(input);
    const top = [home, ...policy.roots, ...commonFolders(home).map((f) => f.path), join(home, 'Library')];
    if (top.some((t) => canonical(t) === path)) throw new FileAccessError(`את ${display(path)} עצמה לא מוחקים. אפשר למחוק קבצים שבתוכה.`);
    let isDir = false;
    try {
      isDir = statSyncIsDir(path);
    } catch { /* gone in the meantime: the move will report it */ }
    return { path, display: display(path), isDir };
  }

  /** Moves to the Trash (after the user approved). Nothing is deleted for good: it can be put back from the Trash. */
  async function trash(input: string): Promise<{ display: string; isDir: boolean }> {
    const checked = trashCheck(input);
    if (platform !== 'darwin') throw new FileAccessError('העברה לסל אפשרית רק במק.');
    try {
      await exec('osascript', ['-l', 'JavaScript', '-e', TRASH_JXA, checked.path]);
    } catch (err) {
      throw new FileAccessError(`לא הצלחתי להעביר לסל: ${(err as Error).message.split('\n')[0]}`);
    }
    if (existsSync(checked.path)) throw new FileAccessError(`לא הצלחתי להעביר לסל את ${checked.display}.`);
    return { display: checked.display, isDir: checked.isDir };
  }

  /** Opens a file sent to the phone earlier, for showing it again (the policy is checked again now). */
  async function openSent(path: string) {
    const current = await resolveAllowed(path);
    const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const s = await handle.stat();
    if (!s.isFile()) {
      await handle.close();
      throw new FileAccessError('זה לא קובץ');
    }
    await ensureLocal(current);
    return { handle, name: basename(current), size: s.size };
  }

  /** Number of pages of a PDF sent earlier (the phone shows them as pictures). */
  async function pdfPageCount(path: string): Promise<number> {
    const real = await resolveAllowed(path);
    if (platform !== 'darwin' || extname(real).toLowerCase() !== '.pdf') throw new FileAccessError('לא PDF');
    await ensureLocal(real);
    const { stdout } = await exec('osascript', ['-l', 'JavaScript', '-e', PDF_PAGE_JXA, real, '-1', '/dev/null']);
    const n = Number(stdout.trim());
    if (!Number.isInteger(n) || n < 1) throw new FileAccessError('לא הצלחתי לקרוא את ה־PDF');
    return n;
  }

  /** One page of that PDF as a JPEG. */
  async function pdfPage(path: string, index: number): Promise<Buffer> {
    const real = await resolveAllowed(path);
    if (platform !== 'darwin' || extname(real).toLowerCase() !== '.pdf') throw new FileAccessError('לא PDF');
    const out = join(tmpdir(), `brain-page-${randomBytes(8).toString('hex')}.jpg`);
    try {
      await exec('osascript', ['-l', 'JavaScript', '-e', PDF_PAGE_JXA, real, String(index), out]);
      return await readFile(out);
    } finally {
      await rm(out, { force: true });
    }
  }

  /** Tries to list each common folder; macOS shows a permission prompt on the Mac the first time. */
  async function checkAccess() {
    const results = [];
    for (const f of commonFolders(home)) {
      try {
        await readdir(f.path);
        results.push({ ...f, display: display(f.path), ok: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        results.push({ ...f, display: display(f.path), ok: false, missing: code === 'ENOENT' });
      }
    }
    return results;
  }

  return {
    search, readText, share, download, checkAccess, display, allowedPath, resolveAllowed, resolveAllowedSync, policy,
    listFolder, trashCheck, trash, openSent, pdfPageCount, pdfPage,
  };
}

export type Files = ReturnType<typeof createFiles>;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

export const relativeTo = (p: string, root: string) => relative(root, p);
