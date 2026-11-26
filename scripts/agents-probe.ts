// Shows how Claude Code and Codex keep their conversations on this Mac: field names and types only,
// never the text itself (so the output can be shared safely). Run: npm run agents:probe
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = homedir();

/** The newest file under a folder (depth-first), matching the filter. */
function newest(dir: string, match: (name: string) => boolean, depth = 4): string | undefined {
  if (!existsSync(dir) || depth < 0) return undefined;
  let best: { path: string; t: number } | undefined;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    const candidate = s.isDirectory() ? newest(p, match, depth - 1) : match(name) ? p : undefined;
    if (!candidate) continue;
    const t = statSync(candidate).mtimeMs;
    if (!best || t > best.t) best = { path: candidate, t };
  }
  return best?.path;
}

/** Fields whose short value is a kind of entry, not content (shown to tell entries apart). */
const KIND_FIELDS = new Set(['type', 'role', 'subtype', 'kind', 'status', 'stop_reason', 'originator', 'source']);

/** The shape of a value: keys and types, no content. */
function shape(v: unknown, depth = 0, key = ''): unknown {
  if (depth > 6) return '…';
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1)] : [];
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shape(x, depth + 1, k)]));
  }
  if (typeof v === 'string') return KIND_FIELDS.has(key) && /^[A-Za-z_.\-]{1,40}$/.test(v) ? `"${v}"` : 'string';
  return typeof v;
}

function probe(label: string, file: string | undefined) {
  console.log(`\n===== ${label} =====`);
  if (!file) return console.log('(לא נמצאה שיחה)');
  console.log(`קובץ: ${file.replace(home, '~')}`);
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  console.log(`שורות: ${lines.length}`);
  const seen = new Set<string>();
  for (const line of lines) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const s = JSON.stringify(shape(obj));
    if (seen.has(s)) continue;
    seen.add(s);
    console.log(s);
    if (seen.size >= 40) break;
  }
}

probe('Claude Code', newest(join(home, '.claude/projects'), (n) => n.endsWith('.jsonl')));
probe('Codex', newest(join(home, '.codex/sessions'), (n) => n.startsWith('rollout-') && n.endsWith('.jsonl')));
