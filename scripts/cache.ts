// Checks when Ollama reuses its cache of the prompt (and so answers fast) and when it re-reads everything.
// Hypothesis: with Gemma, reuse stops once the prompt passes ~1,000 tokens.
// Usage: npm run cache -- [model]     (default: the model chosen in the app). Don't use Brain while it runs.
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { listModels, modelOptions } from '../server/ollama.ts';
import { createToolRegistry } from '../server/tools.ts';

const config = loadConfig();
const db = openDb(join(config.dataDir, 'brain.db'));
const base = config.ollamaUrl;
const registry = createToolRegistry();

interface Msg {
  role: string;
  content: string;
}
interface Stats {
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  message?: { content?: string };
  error?: string;
}

async function ask(model: string, messages: Msg[], opts: { tools?: unknown[]; maxTokens: number }) {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      keep_alive: config.keepAlive,
      options: { num_ctx: config.contextLength, num_predict: opts.maxTokens },
      ...(await modelOptions(base, model, false)),
      ...(opts.tools?.length ? { tools: opts.tools } : {}),
      messages,
    }),
  });
  const s = (await res.json()) as Stats;
  if (s.error) throw new Error(s.error);
  return {
    tokens: s.prompt_eval_count ?? 0,
    sec: (s.prompt_eval_duration ?? 0) / 1e9,
    answer: s.message?.content ?? '',
  };
}

/** Neutral filler lines, so a system prompt can be made any length. */
const filler = (lines: number) =>
  Array.from({ length: lines }, (_, i) => `- הערה ${i + 1}: זה טקסט מילוי לבדיקה, ואין לו קשר לשאלה.`).join('\n');

/**
 * Same system prompt twice. The first request starts with a fresh random id, so nothing is cached ("cold").
 * The second has the same system prompt and a different question ("warm").
 * If the cache works, the warm request reads the prompt much faster than the cold one.
 */
async function coldWarm(model: string, system: string, tools?: unknown[]) {
  const sys = `מזהה בדיקה: ${randomUUID()}\n${system}`;
  const cold = await ask(model, [{ role: 'system', content: sys }, { role: 'user', content: 'מה בירת צרפת?' }], { tools, maxTokens: 10 });
  const warm = await ask(model, [{ role: 'system', content: sys }, { role: 'user', content: 'כמה זה 12 כפול 8?' }], { tools, maxTokens: 10 });
  return { tokens: cold.tokens, cold: cold.sec, warm: warm.sec, cached: isCached(cold.sec, warm.sec) };
}

// Under ~0.4 s the difference doesn't matter (and is mostly noise).
const isCached = (cold: number, warm: number) => (cold < 0.4 ? null : warm < cold * 0.5);
const verdict = (cached: boolean | null) => (cached === null ? '· קצר מכדי לשנות' : cached ? '✔ נשמר' : '✘ נקרא מחדש');

const installed = (await listModels(base)) ?? [];
if (!installed.length) {
  console.error('Ollama לא זמין.');
  process.exit(1);
}
const model = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? db.getSetting('localModel', config.localModel);
if (!installed.includes(model)) {
  console.error(`${model}: לא מותקן`);
  process.exit(1);
}
console.log(`\n=== ${model} ===`);
console.log('טוען את המודל…');
await ask(model, [{ role: 'user', content: 'היי' }], { maxTokens: 5 });

// Calibrate: how many tokens one filler line costs.
const head = 'אתה עוזר אישי שעונה בעברית.';
const t0 = (await coldWarm(model, head)).tokens;
const t50 = (await coldWarm(model, `${head}\n${filler(50)}`)).tokens;
const perLine = Math.max(1, (t50 - t0) / 50);

// ---------- 1. prompt length ----------
console.log('\n## 1. אורך ההוראות (בלי כלים)');
console.log('| טוקנים | קר | חם | מטמון |');
console.log('| --- | --- | --- | --- |');
const lengths: { tokens: number; cached: boolean | null }[] = [];
for (const target of [500, 800, 950, 1100, 1300, 1600, 2500]) {
  const lines = Math.max(0, Math.round((target - t0) / perLine));
  const r = await coldWarm(model, `${head}\n${filler(lines)}`);
  lengths.push(r);
  console.log(`| ${r.tokens} | ${r.cold.toFixed(2)} שנ׳ | ${r.warm.toFixed(2)} שנ׳ | ${verdict(r.cached)} |`);
}

// ---------- 2. tools, with a short prompt ----------
console.log('\n## 2. האם הכלים עצמם שוברים את המטמון? (הוראות קצרות + כלים)');
console.log('| מה | טוקנים | קר | חם | מטמון |');
console.log('| --- | --- | --- | --- | --- |');
const toolRows: { name: string; tokens: number; cached: boolean | null }[] = [];
for (const [name, groups] of [
  ['כלי שעון בלבד', ['clock']],
  ['כלי קבצים', ['files']],
] as const) {
  const r = await coldWarm(model, head, registry.specs([...groups]));
  toolRows.push({ name, ...r });
  console.log(`| ${name} | ${r.tokens} | ${r.cold.toFixed(2)} שנ׳ | ${r.warm.toFixed(2)} שנ׳ | ${verdict(r.cached)} |`);
}

// ---------- 3. a growing conversation ----------
console.log('\n## 3. שיחה שמתארכת (כמו באפליקציה)');
console.log('(קודם השיחה עצמה, ואז אותה שיחה שוב מאפס להשוואה)');
const turns = [
  'ספר לי בשלושה משפטים על ירושלים.',
  'ומה כדאי לראות שם עם ילדים?',
  'ואיפה אפשר לאכול שם טוב?',
  'תן לי שלושה טיפים לחניה.',
  'כמה זמן לוקח להגיע מתל אביב?',
  'ומה עם תחבורה ציבורית?',
  'מה מזג האוויר שם בחורף, באופן כללי?',
  'תסכם לי את כל מה שאמרת בחמש נקודות.',
];
const convo: Msg[] = [{ role: 'system', content: `מזהה בדיקה: ${randomUUID()}\n${head}` }];
const warmSec: number[] = [];
for (const q of turns) {
  convo.push({ role: 'user', content: q });
  const r = await ask(model, convo, { maxTokens: 200 });
  convo.push({ role: 'assistant', content: r.answer });
  warmSec.push(r.sec);
}
console.log('| הודעה | טוקנים בשיחה | בשיחה עצמה | מאפס | מטמון |');
console.log('| --- | --- | --- | --- | --- |');
const convoRows: { tokens: number; sec: number; cached: boolean | null }[] = [];
for (let i = 0; i < turns.length; i++) {
  // The same conversation up to message i, with a new id so nothing is cached.
  const upTo = [{ role: 'system', content: `מזהה בדיקה: ${randomUUID()}\n${head}` }, ...convo.slice(1, 2 + i * 2)];
  const cold = await ask(model, upTo, { maxTokens: 1 });
  const cached = i === 0 ? null : isCached(cold.sec, warmSec[i]);
  convoRows.push({ tokens: cold.tokens, sec: warmSec[i], cached });
  console.log(`| ${i + 1} | ${cold.tokens} | ${warmSec[i].toFixed(2)} שנ׳ | ${cold.sec.toFixed(2)} שנ׳ | ${i === 0 ? '—' : verdict(cached)} |`);
}

// ---------- conclusion ----------
console.log('\n## מסקנה');
const firstMiss = lengths.find((l) => l.cached === false);
const lastHit = [...lengths].reverse().find((l) => l.cached !== false && (!firstMiss || l.tokens < firstMiss.tokens));
if (!firstMiss) console.log('המטמון עבד בכל האורכים. ההשערה לא נכונה.');
else if (!lastHit) console.log('המטמון לא עבד אפילו בהוראות קצרות. הבעיה במקום אחר.');
else console.log(`המטמון עובד עד ~${lastHit.tokens} טוקנים ונשבר ב־~${firstMiss.tokens}. ההשערה נכונה.`);
for (const t of toolRows) {
  if (t.cached === null) console.log(`${t.name}: קצר מכדי לקבוע.`);
  else console.log(`${t.name}: ${t.cached ? 'המטמון עבד, כלומר הכלים עצמם לא הבעיה' : 'המטמון נשבר גם בהוראות קצרות, כלומר גם הכלים הם בעיה'}.`);
}
const lastTurn = convoRows.at(-1)!;
console.log(`שיחה של ${turns.length} הודעות: ההודעה האחרונה חיכתה ${lastTurn.sec.toFixed(1)} שנ׳ לקריאת ההוראות (${lastTurn.tokens} טוקנים).`);
db.close();
