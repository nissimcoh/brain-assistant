// The cloud engine: OpenAI (GPT) or Anthropic (Claude), used only when the user allows it.
// The Mac keeps the keys and runs every tool; the cloud model only sees the conversation and the
// tool results that the privacy settings allow (see agent.ts), and answers with text or tool calls.
import { type ChatMessage, OllamaError, type StreamEvent, type StreamStats, type ToolSpec } from './ollama.ts';

export type Provider = 'openai' | 'anthropic';
export const PROVIDERS: Provider[] = ['openai', 'anthropic'];

/** Kinds of personal data the user can allow to reach the cloud, each on its own switch. */
export type DataCategory = 'memory' | 'personal' | 'files' | 'mail';
export const DATA_CATEGORIES: DataCategory[] = ['memory', 'personal', 'files', 'mail'];
export const CATEGORY_NAMES: Record<DataCategory, string> = {
  memory: 'הזיכרון עליך ושיחות קודמות',
  personal: 'יומן, תזכורות, אנשי קשר, פתקים והודעות',
  files: 'קבצים, תיקיות ושיחות עם סוכני קוד',
  mail: 'מיילים',
};
/** The category of each tool group. Groups not listed (clock, mac, web) carry no personal data. */
export const GROUP_CATEGORY: Record<string, DataCategory | undefined> = {
  memory: 'memory',
  files: 'files',
  mail: 'mail',
  contacts: 'personal',
  calendar: 'personal',
  reminders: 'personal',
  notes: 'personal',
  messages: 'personal',
  agents: 'files',
};

export interface CloudSettings {
  /**
   * 'cloud': conversations are answered in the cloud (the Mac when asked, or when the cloud is down).
   * 'ask': the Mac, and the cloud when the user asks or approves a suggestion. 'local': nothing leaves the Mac.
   */
  mode: 'local' | 'ask' | 'cloud';
  provider: Provider;
  allow: Record<DataCategory, boolean>;
}
export const DEFAULT_CLOUD: CloudSettings = {
  mode: 'ask',
  provider: 'openai',
  allow: { memory: true, personal: true, files: true, mail: true },
};
export function cloudSettings(raw: Partial<CloudSettings> | undefined): CloudSettings {
  return {
    mode: raw?.mode === 'local' || raw?.mode === 'cloud' ? raw.mode : 'ask',
    provider: raw?.provider && PROVIDERS.includes(raw.provider) ? raw.provider : DEFAULT_CLOUD.provider,
    allow: { ...DEFAULT_CLOUD.allow, ...(raw?.allow ?? {}) },
  };
}

export const DEFAULT_MODELS: Record<Provider, string> = { openai: 'gpt-6-luna', anthropic: 'claude-sonnet-5-5' };
export const PROVIDER_NAMES: Record<Provider, string> = { openai: 'OpenAI', anthropic: 'Anthropic' };

/** Display names for the models Brain knows; others are shown as their id. */
const MODEL_NAMES: Record<string, string> = {
  'gpt-6-luna': 'GPT-6 Luna',
  'gpt-6-sol': 'GPT-6 Sol',
  'claude-haiku-5-5': 'Claude Haiku 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
};
export const modelName = (model: string) => MODEL_NAMES[model] ?? model;

/**
 * List prices in USD per million tokens (November 2026), to show what the cloud cost this month.
 * An estimate: the provider's bill is the real number.
 */
const PRICES: Record<string, { input: number; output: number; longInput?: number; longOutput?: number; longFrom?: number }> = {
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'gpt-6-sol': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, longInput: 0.5, longOutput: 2.5, longFrom: 100_000 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
};

export interface CloudStats extends StreamStats {
  inputTokens?: number;
  cachedTokens?: number;
  /** Estimated cost of this request in USD (undefined for a model without a known price). */
  costUsd?: number;
}

export function estimateCost(model: string, input: number, cached: number, output: number, cacheWrite = 0): number | undefined {
  const p = PRICES[model];
  if (!p) return undefined;
  const long = p.longFrom !== undefined && input + cached + cacheWrite > p.longFrom;
  const inPrice = long ? p.longInput! : p.input;
  const outPrice = long ? p.longOutput! : p.output;
  return ((input * inPrice) + (cached * inPrice * 0.1) + (cacheWrite * inPrice * 1.25) + (output * outPrice)) / 1e6;
}

export class CloudError extends OllamaError {}

function httpError(provider: Provider, status: number, body: string): CloudError {
  const name = PROVIDER_NAMES[provider];
  const detail = `${name} HTTP ${status}: ${body.slice(0, 300)}`;
  if (status === 401 || status === 403) {
    return new CloudError(detail, `המפתח של ${name} לא התקבל. במק: npm run cloud:key -- ${provider}`);
  }
  if (status === 429 || /insufficient_quota|credit balance|billing/i.test(body)) {
    return new CloudError(detail, `${name} דחה את הבקשה בגלל מגבלת שימוש או תקרת חיוב. אפשר לנסות שוב בעוד רגע, או לבדוק את החשבון אצל ${name}.`);
  }
  if (status === 400 && /model/i.test(body) && /not.?found|does not exist|invalid/i.test(body)) {
    return new CloudError(detail, `${name} לא מכיר את המודל שנבחר. בדוק את שם המודל בהגדרות.`);
  }
  if (status >= 500) return new CloudError(detail, `${name} לא זמין כרגע. אפשר לנסות שוב, או לכתוב "תחזור למק".`);
  return new CloudError(detail, `${name} החזיר שגיאה. פרטים ביומן השירות.`);
}

// ---------- the conversation, in each provider's shape ----------

interface Call { id: string; name: string; args: Record<string, unknown> }
type Turn =
  | { role: 'system' | 'user'; content: string; images?: string[] }
  | { role: 'assistant'; content: string; calls: Call[] }
  | { role: 'tool'; id: string; name: string; content: string };

/**
 * Brain's history has no call ids, and a call may have no result (a second call dropped while the
 * first waited for approval). Both providers need every call answered by id, right after it.
 */
export function pairCalls(messages: ChatMessage[]): Turn[] {
  const out: Turn[] = [];
  let open: Call[] = [];
  let n = 0;
  const close = () => {
    for (const c of open) out.push({ role: 'tool', id: c.id, name: c.name, content: 'לא בוצע.' });
    open = [];
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      const i = open.findIndex((c) => c.name === m.tool_name);
      const call = i >= 0 ? open.splice(i, 1)[0] : open.shift();
      // A result without a call (should not happen) has nothing to attach to: it is left out.
      if (call) out.push({ role: 'tool', id: call.id, name: call.name, content: m.content || '(ריק)' });
      continue;
    }
    close();
    if (m.role === 'assistant') {
      const calls = (m.tool_calls ?? []).map((c) => ({ id: `call_${++n}`, name: c.function.name, args: c.function.arguments ?? {} }));
      if (!m.content && !calls.length) continue;
      out.push({ role: 'assistant', content: m.content, calls });
      open = [...calls];
    } else {
      out.push({ role: m.role, content: m.content, ...(m.role === 'user' && m.images?.length ? { images: m.images } : {}) });
    }
  }
  close();
  return out;
}

/** The media type of a base64 photo, from its first bytes. */
export function imageType(b64: string): string {
  const head = Buffer.from(b64.slice(0, 24), 'base64');
  if (head[0] === 0x89 && head[1] === 0x50) return 'image/png';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF') return 'image/webp';
  if (head.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  return 'image/jpeg';
}

export function toOpenAI(messages: ChatMessage[]): Record<string, unknown>[] {
  return pairCalls(messages).map((t) => {
    if (t.role === 'tool') return { role: 'tool', tool_call_id: t.id, content: t.content };
    if (t.role === 'assistant') {
      return {
        role: 'assistant',
        content: t.content || null,
        ...(t.calls.length
          ? { tool_calls: t.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
          : {}),
      };
    }
    if (t.role === 'user' && t.images?.length) {
      return {
        role: 'user',
        content: [
          ...t.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${imageType(img)};base64,${img}` } })),
          { type: 'text', text: t.content || '…' },
        ],
      };
    }
    return { role: t.role, content: t.content };
  });
}

type Block = Record<string, unknown>;
export function toAnthropic(messages: ChatMessage[]): { system: string; messages: { role: 'user' | 'assistant'; content: Block[] }[] } {
  const system: string[] = [];
  const out: { role: 'user' | 'assistant'; content: Block[] }[] = [];
  const push = (role: 'user' | 'assistant', block: Block) => {
    const last = out.at(-1);
    // Results of several calls, and the next question, go in one user turn.
    if (last?.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const t of pairCalls(messages)) {
    if (t.role === 'system') system.push(t.content);
    else if (t.role === 'user') {
      for (const img of t.images ?? []) push('user', { type: 'image', source: { type: 'base64', media_type: imageType(img), data: img } });
      push('user', { type: 'text', text: t.content || '…' });
    }
    else if (t.role === 'tool') push('user', { type: 'tool_result', tool_use_id: t.id, content: t.content });
    else if (t.role === 'assistant') {
      if (t.content) push('assistant', { type: 'text', text: t.content });
      for (const c of t.calls) push('assistant', { type: 'tool_use', id: c.id, name: c.name, input: c.args });
    }
  }
  return { system: system.join('\n\n'), messages: out };
}

// ---------- streaming ----------

/** Server-sent events: yields each `data:` payload (and the `event:` name, when there is one). */
async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frame = (raw: string) => {
    let event = '';
    const data: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    return data.length ? { event, data: data.join('\n') } : null;
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const f = frame(buffer.slice(0, i));
      buffer = buffer.slice(i).replace(/^\r?\n\r?\n/, '');
      if (f) yield f;
    }
  }
  const f = frame(buffer);
  if (f) yield f;
}

function parseArgs(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export interface CloudRequest {
  provider: Provider;
  model: string;
  key: string;
  fetch?: typeof fetch;
}
export interface CloudOptions {
  signal?: AbortSignal;
  tools?: ToolSpec[];
  maxTokens?: number;
}

const ENDPOINTS: Record<Provider, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
};

/** Streams a reply from the cloud: the same events as the local model (text pieces, tool calls). */
export async function* streamCloud(req: CloudRequest, messages: ChatMessage[], options: CloudOptions = {}): AsyncGenerator<StreamEvent, CloudStats> {
  const { provider, model, key } = req;
  const doFetch = req.fetch ?? fetch;
  const { signal, tools, maxTokens = 4096 } = options;
  if (!key) throw new CloudError('no key', `אין מפתח של ${PROVIDER_NAMES[provider]}. במק: npm run cloud:key -- ${provider}`);

  let body: Record<string, unknown>;
  let headers: Record<string, string>;
  if (provider === 'openai') {
    headers = { authorization: `Bearer ${key}` };
    body = {
      model,
      messages: toOpenAI(messages),
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: maxTokens,
      // GPT-5/6 models call tools in Chat Completions only without reasoning (OpenAI's model page).
      ...(/^gpt-[56]/.test(model) ? { reasoning_effort: 'none' } : {}),
      ...(tools?.length ? { tools } : {}),
    };
  } else {
    headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    const { system, messages: turns } = toAnthropic(messages);
    body = {
      model,
      max_tokens: maxTokens,
      // The instructions repeat on every request: cached, they cost a tenth.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: turns,
      stream: true,
      ...(tools?.length
        ? { tools: tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) }
        : {}),
    };
  }

  let res: Response;
  try {
    res = await doFetch(ENDPOINTS[provider], {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    });
  } catch (err) {
    if (signal?.aborted) return {};
    throw new CloudError(`${provider}: ${(err as Error).message}`, `אין חיבור ל־${PROVIDER_NAMES[provider]} מהמק. בדוק את האינטרנט במק, או כתוב "תחזור למק".`);
  }
  if (!res.ok || !res.body) throw httpError(provider, res.status, await res.text().catch(() => ''));

  const started = Date.now();
  let firstAt = 0;
  const stats: CloudStats = {};
  const calls = new Map<number, { id: string; name: string; args: string }>();
  try {
    for await (const { event, data } of sse(res.body)) {
      if (data === '[DONE]') break;
      const obj = JSON.parse(data) as Record<string, any>;
      if (obj.error) throw httpError(provider, 500, JSON.stringify(obj.error));
      if (provider === 'openai') {
        const delta = obj.choices?.[0]?.delta;
        if (delta?.content) {
          firstAt ||= Date.now();
          yield { type: 'text', text: delta.content };
        }
        for (const tc of delta?.tool_calls ?? []) {
          const c = calls.get(tc.index ?? 0) ?? { id: '', name: '', args: '' };
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name += tc.function.name;
          if (tc.function?.arguments) c.args += tc.function.arguments;
          calls.set(tc.index ?? 0, c);
        }
        if (obj.usage) {
          const cached = obj.usage.prompt_tokens_details?.cached_tokens ?? 0;
          stats.inputTokens = (obj.usage.prompt_tokens ?? 0) - cached;
          stats.cachedTokens = cached;
          stats.outputTokens = obj.usage.completion_tokens;
          stats.costUsd = estimateCost(model, stats.inputTokens ?? 0, cached, stats.outputTokens ?? 0);
        }
      } else {
        const type = obj.type ?? event;
        if (type === 'message_start') {
          const u = obj.message?.usage ?? {};
          stats.inputTokens = u.input_tokens ?? 0;
          stats.cachedTokens = u.cache_read_input_tokens ?? 0;
          (stats as { cacheWrite?: number }).cacheWrite = u.cache_creation_input_tokens ?? 0;
        } else if (type === 'content_block_start' && obj.content_block?.type === 'tool_use') {
          calls.set(obj.index, { id: obj.content_block.id, name: obj.content_block.name, args: '' });
        } else if (type === 'content_block_delta') {
          if (obj.delta?.type === 'text_delta' && obj.delta.text) {
            firstAt ||= Date.now();
            yield { type: 'text', text: obj.delta.text };
          } else if (obj.delta?.type === 'input_json_delta') {
            const c = calls.get(obj.index);
            if (c) c.args += obj.delta.partial_json ?? '';
          }
        } else if (type === 'message_delta' && obj.usage) {
          stats.outputTokens = obj.usage.output_tokens;
        } else if (type === 'error') {
          throw httpError(provider, 500, JSON.stringify(obj.error ?? obj));
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) return stats;
    if (err instanceof CloudError) throw err;
    throw new CloudError(`${provider} stream: ${(err as Error).message}`, `החיבור ל־${PROVIDER_NAMES[provider]} נקטע באמצע. אפשר לנסות שוב.`);
  }
  if (provider === 'anthropic') {
    stats.costUsd = estimateCost(model, stats.inputTokens ?? 0, stats.cachedTokens ?? 0, stats.outputTokens ?? 0, (stats as { cacheWrite?: number }).cacheWrite ?? 0);
  }
  if (calls.size) {
    yield {
      type: 'tool_calls',
      calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => ({ name: c.name, arguments: parseArgs(c.args) })),
    };
  }
  if (firstAt && stats.outputTokens) {
    const sec = (Date.now() - firstAt) / 1000;
    if (sec > 0.2) stats.tokensPerSecond = stats.outputTokens / sec;
  }
  stats.promptMs = firstAt ? firstAt - started : undefined;
  return stats;
}

/** Checks a key with the provider's free model list (no tokens used). */
export async function checkKey(provider: Provider, key: string, doFetch: typeof fetch = fetch): Promise<string[]> {
  const res = await doFetch(provider === 'openai' ? 'https://api.openai.com/v1/models' : 'https://api.anthropic.com/v1/models?limit=100', {
    headers: provider === 'openai' ? { authorization: `Bearer ${key}` } : { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw httpError(provider, res.status, await res.text().catch(() => ''));
  const data = (await res.json()) as { data?: { id: string }[] };
  return (data.data ?? []).map((m) => m.id);
}

// ---------- when to use the cloud ----------

/** "Answer this in the cloud", "with GPT", "with Claude". */
export const CLOUD_ASK =
  /(?:תעבור|עבור|תענה|ענה|תשתמש|השתמש|תריץ|תעשה|תבדוק|תכתוב|תנסה|נסה|תמשיך)(?: את זה| על זה| לי| את)? (?:ב|ל|דרך ה)ענן(?![א-ת])|^\s*ענן\s*[:,\-–]|(?:תענה|ענה|תעבור|עבור|תשתמש|השתמש)(?: לי)? (?:עם|דרך|ב)[-־ ]?(?:gpt|ג['׳]?י ?פי ?טי|claude|קלוד)(?![a-z])/i;
/** "Back to the Mac", "local only", "without the cloud". */
export const LOCAL_ASK = /(?:תחזור|חזור|תעבור|עבור|תענה|ענה|תמשיך|המשך)(?: את זה| לי)? (?:ל|ב)מק(?![א-ת])|במק בלבד|מקומי בלבד|בלי (?:ה)?ענן(?![א-ת])/;
/**
 * Requests where a small local model often falls short: summaries, analysis, comparisons, planning and
 * longer writing. The cloud is only suggested (with a card); the user decides.
 */
const COMPLEX =
  /(?:^|[\s,.])(?:תסכם|לסכם|סכם|סיכום|תנתח|לנתח|נתח|ניתוח|תשווה|להשוות|השוואה|תתכנן|לתכנן|תכנן|צעד אחר צעד|לעומק|מפורט|מפורטת|(?:תכתוב|תנסח|כתוב|נסח)(?: לי)? (?:מכתב|מסמך|מאמר|חיבור|נאום|קורות חיים|הצעה|פוסט|סיפור|תוכנית|מייל רשמי))/;
export function isComplex(text: string): boolean {
  return text.length > 600 || COMPLEX.test(text);
}
