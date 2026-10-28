'use strict';

/**
 * Live smoke test — performs real network calls.
 *
 *   node test/live.js              # one search through the plugin
 *   node test/live.js --backends   # probe every backend individually first
 *
 * Not part of CI: the keyless endpoints are shared, rate-limited third-party
 * services, so this is a manual check rather than a gate.
 */

const assert = require('node:assert/strict');

const plugin = require('../lib/index.js');
const providers = require('../lib/providers.js');

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

async function probeBackend(id, search) {
  const startedAt = Date.now();
  try {
    const outcome = await search({ query: 'DeepSeek Harness', maxResults: 3 }, { timeoutMs: 25000 });
    const first = outcome.sources[0];
    console.log(
      `  ${id.padEnd(17)} OK   ${String(outcome.sources.length).padStart(2)} sources  `
      + `${Date.now() - startedAt}ms  ${first ? first.url : '(no url)'}`,
    );
    return true;
  } catch (error) {
    console.log(`  ${id.padEnd(17)} FAIL ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function main() {
  if (process.argv.includes('--backends')) {
    console.log('=== live backends ===');
    let healthy = 0;
    for (const backend of providers.PROVIDERS) {
      if (await probeBackend(backend.id, backend.search)) healthy += 1;
    }
    assert.ok(healthy > 0, 'at least one backend must answer');
    console.log(`  ${healthy}/${providers.PROVIDERS.length} healthy`);
  }

  console.log('\n=== live search through the plugin ===');
  const ctx = fakeContext();
  plugin.apply(ctx);
  const provider = ctx.registered[0];

  const startedAt = Date.now();
  const result = await provider.search({ query: 'DeepSeek Harness plugin architecture', maxResults: 3 });
  const elapsed = Date.now() - startedAt;

  assert.ok(result.sources.length > 0, 'a live search must return at least one source');
  assert.ok(result.sources.length <= 3, 'the provider must honour maxResults');
  assert.equal(typeof result.truncated, 'boolean');
  for (const source of result.sources) {
    assert.match(source.url, /^https?:\/\//, 'source urls must be absolute http(s)');
    assert.ok(source.title === undefined || typeof source.title === 'string');
    assert.ok(source.snippet === undefined || typeof source.snippet === 'string');
  }

  console.log(`  ${result.sources.length} sources in ${elapsed}ms`);
  for (const [index, source] of result.sources.entries()) {
    console.log(`  ${index + 1}. ${source.title ?? '(untitled)'}\n     ${source.url}`);
  }
  console.log('\nOK');
}

main().catch((error) => {
  console.error('\nFAILED:', error);
  process.exitCode = 1;
});
