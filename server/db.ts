import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';

export interface Conversation {
  id: string;
  title: string;
  /** first: the start of the first message (temporary) · auto: named by the model · manual: named by the user */
  title_source?: 'first' | 'auto' | 'manual';
  /** 1 = pinned to the top of the list */
  pinned?: number;
  created_at: number;
  updated_at: number;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  model: string | null;
  engine: string | null;
  /** Assistant messages that asked to run tools. */
  tool_calls: ToolCall[] | null;
  /** Tool messages: which tool produced this result. */
  tool_name: string | null;
  /** Assistant messages: whether thinking mode was on. */
  thinking: number;
  /** Tool messages: what the app shows for this result (a mail list, a file…), as JSON. */
  display: unknown | null;
  /** Photos and files that came with the message (from the phone, or from the Mac's camera). */
  attachments: Attachment[] | null;
  created_at: number;
}

/** A photo or a file kept on the Mac with a conversation (uploads.ts). */
export interface Attachment {
  id: string;
  kind: 'image' | 'file';
  name: string;
  mime: string;
  size: number;
  /** Where it came from: the phone, an email's attachment, or the Mac's own camera (never sent to the cloud). */
  source: 'phone' | 'camera' | 'mail';
}

export interface Upload extends Attachment {
  device_id: string;
  conversation_id: string | null;
  /** Text read from a document when it arrived (null for photos, or a document without text). */
  text: string | null;
  created_at: number;
}

export type ActionStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'done' | 'failed';

export interface Action {
  id: string;
  conversation_id: string;
  message_id: string;
  tool: string;
  args: Record<string, unknown>;
  status: ActionStatus;
  result: string | null;
  created_at: number;
  decided_at: number | null;
}

export interface Memory {
  id: number;
  text: string;
  source: 'chat' | 'manual';
  conversation_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface SearchHit {
  conversation_id: string;
  title: string;
  message_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
}

export interface Device {
  id: string;
  name: string;
  created_at: number;
  last_seen: number | null;
  revoked: number;
}

const SCHEMA_V0 = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  model TEXT,
  engine TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
`;

/** Each entry upgrades the schema by one version. Never edit an entry once shipped; append a new one. */
const MIGRATIONS: string[] = [
  // v1 — tools: tool messages, tool calls, approvals, settings.
  `
  CREATE TABLE messages_v1 (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    model TEXT,
    engine TEXT,
    tool_calls TEXT,
    tool_name TEXT,
    thinking INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  INSERT INTO messages_v1 (id, conversation_id, role, content, model, engine, created_at)
    SELECT id, conversation_id, role, content, model, engine, created_at FROM messages ORDER BY rowid;
  DROP TABLE messages;
  ALTER TABLE messages_v1 RENAME TO messages;
  CREATE INDEX messages_by_conversation ON messages (conversation_id);

  CREATE TABLE actions (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    args TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX actions_by_conversation ON actions (conversation_id);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v2 — memory and full-text search over conversations (trigram: matches inside Hebrew words with prefixes).
  `
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('chat', 'manual')),
    conversation_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid', tokenize='trigram');
  INSERT INTO messages_fts (rowid, content)
    SELECT rowid, content FROM messages WHERE role IN ('user', 'assistant') AND content <> '';
  CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
    WHEN new.role IN ('user', 'assistant') AND new.content <> ''
    BEGIN INSERT INTO messages_fts (rowid, content) VALUES (new.rowid, new.content); END;
  CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages
    WHEN old.role IN ('user', 'assistant') AND old.content <> ''
    BEGIN INSERT INTO messages_fts (messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content); END;
  `,
  // v3 — where a conversation's name came from (first message, the model, or the user: never overwritten),
  // and pinned conversations (kept at the top of the list).
  `
  ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'first' CHECK (title_source IN ('first', 'auto', 'manual'));
  ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  `,
  // v4 — what the app shows for a tool result (a list of mails, a file to open again), kept with the conversation.
  `
  ALTER TABLE messages ADD COLUMN display TEXT;
  `,
  // v5 — photos and files sent from the phone (and photos from the Mac's camera): the files themselves are in
  // ~/.brain/uploads; a row ties each one to a conversation once a message uses it.
  `
  ALTER TABLE messages ADD COLUMN attachments TEXT;
  CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    conversation_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
    source TEXT NOT NULL DEFAULT 'phone' CHECK (source IN ('phone', 'camera')),
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    text TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX uploads_by_conversation ON uploads (conversation_id);
  `,
  // v6 — attachments fetched from email are kept like uploads (source 'mail').
  `
  CREATE TABLE uploads_v6 (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    conversation_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
    source TEXT NOT NULL DEFAULT 'phone' CHECK (source IN ('phone', 'camera', 'mail')),
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    text TEXT,
    created_at INTEGER NOT NULL
  );
  INSERT INTO uploads_v6 SELECT id, device_id, conversation_id, kind, source, name, mime, size, text, created_at FROM uploads;
  DROP TABLE uploads;
  ALTER TABLE uploads_v6 RENAME TO uploads;
  CREATE INDEX uploads_by_conversation ON uploads (conversation_id);
  `,
];

export type Db = ReturnType<typeof openDb>;

interface MessageRow extends Omit<Message, 'tool_calls' | 'display' | 'attachments'> {
  tool_calls: string | null;
  display: string | null;
  attachments: string | null;
}
interface ActionRow extends Omit<Action, 'args'> {
  args: string;
}

export function openDb(path: string) {
  const isNew = path !== ':memory:' && !existsSync(path);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_V0);
  if (isNew) chmodSync(path, 0o600);

  // ---------- migrations ----------
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('PRAGMA foreign_keys = OFF; BEGIN;');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}; COMMIT;`);
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  const now = () => Date.now();
  const toMessage = (r: MessageRow): Message => ({
    ...r,
    tool_calls: r.tool_calls ? JSON.parse(r.tool_calls) : null,
    display: r.display ? JSON.parse(r.display) : null,
    attachments: r.attachments ? JSON.parse(r.attachments) : null,
  });
  const toAction = (r: ActionRow): Action => ({ ...r, args: JSON.parse(r.args) });

  return {
    raw: db,
    close: () => db.close(),
    schemaVersion: () => Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version),

    // ---------- devices & pairing ----------
    addPairingCode(codeHash: string, expiresAt: number) {
      db.prepare('INSERT OR REPLACE INTO pairing_codes (code_hash, expires_at) VALUES (?, ?)').run(codeHash, expiresAt);
    },
    /** Marks the code used and returns true if it existed, was unused and not expired. */
    consumePairingCode(codeHash: string): boolean {
      const result = db
        .prepare('UPDATE pairing_codes SET used = 1 WHERE code_hash = ? AND used = 0 AND expires_at > ?')
        .run(codeHash, now());
      return Number(result.changes) === 1;
    },
    invalidatePairingCodes() {
      db.prepare('UPDATE pairing_codes SET used = 1 WHERE used = 0').run();
    },
    addDevice(name: string, tokenHash: string): Device {
      const id = randomUUID();
      const created = now();
      db.prepare('INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)').run(id, name, tokenHash, created);
      return { id, name, created_at: created, last_seen: null, revoked: 0 };
    },
    deviceByTokenHash(tokenHash: string): Device | undefined {
      return db
        .prepare('SELECT id, name, created_at, last_seen, revoked FROM devices WHERE token_hash = ? AND revoked = 0')
        .get(tokenHash) as Device | undefined;
    },
    touchDevice(id: string) {
      db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(now(), id);
    },
    listDevices(): Device[] {
      return db
        .prepare('SELECT id, name, created_at, last_seen, revoked FROM devices ORDER BY created_at')
        .all() as unknown as Device[];
    },
    revokeDevice(id: string): boolean {
      return Number(db.prepare('UPDATE devices SET revoked = 1 WHERE id = ?').run(id).changes) === 1;
    },
    activeDeviceCount(): number {
      return Number((db.prepare('SELECT COUNT(*) AS n FROM devices WHERE revoked = 0').get() as { n: number }).n);
    },

    // ---------- conversations ----------
    createConversation(title: string): Conversation {
      const c: Conversation = { id: randomUUID(), title, title_source: 'first', pinned: 0, created_at: now(), updated_at: now() };
      db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
        c.id,
        c.title,
        c.created_at,
        c.updated_at,
      );
      return c;
    },
    getConversation(id: string): Conversation | undefined {
      return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation | undefined;
    },
    listConversations(): Conversation[] {
      return db.prepare('SELECT * FROM conversations ORDER BY pinned DESC, updated_at DESC').all() as unknown as Conversation[];
    },
    pinConversation(id: string, pinned: boolean): boolean {
      return Number(db.prepare('UPDATE conversations SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id).changes) === 1;
    },
    renameConversation(id: string, title: string, source: 'auto' | 'manual'): boolean {
      // An automatic name never replaces one the user chose.
      const sql =
        source === 'auto'
          ? "UPDATE conversations SET title = ?, title_source = 'auto' WHERE id = ? AND title_source = 'first'"
          : "UPDATE conversations SET title = ?, title_source = 'manual' WHERE id = ?";
      return Number(db.prepare(sql).run(title, id).changes) === 1;
    },
    /** Conversations still named after their first message that already have an answer, newest first. */
    untitledConversations(limit: number): Conversation[] {
      return db
        .prepare(
          `SELECT c.* FROM conversations c WHERE c.title_source = 'first'
             AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.role = 'assistant' AND m.content <> '')
           ORDER BY c.updated_at DESC LIMIT ?`,
        )
        .all(limit) as unknown as Conversation[];
    },
    deleteConversation(id: string): boolean {
      return Number(db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes) === 1;
    },

    // ---------- messages ----------
    addMessage(
      conversationId: string,
      role: Message['role'],
      content: string,
      extra: {
        model?: string | null; engine?: string | null; toolCalls?: ToolCall[]; toolName?: string; thinking?: boolean; display?: unknown;
        attachments?: Attachment[];
      } = {},
    ): Message {
      const m: Message = {
        id: randomUUID(),
        conversation_id: conversationId,
        role,
        content,
        model: extra.model ?? null,
        engine: extra.engine ?? null,
        tool_calls: extra.toolCalls?.length ? extra.toolCalls : null,
        tool_name: extra.toolName ?? null,
        thinking: extra.thinking ? 1 : 0,
        display: extra.display ?? null,
        attachments: extra.attachments?.length ? extra.attachments : null,
        created_at: now(),
      };
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, model, engine, tool_calls, tool_name, thinking, display, attachments, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        m.id,
        m.conversation_id,
        m.role,
        m.content,
        m.model,
        m.engine,
        m.tool_calls ? JSON.stringify(m.tool_calls) : null,
        m.tool_name,
        m.thinking,
        m.display === null ? null : JSON.stringify(m.display),
        m.attachments === null ? null : JSON.stringify(m.attachments),
        m.created_at,
      );
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(m.created_at, conversationId);
      return m;
    },
    listMessages(conversationId: string, sinceId?: string): Message[] {
      const rows = sinceId
        ? db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND rowid >= COALESCE(
            (SELECT rowid FROM messages WHERE id = ? AND conversation_id = ?), 0) ORDER BY rowid`)
            .all(conversationId, sinceId, conversationId)
        : db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid').all(conversationId);
      return (rows as unknown as MessageRow[]).map(toMessage);
    },
    displayMessages(conversationId: string): Message[] {
      // Tool results stay on the Mac; only what the app shows for them (display) goes to the phone.
      const rows = db
        .prepare("SELECT * FROM messages WHERE conversation_id = ? AND (role <> 'tool' OR display IS NOT NULL) ORDER BY rowid")
        .all(conversationId);
      return (rows as unknown as MessageRow[]).map(toMessage).map((m) => (m.role === 'tool' ? { ...m, content: '' } : m));
    },
    getMessage(id: string): Message | undefined {
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      return row ? toMessage(row as unknown as MessageRow) : undefined;
    },
    setMessageDisplay(id: string, display: unknown) {
      db.prepare('UPDATE messages SET display = ? WHERE id = ?').run(JSON.stringify(display), id);
    },
    lastRole(conversationId: string): Message['role'] | undefined {
      // The "move to the cloud?" card (agent.ts) doesn't count: the question before it is still unanswered.
      const row = db
        .prepare("SELECT role FROM messages WHERE conversation_id = ? AND (tool_name IS NULL OR tool_name <> 'cloud_choice') ORDER BY rowid DESC LIMIT 1")
        .get(conversationId);
      return row?.role as Message['role'] | undefined;
    },
    lastUserText(conversationId: string): string | undefined {
      const row = db.prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1").get(conversationId);
      return row?.content as string | undefined;
    },

    // ---------- actions (tool calls that need the user's approval) ----------
    addAction(conversationId: string, messageId: string, tool: string, args: Record<string, unknown>): Action {
      const a: Action = {
        id: randomUUID(),
        conversation_id: conversationId,
        message_id: messageId,
        tool,
        args,
        status: 'pending',
        result: null,
        created_at: now(),
        decided_at: null,
      };
      db.prepare(
        'INSERT INTO actions (id, conversation_id, message_id, tool, args, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(a.id, a.conversation_id, a.message_id, a.tool, JSON.stringify(a.args), a.status, a.created_at);
      return a;
    },
    getAction(id: string): Action | undefined {
      const row = db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as ActionRow | undefined;
      return row ? toAction(row) : undefined;
    },
    listActions(conversationId: string): Action[] {
      return (
        db.prepare('SELECT * FROM actions WHERE conversation_id = ? ORDER BY created_at').all(conversationId) as unknown as ActionRow[]
      ).map(toAction);
    },
    pendingActions(conversationId: string): Action[] {
      return (
        db
          .prepare("SELECT * FROM actions WHERE conversation_id = ? AND status = 'pending'")
          .all(conversationId) as unknown as ActionRow[]
      ).map(toAction);
    },
    /** Moves a pending action to its next state. Returns false if it was no longer pending. */
    decideAction(id: string, status: ActionStatus, args?: Record<string, unknown>): boolean {
      const r = args
        ? db
            .prepare("UPDATE actions SET status = ?, args = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
            .run(status, JSON.stringify(args), now(), id)
        : db.prepare("UPDATE actions SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, now(), id);
      return Number(r.changes) === 1;
    },
    finishAction(id: string, status: 'done' | 'failed', result: string) {
      db.prepare('UPDATE actions SET status = ?, result = ? WHERE id = ?').run(status, result, id);
    },

    // ---------- memory ----------
    listMemories(): Memory[] {
      return db.prepare('SELECT * FROM memories ORDER BY id').all() as unknown as Memory[];
    },
    getMemory(id: number): Memory | undefined {
      return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | undefined;
    },
    findMemory(text: string): Memory | undefined {
      return db.prepare('SELECT * FROM memories WHERE text = ?').get(text) as Memory | undefined;
    },
    addMemory(text: string, source: Memory['source'], conversationId: string | null = null): Memory {
      const t = now();
      const r = db
        .prepare('INSERT INTO memories (text, source, conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(text, source, conversationId, t, t);
      return this.getMemory(Number(r.lastInsertRowid))!;
    },
    updateMemory(id: number, text: string): boolean {
      return Number(db.prepare('UPDATE memories SET text = ?, updated_at = ? WHERE id = ?').run(text, now(), id).changes) === 1;
    },
    deleteMemory(id: number): boolean {
      return Number(db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes) === 1;
    },

    // ---------- search ----------
    /** Finds user/assistant messages containing the query (any part of a word), newest first. */
    searchMessages(query: string, limit = 20): SearchHit[] {
      const q = query.trim();
      if (!q) return [];
      const sql =
        q.length >= 3
          ? `SELECT m.conversation_id, c.title, m.id AS message_id, m.role, m.content, m.created_at
             FROM messages_fts f JOIN messages m ON m.rowid = f.rowid JOIN conversations c ON c.id = m.conversation_id
             WHERE messages_fts MATCH ? ORDER BY m.created_at DESC LIMIT ?`
          : `SELECT m.conversation_id, c.title, m.id AS message_id, m.role, m.content, m.created_at
             FROM messages m JOIN conversations c ON c.id = m.conversation_id
             WHERE m.role IN ('user', 'assistant') AND instr(m.content, ?) > 0 ORDER BY m.created_at DESC LIMIT ?`;
      // Quoted as one FTS phrase so punctuation in the query is taken literally.
      const param = q.length >= 3 ? `"${q.replace(/"/g, '""')}"` : q;
      return db.prepare(sql).all(param, limit) as unknown as SearchHit[];
    },

    // ---------- settings ----------
    // ---------- uploads (uploads.ts keeps the files) ----------
    addUpload(u: Omit<Upload, 'created_at' | 'conversation_id'> & { conversation_id?: string | null }): Upload {
      const row: Upload = { ...u, conversation_id: u.conversation_id ?? null, created_at: now() };
      db.prepare(
        `INSERT INTO uploads (id, device_id, conversation_id, kind, source, name, mime, size, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.id, row.device_id, row.conversation_id, row.kind, row.source, row.name, row.mime, row.size, row.text, row.created_at);
      return row;
    },
    getUpload(id: string): Upload | undefined {
      return db.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as unknown as Upload | undefined;
    },
    /** Ties uploads to the conversation whose message uses them. */
    attachUploads(ids: string[], conversationId: string) {
      const stmt = db.prepare('UPDATE uploads SET conversation_id = ? WHERE id = ? AND (conversation_id IS NULL OR conversation_id = ?)');
      for (const id of ids) stmt.run(conversationId, id, conversationId);
    },
    uploadsOf(conversationId: string): Upload[] {
      return db.prepare('SELECT * FROM uploads WHERE conversation_id = ?').all(conversationId) as unknown as Upload[];
    },
    /** Sent from the phone but never used in a message (the message was abandoned). */
    unusedUploads(before: number): Upload[] {
      return db.prepare('SELECT * FROM uploads WHERE conversation_id IS NULL AND created_at < ?').all(before) as unknown as Upload[];
    },
    /** Uploads whose conversation was deleted. */
    orphanUploads(): Upload[] {
      return db
        .prepare('SELECT * FROM uploads WHERE conversation_id IS NOT NULL AND conversation_id NOT IN (SELECT id FROM conversations)')
        .all() as unknown as Upload[];
    },
    deleteUpload(id: string) {
      db.prepare('DELETE FROM uploads WHERE id = ?').run(id);
    },

    getSetting<T>(key: string, fallback: T): T {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as T) : fallback;
    },
    setSetting(key: string, value: unknown) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        key,
        JSON.stringify(value),
      );
    },

    // ---------- audit log ----------
    audit(kind: string, detail: Record<string, unknown>) {
      db.prepare('INSERT INTO audit (ts, kind, detail) VALUES (?, ?, ?)').run(now(), kind, JSON.stringify(detail));
    },
    listAudit(limit = 100): { id: number; ts: number; kind: string; detail: Record<string, unknown> }[] {
      const rows = db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit) as {
        id: number;
        ts: number;
        kind: string;
        detail: string;
      }[];
      return rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
    },
  };
}
