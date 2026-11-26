// Saves a Tavily key for web search (free at app.tavily.com, no credit card). Run on the Mac:
//   npm run web:key -- tvly-xxxxxxxx
// Without a key Brain searches DuckDuckGo's plain page from the Mac, which works but is less steady.
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../server/config.ts';
import { createWeb } from '../server/web.ts';

const config = loadConfig();
const key = (process.argv[2] ?? '').trim();
const path = join(config.dataDir, 'config.json');
const file = existsSync(path) ? (JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>) : {};

if (key === '--remove') {
  delete file.tavilyKey;
} else {
  if (!/^tvly-[A-Za-z0-9_-]{10,}$/.test(key)) {
    console.error('\n✘ צריך להדביק את המפתח מ־app.tavily.com, למשל: npm run web:key -- tvly-abc123…\n');
    process.exit(1);
  }
  process.stdout.write('בודק את המפתח… ');
  try {
    const r = await createWeb({ tavilyKey: key }).search('Spain La Liga standings');
    console.log(`✔ עובד (${r.results.length} תוצאות)`);
  } catch (err) {
    console.error(`\n✘ ${(err as { userMessage?: string }).userMessage ?? (err as Error).message}\n`);
    process.exit(1);
  }
  file.tavilyKey = key;
}
await writeFile(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
await chmod(path, 0o600);
console.log(key === '--remove' ? '✔ המפתח הוסר. החיפוש יעבור דרך DuckDuckGo.' : `✔ נשמר ב־${path} (רק המשתמש שלך יכול לקרוא אותו).`);
// Brain reads its settings when it starts: restart the background service.
const uid = process.getuid?.();
await promisify(execFile)('launchctl', ['kickstart', '-k', `gui/${uid}/com.brain.server`]).then(
  () => console.log('✔ בריין הופעל מחדש עם ההגדרה החדשה.\n'),
  () => console.log('ℹ הפעל מחדש את בריין: npm run service:install\n'),
);
