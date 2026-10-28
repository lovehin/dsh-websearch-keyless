'use strict';

/**
 * dsh-websearch-keyless — register OpenCode's keyless web-search backends as a
 * DeepSeek Harness `ctx.web` search provider.
 *
 * Why this exists: OpenCode's `WebSearch` service ships five providers, three of
 * which run with no API key at all (Tavily keyless, TinyFish keyless, Exa MCP).
 * A DSH profile without a usable search provider falls back on
 * `@deepseek-ai/dsh-web-search-deepseek`, which answers through the DeepSeek
 * chat API and fails outright when that key is absent or invalid.
 *
 * Deliberate constraints, both required by the DSH 0.2.1-rc.3 loader:
 *
 *   1. No `@deepseek-ai/*` imports and no DSH peer dependencies in package.json.
 *      The plugin-compatibility gate (`evaluatePluginCompatibility`) refuses any
 *      manifest whose declared DSH requirements the running runtime does not
 *      satisfy; declaring none means nothing can be unmet.
 *   2. Plain CommonJS with no build step, so it installs with a bare `link:`.
 *
 * Wire-up lives in cordis.patch.yml: it points the `web` service at the
 * `opencode-keyless` provider id registered here.
 *
 * @module dsh-websearch-keyless
 */

const { searchKeyless } = require('./providers.js');

/** Provider id selected by the profile patch layer. */
const PROVIDER_ID = 'opencode-keyless';

/** Turn any failure into a web-seam error with a routable code. */
function webProviderError(message, cause) {
  const error = new Error(message);
  error.code = 'WEB_PROVIDER_ERROR';
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * A `WebSearchProvider` over the keyless backends.
 * @see WebSearchProvider in @deepseek-ai/dsh-web/types
 */
class KeylessSearchProvider {
  /** @param {(message: string) => void} [onServed] Optional diagnostic sink. */
  constructor(onServed) {
    this.id = PROVIDER_ID;
    this.onServed = onServed;
  }

  /**
   * Availability is a cheap local check and must never touch the network.
   * Every backend here is keyless, so the provider is always usable.
   */
  available() {
    return true;
  }

  /**
   * @param {{query: string, maxResults?: number}} request
   * @param {AbortSignal} [signal]
   * @returns {Promise<{sources: object[], truncated: boolean, content?: string}>}
   */
  async search(request, signal) {
    const query = typeof request?.query === 'string' ? request.query.trim() : '';
    if (query.length === 0) throw webProviderError('web_search requires a non-empty query');

    const maxResults = Number.isFinite(request?.maxResults)
      ? Math.max(1, Math.floor(request.maxResults))
      : undefined;

    let outcome;
    try {
      outcome = await searchKeyless({ query, maxResults }, { signal });
    } catch (error) {
      if (error?.code === 'WEB_ABORTED') throw error;
      throw webProviderError(error instanceof Error ? error.message : String(error), error);
    }

    if (outcome.sources.length === 0 && outcome.attempted > 0 && outcome.errored === outcome.attempted) {
      const detail = outcome.failures.map((failure) => `${failure.provider}: ${failure.message}`).join('; ');
      throw webProviderError(`all keyless search backends failed (${detail})`);
    }

    const sources = maxResults === undefined ? outcome.sources : outcome.sources.slice(0, maxResults);
    if (outcome.provider !== undefined) {
      this.onServed?.(`served "${query}" via ${outcome.provider} (${sources.length} sources)`);
    }

    return {
      sources,
      truncated: sources.length < outcome.sources.length,
      ...(outcome.answer === undefined ? {} : { content: outcome.answer }),
    };
  }
}

/** Cordis plugin name used in loader diagnostics. */
exports.name = 'web-search-opencode-keyless';

/** The `web` capability seam is the only service this plugin needs. */
exports.inject = ['web'];

/** Register the provider on the `web` service; the fiber owns its disposal. */
exports.apply = function apply(ctx) {
  const log = (message) => {
    try {
      ctx.logger?.info?.(`[${PROVIDER_ID}] ${message}`);
    } catch {
      /* Logging must never break a search. */
    }
  };
  ctx.web.registerSearchProvider(new KeylessSearchProvider(log));
};

exports.KeylessSearchProvider = KeylessSearchProvider;
exports.PROVIDER_ID = PROVIDER_ID;
