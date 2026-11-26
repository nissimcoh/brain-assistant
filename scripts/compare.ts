// Compares local models on this Mac: the same speed / accuracy check (scripts/speed.ts) and the same
// Hebrew writing tasks for each, side by side in one report. Real model, made-up mail, calendar and
// search results; your real data is not touched. About 10 minutes per model. Don't use Brain meanwhile.
//   npm run compare -- gemma4:12b qwen3.5:9b mistral-nemo:12b
//   npm run compare -- openai:gpt-6-luna anthropic:claude-haiku-5-5    (cloud: needs npm run cloud:key, costs cents)
// A model that isn't installed (or a cloud model without a key) is skipped, with the command to fix it.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadConfig } from '../server/config.ts';
import { listModels } from '../server/ollama.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = loadConfig();
const models = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!models.length) {
  console.error('\nצריך לכתוב אילו מודלים, למשל: npm run compare -- gemma4:12b qwen3.5:9b\n');
  process.exit(1);
}
const installed = (await listModels(config.ollamaUrl)) ?? [];

interface Result {
  model: string;
  skipped?: string;
  accuracy?: string;
  personal?: string;
  inConversation?: string;
  newConversation?: string;
  wrong: string[];
  writing: string;
  minutes?: number;
  cost?: string;
}
const results: Result[] = [];

for (const model of models) {
  const cloud = model.match(/^(openai|anthropic):/)?.[1];
  if (cloud && !(cloud === 'openai' ? config.openaiKey : config.anthropicKey)) {
    console.log(`\n✘ ${model}: אין מפתח. במק: npm run cloud:key -- ${cloud}`);
    results.push({ model, skipped: `אין מפתח (npm run cloud:key -- ${cloud})`, wrong: [], writing: '' });
    continue;
  }
  if (!cloud && !installed.includes(model)) {
    console.log(`\n✘ ${model} לא מותקן. להתקנה: ollama pull ${model}`);
    results.push({ model, skipped: `לא מותקן (ollama pull ${model})`, wrong: [], writing: '' });
    continue;
  }
  console.log(`\n▶ ${model} (${cloud ? 'בענן, כמה דקות' : 'בערך 10 דקות'})…`);
  const started = Date.now();
  const out = await new Promise<string>((resolve) => {
    let text = '';
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'scripts', 'speed.ts'), model], { cwd: root });
    child.stdout.on('data', (d) => {
      text += d;
      process.stdout.write('.');
    });
    child.stderr.on('data', (d) => (text += d));
    child.on('close', () => resolve(text));
  });
  const line = (re: RegExp) => out.match(re)?.[1]?.trim();
  results.push({
    model,
    accuracy: line(/^דיוק: (.+)$/m),
    personal: line(/^דיוק מייל, יומן ו־Apple: (.+)$/m),
    inConversation: line(/^הודעה בתוך שיחה: (.+)$/m),
    newConversation: line(/^שיחה חדשה או מעבר בין שיחות: (.+)$/m),
    wrong: out.split('\n').filter((l) => l.startsWith('✘')).map((l) => l.trim()),
    writing: out.includes('## 4. כתיבה בעברית') ? out.split('## 4. כתיבה בעברית')[1].split('\n## סיכום')[0].trim() : '(לא הגיע לחלק הזה: ' + out.trim().split('\n').filter((l) => /Error|שגיאה|✘/.test(l)).slice(-3).join(' / ') + ')',
    minutes: (Date.now() - started) / 60_000,
    cost: line(/^עלות בענן: (.+)$/m),
  });
  console.log(` ✔ (${((Date.now() - started) / 60_000).toFixed(0)} דקות)`);
}

const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const md = [
  `# השוואת מודלים · ${day}`,
  '',
  '| מודל | דיוק בכלים | מייל/יומן/Apple | הודעה בתוך שיחה | שיחה חדשה | עלות ההרצה |',
  '| --- | --- | --- | --- | --- | --- |',
  ...results.map((r) =>
    r.skipped
      ? `| ${r.model} | ${r.skipped} | | | | |`
      : `| ${r.model} | ${r.accuracy ?? '?'} | ${r.personal ?? '?'} | ${r.inConversation ?? '?'} | ${r.newConversation ?? '?'} | ${r.cost ?? 'חינם (במק)'} |`,
  ),
  '',
  ...results.filter((r) => !r.skipped).flatMap((r) => [
    `## ${r.model}`,
    '',
    r.wrong.length ? `**טעויות בבחירת כלי:**\n${r.wrong.map((w) => `- ${w}`).join('\n')}` : 'בלי טעויות בבחירת כלי.',
    '',
    '**כתיבה בעברית:**',
    '',
    r.writing,
    '',
  ]),
].join('\n');
await mkdir(join(root, 'reports'), { recursive: true });
const file = join(root, 'reports', `compare-${day}.md`);
await writeFile(file, md);
console.log(`\n✔ הדוח נשמר: ${file}\n`);
console.log(md.split('\n').slice(0, 4 + results.length).join('\n'));
