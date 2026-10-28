<div align="center">

# dsh-websearch-keyless

**让 DeepSeek Harness 原生的 `web_search` 在完全不需要 API Key 的情况下可用。**

把 OpenCode `WebSearch` 服务里那三个免密钥后端 —— Tavily、TinyFish、Exa —— 注册为
`ctx.web` 的搜索提供方。

[![test](https://github.com/lovehin/dsh-websearch-keyless/actions/workflows/test.yml/badge.svg)](https://github.com/lovehin/dsh-websearch-keyless/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20.3-brightgreen.svg)](package.json)

[English](README.md) | 简体中文

</div>

---

## 解决什么问题

DSH profile 若没有可用的搜索提供方，就会回落到 `@deepseek-ai/dsh-web-search-deepseek` —— 它通过
DeepSeek **对话** API 来回答 `web_search`。一旦那个 key 缺失或失效，每次搜索都会失败：

```
DeepSeek API error (HTTP 401): Authentication Fails, your api key: ****d09c is invalid
```

## 怎么解决

OpenCode 的 `WebSearch` 服务注册了 5 个提供方，其中 3 个无需任何 key。本插件照搬这三个，按优先级
降级：某个后端报错、超时或返回空结果时，自动换下一个。

| 顺序 | 后端 | 端点 | 免密钥标识 |
| --- | --- | --- | --- |
| 1 | Tavily | `POST https://api.tavily.com/search` | `X-Tavily-Access-Mode: keyless` |
| 2 | TinyFish | `POST https://agent.tinyfish.ai/mcp` | `X-TinyFish-Access-Mode: keyless` |
| 3 | Exa | `POST https://mcp.exa.ai/mcp` | 无需 key 参数 |

不用注册、不用 key、不用改配置。只接管 `web_search`，`web_fetch` 仍走内置 HTTP 提供方。

## 安装

把 `<profile>` 换成你实际启动的 profile：桌面端是 `desktop`，`dsh web` 是 `web`。

```sh
npx -y @deepseek-ai/dsh plugin --profile <profile> add github:lovehin/dsh-websearch-keyless
```

插件管理器会同时写入 `dependencies` 和 `dsh.profile.bundles`。因为它是以 **bundle** 形式加入的，
它自带的 `cordis.patch.yml` 会被自动应用 —— **不需要**你手动去改 profile 的 patch 层。重启 DSH
（或重新加载 profile）后 `web_search` 即可用。

确认生效：

```sh
npx -y @deepseek-ai/dsh --profile <profile> --dump-config | grep -A3 "^- id: web"
```

应该看到：

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: opencode-keyless
    fetchProvider: http
```

### 手动安装

如果 profile 由应用独占管理、CLI 拒绝操作（`profile "desktop" is managed exclusively by the
Electron application`），可以手动接入：

```sh
git clone https://github.com/lovehin/dsh-websearch-keyless.git \
  ~/.dsh/local-plugins/dsh-websearch-keyless
cd ~/.dsh/profiles/<profile>
ln -sfn ../../../local-plugins/dsh-websearch-keyless node_modules/dsh-websearch-keyless
```

在 profile 的 `package.json` 里加依赖：

```jsonc
"dependencies": {
  "dsh-websearch-keyless": "link:/home/you/.dsh/local-plugins/dsh-websearch-keyless"
}
```

再往 profile 的 `cordis.patch.yml` 追加 —— **若文件里还是空的 `[]`，先把它删掉**：

```yaml
- id: web
  config:
    searchProvider: opencode-keyless
    fetchProvider: http      # 必须写，原因见「三个坑」

- insert:
    - id: web-search-opencode-keyless
      name: 'dsh-websearch-keyless'
```

## 自检

测试零依赖，普通 Node 就能跑：

```sh
git clone https://github.com/lovehin/dsh-websearch-keyless.git
cd dsh-websearch-keyless
npm test              # 离线：解析、降级、插件契约（14 个用例）
npm run test:live     # 联网：真实探测三个后端
```

`npm test` 不需要网络，CI 在 Node 20 / 22 / 24 上跑。`test:live` 打的是第三方共享端点，属于手动
检查，不作为门禁。

## 实现结构

```
lib/providers.js   三个免密钥后端 + 降级流水线（零依赖，纯 CJS）
lib/index.js       Cordis 插件：向 ctx.web 注册 WebSearchProvider
cordis.patch.yml   把 `web` 服务指向本插件的 provider id，并插入插件
test/unit.test.js  离线用例（固件取自真实响应）
test/live.js       联网冒烟测试
```

注册的提供方与 seam 接口逐字对应：

```ts
export interface WebSearchProvider {
  readonly id: string;
  available(): boolean;                                              // 廉价检查，不发网络请求
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
}
```

`available()` 恒返回 `true`，因为没有任何后端需要凭据。失败会映射到 seam 的错误码：取消是
`WEB_ABORTED`，三个后端都因**故障**（而非合法地返回空）失败时是 `WEB_PROVIDER_ERROR`。

### 兼容性

已在 **DSH 0.2.1-rc.3** 上验证。本插件**刻意不声明任何 `@deepseek-ai/*` peer 依赖，也没有
`engines.dsh`** —— DSH 在加载前会对每个 manifest 跑 `evaluatePluginCompatibility`，什么都不声明就
没有什么可被判不满足。它同样不 import 任何 `@deepseek-ai/*` 包，所以用 `link:` 直接解析，无需构建。

## 三个坑

这三条都是真金白银踩出来的。你自己给 DSH 写 web provider 时也会遇到。

**1. `fetchProvider` 必须重写一遍。** 按 id 打补丁是**整个替换** config 对象，不做深合并。上游默认值
在 `@deepseek-ai/dsh-web-app` 层里是 `{ searchProvider: deepseek-official, fetchProvider: http }`。
你只覆盖 `searchProvider`，`fetchProvider` 就被静默抹掉，此后每次 `web_fetch` 都会失败：

```
multiple usable web providers are registered (deepseek-fetch-api, http); configure one explicitly
```

**2. `[]` 会破坏追加。** 还没有任何覆盖的 profile，其 `cordis.patch.yml` 整体就是一个字面量 `[]`。
在它后面追加内容会产生第二个 YAML 文档：

```
dsh: failed to parse overlay .../cordis.patch.yml: YAMLException: end of the stream
or a document separator is expected
```

先删掉 `[]`。

**3. 不要加 DSH peer 依赖。** 任何不覆盖当前运行版本的 `@deepseek-ai/*` peer 范围，都会让插件在
启动时被跳过：

```
dsh: skipping profile bundle "@anysearch/anysearch-dsh": Error: Plugin
@anysearch/anysearch-dsh@0.1.6 is incompatible with dsh 0.2.1-rc.3
```

确有需要时，可以按精确版本放行：

```sh
npx -y @deepseek-ai/dsh plugin --profile <profile> allow-version <pkg>@<version> \
  --dsh-version <runtime-version> --accept-risk
```

## 排错

| 现象 | 原因 |
| --- | --- |
| `WEB_PROVIDER_CONFIGURED_MISSING` | `searchProvider: opencode-keyless` 配了但插件没加载 —— 检查它是否同时在 `dependencies` 和 `bundles` 里，以及 `node_modules/dsh-websearch-keyless` 能否解析 |
| `multiple usable web providers are registered` | 坑 1，补上 `fetchProvider: http` |
| `all keyless search backends failed` | 三个端点全部拒绝，通常是出网受限、代理问题，或共享额度被限流。重试，或用 `npm run test:live` 定位 |
| 搜到空结果 | 免密钥额度是共享的，冷门查询确实可能返回 0 条，换个说法再试 |

## 卸载

```sh
npx -y @deepseek-ai/dsh plugin --profile <profile> remove dsh-websearch-keyless
```

手动安装的话：删掉 `dependencies` 条目、`node_modules` 软链，以及 `cordis.patch.yml` 里那两个块
（或把 `searchProvider` 改回 `deepseek-official`）。

## 说明

- 免密钥模式是共享基础设施上的礼貌性额度，上游随时可能限流或调整 —— 这就是「不用 key」的代价。
  需要稳定配额的话，去这三家任意一家注册账号，然后在 `PROVIDERS` 里把带 key 的提供方排到前面。
- 「三个坑」里的问题全都是**实际调用工具**才暴露的，光看配置发现不了。改动之后要验的是隔壁那个
  工具，而不只是你改的那个。

## 许可证

[MIT](LICENSE)
