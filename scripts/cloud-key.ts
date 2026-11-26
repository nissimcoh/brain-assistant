// Saves a cloud key (OpenAI or Anthropic) on this Mac. Run on the Mac, in the brain folder:
//   npm run cloud:key -- openai        (then paste the key; it isn't shown or kept in the Terminal history)
//   npm run cloud:key -- anthropic
//   npm run cloud:key -- openai --remove
// The key goes to ~/.brain/config.json (readable only by your user) and never leaves the Mac,
// except to the provider itself.
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { checkKey, cloudSettings, type CloudSettings, modelName, type Provider, PROVIDER_NAMES, PROVIDERS } from '../server/cloud.ts';

const args = process.argv.slice(2);
const provider = args.find((a) => PROVIDERS.includes(a as Provider)) as Provider | undefined;
const remove = args.includes('--remove');
if (!provider) {
  console.error('\nצריך לכתוב איזה ספק: npm run cloud:key -- openai   או   npm run cloud:key -- anthropic\n');
  process.exit(1);
}
const field = provider === 'openai' ? 'openaiKey' : 'anthropicKey';
const SITES: Record<Provider, string> = { openai: 'platform.openai.com/api-keys', anthropic: 'console.anthropic.com/settings/keys' };
const SHAPE: Record<Provider, RegExp> = { openai: /^sk-[A-Za-z0-9_-]{20,}$/, anthropic: /^sk-ant-[A-Za-z0-9_-]{20,}$/ };

/** Reads a line without showing it (a dot per character). */
function askHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      let s = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d) => (s += d));
      stdin.on('end', () => resolve(s.trim()));
    });
  }
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let s = '';
    const on = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', on);
          process.stdout.write('\n');
          resolve(s.trim());
          return;
        }
        if (c === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') {
          if (s) {
            s = s.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        s += c;
        process.stdout.write('•');
      }
    };
    stdin.on('data', on);
  });
}

const config = loadConfig();
const path = join(config.dataDir, 'config.json');
const file = existsSync(path) ? (JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>) : {};
const name = PROVIDER_NAMES[provider];

if (remove) {
  delete file[field];
} else {
  // From the command line too (npm run cloud:key -- openai sk-…), though then it stays in the Terminal history.
  const given = args.find((a) => a.startsWith('sk-'));
  const key = given ?? (await askHidden(`הדבק את המפתח של ${name} (מ־${SITES[provider]}) ולחץ Enter: `));
  if (!SHAPE[provider].test(key)) {
    console.error(`\n✘ זה לא נראה כמו מפתח של ${name} (${provider === 'openai' ? 'מתחיל ב־sk-' : 'מתחיל ב־sk-ant-'}). המפתח לא נשמר.\n`);
    process.exit(1);
  }
  process.stdout.write('בודק את המפתח מול הספק (בלי עלות)… ');
  try {
    const models = await checkKey(provider, key);
    const model = config.cloudModels[provider];
    console.log('✔ עובד');
    if (models.length && !models.includes(model)) {
      console.log(`ℹ המודל ${model} לא מופיע ברשימה של החשבון. אם הוא לא יעבוד, אפשר לבחור אחר ב־cloudModels בקובץ ${path}.`);
    }
  } catch (err) {
    console.error(`\n✘ ${(err as { userMessage?: string }).userMessage ?? (err as Error).message}\n`);
    process.exit(1);
  }
  file[field] = key;
}
await writeFile(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
await chmod(path, 0o600);

// If the provider chosen in the app has no key, this one becomes the provider.
const db = openDb(join(config.dataDir, 'brain.db'));
const current = cloudSettings(db.getSetting<Partial<CloudSettings>>('cloud', {}));
const hasKey = (p: Provider) => (p === provider ? !remove : !!(p === 'openai' ? file.openaiKey : file.anthropicKey));
if (!remove && !hasKey(current.provider)) {
  db.setSetting('cloud', { ...current, provider });
  console.log(`✔ ${modelName(config.cloudModels[provider])} נבחר כספק הענן.`);
}
db.close();

if (remove) console.log(`✔ המפתח של ${name} הוסר.`);
else {
  console.log(`✔ נשמר ב־${path} (רק המשתמש שלך יכול לקרוא אותו).`);
  console.log(`ℹ מומלץ לקבוע תקרת חיוב חודשית בחשבון של ${name} (בהגדרות החיוב, Limits), למשל 10 דולר.`);
}
// Brain reads its settings when it starts: restart the background service.
const uid = process.getuid?.();
await promisify(execFile)('launchctl', ['kickstart', '-k', `gui/${uid}/com.brain.server`]).then(
  () => console.log('✔ בריין הופעל מחדש עם ההגדרה החדשה.\n'),
  () => console.log('ℹ הפעל מחדש את בריין: npm run service:install\n'),
);
