'use strict';

/**
 * Keyless web-search backends, mirroring the providers OpenCode's `WebSearch`
 * service registers with no API key configured.
 *
 * Verified against the OpenCode 2.x bundle (`@opencode/WebSearch`), which talks
 * to exactly these three endpoints in keyless mode:
 *
 *   - Tavily    POST https://api.tavily.com/search          (X-Tavily-Access-Mode: keyless)
 *   - TinyFish  POST https://agent.tinyfish.ai/mcp          (X-TinyFish-Access-Mode: keyless, MCP)
 *   - Exa       POST https://mcp.exa.ai/mcp                 (MCP, no key param)
 *
 * The module is deliberately dependency-free plain CommonJS so it can be unit
 * tested with bare `node` and required from a DSH plugin without any build step.
 *
 * @module dsh-websearch-keyless/providers
 */

const USER_AGENT = 'opencode/1.0';

const ENDPOINTS = {
  tavily: 'https://api.tavily.com/search',
  tinyfish: 'https://agent.tinyfish.ai/mcp',
  exa: 'https://mcp.exa.ai/mcp',
};

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RESULTS = 8;
const MAX_RESULTS_LIMIT = 20;

/** Clamp a requested result count into the range the backends accept. */
function clampResults(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_RESULTS;
  const count = Math.floor(value);
  if (count < 1) return 1;
  return Math.min(count, MAX_RESULTS_LIMIT);
}

/** Return a trimmed string, or undefined when there is nothing useful. */
function cleanText(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build one provider-neutral `WebSearchSource`.
 * @see WebSearchSource in @deepseek-ai/dsh-web/types
 */
function toSource(url, title, snippet, publishedAt) {
  const href = cleanText(url);
  if (href === undefined) return undefined;
  const source = { url: href };
  const cleanTitle = cleanText(title);
  if (cleanTitle !== undefined) source.title = cleanTitle;
  const cleanSnippet = cleanText(snippet);
  if (cleanSnippet !== undefined) source.snippet = cleanSnippet;
  const cleanPublished = cleanText(publishedAt);
  if (cleanPublished !== undefined && cleanPublished !== 'N/A') source.publishedAt = cleanPublished;
  return source;
}

/** Abort-aware POST that returns the decoded body text and rejects on non-2xx. */
async function postJSON(url, body, headers, options) {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} responded HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return text;
}

/**
 * Decode an MCP reply that may arrive as plain JSON or as an SSE stream
 * (`event: message` + `data: {...}`), which is what both MCP endpoints send.
 */
function parseMcpResponse(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  for (const line of trimmed.split(/\r?\n/)) {
    const match = /^data:\s*(.*)$/.exec(line.trim());
    if (match === null) continue;
    const data = match[1].trim();
    if (data.length === 0 || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed !== null && typeof parsed === 'object' && (parsed.result !== undefined || parsed.error !== undefined)) {
        return parsed;
      }
    } catch {
      /* Not a complete JSON frame; keep scanning the stream. */
    }
  }
  return JSON.parse(trimmed);
}

/** Pull the first text content block out of an MCP tool result. */
function mcpText(payload) {
  if (payload !== null && typeof payload === 'object' && payload.error !== undefined) {
    const error = payload.error;
    const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
      ? error.message
      : JSON.stringify(error);
    throw new Error(`MCP error: ${message}`);
  }
  const content = payload?.result?.content;
  if (!Array.isArray(content)) return undefined;
  const block = content.find((entry) => entry !== null && typeof entry === 'object'
    && entry.type === 'text' && typeof entry.text === 'string');
  return block?.text;
}

/** Tavily's keyless `basic` search. */
async function searchTavily(request, options) {
  const text = await postJSON(ENDPOINTS.tavily, {
    query: request.query,
    search_depth: 'basic',
    chunks_per_source: 3,
    max_results: clampResults(request.maxResults),
  }, {
    'X-Tavily-Access-Mode': 'keyless',
    'X-Client-Name': 'opencode2',
  }, options);
  const data = JSON.parse(text);
  const results = Array.isArray(data?.results) ? data.results : [];
  return {
    sources: results.map((entry) => toSource(entry?.url, entry?.title, entry?.content)).filter(Boolean),
    answer: cleanText(data?.answer),
  };
}

/** TinyFish's keyless MCP `search` tool. */
async function searchTinyfish(request, options) {
  const text = await postJSON(ENDPOINTS.tinyfish, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'search', arguments: { query: request.query } },
  }, {
    Accept: 'application/json, text/event-stream',
    'X-TinyFish-Access-Mode': 'keyless',
  }, options);
  const payload = mcpText(parseMcpResponse(text));
  if (payload === undefined) return { sources: [] };
  const data = JSON.parse(payload);
  const results = Array.isArray(data?.results) ? data.results : [];
  return {
    sources: results.map((entry) => toSource(entry?.url, entry?.title, entry?.snippet, entry?.date)).filter(Boolean),
  };
}

/**
 * Decode Exa's MCP text block: one block per result, separated by `---`, with
 * `Title:` / `URL:` / `Published:` / `Highlights:` fields.
 */
function parseExaBlocks(text) {
  return text.split(/\n\n---\n\n/).flatMap((block) => {
    const url = /^URL:\s*(.+)$/m.exec(block)?.[1];
    const title = /^Title:\s*(.+)$/m.exec(block)?.[1];
    const published = /^Published:\s*(.+)$/m.exec(block)?.[1];
    const snippet = /^(?:Highlights|Text):\s*(?:\n)?([\s\S]*)$/m.exec(block)?.[1];
    const source = toSource(url, title, snippet, published);
    return source === undefined ? [] : [source];
  });
}

/** Exa's keyless MCP `web_search_exa` tool. */
async function searchExa(request, options) {
  const text = await postJSON(ENDPOINTS.exa, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'web_search_exa',
      arguments: { query: request.query, numResults: clampResults(request.maxResults) },
    },
  }, {
    Accept: 'application/json, text/event-stream',
  }, options);
  const payload = mcpText(parseMcpResponse(text));
  if (payload === undefined) return { sources: [] };
  return { sources: parseExaBlocks(payload) };
}

/** Priority order: first backend that yields a source wins. */
const PROVIDERS = [
  { id: 'tavily-keyless', search: searchTavily },
  { id: 'tinyfish-keyless', search: searchTinyfish },
  { id: 'exa-keyless', search: searchExa },
];

/**
 * Run one query through the keyless backends in order.
 *
 * Falls through to the next backend on transport errors, HTTP failures, empty
 * result sets, and timeouts. Only rejects when every backend failed for a
 * reason (rather than legitimately returning nothing).
 *
 * @returns {Promise<{provider?: string, sources: object[], answer?: string,
 *   failures: {provider: string, message: string}[], attempted: number, errored: number}>}
 */
async function searchKeyless(request, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const backends = options.providers ?? PROVIDERS;
  const failures = [];
  let attempted = 0;
  let errored = 0;

  for (const provider of backends) {
    if (options.signal?.aborted) throw abortError();
    attempted += 1;
    try {
      const outcome = await provider.search(request, { signal: options.signal, timeoutMs });
      if (outcome.sources.length > 0) {
        return { provider: provider.id, sources: outcome.sources, answer: outcome.answer, failures, attempted, errored };
      }
      failures.push({ provider: provider.id, message: 'returned no results' });
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      errored += 1;
      failures.push({ provider: provider.id, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return { provider: undefined, sources: [], answer: undefined, failures, attempted, errored };
}

/** A cancellation error carrying the web seam's abort code. */
function abortError() {
  const error = new Error('keyless web search aborted');
  error.code = 'WEB_ABORTED';
  return error;
}

module.exports = {
  DEFAULT_MAX_RESULTS,
  DEFAULT_TIMEOUT_MS,
  ENDPOINTS,
  MAX_RESULTS_LIMIT,
  PROVIDERS,
  abortError,
  clampResults,
  parseExaBlocks,
  parseMcpResponse,
  searchExa,
  searchKeyless,
  searchTavily,
  searchTinyfish,
  toSource,
};
