// Claude Code and Codex conversations on this Mac: what they are doing, and sending them a message.
// Brain never works on the code itself. It reads the conversations the coding agents keep on disk
// (read-only), and, after the user approves a card, sends a message into one of them; the agent
// then works with its own permissions, as it would in the Terminal.
//   Claude Code: ~/.claude/projects/<folder>/<session>.jsonl
//   Codex:       ~/.codex/sessions/YYYY/MM/DD/rollout-…-<session>.jsonl
import { spawn as nodeSpawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type AgentKind = 'claude' | 'codex';
export const AGENT_NAMES: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' };

/** What a conversation is doing now, as far as its file tells. */
export type SessionState = 'working' | 'finished' | 'stopped' | 'limited' | 'error';
export const STATE_NAMES: Record<SessionState, string> = {
  working: 'עובד עכשיו',
  finished: 'סיים ומחכה לך',
  stopped: 'נעצר באמצע',
  limited: 'נעצר: נגמר ה־usage',
  error: 'נעצר בשגיאה',
};

export interface Turn {
  role: 'user' | 'agent';
  text: string;
  at?: string;
}

export interface AgentSession {
  agent: AgentKind;
  id: string;
  file: string;
  cwd: string;
  project: string;
  title: string;
  updatedAt: number;
  state: SessionState;
  /** When the usage limit resets (ms), for a conversation stopped by it. */
  resetAt?: number;
  /** The last messages, oldest first: what was asked and what the agent answered. */
  turns: Turn[];
  /** Files the agent changed (Claude Code). */
  touched: string[];
  /** Permission mode of the last request (Claude Code), reused when Brain sends a message. */
  permissionMode?: string;
  /** Sandbox of the last turn (Codex), reused likewise. */
  sandbox?: string;
  error?: string;
}

export interface AgentJob {
  id: string;
  agent: AgentKind;
  sessionId: string;
  cwd: string;
  project: string;
  message: string;
  status: 'scheduled' | 'running' | 'done' | 'failed' | 'limited';
  createdAt: number;
  /** For a scheduled message: when it goes out (the usage limit's reset). */
  runAt?: number;
  startedAt?: number;
  endedAt?: number;
  /** The agent's last answer, or what went wrong. */
  result?: string;
  /** Automatic "continue" messages sent after usage limits, for this request. */
  retries: number;
  permissionMode?: string;
  sandbox?: string;
}

/** Messages that mean the plan's usage limit was reached (Claude Code, Codex). */
const LIMIT = /usage limit|limit reached|hit your (?:usage )?limit|rate limit|out of (?:usage|credits)|quota|try again (?:at|in)|resets? (?:at )?\d/i;
const WORKING_MS = 90_000;
const TAIL_BYTES = 2_000_000;
const HEAD_BYTES = 300_000;
const MAX_TURNS = 8;
const TURN_CHARS = 700;
const MAX_RETRIES = 5;
const RUN_TIMEOUT_MS = 3 * 3600_000;

/** When a usage limit resets, from the agent's message. Unknown: in an hour. */
export function parseReset(text: string, now = Date.now()): number {
  const unix = text.match(/\|(\d{10})\b/) ?? text.match(/resets?_?at["':\s]+(\d{10,13})/i);
  if (unix) {
    const n = Number(unix[1]);
    return n < 1e12 ? n * 1000 : n;
  }
  const inMatch = text.match(/(?:try again |resets? )in\s+(\d+)\s*(minute|min|hour|hr|h|m)/i);
  if (inMatch) return now + Number(inMatch[1]) * (/^h/i.test(inMatch[2]) ? 3600_000 : 60_000);
  const at = text.match(/(?:resets?|try again)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (at) {
    let h = Number(at[1]);
    const m = Number(at[2] ?? 0);
    if (at[3]) h = (h % 12) + (at[3].toLowerCase() === 'pm' ? 12 : 0);
    if (h < 24 && m < 60) {
      const d = new Date(now);
      d.setHours(h, m, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
  }
  return now + 3600_000;
}

/** The start and the end of a big file (conversations reach tens of MB; only the ends matter). */
function readEnds(file: string, size: number): { head: string; tail: string } {
  if (size <= HEAD_BYTES + TAIL_BYTES) {
    const all = readFileSync(file, 'utf8');
    return { head: all, tail: '' };
  }
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    readSync(fd, head, 0, HEAD_BYTES, 0);
    const tail = Buffer.alloc(TAIL_BYTES);
    readSync(fd, tail, 0, TAIL_BYTES, size - TAIL_BYTES);
    // Cut at line ends: a line split by the cut is left out.
    const h = head.toString('utf8');
    const t = tail.toString('utf8');
    return { head: h.slice(0, h.lastIndexOf('\n') + 1), tail: t.slice(t.indexOf('\n') + 1) };
  } finally {
    closeSync(fd);
  }
}

function lines(text: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* a broken line (the agent is writing it now) */
    }
  }
  return out;
}

const clip = (s: string, n = TURN_CHARS) => (s.length > n ? `${s.slice(0, n)}…` : s);
const blockText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b?.type === 'text' || b?.type === 'input_text' || b?.type === 'output_text').map((b) => b.text ?? '').join('\n')
      : '';
/** Text the agent's app adds on its own (commands, reminders, environment), not something the user typed. */
const isSystemText = (t: string) => /^\s*<[a-z_-]+[\s>]/i.test(t) || /^\s*\[Request interrupted/i.test(t);

function lastTurns(turns: Turn[]): Turn[] {
  // Consecutive agent texts of one answer are joined; the last ones are kept.
  const merged: Turn[] = [];
  for (const t of turns) {
    const prev = merged.at(-1);
    if (prev && prev.role === t.role && t.role === 'agent') prev.text = `${prev.text}\n${t.text}`;
    else merged.push({ ...t });
  }
  return merged.slice(-MAX_TURNS).map((t) => ({ ...t, text: t.role === 'agent' ? clip(t.text.slice(-TURN_CHARS * 2), TURN_CHARS * 2) : clip(t.text) }));
}

export function readClaude(file: string, now = Date.now()): AgentSession | undefined {
  const st = statSync(file);
  const { head, tail } = readEnds(file, st.size);
  const entries = [...lines(head), ...lines(tail)];
  let cwd = '';
  let title = '';
  let firstPrompt = '';
  let permissionMode: string | undefined;
  const turns: Turn[] = [];
  const touched = new Set<string>();
  let last: { kind: 'user' | 'agent' | 'tool'; stop?: string; text?: string; apiError?: boolean } | undefined;
  for (const e of entries) {
    if (e.cwd) cwd = e.cwd;
    if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
    if (e.isSidechain) continue;
    if (e.type === 'user' && e.message) {
      const content = e.message.content;
      if (Array.isArray(content) && content.some((b: { type?: string }) => b?.type === 'tool_result')) {
        last = { kind: 'tool' };
        continue;
      }
      const text = blockText(content).trim();
      if (!text || e.isMeta || isSystemText(text)) continue;
      if (e.permissionMode) permissionMode = e.permissionMode;
      firstPrompt ||= text;
      turns.push({ role: 'user', text, at: e.timestamp });
      last = { kind: 'user' };
    } else if (e.type === 'assistant' && e.message) {
      const content = Array.isArray(e.message.content) ? e.message.content : [];
      for (const b of content) {
        if (b?.type === 'tool_use' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name) && b.input?.file_path) touched.add(b.input.file_path);
      }
      const text = blockText(content).trim();
      if (text) turns.push({ role: 'agent', text, at: e.timestamp });
      last = { kind: 'agent', stop: e.message.stop_reason, text, apiError: !!e.isApiErrorMessage || !!e.error };
    }
  }
  if (!cwd && !turns.length) return undefined;
  let state: SessionState;
  let resetAt: number | undefined;
  const lastText = last?.text ?? '';
  if (now - st.mtimeMs < WORKING_MS && !(last?.kind === 'agent' && last.stop === 'end_turn')) state = 'working';
  else if (last?.kind === 'agent' && LIMIT.test(lastText) && (last.apiError || lastText.length < 400)) {
    state = 'limited';
    resetAt = parseReset(lastText, now);
  } else if (last?.kind === 'agent' && last.apiError) state = 'error';
  else if (last?.kind === 'agent' && (last.stop === 'end_turn' || (!last.stop && lastText))) state = 'finished';
  else state = 'stopped';
  return {
    agent: 'claude',
    id: basename(file, '.jsonl'),
    file,
    cwd,
    project: cwd ? basename(cwd) : '',
    title: title || clip(firstPrompt.replace(/\s+/g, ' '), 70),
    updatedAt: st.mtimeMs,
    state,
    resetAt,
    turns: lastTurns(turns),
    touched: [...touched].slice(-15),
    permissionMode,
  };
}

export function readCodex(file: string, now = Date.now()): AgentSession | undefined {
  const st = statSync(file);
  const { head, tail } = readEnds(file, st.size);
  const entries = [...lines(head), ...lines(tail)];
  let id = basename(file, '.jsonl').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1] ?? '';
  let cwd = '';
  let sandbox: string | undefined;
  let firstPrompt = '';
  const turns: Turn[] = [];
  let open = false;
  let error = '';
  let limitHit = false;
  let resetHint = '';
  for (const e of entries) {
    const p = e.payload ?? {};
    if (e.type === 'session_meta') {
      id = p.id || p.session_id || id;
      cwd = p.cwd || cwd;
    } else if (e.type === 'turn_context') {
      cwd = p.cwd || cwd;
      sandbox = p.sandbox_policy?.type ?? sandbox;
    } else if (e.type === 'response_item' && p.type === 'message') {
      const text = blockText(p.content).trim();
      if (!text) continue;
      if (p.role === 'user') {
        const provenance = p.internal_chat_message_metadata_passthrough?.content_item_metadata?.[0]?.provenance?.type;
        if ((provenance && provenance !== 'user') || isSystemText(text)) continue;
        firstPrompt ||= text;
        turns.push({ role: 'user', text, at: e.timestamp });
      } else if (p.role === 'assistant') {
        turns.push({ role: 'agent', text, at: e.timestamp });
      }
    } else if (e.type === 'event_msg') {
      if (p.type === 'task_started') {
        open = true;
        error = '';
        limitHit = false;
      } else if (p.type === 'task_complete') {
        open = false;
        error = p.error?.message ?? '';
      } else if (p.type === 'token_count' && p.rate_limits) {
        const r = p.rate_limits;
        if (r.rate_limit_reached_type) {
          limitHit = true;
          resetHint = JSON.stringify(r);
        }
      }
    }
  }
  if (!cwd && !turns.length) return undefined;
  let state: SessionState;
  let resetAt: number | undefined;
  if (open && now - st.mtimeMs < WORKING_MS) state = 'working';
  else if (limitHit || (error && LIMIT.test(error))) {
    state = 'limited';
    resetAt = parseReset(`${error} ${resetHint}`, now);
  } else if (error) state = 'error';
  else if (open) state = 'stopped';
  else state = 'finished';
  return {
    agent: 'codex',
    id,
    file,
    cwd,
    project: cwd ? basename(cwd) : '',
    title: clip(firstPrompt.replace(/\s+/g, ' '), 70),
    updatedAt: st.mtimeMs,
    state,
    resetAt,
    turns: lastTurns(turns),
    touched: [],
    sandbox,
    error: error || undefined,
  };
}

/** Newest files under a folder, by modification time (a few levels deep). */
function newestFiles(dir: string, match: (name: string) => boolean, depth: number, out: { path: string; t: number }[] = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      if (depth > 0) newestFiles(p, match, depth - 1, out);
    } else if (match(name)) out.push({ path: p, t: s.mtimeMs });
  }
  return out;
}

type Spawn = typeof nodeSpawn;

export interface AgentsOptions {
  home?: string;
  bins?: Partial<Record<AgentKind, string>>;
  jobs: { load(): AgentJob[]; save(jobs: AgentJob[]): void };
  spawn?: Spawn;
  now?: () => number;
  /** Called when a job changes (for the activity log). */
  log?: (event: string, details: Record<string, unknown>) => void;
  /** Called when a request ends: done, failed, or stopped by the usage limit (with when it goes on). */
  onFinish?: (job: AgentJob, next?: number) => void;
}

export function createAgents(opts: AgentsOptions) {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now;
  const spawn = opts.spawn ?? nodeSpawn;
  const bins: Record<AgentKind, string> = {
    claude: opts.bins?.claude ?? join(home, '.local/bin/claude'),
    codex: opts.bins?.codex ?? join(home, '.local/bin/codex'),
  };
  const running = new Map<string, { kill(): void }>();

  const available = (): Record<AgentKind, boolean> => ({ claude: existsSync(bins.claude), codex: existsSync(bins.codex) });

  /** The most recent conversations of both agents, newest first. */
  function sessions(limit = 12, filter: { agent?: AgentKind; project?: string } = {}): AgentSession[] {
    const files: { path: string; t: number; agent: AgentKind }[] = [];
    if (!filter.agent || filter.agent === 'claude') {
      for (const f of newestFiles(join(home, '.claude/projects'), (n) => n.endsWith('.jsonl'), 1)) files.push({ ...f, agent: 'claude' });
    }
    if (!filter.agent || filter.agent === 'codex') {
      for (const f of newestFiles(join(home, '.codex/sessions'), (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'), 3)) files.push({ ...f, agent: 'codex' });
    }
    files.sort((a, b) => b.t - a.t);
    const want = filter.project?.toLowerCase().replace(/[\s_-]/g, '');
    const out: AgentSession[] = [];
    for (const f of files) {
      if (out.length >= limit) break;
      let s: AgentSession | undefined;
      try {
        s = f.agent === 'claude' ? readClaude(f.path, now()) : readCodex(f.path, now());
      } catch {
        continue;
      }
      if (!s) continue;
      if (want && !`${s.project} ${s.title}`.toLowerCase().replace(/[\s_-]/g, '').includes(want)) continue;
      out.push(s);
    }
    return out;
  }

  /**
   * One conversation by what the user or the model said: its id (or the start of it), its number in
   * the last list, or a project name ("mortgage-mentor", "המשכנתאות" won't match: names as on disk).
   */
  function find(ref: string, agent?: AgentKind): AgentSession | undefined {
    const r = ref.trim();
    const list = sessions(40, { agent });
    if (/^\d{1,2}$/.test(r)) return list[Number(r) - 1];
    return list.find((s) => s.id === r || (r.length >= 6 && s.id.startsWith(r))) ?? sessions(1, { agent, project: r })[0];
  }

  const loadJobs = () => opts.jobs.load();
  function saveJob(job: AgentJob) {
    const all = loadJobs().filter((j) => j.id !== job.id);
    all.push(job);
    opts.jobs.save(all.slice(-50));
  }

  function jobsFor(sessionId: string) {
    return loadJobs().filter((j) => j.sessionId === sessionId);
  }

  /** The command that sends a message into a conversation (the message itself goes on stdin). */
  function command(job: AgentJob, outFile: string): { file: string; args: string[] } {
    if (job.agent === 'claude') {
      const modes = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto', 'dontAsk'];
      return {
        file: bins.claude,
        args: ['-p', '--resume', job.sessionId, '--output-format', 'json', ...(job.permissionMode && modes.includes(job.permissionMode) ? ['--permission-mode', job.permissionMode] : [])],
      };
    }
    const sandboxes = ['read-only', 'workspace-write', 'danger-full-access'];
    return {
      file: bins.codex,
      args: [
        'exec', 'resume', '--json', '--skip-git-repo-check', '-o', outFile,
        ...(job.sandbox && sandboxes.includes(job.sandbox) ? ['-c', `sandbox_mode="${job.sandbox}"`] : []),
        job.sessionId, '-',
      ],
    };
  }

  function start(job: AgentJob) {
    const outFile = join(tmpdir(), `brain-agent-${job.id}.txt`);
    const { file, args } = command(job, outFile);
    job.status = 'running';
    job.startedAt = now();
    saveJob(job);
    opts.log?.('agent.started', { jobId: job.id, agent: job.agent, project: job.project });
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(file, args, {
        cwd: existsSync(job.cwd) ? job.cwd : home,
        env: { ...process.env, PATH: [join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? ''].join(':') },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish(job, 1, '', (err as Error).message, outFile);
      return;
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), RUN_TIMEOUT_MS);
    timer.unref?.();
    running.set(job.id, { kill: () => child.kill('SIGTERM') });
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < 2_000_000) stdout += d;
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 64_000) stderr += d;
    });
    child.on('error', (err: Error) => {
      stderr += err.message;
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      running.delete(job.id);
      finish(job, code ?? 1, stdout, stderr, outFile);
    });
    child.stdin?.end(job.message);
  }

  function finish(job: AgentJob, code: number, stdout: string, stderr: string, outFile: string) {
    let result = '';
    let isError = code !== 0;
    if (job.agent === 'claude') {
      // --output-format json: one object with the final answer.
      const obj = stdout.trim().split('\n').reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).find(Boolean);
      if (obj) {
        result = String(obj.result ?? '');
        isError ||= !!obj.is_error;
      }
    } else {
      try {
        result = readFileSync(outFile, 'utf8').trim();
      } catch { /* no final answer */ }
      for (const l of stdout.split('\n')) {
        try {
          const e = JSON.parse(l);
          const msg = e?.msg ?? e;
          if (msg?.type === 'error' || msg?.type === 'turn.failed') {
            isError = true;
            result ||= msg.message ?? msg.error?.message ?? '';
          }
        } catch { /* not JSON */ }
      }
      rmSync(outFile, { force: true });
    }
    const problem = `${result}\n${stderr}`;
    if (isError && LIMIT.test(problem)) {
      job.status = 'limited';
      job.result = clip(result || stderr.trim(), 300);
      job.endedAt = now();
      saveJob(job);
      opts.log?.('agent.limited', { jobId: job.id, agent: job.agent, project: job.project });
      // The plan's limit: the same request goes on by itself when it resets.
      const next = job.retries < MAX_RETRIES ? parseReset(problem, now()) + 60_000 : undefined;
      if (next !== undefined) {
        saveJob({
          ...job,
          id: randomUUID(),
          message: 'המשך מאיפה שעצרת (נעצרת כי נגמר ה־usage).',
          status: 'scheduled',
          runAt: next,
          createdAt: now(),
          startedAt: undefined,
          endedAt: undefined,
          result: undefined,
          retries: job.retries + 1,
        });
      }
      opts.onFinish?.(job, next);
      return;
    }
    job.status = isError ? 'failed' : 'done';
    job.result = clip((result || stderr.trim() || (isError ? `יצא עם קוד ${code}` : '')).trim(), 1500);
    job.endedAt = now();
    saveJob(job);
    opts.log?.(isError ? 'agent.failed' : 'agent.done', { jobId: job.id, agent: job.agent, project: job.project });
    opts.onFinish?.(job);
  }

  /**
   * Sends a message into a conversation (after the user approved it). While the agent is working on it,
   * nothing is sent; while its usage limit holds, the message waits for the reset.
   */
  function send(session: AgentSession, message: string): AgentJob {
    if (!available()[session.agent]) throw new Error(`${AGENT_NAMES[session.agent]} לא מותקן במק.`);
    if (jobsFor(session.id).some((j) => j.status === 'running')) throw new Error('כבר שלחתי לו הודעה והוא עובד עליה. אפשר לשאול מה המצב.');
    if (session.state === 'working') {
      throw new Error('הוא עובד עכשיו על השיחה הזו (כנראה במק). אפשר לשלוח כשהוא יסיים.');
    }
    // A message waiting for the reset replaces an earlier one for the same conversation.
    opts.jobs.save(loadJobs().filter((j) => !(j.sessionId === session.id && j.status === 'scheduled')));
    const job: AgentJob = {
      id: randomUUID(),
      agent: session.agent,
      sessionId: session.id,
      cwd: session.cwd,
      project: session.project,
      message,
      status: 'scheduled',
      createdAt: now(),
      retries: 0,
      permissionMode: session.permissionMode,
      sandbox: session.sandbox,
    };
    if (session.state === 'limited' && session.resetAt && session.resetAt > now()) {
      job.runAt = session.resetAt + 60_000;
      saveJob(job);
      return job;
    }
    start(job);
    return job;
  }

  /** Every minute: messages whose time came (usage reset) go out. */
  function tick() {
    for (const job of loadJobs()) {
      if (job.status === 'scheduled' && (job.runAt ?? 0) <= now() && !running.has(job.id)) start(job);
    }
  }

  /** After a restart: a request that was running is no longer watched. */
  function recover() {
    const all = loadJobs();
    let changed = false;
    for (const j of all) {
      if (j.status === 'running' && !running.has(j.id)) {
        j.status = 'failed';
        j.result = 'בריין הופעל מחדש באמצע. מה שהסוכן הספיק נמצא בשיחה עצמה.';
        j.endedAt = now();
        changed = true;
      }
    }
    if (changed) opts.jobs.save(all);
  }

  return { sessions, find, send, tick, recover, jobs: loadJobs, jobsFor, available, bins };
}

export type Agents = ReturnType<typeof createAgents>;
