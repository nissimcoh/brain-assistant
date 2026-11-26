// Facts brought from elsewhere (e.g. what ChatGPT remembers) into Brain's memory: one fact per line.
import { MAX_MEMORIES, sensitiveReason } from './tools.ts';

export interface ImportPlan {
  add: string[];
  skipped: { text: string; reason: string }[];
}

const MAX_FACT = 300;

/** Which lines become memory facts, and why the others don't. Nothing is saved here. */
export function planImport(raw: string, existing: string[]): ImportPlan {
  const plan: ImportPlan = { add: [], skipped: [] };
  const seen = new Set(existing.map((t) => t.trim()));
  for (const line of raw.split(/\r?\n/)) {
    // "- fact", "• fact", "* fact", "12. fact", "12) fact"; headings and empty lines are left out.
    const text = line.replace(/^\s*(?:[-•*–]|\d+[.)])\s*/, '').trim();
    if (!text || /^#/.test(text)) continue;
    const reason =
      text.length > MAX_FACT ? `ארוך מ־${MAX_FACT} תווים: לקצר או לפצל` :
      sensitiveReason(text) ?? (seen.has(text) ? 'כבר בזיכרון' : null);
    if (reason) {
      plan.skipped.push({ text, reason });
      continue;
    }
    seen.add(text);
    plan.add.push(text);
  }
  const room = Math.max(0, MAX_MEMORIES - existing.length);
  for (const text of plan.add.splice(room)) plan.skipped.push({ text, reason: `הזיכרון מוגבל ל־${MAX_MEMORIES} עובדות` });
  return plan;
}
