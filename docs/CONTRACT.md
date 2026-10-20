# 用量看板 bundle · 冻结契约

包名 `dsh-usage-panel`（本地 bundle，无运行时依赖）。插件的两个半边：

- Host 半边 `index.js`：读取本机会话日志，聚合 Token 用量，只提供一个只读 JSON 路由。
- Client 半边 `client.js`：侧边栏 `sidebar.panellist` 入口 + `main` 主面板页面（Lead 编写）。

本文冻结 Host 契约与打包/展示资源要求；Client 只依赖下述 JSON 形状。

## 1. 路由

```
GET /dsh-usage-panel/snapshot          # 使用缓存（会话 revision 未变化时直接回缓存）
GET /dsh-usage-panel/snapshot?refresh=1
```

- 另有按日性能路由：`GET|HEAD /dsh-usage-panel/performance?date=YYYY-MM-DD`（缺省今天；非法日期 400）。
- `kind: 'exact'`，通过 `ctx.webServer.register` 注册；`cache-control: no-store`。
- 仅 GET / HEAD；其他方法 405 + `{ "ok": false, "error": "method-not-allowed" }`。
- 内部异常：500 + `{ "ok": false, "error": "snapshot-failed" }`，同时 `ctx.logger?.warn`。
- 启动预热：`apply` 后延迟约 4s 在后台跑一次聚合（不阻塞启动、失败静默），这样用户第一次点开看板时基本命中缓存。定时器必须在 `ctx.effect` 里清理。

## 2. 快照 JSON（version = 1）

所有数值都是有限非负整数（`cacheHitRate`、`share`、`*Ms` 为 0..1/毫秒数）。字段缺失或服务不可用时也要返回合法空结构，不允许抛给客户端。

```json
{
  "ok": true,
  "version": 1,
  "generatedAt": 1760000000000,
  "timezoneOffsetSeconds": -28800,
  "scan": {
    "sessions": 123,
    "readings": 4567,
    "rescanned": 3,
    "truncated": false,
    "maxSessions": 800,
    "tookMs": 42,
    "cold": false
  },
  "window": { "days": 182, "from": "2026-04-21", "to": "2026-10-20" },
  "totals": {
    "tokens": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
    "reasoning": 0, "prompt": 0, "calls": 0, "cacheHitRate": 0
  },
  "today":  { "day": "2026-10-20", "tokens": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "calls": 0 },
  "month":  { "month": "2026-10",  "tokens": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "calls": 0 },
  "history": { "tokens": 0, "calls": 0, "reasoning": 0 },
  "speed": { "tokensPerSecond": 0, "decodeTokens": 0, "decodeMs": 0, "samples": 0 },
  "daily": [
    { "d": "2026-04-21", "tokens": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "calls": 0, "tokensPerSecond": 0 }
  ],
  "performance": {
    "date": "2026-10-20",
    "providers": [ { "provider": "opencode-go", "tps": 0, "ttftMs": 0, "speedSamples": 0, "ttftSamples": 0, "samples": 0 } ],
    "hours": [ { "h": 0, "providers": [ { "provider": "opencode-go", "tps": 0, "ttftMs": 0, "speedSamples": 0, "ttftSamples": 0, "samples": 0 } ] } ]
  },
  "models": [
    { "model": "deepseek-v4.1-flash", "providers": ["opencode-go"], "tokens": 0,
      "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "calls": 0, "share": 0.64 }
  ]
}
```

口径（必须一致）：

- 一次读数 = 一条 `assistant/message` 事件的 `data.usage`（Anthropic Messages 语义）。
- `input` = `usage.inputTokens`（未命中缓存的输入，不含缓存读写）。
- `cacheRead` = `usage.cacheReadTokens`；`cacheWrite` = `usage.cacheWriteTokens`（独立计数，不是 input 的子集）。
- `output` = `usage.outputTokens`；`reasoning` = `usage.reasoningTokens`（可为 0）。
- `prompt` = `input + cacheRead + cacheWrite`；`tokens` = `prompt + output`。
- `cacheHitRate` = `prompt > 0 ? cacheRead / prompt : 0`。
- `calls` = 读数条数（每调用一次模型记 1）。
- 时间取 `event.time`（epoch ms），按**服务器本地时区**分日/月。
- `daily` 是 `window.days` 个连续本地自然日（旧→新，含今天；零用量日也要有对象）。窗口外的读数仍计入 totals/history/models。
- `models` 按 `tokens` 降序；`model` 取 `data.message.source.model`，`providers` 取不同 `source.provider`（未知或缺失用 `"unknown"`）。
- 速度口径：一次读数在 `step/start` 之后、`assistant/message` 的 durable stream 里找首个 token 的时间戳，`decodeMs = 落盘时间 − 首 token 时间`，`decodeTokens = usage.outputTokens`（含 reasoning）；`speed.tokensPerSecond = ΣdecodeTokens / (ΣdecodeMs / 1000)`，`samples` 为有有效解码窗口的读数数；`daily[i].tokensPerSecond` 为按日同口径聚合。
- 性能口径：`performance` 是「本地日期 × 小时 × provider」折叠。`tps` 取每次调用的 `outputTokens / 解码秒数` 的**中位数**；`ttftMs` 取 `首 token 时间 − step/start` 的**中位数**；`hours` 只包含有样本的小时，`providers` 按样本数降序；快照里的 `performance` 恒为今天，任意日期用 `/performance?date=` 路由。
- `history` 与 `totals` 同源（历史累计，含窗口外）。`scan.cold` 表示本次请求是否真的重扫了日志；`scan.rescanned` 是重读的会话数。

## 3. Host 实现要求

- 服务：`ctx.inject(['sessionPersistence', 'webServer'], scoped => ...)`（同已装参考插件 `dsh-usage-dashboard/index.js` 的用法；只读该文件参考 API，不要照抄其界面）。
- `ctx.sessionPersistence.list()` 的每项兼容 `{ header, revision }` 或裸 header，用 `header.id` / `header.createdAt`；默认最多 `maxSessions` 个（按 `createdAt` 降序截断，`truncated: true`）。
- 逐会话 `open(id, 'read')` → `read()` → `close()`；并发上限 4；单会话失败按空处理，不能让整次快照失败。
- 增量缓存：按 `revision + eventCount` 逐会话缓存读数；再按“所有会话 id+revision 的签名 + 配置”缓存整份快照，签名不变时直接复用（仅刷新 `generatedAt`/`tookMs`/`cold:false`）。缓存挂在 `globalThis[Symbol.for('dsh-usage-panel:cache')]`，HMR 重挂载不丢。
- `?refresh=1` 跳过整份快照缓存（仍逐会话走 revision 缓存）。
- 配置（来自 patch 行 `config`，无 Config 导出，做防御式归一化）：
  - `historyDays`：整数，默认 182，范围 7..365。
  - `maxSessions`：整数，默认 800，范围 1..5000。
- 模块形态：ESM，`export const name = 'dsh-usage-panel'`、`export const inject = []`、`export function apply(ctx, config) {}`。不 import 任何包、不用 `require`。
- 警告日志全部 `ctx.logger?.warn?.('[dsh-usage-panel] ...', error)` 保护。

## 4. 打包与展示资源

- `package.json`：`name: "dsh-usage-panel"`，`version: "1.0.0"`，`private: true`，`type: "module"`；
  `exports` = `".": "./index.js"`、`"./client": "./client.js"`、`"./cordis.patch.yml"`、`"./locale/*.json"`、`"./icon": "./icon.svg"`、`"./package.json"`；
  `files` 覆盖 index.js、client.js、cordis.patch.yml、locale/*.json、icon.svg、README.md；
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
- `locale/en.json`、`locale/zh.json`：至少 `meta.title` / `meta.description`，写清能力（Token 用量看板：总量、构成、趋势、模型占比、热力图），不要模板文案。
- `icon.svg`：原创 64×64 SVG，深海军蓝圆角方块 + 三级蓝色柱状 + 一道细折线；16px 下仍清晰；无外部引用。
- `README.md`：简述安装、入口位置（侧边栏「插件」图标旁）、数据口径、配置项、限制。

## 5. 验收命令

- `node --input-type=module --check < index.js`（语法）
- `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); JSON.parse(require('fs').readFileSync('locale/zh.json','utf8')); JSON.parse(require('fs').readFileSync('locale/en.json','utf8'))"`
- 不得执行 `plugin_manager` / 安装；由 Lead 安装和验证。

## 6. 实施记录（安装后补充）

- 快照 `scan` 额外携带 `failed`（不可读会话的持久失败数）、`skipped`（本次被退避门跳过的会话数）、`retryAt`（下一次重试时间戳）；Client 只展示 `failed`，其余字段可忽略。
- 历史格式会话在 `list()` 中的 revision 末段会随读取漂移；Host 用「去掉末段的稳定 revision + eventCount」作为逐会话缓存键，避免每次请求全量重扫。
- 读取失败的会话进入 10 分钟退避门（revision 变化则立即重试）；整份快照缓存携带 `retryAt`，签名不变时热读不再重扫。
- `?debug=1` 附带 `diagnostics`（失败样本、retryAt、读取耗时、窗口摘要），仅用于排查。
- 实测（本机 201 个会话 / 23k 次读数）：热读约 26ms；首次冷读需迁移历史日志，约 3–6s，由启动后约 4s 的后台预热吸收。
- 增量变更（v1.1）：新增 `speed`（总输出速度）与 `daily[].tokensPerSecond`；Client 用 `speed` 渲染「平均输出速度」卡，用日口径渲染趋势悬浮提示。
- 增量变更（v1.2）：新增 `/performance?date=` 路由与快照 `performance` 块；热力图点击切换性能面板日期；速度/首 token 均按小时中位数展示。
