<div align="center">

# dsh-websearch-keyless

**Make DeepSeek Harness's native `web_search` work with no API key at all.**

Mirrors the three keyless search backends that OpenCode's `WebSearch` service ships with —
Tavily, TinyFish and Exa — and registers them as a `ctx.web` search provider.

[![test](https://github.com/lovehin/dsh-websearch-keyless/actions/workflows/test.yml/badge.svg)](https://github.com/lovehin/dsh-websearch-keyless/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20.3-brightgreen.svg)](package.json)

English | [简体中文](README.zh-CN.md)

</div>

---

## The problem

A DSH profile with no usable search provider falls back on
`@deepseek-ai/dsh-web-search-deepseek`, which answers `web_search` through the DeepSeek **chat**
API. When that key is missing or invalid, every search fails:

```
DeepSeek API error (HTTP 401): Authentication Fails, your api key: ****d09c is invalid
```

## The fix

OpenCode's `WebSearch` service registers five providers; three of them run keyless. This plugin
mirrors those three, in priority order, falling through to the next when one fails, times out, or
returns nothing:

| Order | Backend | Endpoint | Keyless signal |
| --- | --- | --- | --- |
| 1 | Tavily | `POST https://api.tavily.com/search` | `X-Tavily-Access-Mode: keyless` |
| 2 | TinyFish | `POST https://agent.tinyfish.ai/mcp` | `X-TinyFish-Access-Mode: keyless` |
| 3 | Exa | `POST https://mcp.exa.ai/mcp` | no key parameter |

No signup, no key, no config. Only `web_search` is taken over — `web_fetch` keeps using the
built-in HTTP provider.

### How this differs from other keyless DSH search plugins

There are several keyless plugins for DSH now. Some read public search endpoints directly (for
example DuckDuckGo HTML or Bing), which works, but tends to return thin snippets with no
first-party metadata.

This one calls the same first-party search APIs that OpenCode uses, in keyless mode:

- real titles and body snippets rather than scraped result markup
- three independent providers, so one being throttled does not take search down
- two source files, zero dependencies, no build step, no DSH peer dependencies

## Install

Replace `<profile>` with the profile you actually boot: `desktop` for the desktop app, `web` for
`dsh web`.

```sh
npx -y @deepseek-ai/dsh plugin --profile <profile> add github:lovehin/dsh-websearch-keyless
```

The plugin manager adds it to both `dependencies` and `dsh.profile.bundles`. Because it is a
**bundle**, its own `cordis.patch.yml` is applied automatically — you do **not** hand-edit the
profile's patch layer. Restart DSH (or reload the profile) and `web_search` works.

Confirm it took effect:

```sh
npx -y @deepseek-ai/dsh --profile <profile> --dump-config | grep -A3 "^- id: web"
```

You want to see:

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: opencode-keyless
    fetchProvider: http
```

### Manual install

If you prefer to wire it by hand, or the profile is app-managed and the CLI refuses
(`profile "desktop" is managed exclusively by the Electron application`):

```sh
cd ~/.dsh/profiles/<profile>
git clone https://github.com/lovehin/dsh-websearch-keyless.git \
  ~/.dsh/local-plugins/dsh-websearch-keyless
ln -sfn ../../../local-plugins/dsh-websearch-keyless node_modules/dsh-websearch-keyless
```

Add the dependency to the profile's `package.json`:

```jsonc
"dependencies": {
  "dsh-websearch-keyless": "link:/home/you/.dsh/local-plugins/dsh-websearch-keyless"
}
```

Then append to the profile's `cordis.patch.yml` — **deleting the leading `[]` sentinel first if
the file is still empty**:

```yaml
- id: web
  config:
    searchProvider: opencode-keyless
    fetchProvider: http      # REQUIRED — see Gotchas

- insert:
    - id: web-search-opencode-keyless
      name: 'dsh-websearch-keyless'
```

## Verify

The test suite is dependency-free and runs on plain Node:

```sh
git clone https://github.com/lovehin/dsh-websearch-keyless.git
cd dsh-websearch-keyless
npm test              # offline: parsing, fallback and plugin contract (14 tests)
npm run test:live     # live: probes all three backends against the real endpoints
```

`npm test` needs no network and runs in CI on Node 20, 22 and 24. `test:live` hits shared
third-party endpoints, so it is a manual check rather than a gate.

## How it works

```
lib/providers.js   keyless backends + fallback pipeline (zero dependencies, plain CJS)
lib/index.js       Cordis plugin: registers a WebSearchProvider on ctx.web
cordis.patch.yml   points the `web` service at the provider id, inserts the plugin
test/unit.test.js  offline suite (fixtures captured from live responses)
test/live.js       live smoke test
```

The registered provider implements the seam's interface verbatim:

```ts
export interface WebSearchProvider {
  readonly id: string;
  available(): boolean;                                              // cheap, never networked
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
}
```

`available()` returns `true` unconditionally because none of the backends need credentials.
Failures map onto the seam's codes: `WEB_ABORTED` for cancellation, `WEB_PROVIDER_ERROR` when
every backend fails for a reason rather than legitimately returning nothing.

### Compatibility

Tested against **DSH 0.2.1-rc.3**. The plugin declares **no `@deepseek-ai/*` peer dependencies and
no `engines.dsh`**, deliberately — DSH runs `evaluatePluginCompatibility` against every manifest
before loading it, so declaring nothing means nothing can be unmet. It also uses no
`@deepseek-ai/*` imports, so it resolves with a plain `link:` and needs no build step.

## Gotchas

These three cost real debugging time. If you write your own DSH web provider, they will bite you
too.

**1. `fetchProvider` must be restated.** An id-targeted patch entry **replaces** the matched
plugin's `config` object; it does not deep-merge. The shipped default lives in
`@deepseek-ai/dsh-web-app`'s layer as `{ searchProvider: deepseek-official, fetchProvider: http }`.
Override only `searchProvider` and `fetchProvider` is silently dropped — every `web_fetch` then
fails with:

```
multiple usable web providers are registered (deepseek-fetch-api, http); configure one explicitly
```

**2. A `[]` sentinel breaks appends.** A profile with no overrides yet has a literal `[]` as its
entire `cordis.patch.yml`. Appending blocks after it creates a second YAML document:

```
dsh: failed to parse overlay .../cordis.patch.yml: YAMLException: end of the stream
or a document separator is expected
```

Remove the `[]` first.

**3. Do not add DSH peer dependencies.** Any `@deepseek-ai/*` peer range that does not cover the
running version gets the plugin skipped at boot:

```
dsh: skipping profile bundle "@anysearch/anysearch-dsh": Error: Plugin
@anysearch/anysearch-dsh@0.1.6 is incompatible with dsh 0.2.1-rc.3
```

If you must load a plugin whose ranges are stale, grant an exact-version exemption:

```sh
npx -y @deepseek-ai/dsh plugin --profile <profile> allow-version <pkg>@<version> \
  --dsh-version <runtime-version> --accept-risk
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `WEB_PROVIDER_CONFIGURED_MISSING` | `searchProvider: opencode-keyless` is set but the plugin did not load — check the plugin is in `dependencies` **and** `bundles`, and that `node_modules/dsh-websearch-keyless` resolves |
| `multiple usable web providers are registered` | Gotcha 1 — add `fetchProvider: http` |
| `all keyless search backends failed` | All three endpoints refused; usually no outbound network, a proxy, or shared-quota throttling. Retry, or check `npm run test:live` |
| Search returns nothing | Keyless quotas are shared and can legitimately return zero results for an obscure query; rephrase |

## Uninstall

```sh
npx -y @deepseek-ai/dsh plugin --profile <profile> remove dsh-websearch-keyless
```

For a manual install, remove the `dependencies` entry, the `node_modules` symlink, and the two
blocks from `cordis.patch.yml` (or point `searchProvider` back at `deepseek-official`).

## Notes

- Keyless mode is a courtesy quota on shared infrastructure. It can be rate-limited or changed by
  the upstream providers at any time; that is the trade for needing no key. If you need
  guaranteed volume, register an account with one of the three and add a keyed provider ahead of
  these in `PROVIDERS`.
- The regressions in [Gotchas](#gotchas) were all found by actually calling the tools, not by
  reading the config. Verify the neighbouring tool, not just the one you changed.

## License

[MIT](LICENSE)
