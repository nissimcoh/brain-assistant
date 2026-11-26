// Brings facts into Brain's memory from a text file, one per line (e.g. what ChatGPT remembers).
// Run on the Mac, in the brain folder:
//   npm run memory:import -- private/chatgpt-memory.txt
// Shows what will be saved and what won't (and why), and saves only after you confirm.
// Afterwards the facts are in the app: menu ← זיכרון (edit or delete there).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { planImport } from '../server/importer.ts';

const file = process.argv.slice(2).find((a) => !a.startsWith('-'));
if (!file) {
  console.error('\nצריך לכתוב איזה קובץ: npm run memory:import -- private/chatgpt-memory.txt\n');
  process.exit(1);
}
const raw = await readFile(file, 'utf8').catch(() => {
  console.error(`\n✘ לא מצאתי את הקובץ ${file}\n`);
  process.exit(1);
});

const config = loadConfig();
const db = openDb(join(config.dataDir, 'brain.db'));
const plan = planImport(raw, db.listMemories().map((m) => m.text));

console.log(`\nיישמרו ${plan.add.length} עובדות:`);
plan.add.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
if (plan.skipped.length) {
  console.log(`\nלא יישמרו (${plan.skipped.length}):`);
  for (const s of plan.skipped) console.log(`  ✘ ${s.text.slice(0, 80)}  ←  ${s.reason}`);
}
if (!plan.add.length) {
  console.log('\nאין מה לשמור.\n');
  db.close();
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question(`\nלשמור את ${plan.add.length} העובדות בזיכרון של בריין? (כן/לא) `)).trim().toLowerCase();
rl.close();
if (!['כן', 'כ', 'y', 'yes'].includes(answer)) {
  console.log('לא נשמר כלום.\n');
  db.close();
  process.exit(0);
}
for (const text of plan.add) db.addMemory(text, 'manual');
db.audit('memory.imported', { count: plan.add.length, from: 'file' });
db.close();
console.log(`✔ נשמרו ${plan.add.length} עובדות. אפשר לראות, לערוך ולמחוק באפליקציה: תפריט ← זיכרון.`);
console.log('ℹ שיחות חדשות יכירו אותן (שיחה שכבר פתוחה ממשיכה עם מה שהיה כשהתחילה).');
console.log(`ℹ אפשר עכשיו למחוק את הקובץ: rm ${file}\n`);
