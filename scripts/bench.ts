// Hebrew benchmark for local models: answer quality signals, tool calling and speed.
// Usage: npm run bench -- gemma4:e4b qwen3.5:9b
// With no arguments, runs on every installed model.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../server/config.ts';
import { listModels, modelOptions, type ToolSpec } from '../server/ollama.ts';

const config = loadConfig();
const base = config.ollamaUrl;
// --think runs thinking models with thinking on (slower); the default matches the app.
const THINK = process.argv.includes('--think');
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// --runs=N repeats every case N times, since a single run says little about reliability.
const RUNS = Number(process.argv.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 3);

const TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'send_whatsapp',
      description:
        'הכנת הודעת וואטסאפ לאיש קשר ושליחתה עכשיו. המשתמש רואה טיוטה ומאשר לפני השליחה, ולכן אין צורך לשאול שאלות הבהרה כשיש נמען ותוכן.',
      parameters: {
        type: 'object',
        properties: {
          contact: { type: 'string', description: 'שם איש הקשר כפי שהמשתמש אמר אותו' },
          text: { type: 'string', description: 'נוסח ההודעה בעברית' },
        },
        required: ['contact', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calendar_events',
      description: 'רשימת האירועים ביומן של המשתמש ביום מסוים',
      parameters: {
        type: 'object',
        properties: { day: { type: 'string', description: 'היום המבוקש: today, tomorrow או תאריך YYYY-MM-DD' } },
        required: ['day'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'חיפוש קבצים במק לפי תיאור',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'מילות חיפוש' } },
        required: ['query'],
      },
    },
  },
];

const SYSTEM = [
  'אתה עוזר אישי בעברית. ענה בעברית.',
  'כשצריך לבצע פעולה או לשלוף מידע אישי, קרא לכלי המתאים מיד.',
  'פעולות כמו שליחת הודעה מוצגות למשתמש לאישור לפני ביצוע, אז אל תשאל שאלות הבהרה כשיש לך את מה שצריך: נסח את הטיוטה הטובה ביותר.',
  'ביטויי זמן בתוך בקשה לשלוח הודעה ("אני מאחר בעשר דקות", "נגיע בשבע") הם חלק מתוכן ההודעה, לא זמן שליחה, אלא אם המשתמש ביקש במפורש לתזמן.',
].join('\n');

interface Case {
  name: string;
  prompt: string;
  check: (r: { content: string; calls: { name: string; arguments: Record<string, unknown> }[] }) => boolean;
}

const hebrewRatio = (s: string) => {
  const letters = s.match(/\p{L}/gu) ?? [];
  if (!letters.length) return 0;
  return letters.filter((c) => /[֐-׿]/.test(c)).length / letters.length;
};

const CASES: Case[] = [
  {
    name: 'עברית חופשית',
    prompt: 'מה ההבדל בין משכנתא בריבית קבועה לריבית משתנה? שלושה משפטים.',
    check: (r) => r.calls.length === 0 && hebrewRatio(r.content) > 0.8 && r.content.length > 60,
  },
  {
    name: 'חשבון בלי כלי',
    prompt: 'כמה זה 17 כפול 23?',
    check: (r) => r.calls.length === 0 && /391/.test(r.content),
  },
  {
    name: 'כלי: וואטסאפ',
    prompt: 'תשלח לדני שאני מאחר בעשר דקות',
    check: (r) =>
      r.calls[0]?.name === 'send_whatsapp' &&
      String(r.calls[0].arguments.contact ?? '').includes('דני') &&
      /עשר|10/.test(String(r.calls[0].arguments.text ?? '')),
  },
  {
    name: 'כלי: וואטסאפ 2',
    prompt: 'תכתוב לאמא שאנחנו מגיעים לארוחה ביום שישי',
    check: (r) =>
      r.calls[0]?.name === 'send_whatsapp' &&
      String(r.calls[0].arguments.contact ?? '').includes('אמא') &&
      /שישי/.test(String(r.calls[0].arguments.text ?? '')),
  },
  {
    name: 'כלי: וואטסאפ 3',
    prompt: 'שלח לאשתי הודעה שאני אוהב אותה',
    check: (r) =>
      r.calls[0]?.name === 'send_whatsapp' &&
      /אשת/.test(String(r.calls[0].arguments.contact ?? '')) &&
      /אוהב/.test(String(r.calls[0].arguments.text ?? '')),
  },
  {
    name: 'עברית: פנייה',
    prompt: 'שלח לאשתי הודעה שאני אוהב אותה',
    // The message is addressed to her: "אותך", not "אותה".
    check: (r) => /אותך/.test(String(r.calls[0]?.arguments.text ?? '')) && !/אותה/.test(String(r.calls[0]?.arguments.text ?? '')),
  },
  {
    name: 'עברית: התאמה',
    prompt: 'אני גבר. תקן רק את המשפט ותחזיר אותו בלי הסברים: "אני לא יודעת איפה הוא גרה"',
    check: (r) => r.calls.length === 0 && /יודע(?!ת)/.test(r.content) && /גר(?!ה)/.test(r.content),
  },
  {
    name: 'עברית: תרגום',
    prompt: 'תרגם לעברית טבעית, בלי הסברים: "The parent-teacher meeting was moved to Thursday at 6 pm."',
    check: (r) => r.calls.length === 0 && /חמישי/.test(r.content) && /(אסיפ|פגיש)/.test(r.content) && /(18|שש)/.test(r.content),
  },
  {
    name: 'כלי: יומן',
    prompt: 'מה יש לי ביומן מחר?',
    check: (r) => r.calls[0]?.name === 'calendar_events' && /tomorrow|מחר|\d{4}-\d{2}-\d{2}/.test(String(r.calls[0].arguments.day ?? '')),
  },
  {
    name: 'כלי: קבצים',
    prompt: 'תמצא לי את החוזה של הדירה',
    check: (r) => r.calls[0]?.name === 'search_files' && /חוזה|דירה|contract/i.test(String(r.calls[0].arguments.query ?? '')),
  },
];

async function run(model: string, c: Case) {
  const started = Date.now();
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      options: { num_ctx: config.contextLength },
      ...(await modelOptions(base, model, THINK)).extra,
      tools: TOOLS,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: c.prompt },
      ],
    }),
  });
  const data = (await res.json()) as {
    error?: string;
    message?: { content?: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] };
    eval_count?: number;
    eval_duration?: number;
  };
  if (data.error) throw new Error(data.error);
  const content = data.message?.content ?? '';
  const calls = (data.message?.tool_calls ?? []).map((t) => t.function);
  return {
    ok: c.check({ content, calls }),
    ms: Date.now() - started,
    tps: data.eval_count && data.eval_duration ? data.eval_count / (data.eval_duration / 1e9) : 0,
    content: content.slice(0, 200),
    calls,
  };
}

// Free-form Hebrew writing, printed for a human to judge (no automatic score).
const SAMPLES = [
  'כתוב הודעת וואטסאפ קצרה לגננת שהבן שלי חולה היום ולא יגיע לגן.',
  'הסבר במשפט אחד מה זה משכנתא, לילד בן 10.',
];

async function sample(model: string, prompt: string): Promise<string> {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      options: { num_ctx: config.contextLength },
      ...(await modelOptions(base, model, THINK)).extra,
      messages: [
        { role: 'system', content: 'אתה עוזר אישי. ענה בעברית טבעית ותקנית.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  const data = (await res.json()) as { message?: { content?: string }; error?: string };
  return (data.message?.content ?? data.error ?? '').trim();
}

/** How much memory the loaded model takes (from Ollama). */
async function memoryGb(model: string): Promise<number | null> {
  try {
    const ps = (await (await fetch(`${base}/api/ps`)).json()) as { models?: { name: string; model: string; size: number }[] };
    const m = ps.models?.find((x) => x.name === model || x.model === model);
    return m ? m.size / 1024 ** 3 : null;
  } catch {
    return null;
  }
}

const installed = await listModels(base);
if (!installed) {
  console.error('Ollama לא זמין. פתח את אפליקציית Ollama ונסה שוב.');
  process.exit(1);
}
const models = ARGS.length ? ARGS : installed.filter((m) => !/embed/i.test(m));
console.log(THINK ? 'מצב חשיבה: פועל' : 'מצב חשיבה: כבוי (כמו באפליקציה)');
const results: Record<string, unknown[]> = {};
const summary: string[] = [];

for (const model of models) {
  if (!installed.includes(model)) {
    console.log(`\n${model}: לא מותקן — דילוג (ollama pull ${model})`);
    continue;
  }
  console.log(`\n=== ${model} ===`);
  // Warm-up so load time does not count against the first case.
  await run(model, CASES[1]).catch(() => undefined);
  results[model] = [];
  const ram = await memoryGb(model);
  console.log(`זיכרון בשימוש: ${ram ? `${ram.toFixed(1)}GB` : 'לא ידוע'}${ram && ram > 10 ? ' — כבד מדי ל־16GB' : ''}`);
  const score = { tool: [0, 0], hebrew: [0, 0], other: [0, 0] };
  const kind = (name: string) => (name.startsWith('כלי') ? 'tool' : name.startsWith('עברית') ? 'hebrew' : 'other') as keyof typeof score;
  let passed = 0;
  let total = 0;
  let tpsSum = 0;
  let msSum = 0;
  for (const c of CASES) {
    let ok = 0;
    let ms = 0;
    let shown = '';
    let failure = '';
    for (let i = 0; i < RUNS; i++) {
      total++;
      try {
        const r = await run(model, c);
        results[model].push({ case: c.name, run: i + 1, ...r });
        const detail = r.calls.length
          ? `${r.calls[0].name}(${JSON.stringify(r.calls[0].arguments)})`
          : r.content.replace(/\s+/g, ' ').slice(0, 70);
        if (r.ok) {
          ok++;
          shown ||= detail;
        } else {
          failure ||= detail;
        }
        tpsSum += r.tps;
        ms += r.ms;
      } catch (err) {
        results[model].push({ case: c.name, run: i + 1, error: String(err) });
        failure ||= String(err);
      }
    }
    passed += ok;
    msSum += ms;
    score[kind(c.name)][0] += ok;
    score[kind(c.name)][1] += RUNS;
    const mark = ok === RUNS ? '✔' : ok === 0 ? '✘' : '◐';
    console.log(`${mark} ${c.name.padEnd(16)} ${ok}/${RUNS}  ${(ms / RUNS / 1000).toFixed(1)}s  ${shown}`);
    if (failure) console.log(`    נכשל: ${failure}`);
  }
  const pct = ([a, b]: number[]) => (b ? `${Math.round((100 * a) / b)}%` : '—');
  summary.push(
    `| ${model} | ${pct(score.tool)} | ${pct(score.hebrew)} | ${ram ? `${ram.toFixed(1)}GB` : '?'} | ${Math.round(tpsSum / total)} | ${(msSum / total / 1000).toFixed(1)}s |`,
  );
  console.log('\nדוגמאות כתיבה (לשיפוט שלך):');
  for (const p of SAMPLES) {
    const text = await sample(model, p);
    results[model].push({ sample: p, text });
    console.log(`  ✎ ${p}\n    ${text.replace(/\n+/g, '\n    ')}`);
  }
  // Free memory before the next model.
  await fetch(`${base}/api/generate`, { method: 'POST', body: JSON.stringify({ model, keep_alive: 0 }) }).catch(() => undefined);
}

console.log('\n| מודל | כלים | עברית | זיכרון | טוקנים/שנייה | זמן ממוצע |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const line of summary) console.log(line);

const out = join(config.dataDir, `bench-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`\nתוצאות מלאות נשמרו ב־${out}`);
