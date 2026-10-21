# 用量看板 bundle · 冻结契约（v2）

包名 `dsh-usage-panel`（本地 bundle，无运行时依赖）。插件的两个半边：

- Host 半边 `index.js`：读取本机会话日志，聚合 Token 用量，提供两个只读 JSON 路由。
- Client 半边 `client.js`：侧边栏 `sidebar.panellist` 入口 + `main` 主面板页面（Lead 编写）。

本文冻结 Host 契约与打包/展示资源要求；Client 只依赖下述 JSON 形状。

## 1. 路由

```
GET|HEAD /dsh-usage-panel/snapshot[?refresh=1]
GET|HEAD /dsh-usage-panel/performance[?date=YYYY-MM-DD]
GET|HEAD /dsh-usage-panel/performance?from=YYYY-MM-DD&to=YYYY-MM-DD
```

- 两个路由均 `kind: 'exact'`，通过 `ctx.webServer.register` 注册；响应头恒为
  `content-type: application/json; charset=utf-8`、`content-length: <body 长度>`、`cache-control: no-store`。
- 仅 GET / HEAD；其他方法 405 + `{ "ok": false, "error": "method-not-allowed" }`。
- HEAD 一律只回响应头、不回 body（包括 400/405/500）。
- 内部异常：`/snapshot` 500 + `{ "ok": false, "error": "snapshot-failed" }`；
  `/performance` 500 + `{ "ok": false, "error": "performance-failed" }`；同时 `ctx.logger?.warn`。
- `/performance` 的日模式参数非法（`?date=` 不是 `YYYY-MM-DD`）→ 400 `{ "ok": false, "error": "invalid-date" }`。
- `/performance` 的区间模式参数非法（缺 `from`/`to`、日期非法、`from > to`、跨度 > 400 天）→
  400 `{ "ok": false, "error": "invalid-range" }`。只要查询串出现 `from` 或 `to` 任一参数即进入区间模式，
  两者必须同时给出且合法。
- 启动预热：`apply` 后延迟约 4s 在后台跑一次聚合（不阻塞启动、失败静默），这样用户第一次点开看板时基本命中缓存。定时器必须在 `ctx.effect` 里清理。

## 2. 快照 JSON（version = 2）

所有数值都是有限非负数：计数器与样本数为**非负整数**，`decodeMs` 为四舍五入后的非负整数，
`cacheHitRate` / `share` 为 0..1，`tokensPerSecond` / `tps` / `ttftMs` 为中位数或加权比值（允许小数）。
字段缺失或服务不可用时也要返回合法空结构，不允许抛给客户端。

```json
{
  "ok": true,
  "version": 2,
  "generatedAt": 1792850000000,
  "timezoneOffsetSeconds": 28800,
  "scan": {
    "sessions": 123,
    "readings": 4567,
    "rescanned": 3,
    "truncated": false,
    "maxSessions": 800,
    "tookMs": 42,
    "cold": false,
    "failed": 0,
    "skipped": 0,
    "retryAt": 0
  },
  "window": { "days": 182, "from": "2026-04-24", "to": "2026-10-22" },
  "totals": {
    "tokens": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
    "reasoning": 0, "prompt": 0, "calls": 0, "cacheHitRate": 0
  },
  "speed": { "tokensPerSecond": 0, "decodeTokens": 0, "decodeMs": 0, "samples": 0 },
  "today":  { "day": "2026-10-22", "tokens": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "calls": 0, "tokensPerSecond": 0 },
  "month":  { "month": "2026-10",  "tokens": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "calls": 0, "tokensPerSecond": 0 },
  "history": {
    "tokens": 0, "calls": 0, "reasoning": 0,
    "activeDays": 0, "firstDay": "", "lastDay": "",
    "peak": { "day": "", "tokens": 0 }
  },
  "daily": [
    {
      "d": "2026-10-22",
      "tokens": 30220, "input": 1800, "output": 6420, "cacheRead": 21000, "cacheWrite": 1000,
      "calls": 34, "tokensPerSecond": 21.7,
      "reasoning": 2100, "samples": 29, "decodeTokens": 6360, "decodeMs": 293000,
      "models": [
        { "model": "deepseek-v4.1-flash", "tokens": 28100, "calls": 30 },
        { "model": "deepseek-v4.1-pro", "tokens": 2120, "calls": 4 }
      ]
    }
  ],
  "models": [
    { "model": "deepseek-v4.1-flash", "providers": ["opencode-go"], "tokens": 0,
      "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "calls": 0, "tokensPerSecond": 0, "share": 0.64 }
  ],
  "performance": {
    "date": "2026-10-22",
    "providers": [ { "provider": "opencode-go", "tps": 0, "ttftMs": 0, "speedSamples": 0, "ttftSamples": 0, "samples": 0 } ],
    "hours": [
      {
        "h": 14,
        "tokens": 30220, "input": 1800, "output": 6420, "cacheRead": 21000, "cacheWrite": 1000,
        "calls": 34, "tokensPerSecond": 21.7,
        "reasoning": 2100, "decodeTokens": 6360, "decodeMs": 293000, "samples": 29,
        "providers": [ { "provider": "opencode-go", "tps": 0, "ttftMs": 0, "speedSamples": 0, "ttftSamples": 0, "samples": 0 } ]
      }
    ]
  }
}
```

口径（必须一致）：

- 一次读数 = 一条 `assistant/message` 事件的 `data.usage`（Anthropic Messages 语义）。
- `input` = `usage.inputTokens`（未命中缓存的输入，不含缓存读写）。
- `cacheRead` = `usage.cacheReadTokens`；`cacheWrite` = `usage.cacheWriteTokens`（独立计数，不是 input 的子集）。
- `output` = `usage.outputTokens`；`reasoning` = `usage.reasoningTokens`（可为 0；含在 `output` 内，不重复计入 `tokens`）。
- `prompt` = `input + cacheRead + cacheWrite`；`tokens` = `prompt + output`。
- `cacheHitRate` = `prompt > 0 ? cacheRead / prompt : 0`。
- `calls` = 读数条数（每调用一次模型记 1）。
- 时间取 `event.time`（epoch ms），按**服务器本地时区**分日/月。没有可用时间戳（`event.time` 缺失）的读数计入 totals/models，但不参与按日统计。
- `daily` 是 `window.days` 个连续本地自然日（旧→新，含今天；零用量日也要有对象）。窗口外的读数仍计入 totals/history/models。
- `daily[]` 新增字段：
  - `reasoning`：当日 `reasoningTokens` 合计。
  - `samples` / `decodeTokens` / `decodeMs`：当日解码窗口口径（同日历日聚合，见下）。
  - `models`：`[{ model, tokens, calls }]`，只含当日 `tokens > 0` 的模型，按 `tokens` 降序、模型名升序；
    `tokens` 为当日该模型的 token 合计，`calls` 为当日该模型全部读数条数；零用量日为 `[]`。
- `history` 与 `totals` 同源（历史累计，含窗口外），另加：
  - `activeDays`：全历史有 ≥1 条读数（含零 token 读数、不含无时间戳读数）的本地自然日数。
  - `firstDay` / `lastDay`：全历史最早的/最晚的读数日；无数据为 `""`。
  - `peak`：全历史单日 `tokens` 最大的那天，`{ day, tokens }`；并列取较早的一天；无数据为 `{ "day": "", "tokens": 0 }`。
- `models` 按 `tokens` 降序；`model` 取 `data.message.source.model`，`providers` 取不同 `source.provider`（未知或缺失用 `"unknown"`）。
- 速度口径：一次读数在 `step/start` 之后、`assistant/message` 的 durable stream 里找首个 token 的时间戳，`decodeMs = 落盘时间 − 首 token 时间`，`decodeTokens = usage.outputTokens`（含 reasoning）；`speed.tokensPerSecond = ΣdecodeTokens / (ΣdecodeMs / 1000)`，`samples` 为有有效解码窗口的读数数；`daily[i].tokensPerSecond` / `daily[i].samples` / `decode*` 为按日同口径聚合；`daily[i].decodeMs` 取整。
- 快照里的 `performance` 恒为「今天」：`performance.providers` 是当日按 provider 的 tps/ttft 中位数；
  `performance.hours` 是「本地小时 → provider」折叠，`hours[]` 只包含有读数的小时（升序）：
  - provider 行：`tps` 取每次调用 `outputTokens / 解码秒数` 的**中位数**，`ttftMs` 取 `首 token 时间 − step/start` 的**中位数**，
    `speedSamples` / `ttftSamples` 为对应有效样本数，`samples = max(speedSamples, ttftSamples)`；`providers` 按 `samples` 降序、provider 名升序。
  - 小时用量桶（v2 新增）：`tokens / input / output / cacheRead / cacheWrite / reasoning / calls / tokensPerSecond / decodeTokens / decodeMs / samples`，
    口径与该小时内读数的聚合完全一致（`tokensPerSecond = ΣdecodeTokens / (ΣdecodeMs/1000)`，`samples` 为有有效解码窗口的读数数，
    即 `speedSamples`）。小时行的 provider 行与当日 provider 行同形状。
- `scan.cold` 表示本次请求是否真的重扫了日志；`scan.rescanned` 是重读的会话数；`scan.failed` / `skipped` / `retryAt` 见 §6。

## 3. `/performance` 路由（日 / 区间两模式）

两种模式都先 `await scanShared(scope, settings, false)`（复用快照扫描与逐会话缓存），再从内存 records 折叠；
区间模式每次请求实时 fold，不新增缓存。

### 3.1 日模式（v1 兼容）

`GET /dsh-usage-panel/performance?date=YYYY-MM-DD`（缺省今天）：

```json
{
  "ok": true,
  "version": 2,
  "generatedAt": 1792850000000,
  "date": "2026-10-21",
  "tookMs": 6,
  "performance": {
    "date": "2026-10-21",
    "providers": [ { "provider": "opencode-go", "tps": 21.7, "ttftMs": 480, "speedSamples": 29, "ttftSamples": 30, "samples": 30 } ],
    "hours": [
      {
        "h": 14,
        "tokens": 30220, "input": 1800, "output": 6420, "cacheRead": 21000, "cacheWrite": 1000,
        "calls": 34, "tokensPerSecond": 21.7,
        "reasoning": 2100, "decodeTokens": 6360, "decodeMs": 293000, "samples": 29,
        "providers": [ { "provider": "opencode-go", "tps": 21.7, "ttftMs": 480, "speedSamples": 29, "ttftSamples": 30, "samples": 30 } ]
      }
    ]
  }
}
```

- `hours[]` 带 §2 的全部小时用量桶字段；Client 的单日 24 小时图直接用它。
- 非法日期 → 400 `invalid-date`（保持 v1 错误码，向后兼容）。

### 3.2 区间模式（v2 新增）

`GET /dsh-usage-panel/performance?from=YYYY-MM-DD&to=YYYY-MM-DD`（两端含；`from <= to`；跨度 `to - from <= 400` 天）：

```json
{
  "ok": true,
  "version": 2,
  "generatedAt": 1792850000000,
  "tookMs": 7,
  "from": "2026-09-23",
  "to": "2026-10-22",
  "performance": {
    "from": "2026-09-23",
    "to": "2026-10-22",
    "providers": [
      { "provider": "opencode-go", "tps": 21.7, "ttftMs": 480, "speedSamples": 812, "ttftSamples": 830, "samples": 830 }
    ],
    "days": [
      {
        "d": "2026-10-21",
        "providers": [
          { "provider": "opencode-go", "tps": 22.4, "ttftMs": 465, "speedSamples": 29, "ttftSamples": 30, "samples": 30 }
        ]
      }
    ]
  }
}
```

- `providers`：区间内**所有读数**的全局中位数——`tps` 取每次调用 tps 的中位数，`ttftMs` 取每次调用 ttft 的中位数，
  样本次数与对应中位数的有效样本数严格一致；按 `samples` 降序、provider 名升序。有读数但没有有效速度/首 token 样本的 provider
  也保留，此时对应中位数与样本数为 0。
- `days`：只含有读数的本地日，按日期升序；单日行内 provider 同样按 `samples` 降序、provider 名升序；
  provider 行的 `tps` / `ttftMs` 是该日内的中位数。
- 区间模式下 payload 顶层为 `from` / `to`（没有 `date` 字段），`performance.from` / `performance.to` 原样回显请求区间
  （即使区间内没有任何数据）。
- 非法区间 → 400 `{ "ok": false, "error": "invalid-range" }`（见 §1）。

## 4. Host 实现要求

- 服务：`ctx.inject(['sessionPersistence', 'webServer'], scoped => ...)`（同已装参考插件 `dsh-usage-dashboard/index.js` 的用法；只读该文件参考 API，不要照抄其界面）。
- `ctx.sessionPersistence.list()` 的每项兼容 `{ header, revision }` 或裸 header，用 `header.id` / `header.createdAt`；默认最多 `maxSessions` 个（按 `createdAt` 降序截断，`truncated: true`）。
- 逐会话 `open(id, 'read')` → `read()` → `close()`；并发上限 6；单会话失败按空处理，不能让整次快照失败。
- 增量缓存：按 `revision + eventCount` 逐会话缓存读数；再按“所有会话 id+revision 的签名 + 配置”缓存整份快照，签名不变时直接复用（仅刷新 `generatedAt`/`tookMs`/`cold:false`）。缓存挂在 `globalThis[Symbol.for('dsh-usage-panel:cache:v3')]`，HMR 重挂载不丢；快照缓存体额外带 `bodyVersion: 2` 标记，旧模块代折叠的缓存体按 miss 处理（从热逐会话缓存重折叠，不重读日志）。
- `?refresh=1` 跳过整份快照缓存（仍逐会话走 revision 缓存）。
- 折叠：`fold()` 单次遍历同时累计 totals / today / month / daily 窗口 / 全局 models / 按日模型表 / 全历史日统计；
  `performanceOf()` 在日折叠里顺手累计小时用量桶；`performanceRangeOf()` 单次遍历按 `(day, provider)` 收集 tps/ttft 数组并产出区间 `days` 与全局 `providers`。
- 路由解析：日模式 / 区间模式共用参数解析；区间用本地日历日序数校验 `from <= to` 与 400 天上限（不受夏令时影响），非法即 400，不进入扫描。
- 配置（来自 patch 行 `config`，无 Config 导出，做防御式归一化）：
  - `historyDays`：整数，默认 182，范围 7..365。
  - `maxSessions`：整数，默认 800，范围 1..5000。
- 模块形态：ESM，`export const name = 'dsh-usage-panel'`、`export const inject = []`、`export function apply(ctx, config) {}`。不 import 任何包、不用 `require`。
- 警告日志全部 `ctx.logger?.warn?.('[dsh-usage-panel] ...', error)` 保护。

## 5. 打包与展示资源

- `package.json`：`name: "dsh-usage-panel"`，`private: true`，`type: "module"`；`version` 由 release 步骤维护（v2 面板目标 `1.1.0`，实际以 `package.json` 为准）；
  `exports` = `".": "./index.js"`、`"./client": "./client.js"`、`"./cordis.patch.yml"`、`"./locale/*.json"`、`"./icon": "./icon.svg"`、`"./package.json"`；
  `files` 覆盖 index.js、client.js、cordis.patch.yml、locale/*.json、icon.svg、README.md、CHANGELOG.md；
  `dsh.bundle.patch: "./cordis.patch.yml"`；
  `dsh.client: { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-locale"] }`。
- `cordis.patch.yml`：
  ```yaml
  - insert:
      - id: usage-panel
        name: dsh-usage-panel
        config:
          historyDays: 182
          maxSessions: 800
  ```
- `locale/en.json`、`locale/zh.json`：至少 `meta.title` / `meta.description`，写清能力（Token 用量看板：全局时间范围与单日视图、读数条、Token 构成、趋势、模型占比、活跃热力图、提供商性能），不要模板文案。
- `icon.svg`：原创 64×64 SVG，深海军蓝圆角方块 + 三级蓝色柱状 + 一道细折线；16px 下仍清晰；无外部引用。
- `README.md`：简述安装、入口位置（侧边栏「插件」图标旁）、数据口径、配置项、限制。

## 6. 验收命令

- `node --input-type=module --check < index.js`（语法）
- Host fake-ctx 单测（**不提交进仓库**，开发期临时脚本）：覆盖 v2 规格 A4 的六类断言——
  快照新字段与口径、零数据空结构、`daily[].models` 求和 = 当日 tokens 与 history 全历史统计、
  日模式 `hours[]` 桶求和 = 当日 tokens、区间模式 `days[]`/provider 中位数与 400 校验（日模式旧查询仍可用）、
  HEAD 无 body / 405 / 空数据与失败不抛。
- `node --check client.js`（语法）；`node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); JSON.parse(require('fs').readFileSync('locale/zh.json','utf8')); JSON.parse(require('fs').readFileSync('locale/en.json','utf8'))"`
- 不在仓库内执行 `plugin_manager` / 安装；由使用者在宿主中安装后验证（开发期以 Host 单测 + 本地预览 harness 验收客户端）。

## 7. 实施记录（安装后补充）

- 快照 `scan` 额外携带 `failed`（不可读会话的持久失败数）、`skipped`（本次被退避门跳过的会话数）、`retryAt`（下一次重试时间戳）；Client 只展示 `failed`，其余字段可忽略。
- 历史格式会话在 `list()` 中的 revision 末段会随读取漂移；Host 用「去掉末段的稳定 revision + eventCount」作为逐会话缓存键，避免每次请求全量重扫。
- 读取失败的会话进入 10 分钟退避门（revision 变化则立即重试）；整份快照缓存携带 `retryAt`，签名不变时热读不再重扫。
- `?debug=1` 附带 `diagnostics`（失败样本、retryAt、读取耗时、窗口摘要），仅用于排查。
- 实测（本机 201 个会话 / 23k 次读数）：热读约 26ms；首次冷读需迁移历史日志，约 3–6s，由启动后约 4s 的后台预热吸收。
- 增量变更（v1.1）：新增 `speed`（总输出速度）与 `daily[].tokensPerSecond`；Client 用 `speed` 渲染「平均输出速度」卡，用日口径渲染趋势悬浮提示。
- 增量变更（v1.2）：新增 `/performance?date=` 路由与快照 `performance` 块；热力图点击切换性能面板日期；速度/首 token 均按小时中位数展示。
- 增量变更（v2）：`SNAPSHOT_VERSION = 2`（向后兼容，只做增量）——
  `daily[]` 新增 `reasoning / samples / decodeTokens / decodeMs / models[]`；`history` 新增 `activeDays / firstDay / lastDay / peak`；
  快照 `performance.hours[]` 与 `/performance?date=` 的 `hours[]` 新增小时用量桶字段；
  `/performance` 新增 `?from=&to=` 区间模式（`days[]` + 区间 provider 中位数，跨度上限 400 天，非法区间 400 `invalid-range`）；
  区间 fold 每次请求从内存 records 实时计算，不新增缓存、不新增依赖；缓存符号仍为 `cache:v3`，缓存体带 `bodyVersion` 以便 HMR 升代后安全重折叠。
