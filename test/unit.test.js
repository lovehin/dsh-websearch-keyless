'use strict';

/**
 * Offline test suite — no network access, safe for CI.
 *
 *   node --test test/unit.test.js
 *
 * Covers the parsing and fallback logic in lib/providers.js against fixtures
 * captured from the live backends, plus the Cordis plugin contract.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const plugin = require('../lib/index.js');
const {
  clampResults,
  parseExaBlocks,
  parseMcpResponse,
  searchKeyless,
  toSource,
} = require('../lib/providers.js');

// ---------------------------------------------------------------------------
// fixtures — trimmed from real responses
// ---------------------------------------------------------------------------

const TINYFISH_SSE = [
  'event: message',
  `data: {"result":{"content":[{"type":"text","text":"{\\n  \\"query\\": \\"x\\",\\n  \\"results\\": [{\\"position\\": 1, \\"site_name\\": \\"github.com\\", \\"snippet\\": \\"s1\\", \\"title\\": \\"t1\\", \\"url\\": \\"https://a.example\\"}]\\n}"}]}}`,
  '',
].join('\n');

const EXA_TEXT = [
  'Title: First result',
  'URL: https://a.example',
  'Published: N/A',
  'Author: N/A',
  'Highlights:',
  'body one',
  '',
  '---',
  '',
  'Title: Second result',
  'URL: https://b.example',
  'Published: Aug 12, 2026',
  'Author: N/A',
  'Highlights:',
  'body two',
].join('\n');

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('clampResults bounds the requested count', () => {
  assert.equal(clampResults(undefined), 8);
  assert.equal(clampResults(Number.NaN), 8);
  assert.equal(clampResults(0), 1);
  assert.equal(clampResults(-5), 1);
  assert.equal(clampResults(3.9), 3);
  assert.equal(clampResults(9999), 20);
});

test('toSource drops empty fields and an N/A publication date', () => {
  assert.equal(toSource(undefined, 't', 's'), undefined);
  assert.equal(toSource('   ', 't', 's'), undefined);
  assert.deepEqual(toSource('https://a.example', undefined, ''), { url: 'https://a.example' });
  assert.deepEqual(toSource('https://a.example', ' t ', ' s '), {
    url: 'https://a.example',
    title: 't',
    snippet: 's',
  });
  assert.deepEqual(toSource('https://a.example', 't', 's', 'N/A'), {
    url: 'https://a.example',
    title: 't',
    snippet: 's',
  });
  assert.deepEqual(toSource('https://a.example', 't', 's', 'Aug 12, 2026'), {
    url: 'https://a.example',
    title: 't',
    snippet: 's',
    publishedAt: 'Aug 12, 2026',
  });
});

test('parseMcpResponse accepts plain JSON and SSE frames', () => {
  assert.deepEqual(parseMcpResponse('{"result":{"content":[]}}'), { result: { content: [] } });
  assert.deepEqual(parseMcpResponse('event: message\ndata: {"result":{"ok":1}}\n'), { result: { ok: 1 } });
  // Frames that are not complete JSON must be skipped, not fatal.
  assert.deepEqual(parseMcpResponse('data: not-json\ndata: {"result":{}}\n'), { result: {} });
});

test('parseExaBlocks splits the "---" separated result blocks', () => {
  const sources = parseExaBlocks(EXA_TEXT);
  assert.equal(sources.length, 2);
  assert.deepEqual(sources[0], {
    url: 'https://a.example',
    title: 'First result',
    snippet: 'body one',
  });
  assert.deepEqual(sources[1], {
    url: 'https://b.example',
    title: 'Second result',
    snippet: 'body two',
    publishedAt: 'Aug 12, 2026',
  });
});

test('parseExaBlocks ignores blocks without a URL', () => {
  assert.deepEqual(parseExaBlocks('Title: orphan\nHighlights:\nnothing'), []);
});

// ---------------------------------------------------------------------------
// fallback pipeline
// ---------------------------------------------------------------------------

/** A stub backend that records its calls. */
function stub(id, behaviour) {
  return {
    id,
    calls: 0,
    async search() {
      this.calls += 1;
      return behaviour();
    },
  };
}

const request = { query: 'test' };

test('searchKeyless uses the first backend that yields a source', async () => {
  const first = stub('first', () => ({ sources: [] }));
  const second = stub('second', () => ({ sources: [{ url: 'https://b.example' }] }));
  const third = stub('third', () => ({ sources: [{ url: 'https://c.example' }] }));

  const outcome = await searchKeyless(request, { providers: [first, second, third] });

  assert.equal(outcome.provider, 'second');
  assert.deepEqual(outcome.sources, [{ url: 'https://b.example' }]);
  assert.equal(first.calls, 1);
  assert.equal(second.calls, 1);
  assert.equal(third.calls, 0, 'later backends must not be contacted after a hit');
});

test('searchKeyless falls through on a thrown error', async () => {
  const failing = stub('failing', () => {
    throw new Error('boom');
  });
  const working = stub('working', () => ({ sources: [{ url: 'https://ok.example' }] }));

  const outcome = await searchKeyless(request, { providers: [failing, working] });

  assert.equal(outcome.provider, 'working');
  assert.equal(outcome.errored, 1);
  assert.deepEqual(outcome.failures, [{ provider: 'failing', message: 'boom' }]);
});

test('searchKeyless reports every backend failing', async () => {
  const a = stub('a', () => {
    throw new Error('a down');
  });
  const b = stub('b', () => {
    throw new Error('b down');
  });

  const outcome = await searchKeyless(request, { providers: [a, b] });

  assert.equal(outcome.provider, undefined);
  assert.deepEqual(outcome.sources, []);
  assert.equal(outcome.attempted, 2);
  assert.equal(outcome.errored, 2);
});

test('searchKeyless distinguishes "no results" from "all errored"', async () => {
  const a = stub('a', () => ({ sources: [] }));
  const b = stub('b', () => ({ sources: [] }));

  const outcome = await searchKeyless(request, { providers: [a, b] });

  assert.equal(outcome.attempted, 2);
  assert.equal(outcome.errored, 0, 'empty results are not failures');
  assert.deepEqual(
    outcome.failures.map((failure) => failure.message),
    ['returned no results', 'returned no results'],
  );
});

test('searchKeyless rejects immediately on an aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  const a = stub('a', () => ({ sources: [{ url: 'https://a.example' }] }));

  await assert.rejects(
    () => searchKeyless(request, { providers: [a], signal: controller.signal }),
    (error) => error.code === 'WEB_ABORTED',
  );
  assert.equal(a.calls, 0, 'an aborted request must not contact any backend');
});

// ---------------------------------------------------------------------------
// plugin contract
// ---------------------------------------------------------------------------

function fakeContext() {
  const registered = [];
  return {
    registered,
    web: {
      registerSearchProvider(provider) {
        registered.push(provider);
        return () => {};
      },
    },
  };
}

test('apply() registers exactly one provider on ctx.web', () => {
  const ctx = fakeContext();
  plugin.apply(ctx);

  assert.equal(ctx.registered.length, 1);
  assert.equal(ctx.registered[0].id, plugin.PROVIDER_ID);
});

test('the provider reports cheap synchronous availability', () => {
  const ctx = fakeContext();
  plugin.apply(ctx);

  assert.equal(ctx.registered[0].available(), true);
  assert.equal(typeof ctx.registered[0].available(), 'boolean');
});

test('an empty query rejects with WEB_PROVIDER_ERROR', async () => {
  const ctx = fakeContext();
  plugin.apply(ctx);

  for (const query of ['', '   ', undefined]) {
    await assert.rejects(
      () => ctx.registered[0].search({ query }),
      (error) => error.code === 'WEB_PROVIDER_ERROR',
    );
  }
});

test('an aborted signal rejects with WEB_ABORTED', async () => {
  const ctx = fakeContext();
  plugin.apply(ctx);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => ctx.registered[0].search({ query: 'anything' }, controller.signal),
    (error) => error.code === 'WEB_ABORTED',
  );
});
