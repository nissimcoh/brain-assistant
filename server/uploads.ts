/**
 * Photos and files sent from the phone, and photos from the Mac's camera. They are kept in
 * ~/.brain/uploads (only you can read it), tied to the conversation that uses them, and deleted with it.
 *
 * What a file is, is decided by its contents, not its name: only photos (JPEG, PNG, WebP, GIF) and
 * documents with text (PDF, Word, Pages, RTF, plain text) are accepted. A document's text is read once,
 * when it arrives, with the Mac's own tools (files.ts), and goes to the model marked as data.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Attachment, Db, Upload } from './db.ts';
import { extractText } from './files.ts';
import type { Exec } from './tools.ts';

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const MAX_ATTACHMENTS = 6;
/** Text kept from one document (about 15 pages). */
export const MAX_DOC_CHARS = 40_000;
/** Uploads never used in a message are deleted after a day. */
const UNUSED_MS = 24 * 3600_000;

export class UploadError extends Error {}

const IMAGE_TYPES: Record<string, { mime: string; ext: string }> = {
  jpeg: { mime: 'image/jpeg', ext: '.jpg' },
  png: { mime: 'image/png', ext: '.png' },
  webp: { mime: 'image/webp', ext: '.webp' },
  gif: { mime: 'image/gif', ext: '.gif' },
};
const DOC_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pages': 'application/vnd.apple.pages',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.rtf': 'application/rtf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
};

const starts = (b: Buffer, ...bytes: number[]) => bytes.every((x, i) => b[i] === x);

/** The real type of a file, from its first bytes (and, for documents, its name must agree). */
export function sniff(bytes: Buffer, name: string): { kind: Attachment['kind']; mime: string; ext: string } {
  let image: string | undefined;
  if (starts(bytes, 0xff, 0xd8, 0xff)) image = 'jpeg';
  else if (starts(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) image = 'png';
  else if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') image = 'webp';
  else if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('latin1'))) image = 'gif';
  if (image) return { kind: 'image', ...IMAGE_TYPES[image] };

  const ext = extname(name).toLowerCase();
  const mime = DOC_TYPES[ext];
  const head = bytes.subarray(0, 8000);
  const zip = starts(bytes, 0x50, 0x4b, 0x03, 0x04);
  const ok =
    (ext === '.pdf' && bytes.subarray(0, 5).toString('latin1') === '%PDF-') ||
    ((ext === '.docx' || ext === '.pages' || ext === '.odt') && zip) ||
    (ext === '.doc' && starts(bytes, 0xd0, 0xcf, 0x11, 0xe0)) ||
    (ext === '.rtf' && bytes.subarray(0, 5).toString('latin1') === '{\\rtf') ||
    (['.txt', '.md', '.csv', '.json'].includes(ext) && !head.includes(0));
  if (mime && ok) return { kind: 'file', mime, ext };
  if (/^....ftyp(heic|heix|mif1|msf1)/s.test(bytes.subarray(0, 12).toString('latin1'))) {
    throw new UploadError('תמונות HEIC לא נתמכות. באייפון: הגדרות ← מצלמה ← תבניות ← "התאמה מרבית", או לשלוח צילום מסך.');
  }
  throw new UploadError('אפשר לשלוח תמונות (JPEG, PNG), PDF, Word, Pages, RTF או קובץ טקסט.');
}

/** A file name that is safe to show and to store: no folders, no control characters, not too long. */
export function cleanName(name: string, fallback: string): string {
  const base = basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim();
  return (base || fallback).slice(0, 120);
}

export interface UploadsOptions {
  dir: string;
  db: Db;
  exec: Exec;
  platform: string;
  now?: () => number;
}

export function createUploads(o: UploadsOptions) {
  const now = o.now ?? Date.now;
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });

  const extOf = (u: Pick<Upload, 'kind' | 'mime' | 'name'>) =>
    u.kind === 'image' ? (Object.values(IMAGE_TYPES).find((t) => t.mime === u.mime)?.ext ?? '.jpg') : extname(u.name).toLowerCase();
  const pathOf = (u: Pick<Upload, 'id' | 'kind' | 'mime' | 'name'>) => join(o.dir, `${u.id}${extOf(u)}`);

  async function save(deviceId: string, rawName: string, bytes: Buffer, source: Attachment['source'] = 'phone', conversationId?: string): Promise<Upload> {
    if (!bytes.length) throw new UploadError('הקובץ ריק.');
    if (bytes.length > MAX_UPLOAD_BYTES) throw new UploadError('הקובץ גדול מדי (עד 15MB).');
    const type = sniff(bytes, rawName);
    const id = randomUUID();
    const name = type.kind === 'image'
      ? cleanName(rawName, `תמונה${type.ext}`).replace(/\.[^.]*$/, '') + type.ext
      : cleanName(rawName, `קובץ${type.ext}`);
    const path = pathOf({ id, kind: type.kind, mime: type.mime, name });
    await writeFile(path, bytes, { mode: 0o600 });
    let text: string | null = null;
    if (type.kind === 'file') {
      try {
        text = (await extractText(path, o.exec, o.platform, type.ext)).slice(0, MAX_DOC_CHARS) || null;
      } catch {
        text = null;
      }
    }
    return o.db.addUpload({ id, device_id: deviceId, conversation_id: conversationId, kind: type.kind, source, name, mime: type.mime, size: bytes.length, text });
  }

  const read = (u: Upload) => readFile(pathOf(u));

  async function remove(u: Upload) {
    await rm(pathOf(u), { force: true });
    o.db.deleteUpload(u.id);
  }

  /** Deletes uploads never used in a message, and those of deleted conversations. */
  async function cleanup(): Promise<number> {
    const stale = [...o.db.unusedUploads(now() - UNUSED_MS), ...o.db.orphanUploads()];
    for (const u of stale) await remove(u);
    return stale.length;
  }

  /** What a message keeps about an upload (and what the app gets). */
  const attachment = (u: Upload): Attachment => ({ id: u.id, kind: u.kind, name: u.name, mime: u.mime, size: u.size, source: u.source });

  return { save, read, remove, cleanup, attachment, pathOf };
}

export type Uploads = ReturnType<typeof createUploads>;
