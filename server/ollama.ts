export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
  /** Photos, base64 (JPEG/PNG/WebP/GIF), for a model that can see them. */
  images?: string[];
}

/** For a model that can't see photos: the photos are left out, and the model is told so. */
export function withoutImages(messages: ChatMessage[], model: string): ChatMessage[] {
  return messages.map((m) =>
    m.images?.length
      ? { ...m, images: undefined, content: `${m.content}\n[${m.images.length === 1 ? 'צורפה תמונה' : `צורפו ${m.images.length} תמונות`}, אבל המודל ${model} לא רואה תמונות. אפשר לבחור מודל שרואה תמונות בהגדרות, או לכתוב "תעבור לענן".]` }
      : m,
  );
}

export interface StreamStats {
  promptTokens?: number;
  /** Time Ollama spent reading the prompt (low when its cache was reused). */
  promptMs?: number;
  outputTokens?: number;
  /** Output tokens per second, as measured by Ollama. */
  tokensPerSecond?: number;
  /** It stopped at the length limit (maxTokens), not because the answer was done. */
  truncated?: boolean;
}

export class OllamaError extends Error {
  /** Hebrew message that is safe to show to the user. */
  userMessage: string;
  constructor(message: string, userMessage: string) {
    super(message);
    this.userMessage = userMessage;
  }
}

function toOllamaError(err: unknown, baseUrl: string, model: string): OllamaError {
  if (err instanceof OllamaError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
  if (/ECONNREFUSED|fetch failed/i.test(msg + cause)) {
    return new OllamaError(`Ollama unreachable at ${baseUrl}: ${msg}`, 'Ollama לא רץ במק. פתח את אפליקציית Ollama ונסה שוב.');
  }
  if (/not found/i.test(msg)) {
    return new OllamaError(msg, `המודל ${model} לא מותקן. הרץ במק: ollama pull ${model}`);
  }
  return new OllamaError(msg, 'המודל המקומי החזיר שגיאה. פרטים ביומן השירות.');
}

function cloudTag(name: string) {
  return /(?:^|[:-])cloud(?:$|[:/-])/i.test(name);
}

/** Check the current model descriptor before transmitting any conversation.
 * A local Ollama installation can also register cloud-backed aliases. */
export async function modelCapabilities(baseUrl: string, model: string): Promise<string[]> {
  const remote = () => new OllamaError('Remote model in local mode', 'המודל הזה פועל בענן. בחר מודל מקומי בהגדרות.');
  if (cloudTag(model)) throw remote();
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (res.status === 404) throw new Error('model not found');
    if (!res.ok) throw new Error('Model descriptor unavailable');
    const data = await res.json() as { capabilities?: string[]; remote_model?: string; remote_host?: string };
    if (data.remote_model || data.remote_host) throw remote();
    return data.capabilities ?? [];
  } catch (err) {
    throw toOllamaError(err, baseUrl, model);
  }
}

/**
 * Extra request fields for a model. Thinking models spend hundreds of hidden tokens "thinking"
 * before answering; for everyday chat that is pure delay, so it is off unless asked for.
 */
export async function modelOptions(baseUrl: string, model: string, think = false) {
  const caps = await modelCapabilities(baseUrl, model);
  return { extra: caps.includes('thinking') ? { think } : {}, vision: caps.includes('vision') };
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface StreamOptions {
  signal?: AbortSignal;
  keepAlive?: string;
  think?: boolean;
  tools?: ToolSpec[];
  /** Context window in tokens. Ollama's default is small; long files need more. */
  contextLength?: number;
  /** Stop after this many output tokens (used to warm the cache without a real answer). */
  maxTokens?: number;
  /** Sampling temperature (does not affect what Ollama can reuse from its cache). */
  temperature?: number;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; calls: { name: string; arguments: Record<string, unknown> }[] };

/**
 * Streams the assistant's reply: text pieces as they arrive, and tool calls when the model asks for them.
 * Returns usage stats when done.
 */
export async function* streamChat(
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  options: StreamOptions = {},
): AsyncGenerator<StreamEvent, StreamStats> {
  const { signal, keepAlive, think, tools, contextLength, maxTokens, temperature } = options;
  let res: Response;
  try {
    const { extra, vision } = await modelOptions(baseUrl, model, think);
    res = await fetch(`${baseUrl}/api/chat`, {
      redirect: 'error',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: vision ? messages : withoutImages(messages, model),
        stream: true,
        ...extra,
        ...(tools?.length ? { tools } : {}),
        ...(keepAlive ? { keep_alive: keepAlive } : {}),
        ...(contextLength || maxTokens || temperature !== undefined
          ? {
              options: {
                ...(contextLength ? { num_ctx: contextLength } : {}),
                ...(maxTokens ? { num_predict: maxTokens } : {}),
                ...(temperature !== undefined ? { temperature } : {}),
              },
            }
          : {}),
      }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return {};
    throw toOllamaError(err, baseUrl, model);
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw toOllamaError(new Error(`HTTP ${res.status}: ${text}`), baseUrl, model);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stats: StreamStats = {};

  const handle = (line: string): StreamEvent[] => {
    if (!line.trim()) return [];
    const obj = JSON.parse(line) as {
      error?: string;
      done?: boolean;
      message?: {
        content?: string;
        tool_calls?: { function: { name: string; arguments: Record<string, unknown> | string } }[];
      };
      prompt_eval_count?: number;
      prompt_eval_duration?: number;
      eval_count?: number;
      eval_duration?: number;
      done_reason?: string;
    };
    if (obj.error) throw toOllamaError(new Error(obj.error), baseUrl, model);
    if (obj.done) {
      stats = {
        promptTokens: obj.prompt_eval_count,
        promptMs: obj.prompt_eval_duration !== undefined ? Math.round(obj.prompt_eval_duration / 1e6) : undefined,
        outputTokens: obj.eval_count,
        tokensPerSecond:
          obj.eval_count && obj.eval_duration ? obj.eval_count / (obj.eval_duration / 1e9) : undefined,
        ...(obj.done_reason === 'length' ? { truncated: true } : {}),
      };
    }
    const events: StreamEvent[] = [];
    if (obj.message?.content) events.push({ type: 'text', text: obj.message.content });
    if (obj.message?.tool_calls?.length) {
      events.push({
        type: 'tool_calls',
        calls: obj.message.tool_calls.map((t) => ({
          name: t.function.name,
          arguments:
            typeof t.function.arguments === 'string' ? safeJson(t.function.arguments) : (t.function.arguments ?? {}),
        })),
      });
    }
    return events;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        yield* handle(line);
      }
    }
    yield* handle(buffer);
  } catch (err) {
    if (signal?.aborted) return stats;
    throw toOllamaError(err, baseUrl, model);
  }
  return stats;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * Loads the model into memory ahead of the first question, so the first reply is not slowed by loading.
 * Returns true if the model is loaded.
 */
export async function warmUp(baseUrl: string, model: string, keepAlive: string, contextLength?: number): Promise<boolean> {
  try {
    await modelCapabilities(baseUrl, model);
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Same context length as chat requests, otherwise Ollama reloads the model on the first question.
      body: JSON.stringify({ model, keep_alive: keepAlive, ...(contextLength ? { options: { num_ctx: contextLength } } : {}) }),
      signal: AbortSignal.timeout(120_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Models currently loaded in memory, or null if Ollama is unreachable. */
export async function loadedModels(baseUrl: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: { name?: string; model?: string }[] };
    return (data.models ?? []).map((m) => m.name ?? m.model ?? '');
  } catch {
    return null;
  }
}

/** Lists installed model tags, or null if Ollama is unreachable. */
export async function listModels(baseUrl: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: { name: string; remote_model?: string; remote_host?: string }[] };
    return (data.models ?? []).filter(m => !cloudTag(m.name) && !m.remote_model && !m.remote_host).map(m => m.name);
  } catch {
    return null;
  }
}
