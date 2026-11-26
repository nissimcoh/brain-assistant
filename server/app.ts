import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { Config } from './config.ts';
import type { Attachment, Db, Device } from './db.ts';
import { createUploads, MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, UploadError, type Uploads } from './uploads.ts';
import { createAuth } from './auth.ts';
import { listModels, loadedModels, OllamaError, warmUp } from './ollama.ts';
import { type CloudDeps, createAgent, type Emit, type Engine, type Settings, shouldThink, type ThinkingMode } from './agent.ts';
import { AGENT_NAMES, type AgentJob, type Agents, createAgents } from './agents.ts';
import { createPush, type Notice, type Push, type StoredSubscription, validSubscription, type VapidKeys } from './push.ts';
import { CATEGORY_NAMES, cloudSettings, type CloudSettings, DATA_CATEGORIES, modelName, type Provider, PROVIDER_NAMES, PROVIDERS } from './cloud.ts';
import { createFiles, defaultPolicy, type Files } from './files.ts';
import { machineMetrics, requestQuit, runningApps } from './mac.ts';
import { createGoogle, type Google } from './google.ts';
import { type Apple, createApple } from './apple.ts';
import { createWeb, type Web } from './web.ts';
import { randomUUID } from 'node:crypto';
import { createToolRegistry, defaultExec, type Exec, snippet, sensitiveReason, MAX_MEMORIES, type ToolContext, ToolInputError, type ToolRegistry } from './tools.ts';

export const VERSION = '0.17.0';

const MAX_MEMORY_CHARS = 500;

const MAX_BODY_BYTES = 1_000_000;
const MAX_MESSAGE_CHARS = 20_000;
const UUID = '[0-9a-f-]{36}';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self' blob:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'הבקשה גדולה מדי');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'גוף הבקשה אינו JSON תקין');
  }
}

/** A raw request body, up to `max` bytes. */
async function readBody(req: IncomingMessage, max: number, tooBig: string): Promise<Buffer> {
  // Too big: answer at once, and let the rest of the upload drain so the phone gets the answer
  // instead of a broken connection.
  if (Number(req.headers['content-length'] ?? 0) > max) {
    req.resume();
    throw new HttpError(413, tooBig);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) over = true;
    if (!over) chunks.push(chunk as Buffer);
  }
  if (over) throw new HttpError(413, tooBig);
  return Buffer.concat(chunks);
}

/**
 * Opens a server-sent-events response. Leaving the app closes it, but the work goes on in the
 * background (see streamAgent): the emitter simply stops writing once the phone is gone.
 */
function openStream(res: ServerResponse): { emit: Emit } {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const emit: Emit = (event, data) => {
    if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  return { emit };
}

function memoryText(body: Record<string, unknown>): string {
  const text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
  if (!text) throw new HttpError(400, 'העובדה ריקה');
  if (text.length > MAX_MEMORY_CHARS) throw new HttpError(413, `עובדה עד ${MAX_MEMORY_CHARS} תווים`);
  if (sensitiveReason(text)) throw new HttpError(400, 'העובדה מכילה מידע רגיש שאי אפשר לשמור בזיכרון.');
  return text;
}

function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine;
}

const THINKING_MODES: ThinkingMode[] = ['auto', 'off', 'on'];

/** Types the phone can preview; anything else downloads. HTML and SVG are deliberately not here. */
const DOWNLOAD_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

export function createApp(
  config: Config,
  db: Db,
  options: {
    exec?: Exec;
    platform?: string;
    tools?: ToolRegistry;
    files?: Files;
    google?: Google | null;
    apple?: Apple | null;
    web?: Web | null;
    autoWarm?: boolean;
    /** Replaces the network for the cloud providers (tests). */
    cloudFetch?: typeof fetch;
    /** Claude Code / Codex on this Mac (null: none; tests pass their own). */
    agents?: Agents | null;
    /** Replaces the network for the push services (tests). */
    pushFetch?: typeof fetch;
    /** The Mac's camera (null: none; tests pass their own). */
    camera?: ToolContext['camera'] | null;
    /** How long a live view lasts before it asks again (seconds). */
    liveSeconds?: number;
  } = {},
) {
  const auth = createAuth(db);
  const tools = options.tools ?? createToolRegistry();

  // ---- notifications to the phone (push.ts): sealed on the Mac, only paired devices ----
  const push: Push = createPush({
    subscriptions: { load: () => db.getSetting<StoredSubscription[]>('push.subscriptions', []), save: (l) => db.setSetting('push.subscriptions', l) },
    keys: { load: () => db.getSetting<VapidKeys | null>('push.vapid', null), save: (k) => db.setSetting('push.vapid', k) },
    activeDevices: () => new Set(db.listDevices().filter((d) => !d.revoked).map((d) => d.id)),
    fetch: options.pushFetch,
    log: (event, details) => db.audit(event, details),
  });
  /** With "show content" off, a notification only says that something happened, not what. */
  function notify(notice: Notice, opts?: { urgent?: boolean; deviceId?: string }) {
    const preview = db.getSetting<boolean>('push.preview', true);
    return push.send(preview ? notice : { ...notice, body: 'פתח את בריין כדי לראות.' }, opts).catch(() => 0);
  }

  const settings = (): Settings => ({
    localModel: db.getSetting('localModel', config.localModel),
    thinking: db.getSetting<ThinkingMode>('thinking', 'auto'),
  });
  const exec = options.exec ?? defaultExec;
  const platform = options.platform ?? process.platform;
  const files =
    options.files ??
    (() => {
      const policy = defaultPolicy(undefined, config.dataDir);
      policy.roots.push(...config.extraFileRoots);
      policy.blocked.push(...config.extraBlockedPaths);
      return createFiles(policy, exec, platform);
    })();
  // Photos and files from the phone, and photos from the Mac's camera (uploads.ts): ~/.brain/uploads.
  const uploads: Uploads = createUploads({ dir: join(config.dataDir, 'uploads'), db, exec, platform });
  const toolContext: ToolContext = {
    exec,
    platform,
    files,
    memory: {
      list: () => db.listMemories(),
      get: (id) => db.getMemory(id),
      find: (text) => db.findMemory(text),
      add: (text, conversationId) => db.addMemory(text, 'chat', conversationId),
      remove: (id) => db.deleteMemory(id),
    },
    search: (query, limit) => db.searchMessages(query, limit),
    // Gmail / Calendar / Contacts. Credentials stay on this Mac (Keychain); see google.ts.
    google:
      options.google === null
        ? undefined
        : (options.google ?? createGoogle({ dataDir: config.dataDir, exec, platform, renewDays: config.googleRenewDays })),
    // Calendar, Reminders, Contacts, Notes, Messages on this Mac, through Brain Helper (apple.ts).
    // Never the real one inside tests.
    apple:
      options.apple === null
        ? undefined
        : (options.apple ?? (process.env.NODE_TEST_CONTEXT ? undefined : createApple({ dataDir: config.dataDir, platform }))),
    // The internet, from the Mac (web.ts). Never the real one inside tests.
    web: options.web === null ? undefined : (options.web ?? (process.env.NODE_TEST_CONTEXT ? undefined : createWeb({ tavilyKey: config.tavilyKey }))),
    // Claude Code and Codex conversations on this Mac (agents.ts). Never the real ones inside tests.
    agents:
      options.agents === null
        ? undefined
        : (options.agents ??
          (process.env.NODE_TEST_CONTEXT || platform !== 'darwin'
            ? undefined
            : createAgents({
                jobs: { load: () => db.getSetting<AgentJob[]>('agents.jobs', []), save: (jobs) => db.setSetting('agents.jobs', jobs) },
                log: (event, details) => db.audit(event, details),
                onFinish: (job, next) => void notifyAgent(job, next),
              }))),
    // The Mac's camera, through Brain Helper (it holds the camera permission). Never the real one inside tests.
    camera: options.camera === null ? undefined : (options.camera ?? undefined),
    // A file sent to the phone stays with the conversation: the app asks for it again by this id.
    keepSent: (file) => {
      const id = randomUUID();
      db.setSetting(`sent:${id}`, { ...file, created: Date.now() });
      return id;
    },
  };
  // ---- the cloud (cloud.ts): keys stay in ~/.brain/config.json on this Mac ----
  const keyOf = (p: Provider) => (p === 'openai' ? config.openaiKey : config.anthropicKey);
  const month = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
  const spend = () => {
    const s = db.getSetting<{ month: string; usd: number }>('cloud.spend', { month: month(), usd: 0 });
    return s.month === month() ? s.usd : 0;
  };
  const cloud: CloudDeps = {
    settings: () => cloudSettings(db.getSetting<Partial<CloudSettings>>('cloud', {})),
    key: keyOf,
    model: (p) => config.cloudModels[p],
    spent: (usd) => db.setSetting('cloud.spend', { month: month(), usd: spend() + usd }),
    fetch: options.cloudFetch,
  };
  const cloudInfo = () => {
    const s = cloud.settings();
    const ready = agent.cloudReady();
    return {
      ...s,
      ready: ready.ok,
      reason: ready.ok ? undefined : ready.reason,
      model: config.cloudModels[s.provider],
      modelName: modelName(config.cloudModels[s.provider]),
      providers: PROVIDERS.map((p) => ({ id: p, name: PROVIDER_NAMES[p], model: config.cloudModels[p], modelName: modelName(config.cloudModels[p]), hasKey: !!keyOf(p) })),
      categories: DATA_CATEGORIES.map((c) => ({ id: c, name: CATEGORY_NAMES[c] })),
      monthUsd: Math.round(spend() * 10000) / 10000,
    };
  };

  let loadingModel: string | null = null;
  if (options.camera === undefined && toolContext.apple) {
    const apple = toolContext.apple;
    toolContext.camera = {
      available: () => apple.has('camera').catch(() => false),
      async photo(conversationId) {
        const tmp = join(config.dataDir, 'uploads', `camera-${randomUUID()}.jpg`);
        try {
          await apple.cameraPhoto(tmp);
          const saved = await uploads.save('mac', 'מצלמת המק.jpg', await readFile(tmp), 'camera', conversationId);
          db.audit('camera.photo', { conversationId, uploadId: saved.id });
          return uploads.attachment(saved);
        } finally {
          await rm(tmp, { force: true });
        }
      },
    };
  }
  /** A photo kept on the Mac, for a model that can see it. */
  const imageData = (a: Attachment): string | null => {
    const u = db.getUpload(a.id);
    if (!u) return null;
    try {
      return readFileSync(uploads.pathOf(u)).toString('base64');
    } catch {
      return null;
    }
  };
  const agent = createAgent({ config, db, tools, toolContext, settings, cloud, imageData, loadingModel: () => loadingModel });

  // Ollama status is refreshed in the background so /api/health always answers instantly,
  // even while Ollama is busy loading a model.
  const ollamaStatus = { ok: false, models: [] as string[], checkedAt: 0 };
  let refreshing: Promise<void> | null = null;
  function refreshOllama(): Promise<void> {
    refreshing ??= listModels(config.ollamaUrl)
      .then((models) => {
        const cameUp = models !== null && !ollamaStatus.ok;
        if (models !== null) ollamaStatus.models = models;
        ollamaStatus.ok = models !== null;
        ollamaStatus.checkedAt = Date.now();
        // Ollama just became reachable (Brain started first, e.g. after a restart): load the model now,
        // not on the first question.
        if (cameUp && autoWarm) void prepare(true, 'Ollama זמין');
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }
  // ---- keeping the first answer fast ----
  // Loading the model takes ~5 s and reading the instructions ~7 s. Both happen ahead of time:
  // when Ollama comes up, and when the app opens or starts a new conversation.
  const autoWarm = options.autoWarm ?? !process.env.NODE_TEST_CONTEXT;
  let preparing: Promise<void> | null = null;
  let warmController: AbortController | null = null;
  let lastPrefixWarm = 0;
  let activeChats = 0;
  function prepare(newConversation: boolean, reason: string): Promise<void> {
    if (preparing || activeChats) return preparing ?? Promise.resolve();
    const controller = new AbortController();
    warmController = controller;
    preparing = (async () => {
      const model = settings().localModel;
      const loaded = await loadedModels(config.ollamaUrl);
      if (loaded === null || controller.signal.aborted) return;
      if (!loaded.includes(model)) {
        const t = Date.now();
        loadingModel = model;
        const loaded = await warmUp(config.ollamaUrl, model, config.keepAlive, config.contextLength).finally(() => { loadingModel = null; });
        if (loaded) {
          console.log(`[warm] ${reason}: המודל ${model} נטען (${((Date.now() - t) / 1000).toFixed(1)} שנ׳)`);
        }
      }
      // Never while a conversation is answering, and not over and over.
      if (newConversation && activeChats === 0 && !controller.signal.aborted) {
        // The user left the previous conversation, so its cache no longer matters: name it now
        // (and up to 2 older ones), then read the new conversation's start last.
        let named = 0;
        for (const c of db.untitledConversations(3)) {
          if (activeChats > 0 || controller.signal.aborted) return;
          const name = await agent.nameConversation(c.id, controller.signal).catch(() => null);
          if (name) console.log(`[warm] שם לשיחה: ${name}`);
          named++;
        }
        // Not over and over, unless naming just pushed the warm start out of the cache.
        if (activeChats > 0 || controller.signal.aborted || (!named && Date.now() - lastPrefixWarm < 20_000)) return;
        const r = await agent.warm(controller.signal);
        if (controller.signal.aborted) return;
        lastPrefixWarm = Date.now();
        console.log(`[warm] ${reason}: ההוראות נקראו מראש (${r.promptTokens ?? '?'} טוקנים, ${((r.promptMs ?? 0) / 1000).toFixed(1)} שנ׳)`);
      }
    })()
      .catch((err) => console.warn(`[warm] ${reason}: ${(err as Error).message}`))
      .finally(() => {
        preparing = null;
        warmController = null;
      });
    return preparing;
  }
  // Messages to Claude Code / Codex that wait for a usage reset go out on time.
  if (toolContext.agents && !process.env.NODE_TEST_CONTEXT) {
    toolContext.agents.recover();
    setInterval(() => toolContext.agents?.tick(), 60_000).unref();
  }
  // Uploads never used in a message, and those of deleted conversations.
  if (!process.env.NODE_TEST_CONTEXT) {
    void uploads.cleanup().catch(() => {});
    setInterval(() => void uploads.cleanup().catch(() => {}), 3600_000).unref();
  }
  if (autoWarm) {
    void refreshOllama();
    setInterval(() => void refreshOllama(), 15_000).unref();
    if (platform === 'darwin') {
      setTimeout(() => void googleRenewalReminder(), 60_000).unref();
      setInterval(() => void googleRenewalReminder(), 3600_000).unref();
    }
  }

  /**
   * While the Google app is in Testing, Google cancels the permission every 7 days. A day before,
   * a notification on the Mac (once per account and date); the phone shows it when the app opens.
   */
  async function googleRenewalReminder() {
    const g = toolContext.google;
    if (!g) return [];
    const sent: string[] = [];
    for (const a of (await g.status()).accounts) {
      if (!a.renewBy || a.renewBy - Date.now() > 86_400_000) continue;
      const key = `google.reminded.${a.key}`;
      if (db.getSetting<number>(key, 0) === a.renewBy) continue;
      db.setSetting(key, a.renewBy);
      const text =
        a.renewBy > Date.now()
          ? `החיבור של ${a.label} (${a.email}) פג מחר. בטרמינל: npm run google:connect`
          : `החיבור של ${a.label} (${a.email}) פג. בטרמינל: npm run google:connect`;
      await exec('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Brain – Google"', '-e', 'end run', text]).catch(() => {});
      void notify({ title: 'Google צריך חידוש', body: text, tag: `google-${a.key}` });
      sent.push(a.email);
    }
    return sent;
  }

  /** An answer finished after the phone left the app: what it says, or the approval it waits for. */
  async function notifyAnswer(conversationId: string) {
    const conv = db.getConversation(conversationId);
    if (!conv) return;
    const url = `/?c=${conversationId}`;
    const pending = db.pendingActions(conversationId)[0];
    if (pending) {
      const what = tools.get(pending.tool)?.label ?? 'פעולה';
      await notify({ title: 'מחכה לאישור שלך', body: `${what} · ${conv.title}`, url, tag: conversationId }, { urgent: true });
      return;
    }
    const last = db.listMessages(conversationId).reverse().find((m) => m.role === 'assistant' && m.content.trim());
    if (!last) return;
    await notify({ title: conv.title || 'בריין', body: last.content, url, tag: conversationId });
  }

  /** A message sent to Claude Code / Codex came back. */
  async function notifyAgent(job: AgentJob, next?: number) {
    const title = `${AGENT_NAMES[job.agent]} · ${job.project}`;
    const at = (t: number) => new Date(t).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
    const body =
      job.status === 'done' ? `סיים: ${job.result || 'בלי סיכום.'}` :
      job.status === 'limited' ? (next ? `נגמר ה־usage. אשלח לו להמשיך ב־${at(next)}.` : 'נגמר ה־usage, וכבר ניסיתי להמשיך 5 פעמים. כדאי לבדוק בשיחה.') :
      `נעצר: ${job.result || 'שגיאה.'}`;
    await notify({ title, body, tag: `agent-${job.sessionId}` });
  }

  async function ollama(maxWaitMs: number) {
    if (Date.now() - ollamaStatus.checkedAt > 10_000) {
      await Promise.race([refreshOllama(), new Promise((r) => setTimeout(r, maxWaitMs))]);
    }
    return ollamaStatus;
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const root = normalize(config.webDir + sep);
    const file = normalize(join(root, rel));
    if (!file.startsWith(root)) throw new HttpError(404, 'לא נמצא');
    let target = file;
    try {
      const s = await stat(target);
      if (s.isDirectory()) target = join(target, 'index.html');
    } catch {
      // Unknown paths fall back to the app shell (single-page app).
      if (extname(rel)) throw new HttpError(404, 'לא נמצא');
      target = join(root, 'index.html');
    }
    const body = await readFile(target);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  /** Runs the agent on a stream and turns failures into a Hebrew error event. */
  /**
   * Answers being worked on, by conversation. They keep going when the phone leaves the app;
   * only the stop button (or a new message in the same conversation) stops one.
   */
  const runs = new Map<string, { controller: AbortController; done: Promise<void>; label: string }>();
  const actionProgress = new Map<string, { label: string }>();
  function runStatus(id: string) {
    const active = runs.get(id) ?? actionProgress.get(id);
    return active ? { running: true, progress: active.label } : { running: false };
  }

  async function stopRun(conversationId: string) {
    const r = runs.get(conversationId);
    if (!r) return false;
    r.controller.abort();
    await r.done;
    return true;
  }

  async function streamAgent(res: ServerResponse, emit: Emit, conversationId: string, device: Device, think: boolean, engine?: Engine) {
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    const run = { controller, done, label: 'מכין את השיחה…' };
    runs.set(conversationId, run);
    const report: Emit = (event, data) => {
      if (event === 'progress') run.label = (data as { label: string }).label;
      emit(event, data);
    };
    activeChats++;
    warmController?.abort();
    try {
      await agent.run(conversationId, report, { think, deviceId: device.id, signal: controller.signal, autoThinking: settings().thinking === 'auto', engine });
    } catch (err) {
      const userMsg = err instanceof OllamaError ? err.userMessage : 'שגיאה לא צפויה בשירות.';
      console.error('[agent]', err);
      db.audit('chat.error', { deviceId: device.id, conversationId, error: String(err) });
      // The phone may be gone: keep the error in the conversation, so it shows when the user returns.
      if (res.destroyed && !controller.signal.aborted) db.addMessage(conversationId, 'assistant', `⚠ ${userMsg}`, { engine: agent.currentEngine(conversationId) });
      emit('error', { message: userMsg });
    } finally {
      activeChats--;
      if (runs.get(conversationId)?.controller === controller) runs.delete(conversationId);
      finish();
    }
    // The phone left while Brain was answering: tell it the answer is ready (not after a stop).
    if (res.destroyed && !controller.signal.aborted) void notifyAnswer(conversationId);
    if (!res.destroyed) res.end();
  }

  // ---- live view from the Mac's camera ----
  // Only one at a time; the newest viewer takes over. The helper writes the newest frame to a folder in
  // ~/.brain and stops on its own if Brain stops touching it. Frames go to the phone as [4-byte length][JPEG].
  const liveSeconds = options.liveSeconds ?? 300;
  let live: { stop: () => void } | null = null;
  async function cameraLive(res: ServerResponse, device: Device) {
    const apple = toolContext.apple;
    if (!toolContext.camera || !apple || !(await toolContext.camera.available().catch(() => false))) {
      throw new HttpError(409, 'המצלמה של המק לא מחוברת לבריין. במק: npm run apple:setup');
    }
    live?.stop();
    const dir = join(config.dataDir, 'camera-live', randomUUID());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const alive = join(dir, 'alive');
    const frame = join(dir, 'frame.jpg');
    await writeFile(alive, '', { mode: 0o600 });
    let stopped = false;
    const session = {
      stop: () => {
        if (stopped) return;
        stopped = true;
        void writeFile(join(dir, 'stop'), '').catch(() => {});
      },
    };
    live = session;
    res.on('close', session.stop);
    const started = Date.now();
    let helperError: Error | null = null;
    let helperDone = false;
    const helper = apple
      .cameraLive(dir, liveSeconds)
      .catch((err: Error) => { helperError = err; })
      .finally(() => { helperDone = true; });
    const touch = setInterval(() => void utimes(alive, new Date(), new Date()).catch(() => {}), 2000);
    const name = device.name || 'מכשיר מצומד';
    db.audit('camera.live.started', { deviceId: device.id });
    // Whoever is at the Mac sees that someone is watching (as well as the camera's green light).
    if (platform === 'darwin') {
      void exec('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Brain"', '-e', 'end run',
        `צפייה חיה במצלמה של המק מ־${name}`]).catch(() => {});
    }
    let frames = 0;
    let last = 0;
    try {
      while (!stopped && !res.destroyed) {
        const st = await stat(frame).catch(() => null);
        if (st && st.mtimeMs !== last) {
          last = st.mtimeMs;
          const jpeg = await readFile(frame).catch(() => null);
          // A slow connection skips frames instead of piling them up.
          if (jpeg?.length && res.writableLength < 512 * 1024) {
            if (!frames) {
              res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-live-seconds': String(liveSeconds) });
            }
            const len = Buffer.alloc(4);
            len.writeUInt32BE(jpeg.length);
            res.write(len);
            res.write(jpeg);
            frames++;
          }
        }
        if (helperDone) break;
        if (!frames && Date.now() - started > 15_000) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      clearInterval(touch);
      session.stop();
      if (live === session) live = null;
      await helper;
      await rm(dir, { recursive: true, force: true });
      db.audit('camera.live.stopped', { deviceId: device.id, seconds: Math.round((Date.now() - started) / 1000), frames });
    }
    if (!frames) throw new HttpError(503, (helperError as Error | null)?.message ?? 'המצלמה של המק לא שלחה תמונה.');
    if (!res.destroyed) res.end();
  }

  async function chat(req: IncomingMessage, res: ServerResponse, device: Device) {
    const body = await readJson(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    // Photos and files sent from the phone just before (POST /api/uploads), by id.
    const ids = Array.isArray(body.attachments) ? body.attachments.filter((x): x is string => typeof x === 'string') : [];
    if (ids.length > MAX_ATTACHMENTS) throw new HttpError(400, `אפשר לצרף עד ${MAX_ATTACHMENTS} קבצים להודעה`);
    const ups = ids.map((id) => db.getUpload(id));
    if (ups.some((u) => !u)) throw new HttpError(404, 'קובץ מצורף לא נמצא במק. נסה לצרף אותו שוב.');
    if (!text && !ups.length) throw new HttpError(400, 'ההודעה ריקה');
    if (text.length > MAX_MESSAGE_CHARS) throw new HttpError(413, 'ההודעה ארוכה מדי');
    // The switch in the app: answer this conversation in the cloud, or on the Mac (from now on).
    const engine = body.engine === 'cloud' || body.engine === 'local' ? (body.engine as Engine) : undefined;

    let conversation = typeof body.conversationId === 'string' ? db.getConversation(body.conversationId) : undefined;
    if (body.conversationId && !conversation) throw new HttpError(404, 'השיחה לא נמצאה');
    if (ups.some((u) => u!.conversation_id && u!.conversation_id !== conversation?.id)) throw new HttpError(409, 'הקובץ הזה כבר שייך לשיחה אחרת');
    conversation ??= db.createConversation(titleFrom(text || (ups[0]!.kind === 'image' ? 'תמונה' : ups[0]!.name)));

    // A new message replaces an answer still being worked on in this conversation.
    await stopRun(conversation.id);
    agent.expirePending(conversation.id);
    db.attachUploads(ids, conversation.id);
    const userMessage = db.addMessage(conversation.id, 'user', text, { attachments: ups.map((u) => uploads.attachment(u!)) });
    const s = settings();
    const think = shouldThink(s.thinking, text);

    const { emit } = openStream(res);
    const now = engine === 'cloud' && !agent.cloudReady().ok ? 'local' : (engine ?? agent.currentEngine(conversation.id));
    emit('meta', {
      conversationId: conversation.id,
      title: conversation.title,
      userMessageId: userMessage.id,
      model: now === 'cloud' ? cloud.model(cloud.settings().provider) : s.localModel,
      engine: now,
      thinking: now === 'local' && think,
    });
    await streamAgent(res, emit, conversation.id, device, think, engine);
  }

  async function decideAction(req: IncomingMessage, res: ServerResponse, device: Device, actionId: string, reportProgress: boolean) {
    const body = await readJson(req);
    const decision = body.decision;
    if (decision !== 'approve' && decision !== 'reject') throw new HttpError(400, 'החלטה לא תקינה');
    const edited = body.args && typeof body.args === 'object' ? (body.args as Record<string, unknown>) : undefined;

    let outcome;
    let stream: ReturnType<typeof openStream> | undefined;
    let owner: string | undefined;
    const stage = { label: '' };
    try {
      outcome = await agent.decide(actionId, decision, edited, device.id, (id, label) => {
        owner = id;
        stage.label = label;
        actionProgress.set(id, stage);
        if (reportProgress) {
          stream ??= openStream(res);
          stream.emit('progress', { label });
        }
      });
    } catch (err) {
      if (err instanceof ToolInputError) throw new HttpError(409, err.message);
      if (stream) {
        stream.emit('error', { message: 'לא התקבל אישור לסיום הפעולה. בדוק ביומן הפעילות.' });
        res.end();
        return;
      }
      throw err;
    } finally {
      if (owner && actionProgress.get(owner) === stage) actionProgress.delete(owner);
    }

    const { emit } = stream ?? openStream(res);
    emit('action', agent.present(outcome.action));
    // What the action brought back for the app to show (a photo from the Mac's camera).
    if (outcome.ran?.display) emit('tool', { tool: outcome.action.tool, ok: true, display: outcome.ran.display });
    if (decision === 'reject') {
      res.end();
      return;
    }
    // Let the model report back on what happened, in the same conversation.
    const s = settings();
    const now = agent.currentEngine(outcome.action.conversation_id);
    emit('meta', { conversationId: outcome.action.conversation_id, model: now === 'cloud' ? cloud.model(cloud.settings().provider) : s.localModel, engine: now, thinking: false });
    await streamAgent(res, emit, outcome.action.conversation_id, device, false);
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (!path.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'שיטה לא נתמכת');
      return serveStatic(req, res, path);
    }

    // ----- public endpoints -----
    if (path === '/api/health' && method === 'GET') {
      const status = await ollama(300);
      return send(res, 200, { ok: true, name: 'brain', version: VERSION, time: Date.now(), ollama: status.ok });
    }
    if (path === '/api/pair' && method === 'POST') {
      const body = await readJson(req);
      const result = auth.pair(String(body.code ?? ''), String(body.deviceName ?? ''));
      if (!result) throw new HttpError(401, 'קוד צימוד שגוי או שפג תוקפו. צור קוד חדש במק.');
      return send(res, 200, { token: result.token, device: result.device });
    }

    // Download links are the credential themselves: random, short-lived, made only for a paired device.
    const dl = path.match(/^\/api\/files\/([A-Za-z0-9_-]{20,})$/);
    if (dl && method === 'GET') {
      const d = await files.download(dl[1]);
      if (!d) throw new HttpError(404, 'הקישור פג או לא קיים. בקש לשלוח את הקובץ שוב.');
      const type = DOWNLOAD_TYPES[extname(d.name).toLowerCase()] ?? 'application/octet-stream';
      const inline = type !== 'application/octet-stream';
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': type,
        'content-length': String(d.size),
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(d.name)}`,
        'cache-control': 'no-store',
        // Files are shown as-is, never run as part of the app.
        'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      });
      db.audit('file.downloaded', { name: d.name, size: d.size });
      const stream = d.handle.createReadStream();
      res.on('close', () => stream.destroy());
      stream.on('error', () => res.destroy()).pipe(res);
      return;
    }

    // ----- everything else requires a paired device -----
    const device = auth.verify(req.headers.authorization);
    if (!device) throw new HttpError(401, 'המכשיר לא מחובר. צריך לצמד אותו מחדש.');

    // The pages of a PDF sent in a conversation, as pictures: the iPhone shows only page 1 of a PDF inside an app.
    const pdf = path.match(new RegExp(`^/api/sent/(${UUID})/pdf(?:/(\\d{1,4}))?$`));
    if (pdf && method === 'GET') {
      const rec = db.getSetting<{ path: string } | null>(`sent:${pdf[1]}`, null);
      if (!rec) throw new HttpError(404, 'הקובץ לא נמצא.');
      try {
        if (pdf[2] === undefined) return send(res, 200, { pages: await files.pdfPageCount(rec.path) });
        const jpeg = await files.pdfPage(rec.path, Number(pdf[2]));
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/jpeg', 'content-length': String(jpeg.length), 'cache-control': 'private, no-store' });
        res.end(jpeg);
        return;
      } catch {
        throw new HttpError(422, 'אי אפשר להציג את ה־PDF כתמונות.');
      }
    }

    // A file sent to the phone in a conversation, again (the app keeps a copy for when the Mac is away).
    const sent = path.match(new RegExp(`^/api/sent/(${UUID})$`));
    if (sent && method === 'GET') {
      const rec = db.getSetting<{ path: string; name: string } | null>(`sent:${sent[1]}`, null);
      if (!rec) throw new HttpError(404, 'הקובץ לא נמצא.');
      let opened;
      try {
        opened = await files.openSent(rec.path);
      } catch {
        throw new HttpError(404, 'הקובץ כבר לא נמצא במק (אולי נמחק או הועבר).');
      }
      const type = DOWNLOAD_TYPES[extname(opened.name).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': type,
        'content-length': String(opened.size),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(opened.name)}`,
        'cache-control': 'private, no-store',
        'content-security-policy': "default-src 'none'; sandbox",
      });
      db.audit('file.downloaded', { deviceId: device.id, name: opened.name, size: opened.size });
      const stream = opened.handle.createReadStream();
      res.on('close', () => stream.destroy());
      stream.on('error', () => res.destroy()).pipe(res);
      return;
    }

    // The app opened, or a new conversation started: get the model ready while the user types.
    if (path === '/api/warm' && method === 'POST') {
      const body = await readJson(req);
      if (autoWarm) void prepare(body.newConversation === true, body.newConversation === true ? 'שיחה חדשה' : 'האפליקציה נפתחה');
      return send(res, 202, { ok: true });
    }

    if (path === '/api/status' && method === 'GET') {
      const status = await ollama(2000);
      const s = settings();
      return send(res, 200, {
        version: VERSION,
        device: { id: device.id, name: device.name },
        engine: 'local',
        localModel: s.localModel,
        thinking: s.thinking,
        cloud: cloudInfo(),
        ollama: { ok: status.ok, models: status.models, modelInstalled: status.models.includes(s.localModel) },
      });
    }

    if (path === '/api/settings') {
      if (method === 'GET') {
        const status = await ollama(2000);
        return send(res, 200, { ...settings(), models: status.models.filter((m) => !/embed/i.test(m)), cloud: cloudInfo() });
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        const changes: Record<string, unknown> = {};
        if (body.thinking !== undefined && !THINKING_MODES.includes(body.thinking as ThinkingMode)) throw new HttpError(400, 'מצב חשיבה לא תקין');
        if (body.localModel !== undefined) {
          await refreshOllama();
          if (typeof body.localModel !== 'string' || !ollamaStatus.models.includes(body.localModel)) {
            throw new HttpError(400, 'המודל לא מותקן ב־Ollama');
          }
          db.setSetting('localModel', body.localModel);
          changes.localModel = body.localModel;
        }
        if (body.thinking !== undefined) {
          db.setSetting('thinking', body.thinking);
          changes.thinking = body.thinking;
        }
        if (body.cloud !== undefined) {
          const c = body.cloud as Partial<CloudSettings>;
          if (!c || typeof c !== 'object') throw new HttpError(400, 'הגדרת ענן לא תקינה');
          if (c.mode !== undefined && c.mode !== 'local' && c.mode !== 'ask' && c.mode !== 'cloud') throw new HttpError(400, 'מצב ענן לא תקין');
          if (c.provider !== undefined && !PROVIDERS.includes(c.provider)) throw new HttpError(400, 'ספק לא מוכר');
          const allow: Partial<Record<string, boolean>> = {};
          for (const [k, v] of Object.entries(c.allow ?? {})) {
            if (!DATA_CATEGORIES.includes(k as never) || typeof v !== 'boolean') throw new HttpError(400, 'הגדרת פרטיות לא תקינה');
            allow[k] = v;
          }
          const before = cloud.settings();
          const next = cloudSettings({ ...before, ...(c.mode ? { mode: c.mode } : {}), ...(c.provider ? { provider: c.provider } : {}), allow: { ...before.allow, ...allow } });
          db.setSetting('cloud', next);
          changes.cloud = next;
        }
        db.audit('settings.changed', { deviceId: device.id, ...changes });
        return send(res, 200, { ...settings(), cloud: cloudInfo() });
      }
    }

    if (path === '/api/chat' && method === 'POST') return chat(req, res, device);

    // ----- photos and files from the phone (uploads.ts) -----
    if (path === '/api/uploads' && method === 'POST') {
      const bytes = await readBody(req, MAX_UPLOAD_BYTES, 'הקובץ גדול מדי (עד 15MB).');
      let saved;
      try {
        saved = await uploads.save(device.id, url.searchParams.get('name') ?? '', bytes);
      } catch (err) {
        if (err instanceof UploadError) throw new HttpError(415, err.message);
        throw err;
      }
      db.audit('upload.saved', { deviceId: device.id, uploadId: saved.id, kind: saved.kind, name: saved.name, size: saved.size });
      return send(res, 200, { ...uploads.attachment(saved), hasText: saved.kind === 'file' ? !!saved.text : undefined });
    }
    const up = path.match(new RegExp(`^/api/uploads/(${UUID})$`));
    if (up && method === 'GET') {
      const u = db.getUpload(up[1]);
      if (!u) throw new HttpError(404, 'הקובץ לא נמצא.');
      let bytes: Buffer;
      try {
        bytes = await uploads.read(u);
      } catch {
        throw new HttpError(404, 'הקובץ כבר לא נמצא במק.');
      }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': u.mime,
        'content-length': String(bytes.length),
        'content-disposition': `${u.kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(u.name)}`,
        'cache-control': 'private, no-store',
        'content-security-policy': "default-src 'none'; sandbox",
      });
      res.end(bytes);
      return;
    }

    // ----- the Mac's camera: live view, only while the phone watches, never longer than liveSeconds -----
    if (path === '/api/camera' && method === 'GET') {
      const ok = !!toolContext.camera && (await toolContext.camera.available().catch(() => false));
      return send(res, 200, { available: ok, seconds: liveSeconds });
    }
    if (path === '/api/camera/live' && method === 'GET') return cameraLive(res, device);

    // ----- memory -----
    if (path === '/api/memories') {
      if (method === 'GET') return send(res, 200, db.listMemories());
      if (method === 'POST') {
        const text = memoryText(await readJson(req));
        if (db.findMemory(text)) throw new HttpError(409, 'העובדה הזו כבר בזיכרון');
        if (db.listMemories().length >= MAX_MEMORIES) throw new HttpError(409, 'הזיכרון מלא');
        const m = db.addMemory(text, 'manual');
        db.audit('memory.added', { deviceId: device.id, memoryId: m.id, text, source: 'manual' });
        return send(res, 200, m);
      }
    }
    const mem = path.match(/^\/api\/memories\/(\d+)$/);
    if (mem) {
      const id = Number(mem[1]);
      const before = db.getMemory(id);
      if (!before) throw new HttpError(404, 'העובדה לא נמצאה');
      if (method === 'PUT') {
        const text = memoryText(await readJson(req));
        db.updateMemory(id, text);
        db.audit('memory.edited', { deviceId: device.id, memoryId: id, before: before.text, text });
        return send(res, 200, db.getMemory(id));
      }
      if (method === 'DELETE') {
        db.deleteMemory(id);
        db.audit('memory.deleted', { deviceId: device.id, memoryId: id, text: before.text });
        return send(res, 200, { ok: true });
      }
    }

    if (path === '/api/mac' && method === 'GET') {
      const [metrics, apps] = await Promise.all([
        machineMetrics(exec), platform === 'darwin' ? runningApps(exec).catch(() => null) : null,
      ]);
      return send(res, 200, { ...metrics, apps });
    }
    if (path === '/api/mac/apps/quit' && method === 'POST') {
      const { bundle, pid, started, confirmed } = await readJson(req);
      if (platform !== 'darwin' || confirmed !== true || typeof bundle !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,200}$/i.test(bundle)
        || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0
        || typeof started !== 'string' || !/^\d{1,12}(?:\.\d{1,9})?$/.test(started)) {
        throw new HttpError(400, 'בקשת סגירה לא תקינה');
      }
      const requested = await requestQuit(exec, bundle, pid, started);
      db.audit('mac.quit_requested', { deviceId: device.id, bundle, requested });
      if (!requested) throw new HttpError(409, 'האפליקציה נסגרה, השתנתה או אינה מאפשרת סגירה. רענן את הרשימה.');
      return send(res, 202, { requested });
    }

    // ----- macOS folder permissions -----
    // Mail and calendar connection (Settings). Connecting happens on the Mac: npm run google:connect.
    if (path === '/api/google' && method === 'GET') {
      const g = toolContext.google;
      const s = g ? await g.status() : { configured: false, connected: false, email: null, accounts: [], where: null };
      return send(res, 200, s);
    }
    if (path === '/api/google/disconnect' && method === 'POST') {
      const body = await readJson(req);
      const which = typeof body.account === 'string' && body.account ? body.account : undefined;
      const gone = (await toolContext.google?.disconnect(which)) ?? [];
      db.audit('google.disconnected', { deviceId: device.id, accounts: gone });
      return send(res, 200, { ok: true });
    }

    // Apple (calendar, reminders, contacts, notes, messages). Connecting happens on the Mac: npm run apple:setup.
    if (path === '/api/apple' && method === 'GET') {
      const a = toolContext.apple;
      if (!a) return send(res, 200, { installed: false });
      const st = await a.status(true);
      return send(res, 200, { installed: st.installed, calendar: st.calendar, reminders: st.reminders, contacts: st.contacts, camera: st.camera ?? 'none' });
    }

    if (path === '/api/files/access' && method === 'GET') {
      return send(res, 200, { node: process.execPath, folders: await files.checkAccess() });
    }

    // ----- search in past conversations -----
    if (path === '/api/search' && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
      return send(
        res,
        200,
        db.searchMessages(q, 30).map((h) => ({
          conversationId: h.conversation_id,
          title: h.title,
          role: h.role,
          createdAt: h.created_at,
          snippet: snippet(h.content, q, 50),
        })),
      );
    }

    const action = path.match(new RegExp(`^/api/actions/(${UUID})$`));
    if (action && method === 'POST') return decideAction(req, res, device, action[1], url.searchParams.get('progress') === '1');

    if (path === '/api/conversations' && method === 'GET') return send(res, 200, db.listConversations());

    // Local or cloud for a conversation: the switch in the app, or the answer on a suggestion card
    // (run: answer the question that is waiting, with the engine just chosen).
    const eng = path.match(new RegExp(`^/api/conversations/(${UUID})/engine$`));
    if (eng && method === 'POST') {
      const body = await readJson(req);
      if (body.engine !== 'cloud' && body.engine !== 'local') throw new HttpError(400, 'מנוע לא תקין');
      if (!db.getConversation(eng[1])) throw new HttpError(404, 'השיחה לא נמצאה');
      try {
        agent.setEngine(eng[1], body.engine, body.fromCard === true);
      } catch (err) {
        if (err instanceof ToolInputError) throw new HttpError(409, err.message);
        throw err;
      }
      if (body.run !== true || db.lastRole(eng[1]) !== 'user' || runs.has(eng[1])) {
        return send(res, 200, { engine: agent.currentEngine(eng[1]) });
      }
      const { emit } = openStream(res);
      const now = agent.currentEngine(eng[1]);
      emit('meta', { conversationId: eng[1], model: now === 'cloud' ? cloud.model(cloud.settings().provider) : settings().localModel, engine: now, thinking: false });
      await streamAgent(res, emit, eng[1], device, false);
      return;
    }

    const stop = path.match(new RegExp(`^/api/conversations/(${UUID})/stop$`));
    if (stop && method === 'POST') return send(res, 200, { stopped: await stopRun(stop[1]) });

    const conv = path.match(new RegExp(`^/api/conversations/(${UUID})$`));
    if (conv) {
      const id = conv[1];
      if (method === 'GET') {
        const c = db.getConversation(id);
        if (!c) throw new HttpError(404, 'השיחה לא נמצאה');
        if (url.searchParams.get('view') === 'run') return send(res, 200, runStatus(id));
        return send(res, 200, {
          ...c,
          ...runStatus(id),
          engine: agent.currentEngine(id),
          messages: url.searchParams.get('view') === 'chat' ? db.displayMessages(id) : db.listMessages(id),
          actions: db.listActions(id).map((a) => ({ ...agent.present(a), messageId: a.message_id })),
          toolLabels: Object.fromEntries(tools.list().map((t) => [t.name, t.label])),
        });
      }
      if (method === 'PATCH') {
        const body = await readJson(req);
        if (typeof body.pinned === 'boolean') {
          if (!db.pinConversation(id, body.pinned)) throw new HttpError(404, 'השיחה לא נמצאה');
          return send(res, 200, { ok: true, pinned: body.pinned });
        }
        const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : '';
        if (!title) throw new HttpError(400, 'השם ריק');
        if (title.length > 80) throw new HttpError(400, 'השם ארוך מדי');
        if (!db.renameConversation(id, title, 'manual')) throw new HttpError(404, 'השיחה לא נמצאה');
        db.audit('conversation.renamed', { deviceId: device.id, conversationId: id });
        return send(res, 200, { ok: true, title });
      }
      if (method === 'DELETE') {
        const attached = db.uploadsOf(id);
        if (!db.deleteConversation(id)) throw new HttpError(404, 'השיחה לא נמצאה');
        for (const u of attached) await uploads.remove(u);
        db.audit('conversation.deleted', { deviceId: device.id, conversationId: id });
        return send(res, 200, { ok: true });
      }
    }

    // Checks for `npm run doctor`: run inside the service itself, because a background service on macOS
    // behaves differently from the Terminal (iCloud files, notifications).
    if (path === '/api/diag' && method === 'POST') {
      const body = await readJson(req);
      db.audit('diag', { deviceId: device.id, action: body.action });
      try {
        if (body.action === 'notify') {
          await tools.get('mac_notification')!.run({ text: 'בדיקה מ־npm run doctor', title: 'בריין' }, toolContext);
          return send(res, 200, { ok: true });
        }
        if (body.action === 'read' && typeof body.path === 'string') {
          const t = Date.now();
          const r = await files.readText(body.path);
          return send(res, 200, { ok: true, chars: r.text.length, preview: r.text.slice(0, 160), downloaded: r.downloaded, ms: Date.now() - t });
        }
        if (body.action === 'warm') return send(res, 200, { ok: true, ...(await agent.warm()) });
        if (body.action === 'apple') {
          const a = toolContext.apple;
          if (!a) return send(res, 200, { ok: false, error: 'לא זמין' });
          const st = await a.status(true);
          if (!st.installed) return send(res, 200, { ok: true, installed: false });
          const checks: Record<string, string> = {};
          const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
          const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
          const attempt = async (key: string, fn: () => Promise<string>) => {
            try {
              checks[key] = `ok: ${await fn()}`;
            } catch (err) {
              checks[key] = `error: ${(err as { userMessage?: string }).userMessage ?? (err as Error).message}`;
            }
          };
          if (st.calendar === 'full') await attempt('calendar', async () => `${(await a.events(today, tomorrow)).length} אירועים היום`);
          if (st.reminders === 'full') await attempt('reminders', async () => `${(await a.reminders()).length} תזכורות פתוחות`);
          if (st.contacts === 'full') await attempt('contacts', async () => `חיפוש עבד (${(await a.contacts('א')).length} תוצאות ל"א")`);
          return send(res, 200, { ok: true, ...st, calendars: st.calendars.length, lists: st.lists.length, checks });
        }
        if (body.action === 'google') {
          const g = toolContext.google;
          if (!g) return send(res, 200, { ok: false, error: 'Google לא זמין' });
          const st = await g.status();
          if (!st.connected) return send(res, 200, { ok: true, ...st });
          // Real calls from inside the service, per account: the token is read from the Keychain the way Brain reads it.
          const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
          const checks = await Promise.all(
            st.accounts.map(async (a) => {
              try {
                const mail = await g.searchMail('in:inbox', 1, a.email);
                const cal = await g.listEvents(today, today, a.email);
                return { ...a, ok: true, inboxSample: mail.mails.length, eventsToday: cal.events.length };
              } catch (err) {
                return { ...a, ok: false, error: (err as { userMessage?: string }).userMessage ?? (err as Error).message };
              }
            }),
          );
          return send(res, 200, { ok: true, ...st, checks });
        }
      } catch (err) {
        return send(res, 200, { ok: false, error: (err as { userMessage?: string }).userMessage ?? (err as Error).message });
      }
      throw new HttpError(400, 'בדיקה לא מוכרת');
    }

    // ----- notifications -----
    if (path === '/api/push') {
      if (method === 'GET') {
        return send(res, 200, { publicKey: push.publicKey(), subscribed: push.has(device.id), preview: db.getSetting<boolean>('push.preview', true) });
      }
      if (method === 'POST') {
        const sub = validSubscription((await readJson(req)).subscription);
        if (!sub) throw new HttpError(400, 'המנוי להתראות לא תקין');
        push.subscribe(device.id, sub);
        db.audit('push.subscribed', { deviceId: device.id, service: new URL(sub.endpoint).hostname });
        return send(res, 200, { subscribed: true });
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        if (typeof body.preview !== 'boolean') throw new HttpError(400, 'הגדרה לא תקינה');
        db.setSetting('push.preview', body.preview);
        db.audit('settings.changed', { deviceId: device.id, pushPreview: body.preview });
        return send(res, 200, { preview: body.preview });
      }
      if (method === 'DELETE') {
        if (push.unsubscribe(device.id)) db.audit('push.unsubscribed', { deviceId: device.id });
        return send(res, 200, { subscribed: false });
      }
    }
    if (path === '/api/push/test' && method === 'POST') {
      const delivered = await notify({ title: 'בריין', body: 'ההתראות עובדות. כך תדע כשתשובה מוכנה, כשמשהו מחכה לאישור, או כשסוכן קוד סיים.', tag: 'test' }, { deviceId: device.id });
      return send(res, 200, { delivered });
    }

    if (path === '/api/devices' && method === 'GET') {
      return send(
        res,
        200,
        db.listDevices().map((d) => ({ ...d, current: d.id === device.id })),
      );
    }
    const dev = path.match(new RegExp(`^/api/devices/(${UUID})$`));
    if (dev && method === 'DELETE') {
      if (!db.revokeDevice(dev[1])) throw new HttpError(404, 'המכשיר לא נמצא');
      push.unsubscribe(dev[1]);
      db.audit('device.revoked', { by: device.id, deviceId: dev[1] });
      return send(res, 200, { ok: true });
    }
    if (path === '/api/audit' && method === 'GET') {
      const devices = new Map(db.listDevices().map((d) => [d.id, d.name]));
      const toolLabels = new Map(tools.list().map((t) => [t.name, t.label]));
      return send(
        res,
        200,
        db.listAudit(200).map((a) => ({
          ...a,
          deviceName: typeof a.detail.deviceId === 'string' ? devices.get(a.detail.deviceId) : undefined,
          toolLabel: typeof a.detail.tool === 'string' ? toolLabels.get(a.detail.tool) : undefined,
        })),
      );
    }

    throw new HttpError(404, 'לא נמצא');
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error('[http]', err);
      send(res, 500, { error: 'שגיאה פנימית בשירות' });
    });
  });

  return { server, auth, googleRenewalReminder };
}
