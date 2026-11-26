/**
 * The internet, from the Mac: search (Tavily when a key is set, otherwise DuckDuckGo's plain HTML page)
 * and reading pages. Only the search words and the page address leave the Mac.
 * Pages on the Mac itself or the home network are never fetched (a page could try to make Brain read
 * them), and page text reaches the model marked as outside content.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { htmlToText } from './google.ts';

export class WebError extends Error {
  userMessage: string;
  constructor(message: string, userMessage: string) {
    super(message);
    this.userMessage = userMessage;
  }
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const PAGE_CHARS = 7000;

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();

/** Results from DuckDuckGo's HTML page (html.duckduckgo.com), without ads. */
export function parseDuckDuckGo(html: string, max = 6): SearchResult[] {
  const attr = (attrs: string, name: string) => attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '';
  const links = [...html.matchAll(/<a([^>]*class="result__a"[^>]*)>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/<(?:a|div)([^>]*class="result__snippet"[^>]*)>([\s\S]*?)<\/(?:a|div)>/g)];
  const out: SearchResult[] = [];
  links.forEach((m, i) => {
    let href = attr(m[1], 'href').replace(/&amp;/g, '&');
    if (href.startsWith('//')) href = `https:${href}`;
    try {
      const u = new URL(href);
      if (u.hostname.endsWith('duckduckgo.com')) {
        if (u.pathname.startsWith('/y.js')) return; // an ad
        const target = u.searchParams.get('uddg');
        if (!target) return;
        href = target;
      }
    } catch {
      return;
    }
    if (!/^https?:\/\//.test(href)) return;
    out.push({ title: decode(m[2]), url: href, snippet: decode(snippets[i]?.[2] ?? '') });
  });
  return out.slice(0, max);
}

/** Loopback, private, link-local, CGNAT (Tailscale) and similar addresses: never fetched. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

export interface WebOptions {
  tavilyKey?: string;
  /** Replaces fetch (tests). */
  fetch?: typeof fetch;
  /** Replaces the DNS check (tests). */
  resolveHost?: (host: string) => Promise<string[]>;
}

export function createWeb(o: WebOptions = {}) {
  const f = o.fetch ?? fetch;
  const resolveHost = o.resolveHost ?? (async (host: string) => (await lookup(host, { all: true })).map((a) => a.address));
  const offline = (err: unknown) => new WebError(String(err), 'אין חיבור לאינטרנט מהמק כרגע. נסה שוב עוד רגע.');

  async function safeUrl(raw: string): Promise<URL> {
    let u: URL;
    try {
      u = new URL(raw.trim());
    } catch {
      throw new WebError('bad url', `"${raw}" זו לא כתובת אינטרנט.`);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new WebError('protocol', 'אפשר לקרוא רק עמודי http או https.');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (/^(localhost|.*\.local|.*\.internal|.*\.ts\.net)$/i.test(host)) throw new WebError('private', 'זו כתובת ברשת הביתית, לא באינטרנט.');
    const addresses = isIP(host) ? [host] : await resolveHost(host).catch(() => []);
    if (!addresses.length) throw new WebError('dns', `לא מצאתי את האתר ${host}.`);
    if (addresses.some(isPrivateAddress)) throw new WebError('private', 'זו כתובת ברשת הביתית, לא באינטרנט.');
    return u;
  }

  /** Tavily when there is a key; if it fails (quota, network), DuckDuckGo from the Mac. */
  async function search(query: string): Promise<{ results: SearchResult[]; answer?: string; via: string }> {
    if (o.tavilyKey) {
      try {
        return await tavily(query);
      } catch (err) {
        const fallback = await duckDuckGo(query).catch(() => null);
        if (fallback?.results.length) return fallback;
        throw err;
      }
    }
    return duckDuckGo(query);
  }

  async function tavily(query: string): Promise<{ results: SearchResult[]; answer?: string; via: string }> {
    const res = await f('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${o.tavilyKey}` },
      body: JSON.stringify({ query, max_results: 6, search_depth: 'basic', include_answer: true }),
      signal: AbortSignal.timeout(20_000),
    }).catch((e) => {
      throw offline(e);
    });
    const data = (await res.json().catch(() => ({}))) as {
      answer?: string; results?: { title?: string; url?: string; content?: string }[]; detail?: { error?: string };
    };
    if (res.status === 401 || res.status === 403) throw new WebError('tavily auth', 'מפתח החיפוש (Tavily) לא תקין. בדוק אותו במק: npm run web:key');
    if (res.status === 429 || res.status === 432) throw new WebError('tavily quota', 'נגמרו החיפושים החודשיים ב־Tavily.');
    if (!res.ok) throw new WebError(`tavily ${res.status}`, 'החיפוש באינטרנט נכשל. נסה שוב עוד רגע.');
    return {
      via: 'Tavily',
      answer: data.answer || undefined,
      results: (data.results ?? []).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: (r.content ?? '').replace(/\s+/g, ' ').slice(0, 400) })),
    };
  }

  async function duckDuckGo(query: string): Promise<{ results: SearchResult[]; answer?: string; via: string }> {
    const res = await f(`https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query, kl: 'wt-wt' })}`, {
      headers: { 'user-agent': UA, 'accept-language': 'he,en;q=0.8' },
      signal: AbortSignal.timeout(15_000),
    }).catch((e) => {
      throw offline(e);
    });
    if (!res.ok) throw new WebError(`ddg ${res.status}`, 'מנוע החיפוש לא ענה. אפשר לחבר מפתח Tavily לחיפוש יציב יותר: npm run web:key');
    const results = parseDuckDuckGo(await res.text());
    return { via: 'DuckDuckGo', results };
  }

  async function fetchPage(raw: string): Promise<{ url: string; title: string; text: string }> {
    let url = await safeUrl(raw);
    let res: Response | undefined;
    for (let hop = 0; hop < 5; hop++) {
      res = await f(url, {
        redirect: 'manual',
        headers: { 'user-agent': UA, 'accept-language': 'he,en;q=0.8', accept: 'text/html,text/plain,*/*;q=0.5' },
        signal: AbortSignal.timeout(15_000),
      }).catch((e) => {
        throw offline(e);
      });
      const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!next) break;
      url = await safeUrl(new URL(next, url).toString()); // every hop is checked again
    }
    if (!res || !res.ok) throw new WebError(`http ${res?.status}`, `האתר החזיר שגיאה (${res?.status ?? '?'}).`);
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/|html|xml|json/.test(type)) throw new WebError('type', 'זה לא עמוד טקסט (אולי קובץ או תמונה).');
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size > MAX_PAGE_BYTES) {
        await reader.cancel();
        break;
      }
    }
    const raw8 = Buffer.concat(chunks).toString('utf8');
    const title = decode(raw8.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
    const body = /html/.test(type)
      ? htmlToText(raw8.replace(/<(nav|header|footer|aside|form|svg|noscript)[\s\S]*?<\/\1>/gi, ' '))
      : raw8;
    const text = body.replace(/\n{3,}/g, '\n\n').trim();
    return { url: url.toString(), title, text: text.length > PAGE_CHARS ? `${text.slice(0, PAGE_CHARS)}\n…(העמוד קוצר)` : text };
  }

  return { search, fetchPage, via: () => (o.tavilyKey ? 'Tavily' : 'DuckDuckGo') };
}

export type Web = ReturnType<typeof createWeb>;
