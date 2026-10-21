/**
 * dsh-usage-panel — Client half.
 *
 * Registers two surfaces into the live slot table:
 *   - `sidebar.panellist` (list, id = PANEL_ID): the sidebar entry, placed at
 *     order 1 so it sits directly beside the Plugins entry (order 0).
 *   - `main` (keyed, key = PANEL_ID): the token-usage board, rendered as the
 *     centre panel when that sidebar entry is selected.
 *
 * All numbers come from the package-private Host route
 * `/dsh-usage-panel/snapshot`; this module never reads a session log, never
 * touches another plugin's DOM, and never imports a Harness Client package.
 *
 * Motion policy: entrance is one-shot, composite-only (transform/opacity),
 * numbers are written straight to their text nodes from one rAF and never
 * through React state, chart interaction only re-renders when the hovered day
 * changes, and everything collapses to a static view under
 * `prefers-reduced-motion: reduce`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-usage-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React

    /** Bundle identity and the two panel coordinates. */
    const PACKAGE_ID = 'dsh-usage-panel'
    const PANEL_ID = 'usage-panel'
    const ROUTE = '/dsh-usage-panel/snapshot'
    const PERF_ROUTE = '/dsh-usage-panel/performance'

    /** Snapshot reuse on the client and while the panel stays closed. */
    const CLIENT_FRESH_MS = 30_000
    const POLL_MS = 60_000
    const PREFETCH_DELAY_MS = 7_000

    /** Chosen windows are sliced from the Host's daily series. */
    const RANGE_DEFS = [{ id: 7 }, { id: 30 }, { id: 90 }, { id: 0 }]
    const DEFAULT_RANGE = 30

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
    const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

    // ------------------------------------------------------------------ i18n

    const ZH = {
      'panel.title': '用量看板',
      'panel.sub': '本机会话日志实时统计',
      'action.refresh': '刷新',
      'action.syncing': '同步中',
      'action.retry': '重试',
      'range.7': '7 天',
      'range.30': '30 天',
      'range.90': '90 天',
      'range.all': '全部',
      'stat.total': 'Token 总量',
      'stat.today': '今日 Token',
      'stat.month': '本月 Token',
      'stat.speed': '平均输出速度',
      'stat.cache': '缓存命中率',
      'stat.totalSub': '{calls} 次调用 · 平均每次 {avg}',
      'stat.calls': '{calls} 次调用',
      'stat.avg': '平均每次 {avg}',
      'stat.todaySub': '{calls} 次调用',
      'stat.monthSub': '{calls} 次调用',
      'stat.cacheSub': '缓存读取 {tokens}',
      'stat.speedSub': '解码 {decode} · {samples} 次采样',
      'speed.unit': 'tok/s',
      'stat.vsYesterday': '较昨日',
      'unit.tokens': 'tokens',
      'comp.title': 'Token 构成',
      'comp.hint': '全部历史',
      'comp.input': '输入',
      'comp.inputHint': '未命中缓存',
      'comp.cacheRead': '缓存命中',
      'comp.cacheWrite': '缓存写入',
      'comp.output': '输出',
      'comp.prompt': 'Prompt 合计',
      'comp.hitRate': '缓存命中率',
      'comp.legendValue': '{tokens} · {share}',
      'empty.title': '还没有可统计的 Token 用量',
      'empty.hint': '发起一次对话之后，这里会自动出现真实的用量数据。',
      'models.title': '模型占比',
      'models.hint': '按总 Token',
      'models.other': '其他 {count} 个模型',
      'models.calls': '{calls} 次调用',
      'trend.title': '使用趋势',
      'trend.hint': '每日 Token',
      'trend.rangeTokens': '本区间 {tokens}',
      'trend.dailyAvg': '日均 {tokens}',
      'trend.speed': '速度 {tps} tok/s',
      'trend.calls': '{calls} 次调用',
      'trend.noData': '暂无区间数据',
      'trend.a11y': '每日 Token 使用趋势，可使用左右方向键查看每一天',
      'heat.title': '活跃热力图',
      'heat.hint': '最近 {days} 天',
      'heat.less': '少',
      'heat.more': '多',
      'heat.hoverHint': '悬停方格查看当天明细',
      'heat.detail': '{tokens} tokens · {calls} 次调用',
      'perf.title': '提供商性能',
      'perf.hint': '点击上方热力图切换日期 · 数值为小时中位数',
      'perf.tabSpeed': '速度',
      'perf.tabTtft': '首 Token',
      'perf.reset': '回到今天',
      'perf.loading': '正在统计该日性能…',
      'perf.empty': '该日暂无性能样本',
      'perf.samples': '{count} 次',
      'perf.unitSpeed': 'tok/s',
      'perf.noSampleHour': '该小时无样本',
      'perf.a11y': '按小时展示各提供商输出速度与首 token 延迟，可使用左右方向键切换小时',
      'meta.updated': '更新于 {time}',
      'meta.scan': '{sessions} 个会话 / {readings} 次调用',
      'meta.truncated': '仅统计最近 {max} 个会话',
      'meta.source': '数据来自本机会话日志，不经过网络。',
      'meta.unreadable': '{count} 个会话日志无法读取（已跳过）',
      'state.loading': '正在统计会话日志…',
      'state.error': '读取失败',
      'state.errorHint': 'Host 路由没有返回数据，稍后重试即可。',
      'state.stale': '最近一次同步失败，正在展示上次的数据',
      'a11y.icon': '打开用量看板',
    }

    const EN = {
      'panel.title': 'Usage',
      'panel.sub': 'Live from local session logs',
      'action.refresh': 'Refresh',
      'action.syncing': 'Syncing',
      'action.retry': 'Retry',
      'range.7': '7d',
      'range.30': '30d',
      'range.90': '90d',
      'range.all': 'All',
      'stat.total': 'Total tokens',
      'stat.today': 'Today',
      'stat.month': 'This month',
      'stat.speed': 'Output speed',
      'stat.cache': 'Cache hit rate',
      'stat.totalSub': '{calls} calls · {avg} avg',
      'stat.calls': '{calls} calls',
      'stat.avg': '{avg} avg',
      'stat.todaySub': '{calls} calls',
      'stat.monthSub': '{calls} calls',
      'stat.cacheSub': '{tokens} cache reads',
      'stat.speedSub': '{decode} decoded · {samples} samples',
      'speed.unit': 'tok/s',
      'stat.vsYesterday': 'vs yesterday',
      'unit.tokens': 'tokens',
      'comp.title': 'Token makeup',
      'comp.hint': 'All history',
      'comp.input': 'Input',
      'comp.inputHint': 'cache miss',
      'comp.cacheRead': 'Cache read',
      'comp.cacheWrite': 'Cache write',
      'comp.output': 'Output',
      'comp.prompt': 'Prompt total',
      'comp.hitRate': 'Cache hit rate',
      'comp.legendValue': '{tokens} · {share}',
      'empty.title': 'No token usage yet',
      'empty.hint': 'Start a conversation and real usage numbers will appear here.',
      'models.title': 'Model share',
      'models.hint': 'By total tokens',
      'models.other': '{count} more models',
      'models.calls': '{calls} calls',
      'trend.title': 'Usage trend',
      'trend.hint': 'Tokens per day',
      'trend.rangeTokens': '{tokens} in range',
      'trend.dailyAvg': '{tokens} / day',
      'trend.speed': '{tps} tok/s',
      'trend.calls': '{calls} calls',
      'trend.noData': 'No data in this range',
      'trend.a11y': 'Daily token usage trend; use the left and right arrow keys to step through days',
      'heat.title': 'Activity',
      'heat.hint': 'Last {days} days',
      'heat.less': 'Less',
      'heat.more': 'More',
      'heat.hoverHint': 'Hover a cell for that day',
      'heat.detail': '{tokens} tokens · {calls} calls',
      'perf.title': 'Provider performance',
      'perf.hint': 'Click the heatmap to switch days · hourly medians',
      'perf.tabSpeed': 'Speed',
      'perf.tabTtft': 'First token',
      'perf.reset': 'Back to today',
      'perf.loading': 'Loading that day…',
      'perf.empty': 'No performance samples for this day',
      'perf.samples': '{count} calls',
      'perf.unitSpeed': 'tok/s',
      'perf.noSampleHour': 'No samples this hour',
      'perf.a11y': 'Hourly provider output speed and first-token latency; use the left and right arrow keys to step through hours',
      'meta.updated': 'Updated {time}',
      'meta.scan': '{sessions} sessions / {readings} calls',
      'meta.truncated': 'latest {max} sessions only',
      'meta.source': 'Derived from local session logs; nothing leaves the machine.',
      'meta.unreadable': '{count} session logs unreadable (skipped)',
      'state.loading': 'Counting session logs…',
      'state.error': 'Could not read usage',
      'state.errorHint': 'The Host route returned no data. Try again in a moment.',
      'state.stale': 'Last sync failed; showing the previous snapshot',
      'a11y.icon': 'Open the usage dashboard',
    }

    /** Module-level view state shared by the panel and the sidebar label. */
    let ctxRef = null
    let activeLang = 'zh'
    let snapshotCache = null
    let snapshotAt = 0
    let inflight = null
    const performanceCache = new Map()

    /** Active language id from the Client locale service. */
    function readLang() {
      try {
        const active = ctxRef && ctxRef.locale && ctxRef.locale.getLocale().active
        return typeof active === 'string' && active.toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'en'
      }
    }

    function syncLang() {
      activeLang = readLang()
    }

    /** Current dictionary. Callers read it once per render. */
    function tr() {
      return activeLang === 'zh' ? ZH : EN
    }

    /** Resolve `{name}` placeholders in dictionary rows. */
    function fill(text, vars) {
      return String(text).replace(/\{(\w+)\}/g, (match, key) => (vars && vars[key] !== undefined ? String(vars[key]) : match))
    }

    // -------------------------------------------------------------- formatting

    function trimNum(value, digits) {
      let text = Number(value).toFixed(digits)
      if (text.indexOf('.') >= 0) text = text.replace(/0+$/, '').replace(/\.$/, '')
      return text
    }

    /** Grouped integer with narrow spaces as separators. */
    function fmtInt(value) {
      const rounded = Math.max(0, Math.round(num(value) || (typeof value === 'number' && Number.isFinite(value) ? value : 0)))
      return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /** Compact token count in the reader's language. */
    function fmtTokens(value, lang) {
      const n = Math.max(0, Number(value) || 0)
      if (n < 1000) return fmtInt(n)
      if (lang === 'zh') {
        if (n >= 1e8) return `${trimNum(n / 1e8, n >= 1e9 ? 1 : 2)} 亿`
        return `${trimNum(n / 1e4, n >= 1e6 ? 0 : 1)} 万`
      }
      if (n >= 1e9) return `${trimNum(n / 1e9, 2)}B`
      if (n >= 1e6) return `${trimNum(n / 1e6, 2)}M`
      return `${trimNum(n / 1e3, 1)}K`
    }

    /** Compact axis label without a space (SVG axis width budget). */
    function fmtAxis(value, lang) {
      const n = Math.max(0, Number(value) || 0)
      if (n >= 1e8) return `${trimNum(n / 1e8, 1)}${lang === 'zh' ? '亿' : 'B'}`
      if (n >= 1e4) return `${trimNum(n / 1e4, 0)}${lang === 'zh' ? '万' : 'K'}`
      if (n >= 1e3) return `${trimNum(n / 1e3, 0)}${lang === 'zh' ? 'k' : 'K'}`
      return trimNum(n, 0)
    }

    function fmtPct(value, digits) {
      const pct = clamp(Number(value) || 0, 0, 1) * 100
      return `${trimNum(pct, digits === undefined ? 1 : digits)}%`
    }

    function splitDay(key) {
      const parts = String(key || '').split('-')
      const year = Number(parts[0])
      const month = Number(parts[1])
      const day = Number(parts[2])
      if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
      return { year, month, day }
    }

    function dayFromKey(key) {
      const parts = splitDay(key)
      return parts === null ? null : new Date(parts.year, parts.month - 1, parts.day)
    }

    /** Monday-first weekday index (0..6). */
    function weekdayIndex(key) {
      const date = dayFromKey(key)
      return date === null ? 0 : (date.getDay() + 6) % 7
    }

    function shortDate(key, lang) {
      const parts = splitDay(key)
      if (parts === null) return key
      if (lang === 'zh') return `${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
      const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      return `${NAMES[parts.month - 1]} ${parts.day}`
    }

    function fullDate(key, lang) {
      const parts = splitDay(key)
      if (parts === null) return key
      if (lang === 'zh') {
        const WEEK = ['日', '一', '二', '三', '四', '五', '六']
        const date = dayFromKey(key)
        const weekday = date === null ? '' : ` 周${WEEK[date.getDay()]}`
        return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}${weekday}`
      }
      const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      const date = dayFromKey(key)
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      return `${NAMES[parts.month - 1]} ${parts.day}, ${parts.year}${date === null ? '' : ` (${names[date.getDay()]})`}`
    }

    function fmtClock(epochMs) {
      const date = new Date(Number(epochMs) || Date.now())
      if (Number.isNaN(date.getTime())) return '--:--'
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }

    /** Shared formatter for the direct-to-DOM number component. */
    function fmtMode(mode, value, lang) {
      if (mode === 'tokens') return fmtTokens(value, lang)
      if (mode === 'int') return fmtInt(value)
      if (mode === 'pct') return fmtPct(value)
      if (mode === 'rate') return trimNum(Math.max(0, Number(value) || 0), 1)
      return String(value)
    }

    /** Latency text: milliseconds below one second, seconds above. */
    function fmtLatency(ms, lang) {
      const value = Math.max(0, Number(ms) || 0)
      if (value >= 1000) return `${trimNum(value / 1000, 1)}${lang === 'zh' ? ' 秒' : 's'}`
      return `${Math.round(value)}ms`
    }

    /** Compact y-axis label for the performance chart. */
    function fmtPerfAxis(metric, value) {
      const number = Math.max(0, Number(value) || 0)
      if (metric === 'ttft') return number >= 1000 ? `${trimNum(number / 1000, 1)}s` : `${Math.round(number)}ms`
      return trimNum(number, 0)
    }

    /** Chart colours for providers; artwork colours, theme tokens keep the rest. */
    const PROVIDER_COLORS = ['#4c8dff', '#34d399', '#fbbf24', '#a78bfa', '#f472b6']

    /** Friendlier provider names, falling back to the raw id. */
    function providerLabel(id) {
      const NAMES = {
        'opencode-go': 'OpenCode',
        'minimax-cn': 'MiniMax',
        'deepseek-account': 'DeepSeek',
        'deepseek-official': 'DeepSeek',
        'deepseek-flash': 'DeepSeek',
      }
      const key = String(id === undefined || id === null || id === '' ? 'unknown' : id)
      if (NAMES[key] !== undefined) return NAMES[key]
      return key.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
    }

    function prefersReducedMotion() {
      try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches
      } catch {
        return false
      }
    }

    /** Nice axis upper bound: 1 / 2 / 2.5 / 5 × 10^k. */
    function niceCeil(value) {
      const n = Number(value) || 0
      if (n <= 0) return 1
      const power = Math.pow(10, Math.floor(Math.log10(n)))
      const scaled = n / power
      const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10
      return step * power
    }

    // ------------------------------------------------------------------- data

    function normalizeSnapshot(raw) {
      if (raw === null || typeof raw !== 'object' || raw.ok !== true || raw.totals === null || typeof raw.totals !== 'object') return null
      const rate = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
      const bucket = (value) => ({
        tokens: num(value && value.tokens),
        input: num(value && value.input),
        output: num(value && value.output),
        cacheRead: num(value && value.cacheRead),
        cacheWrite: num(value && value.cacheWrite),
        calls: num(value && value.calls),
        prompt: num(value && value.prompt),
        cacheHitRate: clamp(num(value && value.cacheHitRate), 0, 1),
        tokensPerSecond: rate(value && value.tokensPerSecond),
      })
      const daily = Array.isArray(raw.daily)
        ? raw.daily.filter((row) => row && typeof row === 'object' && typeof row.d === 'string').map((row) => ({
          d: row.d,
          tokens: num(row.tokens),
          input: num(row.input),
          output: num(row.output),
          cacheRead: num(row.cacheRead),
          cacheWrite: num(row.cacheWrite),
          calls: num(row.calls),
          tokensPerSecond: rate(row.tokensPerSecond),
        }))
        : []
      const models = Array.isArray(raw.models)
        ? raw.models.filter((row) => row && typeof row === 'object' && typeof row.model === 'string').map((row) => ({
          model: row.model,
          providers: Array.isArray(row.providers) ? row.providers.filter((p) => typeof p === 'string') : [],
          tokens: num(row.tokens),
          input: num(row.input),
          output: num(row.output),
          cacheRead: num(row.cacheRead),
          cacheWrite: num(row.cacheWrite),
          calls: num(row.calls),
          share: clamp(num(row.share), 0, 1),
        }))
        : []
      return {
        generatedAt: num(raw.generatedAt) || Date.now(),
        scan: {
          sessions: num(raw.scan && raw.scan.sessions),
          readings: num(raw.scan && raw.scan.readings),
          truncated: Boolean(raw.scan && raw.scan.truncated),
          maxSessions: num(raw.scan && raw.scan.maxSessions),
          cold: Boolean(raw.scan && raw.scan.cold),
          failed: num(raw.scan && raw.scan.failed),
          skipped: num(raw.scan && raw.scan.skipped),
        },
        window: {
          days: num(raw.window && raw.window.days),
          from: typeof (raw.window && raw.window.from) === 'string' ? raw.window.from : '',
          to: typeof (raw.window && raw.window.to) === 'string' ? raw.window.to : '',
        },
        totals: bucket(raw.totals),
        speed: {
          tokensPerSecond: rate(raw.speed && raw.speed.tokensPerSecond),
          decodeTokens: num(raw.speed && raw.speed.decodeTokens),
          decodeMs: num(raw.speed && raw.speed.decodeMs),
          samples: num(raw.speed && raw.speed.samples),
        },
        today: bucket(raw.today),
        month: bucket(raw.month),
        history: {
          tokens: num(raw.history && raw.history.tokens),
          calls: num(raw.history && raw.history.calls),
          reasoning: num(raw.history && raw.history.reasoning),
        },
        daily,
        models,
        performance: normalizePerformance(raw.performance),
      }
    }

    /**
     * One shared Host read. Concurrent callers coalesce onto the same request;
     * a cached snapshot younger than CLIENT_FRESH_MS answers immediately.
     */
    function loadSnapshot(force) {
      if (!force && snapshotCache !== null && Date.now() - snapshotAt < CLIENT_FRESH_MS) {
        return Promise.resolve(snapshotCache)
      }
      if (inflight !== null) return inflight
      const request = (async () => {
        const response = await fetch(force ? `${ROUTE}?refresh=1` : ROUTE, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
        })
        if (!response.ok) throw new Error(`snapshot http ${response.status}`)
        const data = normalizeSnapshot(await response.json())
        if (data === null) throw new Error('snapshot payload rejected')
        snapshotCache = data
        snapshotAt = Date.now()
        return data
      })()
      inflight = request
      return request.finally(() => {
        if (inflight === request) inflight = null
      })
    }

    /** Normalize one day's provider-performance payload (missing input = empty). */
    function normalizePerformance(raw) {
      const rate = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
      const providerRow = (row) => (row === null || typeof row !== 'object' ? null : {
        provider: typeof row.provider === 'string' && row.provider !== '' ? row.provider : 'unknown',
        tps: rate(row.tps),
        ttftMs: rate(row.ttftMs),
        speedSamples: num(row.speedSamples),
        ttftSamples: num(row.ttftSamples),
        samples: num(row.samples),
      })
      const providers = Array.isArray(raw && raw.providers)
        ? raw.providers.map(providerRow).filter((row) => row !== null)
        : []
      const hours = Array.isArray(raw && raw.hours)
        ? raw.hours
          .filter((row) => row !== null && typeof row === 'object' && typeof row.h === 'number')
          .map((row) => ({
            h: clamp(Math.round(row.h), 0, 23),
            providers: Array.isArray(row.providers) ? row.providers.map(providerRow).filter((item) => item !== null) : [],
          }))
          .sort((left, right) => left.h - right.h)
        : []
      return {
        date: raw !== null && raw !== undefined && typeof raw.date === 'string' ? raw.date : '',
        providers,
        hours,
      }
    }

    /** Fetch (and cache) one day's provider-performance fold. */
    async function loadPerformance(date, signal) {
      const cached = performanceCache.get(date)
      if (cached !== undefined) return cached
      const response = await fetch(`${PERF_ROUTE}?date=${encodeURIComponent(date)}`, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal,
      })
      if (!response.ok) throw new Error(`performance http ${response.status}`)
      const data = await response.json()
      if (data === null || typeof data !== 'object' || data.ok !== true) throw new Error('performance payload rejected')
      const performance = normalizePerformance(data.performance)
      performance.date = typeof data.date === 'string' && data.date !== '' ? data.date : date
      performanceCache.set(date, performance)
      return performance
    }

    function hasAnyUsage(snapshot) {
      return Boolean(snapshot && (snapshot.totals.tokens > 0 || snapshot.totals.calls > 0))
    }

    // ------------------------------------------------------------------ styles

    const CSS = `
.up-root{--up-1:#dff2fe;--up-2:#a0dcfd;--up-3:#60b3fe;--up-4:#0c70f3;--up-out:#8b5cf6;--up-accent:#0c70f3;--up-warn:#b45309;--up-spring:cubic-bezier(.34,1.56,.64,1);--up-ease:cubic-bezier(.22,1,.36,1);height:100%;min-height:0;overflow:auto;overscroll-behavior:contain;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:400 13px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
[data-ds-dark-theme] .up-root{--up-1:#13324f;--up-2:#1c4c78;--up-3:#2f74b8;--up-4:#69b3ff;--up-out:#a78bfa;--up-accent:#69b3ff;--up-warn:#fbbf24}
.up-root.is-hidden *{animation-play-state:paused!important}
.up-root ::selection{background:var(--up-accent);color:#fff}
.up-root :focus-visible{outline:2px solid var(--up-accent);outline-offset:2px;border-radius:6px}
.up-inner{max-width:1120px;margin:0 auto;padding:20px 28px 40px;display:flex;flex-direction:column;gap:14px}
.up-head{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;padding:2px 2px 0}
.up-head-text{min-width:0;display:flex;flex-direction:column;gap:3px}
.up-title-row{display:flex;align-items:center;gap:9px}
.up-title{margin:0;font-size:19px;font-weight:600;line-height:1.3;letter-spacing:-.01em}
.up-live{width:7px;height:7px;border-radius:50%;background:var(--up-accent);position:relative;flex:none}
.up-live:after{content:"";position:absolute;inset:-5px;border-radius:50%;border:1px solid var(--up-accent);opacity:0;animation:up-ping 2.6s var(--up-ease) infinite}
.up-sub{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere}
.up-head-actions{margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.up-seg{--up-seg-w:56px;position:relative;display:inline-flex;padding:3px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);isolate:isolate}
.up-seg-pill{position:absolute;top:3px;left:3px;width:var(--up-seg-w);height:calc(100% - 6px);border-radius:7px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 1px 2px rgba(0,0,0,.06);transform:translateX(calc(var(--i,0) * var(--up-seg-w)));transition:transform .34s var(--up-spring);z-index:0}
.up-seg-btn{position:relative;z-index:1;appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);width:var(--up-seg-w);height:24px;padding:0;border-radius:7px;font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:color .2s ease}
.up-seg-btn.is-active{color:var(--dsw-alias-label-primary);font-weight:500}
.up-seg-btn:hover{color:var(--dsw-alias-label-primary)}
.up-refresh{appearance:none;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;transition:background-color .16s ease,transform .16s var(--up-ease),opacity .16s ease}
.up-refresh:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.up-refresh:active:not(:disabled){transform:scale(.97)}
.up-refresh:disabled{opacity:.6;cursor:default}
.up-refresh svg{width:13px;height:13px;display:block}
.up-refresh.is-busy svg{animation:up-spin .9s linear infinite}
.up-sync{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.up-sync-dot{width:5px;height:5px;border-radius:50%;background:var(--up-accent);animation:up-breathe 1.4s ease-in-out infinite}
.up-warn{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:10px;border:1px solid color-mix(in srgb,var(--up-warn) 35%,transparent);background:color-mix(in srgb,var(--up-warn) 8%,transparent);color:var(--dsw-alias-label-primary);font-size:12px}
.up-card{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);min-width:0}
.up-stats{display:grid;grid-template-columns:1.3fr 1fr 1fr 1fr 1.1fr;gap:12px}
.up-stat{position:relative;padding:14px 16px;display:flex;flex-direction:column;gap:6px;overflow:hidden;transition:transform .3s var(--up-ease),border-color .3s ease,box-shadow .3s ease}
.up-stat:hover{transform:translateY(-1px);border-color:var(--dsw-alias-border-l2);box-shadow:0 10px 26px -18px rgba(4,24,54,.4)}
.up-stat-label{color:var(--dsw-alias-label-secondary);font-size:12px;display:flex;align-items:center;gap:6px;white-space:nowrap}
.up-stat-value{display:flex;align-items:baseline;gap:6px;min-height:30px}
.up-num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum";letter-spacing:-.02em}
.up-hero .up-num{font-size:30px;font-weight:600;line-height:1.1}
.up-stat-value .up-num{font-size:22px;font-weight:600;line-height:1.15}
.up-hero-unit{color:var(--dsw-alias-label-secondary);font-size:11.5px;letter-spacing:.01em}
.up-hero-meta{display:flex;align-items:center;gap:12px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.up-hero-meta b{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}
.up-dot{display:inline-block;width:3px;height:3px;border-radius:50%;background:var(--dsw-alias-border-l2);flex:none;vertical-align:middle}
.up-hero:before{content:"";position:absolute;right:-46px;top:-64px;width:190px;height:190px;border-radius:50%;background:radial-gradient(circle at 40% 40%,color-mix(in srgb,var(--up-accent) 26%,transparent),transparent 68%);filter:blur(8px);pointer-events:none;animation:up-drift 22s ease-in-out infinite alternate}
.up-delta{display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:999px;font-size:11px;line-height:1.5;font-variant-numeric:tabular-nums;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.up-delta.up{color:var(--up-accent)}
.up-delta.down{color:var(--dsw-alias-state-warn-primary)}
.up-stat-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.up-gauge-wrap{position:relative;width:44px;height:44px;flex:none;align-self:flex-start}
.up-gauge{width:44px;height:44px;display:block;transform:rotate(-90deg)}
.up-gauge-track{stroke:var(--dsw-alias-border-l1)}
.up-gauge-arc{stroke:var(--up-accent);transition:stroke-dashoffset 1s var(--up-ease)}
.up-gauge-label{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.up-cache-body{display:flex;align-items:center;gap:12px;min-width:0}
.up-cache-body .up-stat-value .up-num{font-size:24px}
.up-grid2{display:grid;grid-template-columns:1.15fr 1fr;gap:12px}
.up-panel{padding:15px 16px 13px;display:flex;flex-direction:column;gap:12px;min-width:0}
.up-panel-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.up-panel-title{font-size:13px;font-weight:600;margin:0}
.up-panel-hint{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.up-panel-head .up-spacer{margin-left:auto}
.up-stack{height:12px;border-radius:99px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);display:flex;gap:2px}
.up-stack-track{display:flex;width:100%;gap:2px;transform-origin:left center}
.up-root[data-ready] .up-stack-track{animation:up-grow .9s var(--up-ease) both}
.up-stack-seg{height:100%;border-radius:99px;min-width:2px}
.up-legend{display:flex;flex-direction:column;gap:2px}
.up-legend-row{display:flex;align-items:center;gap:9px;padding:6px 0;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 55%,transparent);font-size:12px}
.up-legend-row:last-child{border-bottom:0}
.up-legend-dot{width:8px;height:8px;border-radius:3px;flex:none}
.up-legend-name{flex:1;min-width:0;display:flex;align-items:baseline;gap:6px;overflow:hidden}
.up-legend-name small{color:var(--dsw-alias-label-secondary);font-size:10.5px;white-space:nowrap}
.up-legend-value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);white-space:nowrap}
.up-legend-share{width:48px;text-align:right;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.up-panel-foot{display:flex;align-items:center;gap:14px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11.5px;padding-top:2px}
.up-panel-foot b{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}
.up-models{display:flex;flex-direction:column;gap:9px}
.up-model{display:flex;flex-direction:column;gap:4px;min-width:0}
.up-model-top{display:flex;align-items:baseline;gap:8px;min-width:0}
.up-model-name{font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.up-model-name small{color:var(--dsw-alias-label-secondary);font-size:10.5px;margin-left:5px}
.up-model-top .up-spacer{margin-left:auto}
.up-model-share{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.up-model-value{font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.up-model-bar{height:5px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.up-model-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,var(--up-3),var(--up-4));transform-origin:left center;transform:scaleX(0);transition:transform .85s var(--up-ease)}
.up-root[data-ready] .up-model-fill{transform:scaleX(var(--w,0));transition-delay:var(--d,0ms)}
.up-model-other .up-model-name{color:var(--dsw-alias-label-secondary)}
.up-model-other .up-model-fill{background:var(--dsw-alias-border-l2)}
.up-empty-inline{color:var(--dsw-alias-label-secondary);font-size:12px;padding:8px 0}
.up-seg-metric{--up-seg-w:64px}
.up-perf-chart{margin-top:2px}
.up-perf-line{fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.up-perf-point{fill:var(--dsw-alias-bg-base);stroke-width:2}
.up-perf-tip-row{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.up-perf-tip-dot{width:7px;height:7px;border-radius:50%;flex:none}
.up-perf-tip-name{flex:1;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis}
.up-perf-legend{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-secondary);padding-top:2px}
.up-perf-chip{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-primary)}
.up-perf-chip small{color:var(--dsw-alias-label-secondary);font-size:10.5px}
.up-perf-chip-dot{width:8px;height:8px;border-radius:50%;flex:none}
.up-perf-hint{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.85}
.up-perf-panel{position:relative}
.up-perf-body{position:relative;display:flex;flex-direction:column;gap:12px;min-height:248px}
.up-perf-empty{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px}
.up-perf-loading{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;gap:8px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 74%,transparent);color:var(--dsw-alias-label-secondary);font-size:12px;pointer-events:none;animation:up-fade .16s ease both}
.up-perf-body.is-stale .up-perf-chart,.up-perf-body.is-stale .up-perf-legend{opacity:.32;pointer-events:none}
.up-perf-reset.is-hidden{display:none}
.up-sk-perf{height:268px}
.up-trend{position:relative}
.up-trend-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.up-trend-readout{color:var(--dsw-alias-label-secondary);font-size:11.5px;font-variant-numeric:tabular-nums}
.up-chart{position:relative;width:100%;margin-top:2px;touch-action:pan-y}
.up-chart svg{display:block;width:100%;height:auto;overflow:visible}
.up-chart-axis{fill:var(--dsw-alias-label-secondary);font-size:10px;font-family:inherit}
.up-chart-grid{stroke:var(--dsw-alias-border-l1);stroke-width:1;stroke-dasharray:3 5}
.up-chart-line{fill:none;stroke:var(--up-4);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.up-chart-area{fill:url(#up-area-grad);animation:up-fade .8s var(--up-ease) .18s both}
.up-chart-draw{stroke-dasharray:1;stroke-dashoffset:1;animation:up-draw 1s var(--up-ease) .04s forwards}
.up-chart-cross{stroke:var(--dsw-alias-border-l2);stroke-width:1;stroke-dasharray:3 4}
.up-chart-dot{fill:var(--dsw-alias-bg-base);stroke:var(--up-4);stroke-width:2}
.up-chart-hit{fill:transparent;cursor:crosshair}
.up-chart-tip{position:absolute;pointer-events:none;transform:translate(-50%,-100%);min-width:132px;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 10px 30px -14px rgba(3,20,42,.45);font-size:11.5px;line-height:1.5;z-index:2;transition:opacity .12s ease}
.up-chart-tip-day{color:var(--dsw-alias-label-secondary);font-size:10.5px}
.up-chart-tip-value{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.up-chart-tip-row{display:flex;justify-content:space-between;gap:14px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.up-chart-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:12px;pointer-events:none}
.up-heat-wrap{display:flex;align-items:flex-start;gap:18px;flex-wrap:wrap}
.up-heat{display:flex;gap:3px;padding:2px 0}
.up-heat-col{display:flex;flex-direction:column;gap:3px}
.up-heat-cell{width:12px;height:12px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);opacity:0;transform:scale(.55);animation:up-cell .4s var(--up-ease) both;animation-delay:min(calc(var(--i) * 3ms),380ms);transition:background-color .16s ease,box-shadow .16s ease;cursor:pointer}
.up-heat-cell.lv1{background:var(--up-1)}
.up-heat-cell.lv2{background:var(--up-2)}
.up-heat-cell.lv3{background:var(--up-3)}
.up-heat-cell.lv4{background:var(--up-4)}
.up-heat-cell.is-today{box-shadow:0 0 0 1.5px var(--dsw-alias-bg-base),0 0 0 2.5px var(--up-accent)}
.up-heat-cell.is-selected{box-shadow:0 0 0 1.5px var(--dsw-alias-bg-base),0 0 0 2.5px var(--up-out)}
.up-heat-legend .up-heat-cell{cursor:default}
.up-heat-cell.is-hover{background:var(--up-accent)!important;box-shadow:0 0 0 3px color-mix(in srgb,var(--up-accent) 22%,transparent)}
.up-heat-side{display:flex;flex-direction:column;gap:8px;min-width:200px;flex:1;padding-top:2px}
.up-heat-legend{display:flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary);font-size:10.5px}
.up-heat-legend .up-heat-cell{width:10px;height:10px;animation:none;opacity:1;transform:none;border-radius:2.5px}
.up-heat-readout{min-height:20px;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.up-heat-readout b{color:var(--dsw-alias-label-primary);font-weight:500}
.up-heat-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary);opacity:.85}
.up-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11px;padding:2px 4px 0;line-height:1.6}
.up-foot .up-dot{width:3px;height:3px;border-radius:50%;background:var(--dsw-alias-border-l2)}
.up-unreadable{color:var(--up-warn)}
.up-skeleton{display:flex;flex-direction:column;gap:12px}
.up-stat-unit{margin-left:1px;color:var(--dsw-alias-label-secondary);font-size:11.5px;align-self:flex-end;padding-bottom:3px}
.up-sk{position:relative;overflow:hidden;border-radius:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.up-sk:after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent),transparent);animation:up-shimmer 1.5s ease-in-out infinite}
.up-sk-row{display:grid;grid-template-columns:1.45fr 1fr 1fr 1.1fr;gap:12px}
.up-sk-stats{height:96px;display:grid;grid-template-columns:1.3fr 1fr 1fr 1fr 1.1fr;gap:12px}
.up-sk-stats .up-sk{height:96px}
.up-sk-grid2{display:grid;grid-template-columns:1.15fr 1fr;gap:12px}
.up-sk-grid2 .up-sk{height:208px}
.up-sk-trend{height:252px}
.up-sk-heat{height:148px}
.up-loading-spin{width:12px;height:12px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--up-accent);animation:up-spin .8s linear infinite}
.up-empty,.up-error{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:220px;padding:28px;text-align:center}
.up-empty-art{color:var(--up-accent);opacity:.9;animation:up-bob 3.6s ease-in-out infinite alternate}
.up-empty-title{font-size:14px;font-weight:600}
.up-empty-hint,.up-error-hint{color:var(--dsw-alias-label-secondary);font-size:12px;max-width:340px}
.up-error-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.up-empty .up-refresh,.up-error .up-refresh{margin-top:6px}
.up-rise{opacity:0}
.up-root[data-ready] .up-rise{animation:up-rise .56s var(--up-ease) both;animation-delay:var(--d,0ms)}
@keyframes up-rise{from{opacity:0;transform:translate3d(0,10px,0)}to{opacity:1;transform:none}}
@keyframes up-grow{from{transform:scaleX(.02)}to{transform:none}}
@keyframes up-draw{to{stroke-dashoffset:0}}
@keyframes up-fade{from{opacity:0}to{opacity:1}}
@keyframes up-cell{to{opacity:1;transform:none}}
@keyframes up-spin{to{transform:rotate(360deg)}}
@keyframes up-shimmer{to{transform:translateX(100%)}}
@keyframes up-ping{0%{opacity:.6;transform:scale(.6)}70%,100%{opacity:0;transform:scale(1.6)}}
@keyframes up-breathe{0%,100%{opacity:.35}50%{opacity:1}}
@keyframes up-drift{from{transform:translate3d(0,0,0) scale(1)}to{transform:translate3d(-16px,14px,0) scale(1.12)}}
@keyframes up-bob{from{transform:translateY(0)}to{transform:translateY(-5px)}}
@media (prefers-reduced-motion:reduce){
  .up-root *{animation:none!important;transition:none!important}
  .up-rise{opacity:1!important}
  .up-heat-cell{opacity:1!important;transform:none!important}
  .up-model-fill{transform:scaleX(var(--w,0))!important}
  .up-stack-track{transform:none!important}
  .up-chart-line{stroke-dasharray:none!important;stroke-dashoffset:0!important}
}
@media (max-width:980px){.up-stats,.up-sk-stats,.up-sk-row{grid-template-columns:1fr 1fr}.up-hero{grid-column:1/-1}}
@media (max-width:900px){.up-grid2,.up-sk-grid2{grid-template-columns:1fr}.up-perf-body{min-height:276px}}
@media (max-width:640px){.up-inner{padding:16px 14px 32px}.up-stats,.up-sk-stats,.up-sk-row{grid-template-columns:1fr}.up-head-actions{margin-left:0}.up-seg{--up-seg-w:48px}.up-hero .up-num{font-size:27px}.up-perf-reset.is-hidden{display:inline-flex}}
`

    // ------------------------------------------------------------- primitives

    /**
     * Write formatted values straight into the DOM from one rAF. Avoids a
     * React render per animation frame while keeping the count-up physical.
     */
    function AnimatedNumber(props) {
      const { value, mode, lang, className } = props
      const nodeRef = useRef(null)
      const previousRef = useRef(0)
      const rafRef = useRef(0)

      useEffect(() => {
        const node = nodeRef.current
        if (node === null) return undefined
        const to = Number.isFinite(value) ? Math.max(0, value) : 0
        const from = previousRef.current
        previousRef.current = to
        const write = (current) => {
          node.textContent = fmtMode(mode, current, lang)
        }
        if (prefersReducedMotion() || from === to) {
          write(to)
          return undefined
        }
        let startedAt = 0
        const step = (now) => {
          if (startedAt === 0) startedAt = now
          const progress = clamp((now - startedAt) / 820, 0, 1)
          if (progress >= 1) {
            write(to)
            return
          }
          const eased = 1 - Math.pow(2, -9 * progress)
          write(from + (to - from) * eased)
          rafRef.current = window.requestAnimationFrame(step)
        }
        rafRef.current = window.requestAnimationFrame(step)
        return () => window.cancelAnimationFrame(rafRef.current)
      }, [value, mode, lang])

      return h('span', { ref: nodeRef, className: className === undefined ? 'up-num' : `up-num ${className}` })
    }

    /** One-shot mount flag used to start entrance/transition animations. */
    function useReady() {
      const [ready, setReady] = useState(false)
      useEffect(() => {
        const frame = window.requestAnimationFrame(() => setReady(true))
        return () => window.cancelAnimationFrame(frame)
      }, [])
      return ready
    }

    /**
     * Measured content width for the SVG charts. The first measure runs in a
     * layout effect so the viewBox already matches the real width on the first
     * painted frame; a ResizeObserver keeps it fresh. Without this an 860px
     * default viewBox briefly renders the chart taller and then snaps, which
     * shifts the whole page while it is scrolled to the bottom.
     */
    function useMeasuredWidth() {
      const ref = useRef(null)
      const [width, setWidth] = useState(860)
      const measure = useCallback(() => {
        const element = ref.current
        if (element === null) return
        const next = Math.max(320, Math.round(element.getBoundingClientRect().width))
        setWidth((current) => (Math.abs(current - next) > 2 ? next : current))
      }, [])
      useLayoutEffect(measure, [measure])
      useEffect(() => {
        const element = ref.current
        if (element === null || typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver(() => measure())
        observer.observe(element)
        return () => observer.disconnect()
      }, [measure])
      return [ref, width]
    }

    /** Re-render whenever the Client locale changes. */
    function useLang() {
      const [lang, setLang] = useState(() => activeLang)
      useEffect(() => {
        syncLang()
        setLang(activeLang)
        if (ctxRef === null || !ctxRef.locale) return undefined
        const dispose = ctxRef.locale.subscribe(() => {
          syncLang()
          setLang(activeLang)
        })
        return dispose
      }, [])
      return lang
    }

    /** Sidebar glyph: three ascending bars; bars nudge up on hover. */
    function PanelIcon(props) {
      const size = Number.isFinite(props && props.size) && props.size > 0 ? props.size : 18
      const active = Boolean(props && props.active)
      const color = active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)'
      return h(
        'svg',
        {
          className: 'up-glyph',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block', color },
        },
        h('rect', { className: 'up-glyph-bar', x: 3.4, y: 13.2, width: 4, height: 7.4, rx: 1.4, fill: 'currentColor', opacity: active ? 0.95 : 0.62 }),
        h('rect', { className: 'up-glyph-bar', x: 10, y: 9, width: 4, height: 11.6, rx: 1.4, fill: 'currentColor', opacity: active ? 1 : 0.82 }),
        h('rect', { className: 'up-glyph-bar', x: 16.6, y: 4.8, width: 4, height: 15.8, rx: 1.4, fill: 'currentColor', opacity: active ? 1 : 0.4 }),
        h('circle', { cx: 19.2, cy: 3.2, r: 1.5, fill: 'currentColor', opacity: active ? 1 : 0.7 }),
      )
    }

    /** Small unlabelled state chip. */
    function DeltaChip(props) {
      const { value, T } = props
      if (value === null || !Number.isFinite(value)) return null
      const up = value >= 0
      return h(
        'span',
        { className: `up-delta${up ? ' up' : ' down'}`, title: T['stat.vsYesterday'] },
        `${up ? '▲' : '▼'} ${trimNum(Math.abs(value) * 100, 1)}%`,
      )
    }

    /** One of the four overview cards. */
    function StatCard(props) {
      const { T, delay, children, className } = props
      return h(
        'div',
        { className: `up-card up-stat up-rise ${className || ''}`.trim(), style: { '--d': `${delay}ms` } },
        children,
      )
    }

    /** Animated SVG gauge used by the cache-hit card. */
    function Gauge(props) {
      const rate = clamp(Number(props.rate) || 0, 0, 1)
      return h(
        'div',
        { className: 'up-gauge-wrap' },
        h(
          'svg',
          { className: 'up-gauge', viewBox: '0 0 48 48', 'aria-hidden': true },
          h('circle', { className: 'up-gauge-track', cx: 24, cy: 24, r: 19, fill: 'none', strokeWidth: 4 }),
          h('circle', {
            className: 'up-gauge-arc',
            cx: 24,
            cy: 24,
            r: 19,
            fill: 'none',
            strokeWidth: 4,
            strokeLinecap: 'round',
            pathLength: 1,
            style: {
              strokeDasharray: '1 1',
              strokeDashoffset: props.ready ? 1 - rate : 1,
            },
          }),
        ),
      )
    }

    // ------------------------------------------------------------------ chart

    /** Catmull-Rom-ish smoothing clamped to the plot band. */
    function smoothPath(points, top, bottom) {
      if (points.length === 0) return ''
      if (points.length === 1) return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`
      const tension = 0.18
      const clampY = (value) => clamp(value, top, bottom)
      let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`
      for (let index = 0; index < points.length - 1; index += 1) {
        const p0 = points[index - 1] || points[index]
        const p1 = points[index]
        const p2 = points[index + 1]
        const p3 = points[index + 2] || p2
        const c1x = p1.x + (p2.x - p0.x) * tension
        const c1y = clampY(p1.y + (p2.y - p0.y) * tension)
        const c2x = p2.x - (p3.x - p1.x) * tension
        const c2y = clampY(p2.y - (p3.y - p1.y) * tension)
        path += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`
      }
      return path
    }

    /** Daily token trend with hover crosshair and keyboard stepping. */
    function TrendChart(props) {
      const { series, lang, T } = props
      const [wrapRef, width] = useMeasuredWidth()
      const [hover, setHover] = useState(-1)
      const HEIGHT = 212
      const PAD = { top: 16, right: 12, bottom: 24, left: 46 }
      const innerWidth = Math.max(80, width - PAD.left - PAD.right)
      const innerHeight = HEIGHT - PAD.top - PAD.bottom

      const points = useMemo(() => {
        const list = Array.isArray(series) ? series : []
        const max = Math.max(1, ...list.map((row) => num(row.tokens)))
        const bound = niceCeil(max)
        const count = list.length
        return list.map((row, index) => {
          const ratio = count <= 1 ? 0.5 : index / (count - 1)
          return {
            row,
            x: PAD.left + ratio * innerWidth,
            y: PAD.top + innerHeight * (1 - num(row.tokens) / bound),
          }
        }).concat([])
      }, [series, innerWidth, innerHeight])

      const bound = useMemo(() => {
        const list = Array.isArray(series) ? series : []
        return niceCeil(Math.max(1, ...list.map((row) => num(row.tokens))))
      }, [series])

      const linePath = useMemo(
        () => smoothPath(points, PAD.top, PAD.top + innerHeight),
        [points, innerHeight],
      )
      const areaPath = useMemo(() => {
        if (points.length === 0) return ''
        const first = points[0]
        const last = points[points.length - 1]
        const floor = PAD.top + innerHeight
        return `${linePath} L ${last.x.toFixed(2)} ${floor} L ${first.x.toFixed(2)} ${floor} Z`
      }, [linePath, points, innerHeight])

      const activeIndex = hover >= 0 && hover < points.length ? hover : -1
      const active = activeIndex >= 0 ? points[activeIndex] : null

      const handlePointer = (event) => {
        if (points.length === 0) return
        const element = wrapRef.current
        if (element === null) return
        const rect = element.getBoundingClientRect()
        const px = event.clientX - rect.left
        const ratio = clamp((px - PAD.left) / innerWidth, 0, 1)
        const index = points.length <= 1 ? 0 : Math.round(ratio * (points.length - 1))
        setHover((current) => (current === index ? current : index))
      }
      const handleKey = (event) => {
        if (points.length === 0) return
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const direction = event.key === 'ArrowRight' ? 1 : -1
        setHover((current) => {
          const base = current < 0 ? (direction > 0 ? -1 : points.length) : current
          return clamp(base + direction, 0, points.length - 1)
        })
      }

      const axisRows = [0, 0.5, 1].map((fraction) => ({
        y: PAD.top + innerHeight * (1 - fraction),
        label: fmtAxis(bound * fraction, lang),
      }))
      const labelIndices = points.length === 0 ? [] : [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])]

      return h(
        'div',
        {
          className: 'up-chart',
          ref: wrapRef,
          role: 'img',
          tabIndex: 0,
          'aria-label': T['trend.a11y'],
          onPointerMove: (event) => {
            if (event.pointerType === 'touch') return
            handlePointer(event)
          },
          onPointerLeave: () => setHover(-1),
          onBlur: () => setHover(-1),
          onKeyDown: handleKey,
        },
        h(
          'svg',
          { viewBox: `0 0 ${width} ${HEIGHT}`, width: '100%', 'aria-hidden': true },
          h(
            'defs',
            null,
            h(
              'linearGradient',
              { id: 'up-area-grad', x1: '0', y1: '0', x2: '0', y2: '1' },
              h('stop', { offset: '0%', stopColor: 'var(--up-4)', stopOpacity: 0.22 }),
              h('stop', { offset: '100%', stopColor: 'var(--up-4)', stopOpacity: 0 }),
            ),
          ),
          axisRows.map((row, index) => h('g', { key: `grid-${index}` },
            h('line', { className: 'up-chart-grid', x1: PAD.left, x2: width - PAD.right, y1: row.y, y2: row.y }),
            h('text', { className: 'up-chart-axis', x: PAD.left - 8, y: row.y, textAnchor: 'end', dominantBaseline: 'middle' }, row.label),
          )),
          labelIndices.map((index) => {
            const point = points[index]
            if (!point) return null
            const anchor = index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'
            return h('text', {
              key: `x-${index}`,
              className: 'up-chart-axis',
              x: point.x,
              y: HEIGHT - 6,
              textAnchor: anchor,
            }, shortDate(point.row.d, lang))
          }),
          points.length > 1 ? h('path', { className: 'up-chart-area', d: areaPath }) : null,
          points.length > 1 ? h('path', { className: 'up-chart-line up-chart-draw', d: linePath, pathLength: 1 }) : null,
          points.length === 1 ? h('circle', { className: 'up-chart-dot', cx: points[0].x, cy: points[0].y, r: 3 }) : null,
          active !== null ? h('g', null,
            h('line', { className: 'up-chart-cross', x1: active.x, x2: active.x, y1: PAD.top, y2: PAD.top + innerHeight }),
            h('circle', { className: 'up-chart-dot', cx: active.x, cy: active.y, r: 3.5 }),
          ) : null,
          h('rect', {
            className: 'up-chart-hit',
            x: PAD.left,
            y: PAD.top,
            width: innerWidth,
            height: innerHeight,
          }),
        ),
        active !== null
          ? h(
            'div',
            {
              className: 'up-chart-tip',
              style: {
                left: `${clamp(active.x, 70, width - 70)}px`,
                top: `${clamp(active.y - 12, 8, HEIGHT - 12)}px`,
              },
            },
            h('div', { className: 'up-chart-tip-day' }, fullDate(active.row.d, lang)),
            h('div', { className: 'up-chart-tip-value' }, `${fmtTokens(active.row.tokens, lang)} ${T['unit.tokens']}`),
            h('div', { className: 'up-chart-tip-row' },
              h('span', null, fill(T['trend.calls'], { calls: fmtInt(active.row.calls) })),
              h('span', null, fmtPct(active.row.tokens > 0 ? active.row.cacheRead / Math.max(1, active.row.input + active.row.cacheRead + active.row.cacheWrite) : 0, 0)),
            ),
            active.row.tokensPerSecond > 0
              ? h('div', { className: 'up-chart-tip-row' }, h('span', null, fill(T['trend.speed'], { tps: trimNum(active.row.tokensPerSecond, 1) })))
              : null,
          )
          : null,
        points.length === 0 ? h('div', { className: 'up-chart-empty' }, T['trend.noData']) : null,
      )
    }

    // ---------------------------------------------------------------- heatmap

    /** Last N daily buckets laid out as Monday-first week columns. */
    function Heatmap(props) {
      const { daily, lang, T, selectedDay, onSelectDay } = props
      const [hover, setHover] = useState(-1)

      const layout = useMemo(() => {
        const windowDays = (Array.isArray(daily) ? daily : []).slice(-119)
        if (windowDays.length === 0) return { columns: [], days: [], max: 0 }
        const lead = weekdayIndex(windowDays[0].d)
        const cells = new Array(lead).fill(null).concat(windowDays)
        const columns = []
        for (let index = 0; index < cells.length; index += 7) columns.push(cells.slice(index, index + 7))
        const max = Math.max(1, ...windowDays.map((row) => num(row.tokens)))
        return { columns, days: windowDays, max }
      }, [daily])

      const todayKey = layout.days.length > 0 ? layout.days[layout.days.length - 1].d : ''
      const levelOf = (tokens) => {
        if (!(tokens > 0)) return 0
        return clamp(Math.ceil((tokens / layout.max) * 4), 1, 4)
      }
      const active = hover >= 0 && hover < layout.days.length ? layout.days[hover] : null

      let runningIndex = 0
      return h(
        'div',
        { className: 'up-heat-wrap' },
        h(
          'div',
          { className: 'up-heat', role: 'img', 'aria-label': fill(T['heat.hint'], { days: layout.days.length }) },
          layout.columns.map((column, columnIndex) =>
            h(
              'div',
              { className: 'up-heat-col', key: `col-${columnIndex}` },
              column.map((row, rowIndex) => {
                if (row === null) return h('div', { key: `pad-${columnIndex}-${rowIndex}`, className: 'up-heat-cell', style: { background: 'transparent', boxShadow: 'none', animation: 'none', opacity: 1 } })
                const index = runningIndex
                runningIndex += 1
                const level = levelOf(row.tokens)
                return h('div', {
                  key: `${row.d}`,
                  className: `up-heat-cell${level > 0 ? ` lv${level}` : ''}${row.d === todayKey ? ' is-today' : ''}${row.d === selectedDay ? ' is-selected' : ''}${index === hover ? ' is-hover' : ''}`,
                  style: { '--i': index },
                  title: `${fullDate(row.d, lang)} · ${fmtTokens(row.tokens, lang)} ${T['unit.tokens']}`,
                  onMouseEnter: () => setHover(index),
                  onMouseLeave: () => setHover((current) => (current === index ? -1 : current)),
                  onClick: onSelectDay === undefined ? undefined : () => onSelectDay(row.d),
                })
              }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'up-heat-side' },
          h(
            'div',
            { className: 'up-heat-legend' },
            h('span', null, T['heat.less']),
            h('div', { className: 'up-heat-cell' }),
            h('div', { className: 'up-heat-cell lv1' }),
            h('div', { className: 'up-heat-cell lv2' }),
            h('div', { className: 'up-heat-cell lv3' }),
            h('div', { className: 'up-heat-cell lv4' }),
            h('span', null, T['heat.more']),
          ),
          h(
            'div',
            { className: 'up-heat-readout' },
            active === null
              ? h('span', { className: 'up-heat-hint' }, T['heat.hoverHint'])
              : h('span', null,
                h('b', null, fullDate(active.d, lang)),
                `　${fill(T['heat.detail'], { tokens: fmtInt(active.tokens), calls: fmtInt(active.calls) })}`,
              ),
          ),
        ),
      )
    }


    /** Hourly multi-provider speed / first-token chart for one selected day. */
    function PerformanceChart(props) {
      const { performance, metric, lang, T } = props
      const [wrapRef, width] = useMeasuredWidth()
      const [hover, setHover] = useState(-1)
      const HEIGHT = 210
      const PAD = { top: 16, right: 12, bottom: 26, left: 46 }
      const innerWidth = Math.max(80, width - PAD.left - PAD.right)
      const innerHeight = HEIGHT - PAD.top - PAD.bottom

      const providers = useMemo(
        () => (performance && Array.isArray(performance.providers) ? performance.providers.slice(0, 4) : []),
        [performance],
      )
      const hours = useMemo(
        () => (performance && Array.isArray(performance.hours) ? performance.hours : []),
        [performance],
      )
      const lines = useMemo(() => {
        const output = []
        providers.forEach((provider, index) => {
          const points = []
          for (const hour of hours) {
            const entry = hour.providers.find((item) => item.provider === provider.provider)
            if (entry === undefined) continue
            const value = metric === 'ttft' ? entry.ttftMs : entry.tps
            if (!(value > 0)) continue
            points.push({ h: hour.h, value })
          }
          if (points.length > 0) {
            output.push({ provider: provider.provider, color: PROVIDER_COLORS[index % PROVIDER_COLORS.length], points })
          }
        })
        return output
      }, [providers, hours, metric])

      const maxValue = useMemo(() => {
        let max = 0
        for (const line of lines) for (const point of line.points) max = Math.max(max, point.value)
        return niceCeil(max)
      }, [lines])

      const hoverHours = useMemo(() => {
        const seen = new Set()
        for (const line of lines) for (const point of line.points) seen.add(point.h)
        return [...seen].sort((left, right) => left - right)
      }, [lines])

      const activeIndex = hover >= 0 && hover < hoverHours.length ? hover : -1
      const activeHour = activeIndex >= 0 ? hoverHours[activeIndex] : -1
      const activeRows = useMemo(() => {
        if (activeHour < 0) return []
        return lines
          .map((line) => {
            const point = line.points.find((item) => item.h === activeHour)
            return point === undefined ? null : { line, value: point.value }
          })
          .filter((row) => row !== null)
          .sort((left, right) => right.value - left.value)
      }, [lines, activeHour])

      const xOf = (hour) => PAD.left + (hour / 23) * innerWidth
      const yOf = (value) => PAD.top + innerHeight * (1 - clamp(value / Math.max(1, maxValue), 0, 1))

      const handlePointer = (event) => {
        if (hoverHours.length === 0) return
        const element = wrapRef.current
        if (element === null) return
        const rect = element.getBoundingClientRect()
        const ratio = clamp((event.clientX - rect.left - PAD.left) / innerWidth, 0, 1)
        const targetHour = ratio * 23
        let best = 0
        let bestGap = Infinity
        for (let index = 0; index < hoverHours.length; index += 1) {
          const gap = Math.abs(hoverHours[index] - targetHour)
          if (gap < bestGap) {
            bestGap = gap
            best = index
          }
        }
        setHover((current) => (current === best ? current : best))
      }

      const handleKey = (event) => {
        if (hoverHours.length === 0) return
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const direction = event.key === 'ArrowRight' ? 1 : -1
        setHover((current) => {
          const base = current < 0 ? (direction > 0 ? -1 : hoverHours.length) : current
          return clamp(base + direction, 0, hoverHours.length - 1)
        })
      }

      const axisRows = [0, 0.5, 1].map((fraction) => ({
        y: PAD.top + innerHeight * (1 - fraction),
        label: fmtPerfAxis(metric, maxValue * fraction),
      }))
      const tooltipTop = activeRows.length === 0
        ? PAD.top + 8
        : Math.min(...activeRows.map((row) => yOf(row.value)))

      return h('div', {
        className: 'up-chart up-perf-chart',
        ref: wrapRef,
        role: 'img',
        tabIndex: 0,
        'aria-label': T['perf.a11y'],
        onPointerMove: (event) => {
          if (event.pointerType === 'touch') return
          handlePointer(event)
        },
        onPointerLeave: () => setHover(-1),
        onBlur: () => setHover(-1),
        onKeyDown: handleKey,
      },
        h('svg', { viewBox: `0 0 ${width} ${HEIGHT}`, width: '100%', 'aria-hidden': true },
          axisRows.map((row, index) => h('g', { key: `perf-grid-${index}` },
            h('line', { className: 'up-chart-grid', x1: PAD.left, x2: width - PAD.right, y1: row.y, y2: row.y }),
            h('text', { className: 'up-chart-axis', x: PAD.left - 8, y: row.y, textAnchor: 'end', dominantBaseline: 'middle' }, row.label),
          )),
          [0, 6, 12, 18, 23].map((hour) => h('text', {
            key: `perf-x-${hour}`,
            className: 'up-chart-axis',
            x: xOf(hour),
            y: HEIGHT - 6,
            textAnchor: hour === 0 ? 'start' : hour === 23 ? 'end' : 'middle',
          }, `${String(hour).padStart(2, '0')}:00`)),
          lines.map((line) => {
            if (line.points.length === 1) {
              const point = line.points[0]
              return h('circle', {
                key: `perf-single-${line.provider}`,
                className: 'up-perf-point',
                cx: xOf(point.h),
                cy: yOf(point.value),
                r: 3,
                style: { stroke: line.color },
              })
            }
            const path = smoothPath(
              line.points.map((point) => ({ x: xOf(point.h), y: yOf(point.value) })),
              PAD.top,
              PAD.top + innerHeight,
            )
            return h('path', {
              key: `perf-line-${line.provider}`,
              className: 'up-perf-line up-chart-draw',
              d: path,
              pathLength: 1,
              style: { stroke: line.color },
            })
          }),
          lines.map((line) => line.points.map((point) => h('circle', {
            key: `perf-point-${line.provider}-${point.h}`,
            className: 'up-perf-point',
            cx: xOf(point.h),
            cy: yOf(point.value),
            r: 2.4,
            style: { stroke: line.color },
          }))),
          activeHour >= 0 ? h('g', null,
            h('line', {
              className: 'up-chart-cross',
              x1: xOf(activeHour),
              x2: xOf(activeHour),
              y1: PAD.top,
              y2: PAD.top + innerHeight,
            }),
            activeRows.map((row) => h('circle', {
              key: `perf-hover-${row.line.provider}`,
              className: 'up-perf-point',
              cx: xOf(activeHour),
              cy: yOf(row.value),
              r: 3.6,
              style: { stroke: row.line.color },
            })),
          ) : null,
          h('rect', { className: 'up-chart-hit', x: PAD.left, y: PAD.top, width: innerWidth, height: innerHeight }),
        ),
        activeHour >= 0 ? h('div', {
          className: 'up-chart-tip up-perf-tip',
          style: {
            left: `${clamp(xOf(activeHour), 82, width - 82)}px`,
            top: `${clamp(tooltipTop - 10, 8, HEIGHT - 12)}px`,
          },
        },
          h('div', { className: 'up-chart-tip-day' }, `${String(activeHour).padStart(2, '0')}:00 · ${fullDate(performance.date, lang)}`),
          activeRows.length === 0
            ? h('div', { className: 'up-chart-tip-row' }, T['perf.noSampleHour'])
            : activeRows.map((row) => h('div', { className: 'up-perf-tip-row', key: `perf-tip-${row.line.provider}` },
              h('span', { className: 'up-perf-tip-dot', style: { background: row.line.color } }),
              h('span', { className: 'up-perf-tip-name' }, providerLabel(row.line.provider)),
              h('span', null, metric === 'ttft' ? fmtLatency(row.value, lang) : `${trimNum(row.value, 1)} ${T['perf.unitSpeed']}`),
            )),
        ) : null,
      )
    }

    /**
     * Provider performance panel: metric tabs plus the selected day's chart.
     * The panel stays mounted when the day changes (no key, no entrance
     * animation replay) and its body keeps a stable height, so switching days
     * never reflows the page and never clamps the scroll position.
     */
    function PerformancePanel(props) {
      const { performance, loading, day, today, onReset, lang, T, delay } = props
      const [metric, setMetric] = useState('tps')
      const perf = performance === undefined ? null : performance
      const isToday = day === '' || day === today
      const metricOptions = [
        { id: 'tps', label: T['perf.tabSpeed'] },
        { id: 'ttft', label: T['perf.tabTtft'] },
      ]
      const metricIndex = metric === 'ttft' ? 1 : 0
      const fresh = perf !== null && (perf.date === day || perf.date === '')
      const hasData = fresh && perf.hours.length > 0 && perf.providers.length > 0
      const staleData = !fresh && perf !== null && perf.hours.length > 0 && perf.providers.length > 0
      const showChart = hasData || staleData
      const showOverlay = loading && showChart
      const legend = perf === null
        ? []
        : perf.providers
          .map((provider, index) => ({ provider, index }))
          .filter(({ provider }) => (metric === 'ttft' ? provider.ttftSamples > 0 : provider.speedSamples > 0))
          .slice(0, 4)

      const chartView = showChart
        ? h(React.Fragment, null,
          h(PerformanceChart, { key: `${perf.date}-${metric}`, performance: perf, metric, lang, T }),
          h('div', { className: 'up-perf-legend' },
            legend.map(({ provider, index }) => h('span', { className: 'up-perf-chip', key: provider.provider },
              h('span', { className: 'up-perf-chip-dot', style: { background: PROVIDER_COLORS[index % PROVIDER_COLORS.length] } }),
              providerLabel(provider.provider),
              h('small', null, fill(T['perf.samples'], { count: fmtInt(provider.samples) })),
            )),
            h('span', { className: 'up-perf-hint' }, T['perf.hint']),
          ),
        )
        : null

      return h('section', {
        className: 'up-card up-panel up-perf-panel up-rise',
        style: { '--d': `${delay}ms` },
        'aria-busy': loading ? true : undefined,
      },
        h('div', { className: 'up-panel-head' },
          h('h2', { className: 'up-panel-title' }, T['perf.title']),
          h('span', { className: 'up-panel-hint' }, day === '' ? '—' : fullDate(day, lang)),
          h('span', { className: 'up-spacer' }),
          h('div', { className: 'up-seg up-seg-metric', role: 'group', 'aria-label': T['perf.title'] },
            h('span', { className: 'up-seg-pill', style: { '--i': metricIndex } }),
            metricOptions.map((option) => h('button', {
              key: option.id,
              type: 'button',
              className: `up-seg-btn${option.id === metric ? ' is-active' : ''}`,
              'aria-pressed': option.id === metric,
              onClick: () => setMetric(option.id),
            }, option.label)),
          ),
          // Keep the reset button in the layout even on today, so the head never
          // grows a second row when a past day is selected on a narrow screen.
          h('button', {
            type: 'button',
            className: `up-refresh up-perf-reset${isToday ? ' is-hidden' : ''}`,
            onClick: onReset,
            disabled: isToday,
            tabIndex: isToday ? -1 : undefined,
          }, T['perf.reset']),
        ),
        h('div', { className: `up-perf-body${showOverlay ? ' is-stale' : ''}` },
          chartView !== null
            ? chartView
            : loading
              ? h('div', { className: 'up-perf-empty' }, h('span', { className: 'up-loading-spin' }), T['perf.loading'])
              : h('div', { className: 'up-perf-empty' }, T['perf.empty']),
          showOverlay
            ? h('div', { className: 'up-perf-loading', role: 'status' }, h('span', { className: 'up-loading-spin' }), T['perf.loading'])
            : null,
        ),
      )
    }

    // ------------------------------------------------------------- composition

    function CompositionPanel(props) {
      const { snapshot, lang, T, delay } = props
      const totals = snapshot.totals
      const segments = [
        { key: 'input', label: T['comp.input'], hint: T['comp.inputHint'], value: totals.input, color: 'var(--up-4)' },
        { key: 'cacheRead', label: T['comp.cacheRead'], hint: '', value: totals.cacheRead, color: 'var(--up-3)' },
        { key: 'cacheWrite', label: T['comp.cacheWrite'], hint: '', value: totals.cacheWrite, color: 'var(--up-2)' },
        { key: 'output', label: T['comp.output'], hint: '', value: totals.output, color: 'var(--up-out)' },
      ]
      const total = segments.reduce((sum, item) => sum + item.value, 0)
      const prompt = totals.prompt || (totals.input + totals.cacheRead + totals.cacheWrite)
      const hitRate = prompt > 0 ? totals.cacheRead / prompt : totals.cacheHitRate

      return h(
        'section',
        { className: 'up-card up-panel up-rise', style: { '--d': `${delay}ms` } },
        h('div', { className: 'up-panel-head' },
          h('h2', { className: 'up-panel-title' }, T['comp.title']),
          h('span', { className: 'up-panel-hint' }, T['comp.hint']),
        ),
        h('div', { className: 'up-stack', role: 'img', 'aria-label': `${T['comp.title']} ${fmtPct(hitRate, 0)}` },
          h('div', { className: 'up-stack-track' },
            segments.filter((item) => item.value > 0).map((item) =>
              h('div', {
                key: item.key,
                className: 'up-stack-seg',
                style: { width: `${total > 0 ? (item.value / total) * 100 : 0}%`, background: item.color },
              }),
            ),
          ),
        ),
        h('div', { className: 'up-legend' },
          segments.map((item) => {
            const share = total > 0 ? item.value / total : 0
            return h('div', { className: 'up-legend-row', key: item.key },
              h('span', { className: 'up-legend-dot', style: { background: item.color } }),
              h('span', { className: 'up-legend-name' }, item.label, item.hint ? h('small', null, item.hint) : null),
              h('span', { className: 'up-legend-value' }, h(AnimatedNumber, { value: item.value, mode: 'int', lang })),
              h('span', { className: 'up-legend-share' }, fmtPct(share, 1)),
            )
          }),
        ),
        h('div', { className: 'up-panel-foot' },
          h('span', null, `${T['comp.prompt']} `, h('b', null, fmtTokens(prompt, lang))),
          h('span', { className: 'up-dot' }),
          h('span', null, `${T['comp.hitRate']} `, h('b', null, fmtPct(hitRate, 1))),
        ),
      )
    }

    function ModelsPanel(props) {
      const { snapshot, lang, T, delay } = props
      const models = snapshot.models
      const totalTokens = snapshot.totals.tokens
      const top = models.slice(0, 6)
      const rest = models.slice(6)
      const restTokens = rest.reduce((sum, row) => sum + row.tokens, 0)
      const restCalls = rest.reduce((sum, row) => sum + row.calls, 0)
      const maxShare = Math.max(0.0001, ...top.map((row) => (totalTokens > 0 ? row.tokens / totalTokens : 0)))

      const row = (item, index) => {
        const share = totalTokens > 0 ? item.tokens / totalTokens : 0
        const width = clamp(share / maxShare, 0.01, 1)
        const label = item.providers && item.providers.length > 0 ? item.providers.join(' · ') : ''
        return h('div', { className: 'up-model', key: item.model, title: label },
          h('div', { className: 'up-model-top' },
            h('span', { className: 'up-model-name' }, item.model, label ? h('small', null, label) : null),
            h('span', { className: 'up-spacer' }),
            h('span', { className: 'up-model-value' }, fmtTokens(item.tokens, lang)),
            h('span', { className: 'up-model-share' }, fmtPct(share, 0)),
          ),
          h('div', { className: 'up-model-bar' },
            h('div', { className: 'up-model-fill', style: { '--w': width, '--d': `${index * 55}ms` } }),
          ),
        )
      }

      return h(
        'section',
        { className: 'up-card up-panel up-rise', style: { '--d': `${delay}ms` } },
        h('div', { className: 'up-panel-head' },
          h('h2', { className: 'up-panel-title' }, T['models.title']),
          h('span', { className: 'up-panel-hint' }, T['models.hint']),
        ),
        models.length === 0
          ? h('div', { className: 'up-empty-inline' }, T['empty.title'])
          : h('div', { className: 'up-models' },
            top.map((item, index) => row(item, index)),
            rest.length > 0
              ? h('div', { className: 'up-model up-model-other' },
                h('div', { className: 'up-model-top' },
                  h('span', { className: 'up-model-name' }, fill(T['models.other'], { count: rest.length })),
                  h('span', { className: 'up-spacer' }),
                  h('span', { className: 'up-model-value' }, fmtTokens(restTokens, lang)),
                  h('span', { className: 'up-model-share' }, fmtPct(totalTokens > 0 ? restTokens / totalTokens : 0, 0)),
                ),
                h('div', { className: 'up-model-bar' },
                  h('div', { className: 'up-model-fill', style: { '--w': clamp(restTokens / Math.max(1, totalTokens) / maxShare, 0.01, 1), '--d': '380ms' } }),
                ),
              )
              : null,
          ),
        h('div', { className: 'up-panel-foot' },
          h('span', null, T['stat.total'], ' ', h('b', null, fmtTokens(totalTokens, lang))),
          h('span', { className: 'up-dot' }),
          h('span', null, fill(T['models.calls'], { calls: fmtInt(snapshot.totals.calls) })),
        ),
      )
    }

    // ------------------------------------------------------------------ board

    function Skeleton() {
      return h('div', { className: 'up-skeleton', 'aria-hidden': true },
        h('div', { className: 'up-sk-stats' }, h('div', { className: 'up-sk' }), h('div', { className: 'up-sk' }), h('div', { className: 'up-sk' }), h('div', { className: 'up-sk' }), h('div', { className: 'up-sk' })),
        h('div', { className: 'up-sk-grid2' }, h('div', { className: 'up-sk' }), h('div', { className: 'up-sk' })),
        h('div', { className: 'up-sk up-sk-trend' }),
        h('div', { className: 'up-sk up-sk-heat' }),
        h('div', { className: 'up-sk up-sk-perf' }),
      )
    }

    function EmptyArt() {
      return h('svg', { className: 'up-empty-art', width: 64, height: 64, viewBox: '0 0 64 64', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 10, y: 36, width: 8, height: 16, rx: 2.5, stroke: 'currentColor', strokeWidth: 2, opacity: 0.45 }),
        h('rect', { x: 28, y: 26, width: 8, height: 26, rx: 2.5, stroke: 'currentColor', strokeWidth: 2, opacity: 0.7 }),
        h('rect', { x: 46, y: 16, width: 8, height: 36, rx: 2.5, stroke: 'currentColor', strokeWidth: 2 }),
        h('path', { d: 'M12 28 L28 20 L44 24 L54 13', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', opacity: 0.55 }),
      )
    }

    function Board() {
      const lang = useLang()
      const T = lang === 'zh' ? ZH : EN
      const ready = useReady()
      const [snapshot, setSnapshot] = useState(() => (snapshotCache === null ? null : snapshotCache))
      const [busy, setBusy] = useState(() => snapshotCache === null)
      const [syncing, setSyncing] = useState(false)
      const [failed, setFailed] = useState(false)
      const [range, setRange] = useState(DEFAULT_RANGE)
      const [hidden, setHidden] = useState(false)
      const [selectedDay, setSelectedDay] = useState('')
      const [performance, setPerformance] = useState(() => (snapshotCache === null ? null : snapshotCache.performance))
      const [perfLoading, setPerfLoading] = useState(false)

      const refresh = useCallback((force) => {
        let cancelled = false
        setSyncing(true)
        loadSnapshot(force)
          .then((data) => {
            if (cancelled) return
            setSnapshot(data)
            setFailed(false)
            setBusy(false)
          })
          .catch(() => {
            if (cancelled) return
            setFailed(true)
            setBusy(false)
          })
          .finally(() => {
            if (!cancelled) setSyncing(false)
          })
        return () => {
          cancelled = true
        }
      }, [])

      useEffect(() => {
        const cached = snapshotCache
        if (cached !== null) {
          setSnapshot(cached)
          setBusy(false)
        }
        if (cached === null || Date.now() - snapshotAt > CLIENT_FRESH_MS) refresh(false)

        const timer = window.setInterval(() => {
          if (document.visibilityState === 'visible') refresh(false)
        }, POLL_MS)

        const onVisibility = () => {
          const isHidden = document.visibilityState !== 'visible'
          setHidden(isHidden)
          if (!isHidden && Date.now() - snapshotAt > POLL_MS) refresh(false)
        }
        setHidden(document.visibilityState !== 'visible')
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [refresh])

      const todayKey = snapshot === null ? '' : snapshot.window.to
      const snapshotPerf = snapshot === null ? null : snapshot.performance
      const activeDay = selectedDay === '' ? todayKey : selectedDay
      // Today always renders straight from the snapshot. For another day the last
      // loaded payload stays visible as a dimmed backdrop until the new fold lands,
      // so the panel never collapses to a short loading line (which would clamp the
      // scroll position when the board is scrolled to the bottom).
      const shownPerf = activeDay === todayKey ? snapshotPerf : performance

      const selectDay = useCallback((dayKey) => {
        const next = dayKey === todayKey ? '' : dayKey
        setSelectedDay(next)
        if (next === '') {
          setPerfLoading(false)
          return
        }
        // Keep a dimmed backdrop (today's payload) while the requested fold loads.
        if (performance === null && snapshotPerf !== null) setPerformance(snapshotPerf)
        const cached = performanceCache.get(next)
        if (cached !== undefined) {
          setPerformance(cached)
          setPerfLoading(false)
        } else {
          setPerfLoading(true)
        }
      }, [todayKey, performance, snapshotPerf])

      useEffect(() => {
        if (activeDay === '' || activeDay === todayKey) {
          setPerfLoading(false)
          return undefined
        }
        const cached = performanceCache.get(activeDay)
        if (cached !== undefined) {
          setPerformance(cached)
          setPerfLoading(false)
          return undefined
        }
        let alive = true
        const controller = new AbortController()
        setPerfLoading(true)
        loadPerformance(activeDay, controller.signal)
          .then((data) => {
            if (!alive) return
            setPerformance(data)
            setPerfLoading(false)
          })
          .catch(() => {
            if (!alive || controller.signal.aborted) return
            setPerformance(null)
            setPerfLoading(false)
          })
        return () => {
          alive = false
          controller.abort()
        }
      }, [activeDay, todayKey])

      const daily = snapshot === null ? [] : snapshot.daily
      const series = useMemo(() => (range === 0 ? daily : daily.slice(-range)), [daily, range])
      const seriesSummary = useMemo(() => {
        let tokens = 0
        let calls = 0
        for (const row of series) {
          tokens += num(row.tokens)
          calls += num(row.calls)
        }
        return { tokens, calls }
      }, [series])

      const todayRow = daily.length > 0 ? daily[daily.length - 1] : null
      const yesterdayRow = daily.length > 1 ? daily[daily.length - 2] : null
      const delta = todayRow !== null && yesterdayRow !== null && yesterdayRow.tokens > 0
        ? (todayRow.tokens - yesterdayRow.tokens) / yesterdayRow.tokens
        : null

      const totalTokens = snapshot === null ? 0 : snapshot.totals.tokens
      const totalCalls = snapshot === null ? 0 : snapshot.totals.calls
      const cacheRate = snapshot === null ? 0 : snapshot.totals.cacheHitRate
      const empty = snapshot !== null && !hasAnyUsage(snapshot)

      const rangeId = range === 0 ? 'all' : String(range)
      const rangeOptions = RANGE_DEFS.map((definition) => ({
        id: definition.id,
        label: T[`range.${definition.id === 0 ? 'all' : definition.id}`],
      }))
      const rangeIndex = Math.max(0, rangeOptions.findIndex((option) => option.id === range))

      const header = h('header', { className: 'up-head up-rise', style: { '--d': '0ms' } },
        h('div', { className: 'up-head-text' },
          h('div', { className: 'up-title-row' },
            h('span', { className: 'up-live', 'aria-hidden': true }),
            h('h1', { className: 'up-title' }, T['panel.title']),
          ),
          h('p', { className: 'up-sub' },
            snapshot === null
              ? T['state.loading']
              : `${T['panel.sub']} · ${fill(T['meta.updated'], { time: fmtClock(snapshot.generatedAt) })}`,
          ),
        ),
        h('div', { className: 'up-head-actions' },
          syncing ? h('span', { className: 'up-sync' }, h('span', { className: 'up-sync-dot' }), T['action.syncing']) : null,
          h('div', { className: 'up-seg', role: 'group', 'aria-label': T['trend.hint'] },
            h('span', { className: 'up-seg-pill', style: { '--i': rangeIndex } }),
            rangeOptions.map((option) => h('button', {
              key: option.id,
              type: 'button',
              className: `up-seg-btn${option.id === range ? ' is-active' : ''}`,
              'aria-pressed': option.id === range,
              onClick: () => setRange(option.id),
            }, option.label)),
          ),
          h('button', {
            type: 'button',
            className: `up-refresh${syncing ? ' is-busy' : ''}`,
            onClick: () => refresh(true),
            disabled: syncing,
            title: T['action.refresh'],
          },
          h('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
            h('path', { d: 'M20 12a8 8 0 1 1-2.4-5.7', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
            h('path', { d: 'M20 4v5h-5', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
          ),
          h('span', null, T['action.refresh'])),
        ),
      )

      let body = null
      if (snapshot === null && busy) {
        body = Skeleton()
      } else if (snapshot === null) {
        body = h('div', { className: 'up-card up-error up-rise', style: { '--d': '60ms' } },
          h('div', { className: 'up-error-title' }, T['state.error']),
          h('p', { className: 'up-error-hint' }, T['state.errorHint']),
          h('button', { type: 'button', className: 'up-refresh', onClick: () => { setBusy(true); refresh(true) } }, T['action.retry']),
        )
      } else {
        const stats = h('div', { className: 'up-stats' },
          h(StatCard, { T, delay: 20, className: 'up-hero' },
            h('div', { className: 'up-stat-label' }, T['stat.total']),
            h('div', { className: 'up-stat-value' },
              h(AnimatedNumber, { value: totalTokens, mode: 'tokens', lang }),
              h('span', { className: 'up-hero-unit' }, T['unit.tokens']),
            ),
            h('div', { className: 'up-hero-meta' },
              h('span', null, fill(T['stat.calls'], { calls: fmtInt(totalCalls) })),
              h('span', { className: 'up-dot' }),
              h('span', null, fill(T['stat.avg'], { avg: `${fmtTokens(totalTokens > 0 && totalCalls > 0 ? totalTokens / totalCalls : 0, lang)} ${T['unit.tokens']}` })),
            ),
          ),
          h(StatCard, { T, delay: 60 },
            h('div', { className: 'up-stat-label' }, T['stat.today']),
            h('div', { className: 'up-stat-value' }, h(AnimatedNumber, { value: snapshot.today.tokens, mode: 'tokens', lang })),
            h('div', { className: 'up-stat-sub' },
              h(DeltaChip, { value: delta, T }),
              ' ',
              fill(T['stat.todaySub'], { calls: fmtInt(snapshot.today.calls) }),
            ),
          ),
          h(StatCard, { T, delay: 100 },
            h('div', { className: 'up-stat-label' }, T['stat.month']),
            h('div', { className: 'up-stat-value' }, h(AnimatedNumber, { value: snapshot.month.tokens, mode: 'tokens', lang })),
            h('div', { className: 'up-stat-sub' }, fill(T['stat.monthSub'], { calls: fmtInt(snapshot.month.calls) })),
          ),
          h(StatCard, { T, delay: 140 },
            h('div', { className: 'up-stat-label' }, T['stat.speed']),
            h('div', { className: 'up-stat-value' },
              h(AnimatedNumber, { value: snapshot.speed.tokensPerSecond, mode: 'rate', lang }),
              h('span', { className: 'up-stat-unit' }, T['speed.unit']),
            ),
            h('div', { className: 'up-stat-sub' }, fill(T['stat.speedSub'], {
              decode: fmtTokens(snapshot.speed.decodeTokens, lang),
              samples: fmtInt(snapshot.speed.samples),
            })),
          ),
          h(StatCard, { T, delay: 180 },
            h('div', { className: 'up-stat-label' }, T['stat.cache']),
            h('div', { className: 'up-cache-body' },
              h(Gauge, { rate: cacheRate, ready }),
              h('div', { className: 'up-stat-value' }, h(AnimatedNumber, { value: cacheRate, mode: 'pct', lang })),
            ),
            h('div', { className: 'up-stat-sub' }, fill(T['stat.cacheSub'], { tokens: fmtTokens(snapshot.totals.cacheRead, lang) })),
          ),
        )

        body = h(React.Fragment, null,
          stats,
          empty
            ? h('div', { className: 'up-card up-empty up-rise', style: { '--d': '180ms' } },
              h(EmptyArt),
              h('div', { className: 'up-empty-title' }, T['empty.title']),
              h('p', { className: 'up-empty-hint' }, T['empty.hint']),
            )
            : h(React.Fragment, null,
              h('div', { className: 'up-grid2' },
                h(CompositionPanel, { snapshot, lang, T, delay: 180 }),
                h(ModelsPanel, { snapshot, lang, T, delay: 210 }),
              ),
              h('section', { className: 'up-card up-panel up-trend up-rise', style: { '--d': '240ms' } },
                h('div', { className: 'up-panel-head' },
                  h('h2', { className: 'up-panel-title' }, T['trend.title']),
                  h('span', { className: 'up-panel-hint' }, T['trend.hint']),
                  h('span', { className: 'up-spacer' }),
                  h('span', { className: 'up-trend-readout' },
                    fill(T['trend.rangeTokens'], { tokens: fmtTokens(seriesSummary.tokens, lang) }),
                    ' · ',
                    fill(T['trend.calls'], { calls: fmtInt(seriesSummary.calls) }),
                    ' · ',
                    fill(T['trend.dailyAvg'], { tokens: fmtTokens(seriesSummary.tokens / Math.max(1, series.length), lang) }),
                  ),
                ),
                h(TrendChart, { key: `chart-${rangeId}`, series, lang, T }),
              ),
              h('section', { className: 'up-card up-panel up-rise', style: { '--d': '270ms' } },
                h('div', { className: 'up-panel-head' },
                  h('h2', { className: 'up-panel-title' }, T['heat.title']),
                  h('span', { className: 'up-panel-hint' }, fill(T['heat.hint'], { days: Math.min(119, daily.length) })),
                ),
                h(Heatmap, {
                  daily,
                  lang,
                  T,
                  selectedDay: activeDay,
                  onSelectDay: selectDay,
                }),
              ),
              h(PerformancePanel, {
                performance: shownPerf,
                loading: perfLoading,
                day: activeDay,
                today: todayKey,
                onReset: () => selectDay(todayKey),
                lang,
                T,
                delay: 300,
              }),
            ),
          failed ? h('div', { className: 'up-warn up-rise', style: { '--d': '300ms' } },
            h('span', { className: 'up-live', 'aria-hidden': true }),
            h('span', null, T['state.stale']),
            h('button', { type: 'button', className: 'up-refresh', onClick: () => refresh(true) }, T['action.retry']),
          ) : null,
        )
      }

      const foot = snapshot === null
        ? null
        : h('footer', { className: 'up-foot up-rise', style: { '--d': '320ms' } },
          h('span', null, fill(T['meta.updated'], { time: fmtClock(snapshot.generatedAt) })),
          h('span', { className: 'up-dot' }),
          h('span', null, fill(T['meta.scan'], { sessions: fmtInt(snapshot.scan.sessions), readings: fmtInt(snapshot.scan.readings) })),
          snapshot.scan.truncated ? h('span', { className: 'up-dot' }) : null,
          snapshot.scan.truncated ? h('span', null, fill(T['meta.truncated'], { max: fmtInt(snapshot.scan.maxSessions) })) : null,
          snapshot.scan.failed > 0 ? h('span', { className: 'up-dot' }) : null,
          snapshot.scan.failed > 0
            ? h('span', { className: 'up-unreadable' }, fill(T['meta.unreadable'], { count: fmtInt(snapshot.scan.failed) }))
            : null,
          h('span', { className: 'up-dot' }),
          h('span', null, T['meta.source']),
        )

      return h('div', {
        className: `up-root${hidden ? ' is-hidden' : ''}`,
        'data-ready': ready ? '' : undefined,
      }, h('div', { className: 'up-inner' }, header, body, foot))
    }

    // -------------------------------------------------------------------- apply

    function apply(ctx) {
      ctxRef = ctx
      syncLang()

      const style = document.createElement('style')
      style.setAttribute('data-plugin', PACKAGE_ID)
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => style.remove(), 'usage-panel: styles')

      const disposeLocale = ctx.locale.subscribe(() => {
        syncLang()
      })
      ctx.effect(() => disposeLocale, 'usage-panel: locale')

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 1,
        label: () => {
          const dictionary = activeLang === 'zh' ? ZH : EN
          return dictionary['panel.title']
        },
      }, PanelIcon))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
      }, Board))

      // Warm the Host snapshot after the app settled, so opening the board the
      // first time paints real numbers instead of a cold scan.
      ctx.effect(() => {
        const timer = window.setTimeout(() => {
          loadSnapshot(false).catch(() => {})
        }, PREFETCH_DELAY_MS)
        return () => window.clearTimeout(timer)
      }, 'usage-panel: prefetch')
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
