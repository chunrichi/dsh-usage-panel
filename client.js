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

    /**
     * Global time scope. Every card and panel reads through this one object, so
     * the header filter genuinely filters the whole board instead of a single
     * chart. `range` = trailing local-day window (0 = all history); `day` = one
     * concrete local date, today included.
     */
    const DEFAULT_SCOPE = { kind: 'range', days: DEFAULT_RANGE }
    const SCOPE_SEGMENTS = [
      { id: 'today', kind: 'day' },
      { id: 7, kind: 'range' },
      { id: 30, kind: 'range' },
      { id: 90, kind: 'range' },
      { id: 0, kind: 'range' },
    ]

    /** One performance payload is cached per request key on the client. */
    const PERF_CACHE_MS = 30_000
    /** The selected scope survives a panel remount, like the snapshot cache. */
    let activeScope = { kind: DEFAULT_SCOPE.kind, days: DEFAULT_SCOPE.days }

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
      'scope.anyDay': '任意一天',
      'scope.today': '今日',
      'scope.groupA11y': '时间范围',
      'scope.calendarA11y': '打开日期选择器',
      'scope.calendarTitle': '选择日期',
      'scope.prevMonth': '上一月',
      'scope.nextMonth': '下一月',
      'scope.backToday': '回到今天',
      'scope.legendData': '有用量',
      'scope.labelRange': '近 {days} 天',
      'scope.labelAll': '全部历史',
      'scope.dayView': '单日视图',
      'stat.total': 'Token 总量',
      'stat.rangeTokens': '近 {days} 天 Token',
      'stat.dayTokens': '当日 Token',
      'stat.speed': '平均输出速度',
      'stat.cache': '缓存命中率',
      'stat.calls': '{calls} 次调用',
      'stat.avg': '均次 {avg}',
      'stat.cacheSub': '缓存读取 {tokens}',
      'stat.speedSub': '解码 {decode} · {samples} 次采样',
      'stat.vsPrevDays': '较前 {days} 天',
      'stat.vsPrevDay': '较前一日',
      'stat.prevValue': '上期 {tokens}',
      'stat.prevDayValue': '前一日 {tokens}',
      'stat.noPrev': '暂无对比数据',
      'stat.peakDay': '峰值单日',
      'stat.peakHour': '峰值时段',
      'stat.activeAvg': '活跃日均',
      'stat.activeAvgSub': '活跃 {days} 天',
      'stat.noPeak': '暂无峰值',
      'speed.unit': 'tok/s',
      'unit.tokens': 'tokens',
      'comp.title': 'Token 构成',
      'comp.hintRange': '本区间 · 近 {days} 天',
      'comp.hintDay': '当日 · {date}',
      'comp.hintAll': '全部历史',
      'comp.input': '输入',
      'comp.inputHint': '未命中缓存',
      'comp.cacheRead': '缓存命中',
      'comp.cacheWrite': '缓存写入',
      'comp.output': '输出',
      'comp.prompt': 'Prompt 合计',
      'comp.hitRate': '缓存命中率',
      'empty.title': '还没有可统计的 Token 用量',
      'empty.hint': '发起一次对话之后，这里会自动出现真实的用量数据。',
      'empty.scopeRange': '该时间范围内暂无用量，换个更大的范围试试。',
      'empty.scopeDay': '该日暂无用量，点击热力图或日历换一天。',
      'models.title': '模型占比',
      'models.hint': '按总 Token',
      'models.hintRange': '按区间 Token',
      'models.hintDay': '按当日 Token',
      'models.other': '其他 {count} 个模型',
      'models.calls': '{calls} 次调用',
      'combo.title': '趋势与性能',
      'combo.hintRange': '每日 Token 与按天中位数',
      'combo.hintAll': '每日 Token 与按天中位数 · 最近 {days} 天',
      'combo.hintDay': '每小时 Token 与按小时中位数 · {date}',
      'combo.tokenLegend': 'Token 用量',
      'combo.metricA11y': '性能折线指标',
      'combo.a11yRange': '每日 Token 柱状与各提供商性能折线，可使用左右方向键查看每一天',
      'combo.a11yHour': '每小时 Token 柱状与各提供商性能折线，可使用左右方向键查看每小时',
      'combo.emptyRange': '该时间范围暂无用量与性能样本',
      'combo.emptyDay': '该日暂无用量与性能样本',
      'combo.emptyHourDetail': '该日暂无小时明细数据',
      'trend.rangeTokens': '本区间 {tokens}',
      'trend.windowTokens': '最近 {days} 天 {tokens}',
      'trend.dailyAvg': '日均 {tokens}',
      'trend.speed': '速度 {tps} tok/s',
      'trend.calls': '{calls} 次调用',
      'trend.dayReadout': '当日 {tokens} · {calls} 次调用',
      'trend.hourPeak': '峰值 {hour}',
      'trend.earlyDay': '今天刚开始，用量会随时间累积',
      'heat.title': '活跃热力图',
      'heat.hint': '最近 {days} 天 · 点击查看当天',
      'heat.less': '少',
      'heat.more': '多',
      'heat.hoverHint': '悬停看当天明细，点击切换为单日视图',
      'heat.detail': '{tokens} tokens · {calls} 次调用',
      'perf.hintLegendDay': '柱=Token · 线为按小时中位数 · 悬浮查看各 provider',
      'perf.hintLegendRange': '柱=Token · 线为按天中位数 · 悬浮查看当天',
      'perf.tabSpeed': '速度',
      'perf.tabTtft': '首 Token',
      'perf.reset': '回到今天',
      'perf.loading': '正在统计该日性能…',
      'perf.loadingRange': '正在统计区间性能…',
      'perf.samples': '{count} 次',
      'perf.unitSpeed': 'tok/s',
      'perf.noSampleHour': '该小时无样本',
      'perf.noSampleDay': '该日无样本',
      'meta.updated': '更新于 {time}',
      'meta.scan': '{sessions} 个会话 / {readings} 次调用',
      'meta.truncated': '仅统计最近 {max} 个会话',
      'meta.source': '数据来自本机会话日志，不经过网络。',
      'meta.unreadable': '{count} 个会话日志无法读取（已跳过）',
      'state.loading': '正在统计会话日志…',
      'state.error': '读取失败',
      'state.errorHint': 'Host 路由没有返回数据，稍后重试即可。',
      'state.stale': '最近一次同步失败，正在展示上次的数据',
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
      'scope.anyDay': 'Any day',
      'scope.today': 'Today',
      'scope.groupA11y': 'Time range',
      'scope.calendarA11y': 'Open the date picker',
      'scope.calendarTitle': 'Pick a day',
      'scope.prevMonth': 'Previous month',
      'scope.nextMonth': 'Next month',
      'scope.backToday': 'Back to today',
      'scope.legendData': 'has usage',
      'scope.labelRange': 'Last {days}d',
      'scope.labelAll': 'All time',
      'scope.dayView': 'Day view',
      'stat.total': 'Total tokens',
      'stat.rangeTokens': 'Last {days}d tokens',
      'stat.dayTokens': 'Tokens that day',
      'stat.speed': 'Output speed',
      'stat.cache': 'Cache hit rate',
      'stat.calls': '{calls} calls',
      'stat.avg': '{avg} avg',
      'stat.cacheSub': '{tokens} cache reads',
      'stat.speedSub': '{decode} · {samples} samples',
      'stat.vsPrevDays': 'vs previous {days}d',
      'stat.vsPrevDay': 'vs previous day',
      'stat.prevValue': 'prev. {tokens}',
      'stat.prevDayValue': 'prev. day {tokens}',
      'stat.noPrev': 'No comparison data',
      'stat.peakDay': 'Peak day',
      'stat.peakHour': 'Peak hour',
      'stat.activeAvg': 'Active-day average',
      'stat.activeAvgSub': '{days} active days',
      'stat.noPeak': 'No peak yet',
      'speed.unit': 'tok/s',
      'unit.tokens': 'tokens',
      'comp.title': 'Token makeup',
      'comp.hintRange': 'This range · last {days}d',
      'comp.hintDay': 'That day · {date}',
      'comp.hintAll': 'All history',
      'comp.input': 'Input',
      'comp.inputHint': 'cache miss',
      'comp.cacheRead': 'Cache read',
      'comp.cacheWrite': 'Cache write',
      'comp.output': 'Output',
      'comp.prompt': 'Prompt total',
      'comp.hitRate': 'Cache hit rate',
      'empty.title': 'No token usage yet',
      'empty.hint': 'Start a conversation and real usage numbers will appear here.',
      'empty.scopeRange': 'No usage in this range — try a wider window.',
      'empty.scopeDay': 'No usage that day — pick another cell or date.',
      'models.title': 'Model share',
      'models.hint': 'By total tokens',
      'models.hintRange': 'By tokens in range',
      'models.hintDay': 'By tokens that day',
      'models.other': '{count} more models',
      'models.calls': '{calls} calls',
      'combo.title': 'Trend & performance',
      'combo.hintRange': 'Tokens per day + daily medians',
      'combo.hintAll': 'Tokens per day + daily medians · last {days}d',
      'combo.hintDay': 'Tokens per hour + hourly medians · {date}',
      'combo.tokenLegend': 'Token usage',
      'combo.metricA11y': 'Performance line metric',
      'combo.a11yRange': 'Daily token bars with per-provider performance lines; use the left and right arrow keys to step through days',
      'combo.a11yHour': 'Hourly token bars with per-provider performance lines; use the left and right arrow keys to step through hours',
      'combo.emptyRange': 'No usage or performance samples in this range',
      'combo.emptyDay': 'No usage or performance samples that day',
      'combo.emptyHourDetail': 'No hourly detail for that day',
      'trend.rangeTokens': '{tokens} in range',
      'trend.windowTokens': '{tokens} in last {days}d',
      'trend.dailyAvg': '{tokens} / day',
      'trend.speed': '{tps} tok/s',
      'trend.calls': '{calls} calls',
      'trend.dayReadout': '{tokens} that day · {calls} calls',
      'trend.hourPeak': 'peak {hour}',
      'trend.earlyDay': 'The day is just starting — usage builds up over time',
      'heat.title': 'Activity',
      'heat.hint': 'Last {days} days · click for a day',
      'heat.less': 'Less',
      'heat.more': 'More',
      'heat.hoverHint': 'Hover for details, click to switch to that day',
      'heat.detail': '{tokens} tokens · {calls} calls',
      'perf.hintLegendDay': 'bars = tokens · lines = hourly medians',
      'perf.hintLegendRange': 'bars = tokens · lines = daily medians',
      'perf.tabSpeed': 'Speed',
      'perf.tabTtft': 'First token',
      'perf.reset': 'Back to today',
      'perf.loading': 'Loading that day…',
      'perf.loadingRange': 'Loading range…',
      'perf.samples': '{count} calls',
      'perf.unitSpeed': 'tok/s',
      'perf.noSampleHour': 'No samples this hour',
      'perf.noSampleDay': 'No samples that day',
      'meta.updated': 'Updated {time}',
      'meta.scan': '{sessions} sessions / {readings} calls',
      'meta.truncated': 'latest {max} sessions only',
      'meta.source': 'Derived from local session logs; nothing leaves the machine.',
      'meta.unreadable': '{count} session logs unreadable (skipped)',
      'state.loading': 'Counting session logs…',
      'state.error': 'Could not read usage',
      'state.errorHint': 'The Host route returned no data. Try again in a moment.',
      'state.stale': 'Last sync failed; showing the previous snapshot',
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

    /** Local `YYYY-MM-DD` key for one Date object. */
    function keyOfDay(date) {
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${date.getFullYear()}-${month}-${day}`
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

    /** Short weekday label (`周三` / `Wed`). */
    function weekdayShort(key, lang) {
      const date = dayFromKey(key)
      if (date === null) return ''
      if (lang === 'zh') return `周${['日', '一', '二', '三', '四', '五', '六'][date.getDay()]}`
      return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()]
    }

    /** `2026 年 10 月` / `October 2026` for the calendar header. */
    function monthLabel(year, month, lang) {
      if (lang === 'zh') return `${year} 年 ${month} 月`
      const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
      return `${names[month - 1]} ${year}`
    }

    /** `14:00–15:00` clock range for one local hour. */
    function hourRangeOf(hour) {
      const start = clamp(Math.round(Number(hour) || 0), 0, 23)
      return `${String(start).padStart(2, '0')}:00–${String(start + 1).padStart(2, '0')}:00`
    }

    /** Compact day chip: `10-21 周三` in Chinese, `Wed, Oct 21` in English. */
    function dayBadge(key, lang) {
      if (typeof key !== 'string' || key === '') return ''
      const weekday = weekdayShort(key, lang)
      const date = shortDate(key, lang)
      if (lang === 'zh') return `${date} ${weekday}`.trim()
      return weekday === '' ? date : `${weekday}, ${date}`
    }

    /** Human label for the active scope (`近 30 天` / `10-21 周三` / `全部历史`). */
    function scopeLabelOf(scope, snapshot, lang) {
      const T = lang === 'zh' ? ZH : EN
      if (scope.kind === 'day') return dayBadge(scope.date, lang)
      if (scope.days === 0) return T['scope.labelAll']
      const available = snapshot !== null && snapshot.daily.length > 0 ? Math.min(scope.days, snapshot.daily.length) : scope.days
      return fill(T['scope.labelRange'], { days: available })
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
      if (mode === 'pctfree') return `${trimNum(Math.max(0, Number(value) || 0) * 100, 1)}%`
      if (mode === 'rate') return trimNum(Math.max(0, Number(value) || 0), 1)
      return String(value)
    }

    /** Latency text: milliseconds below one second, seconds above. */
    function fmtLatency(ms, lang) {
      const value = Math.max(0, Number(ms) || 0)
      if (value >= 1000) return `${trimNum(value / 1000, 1)}${lang === 'zh' ? ' 秒' : 's'}`
      return `${Math.round(value)}ms`
    }

    /** Compact y-axis label for the performance chart (one unit per axis). */
    function fmtPerfAxis(metric, value, unit) {
      const number = Math.max(0, Number(value) || 0)
      if (metric === 'ttft') {
        return unit === 's' ? `${trimNum(number / 1000, 1)}s` : `${Math.round(number)}ms`
      }
      return trimNum(number, 0)
    }

    /** Axis unit for one performance metric, chosen from the axis maximum. */
    function perfAxisUnit(metric, maxValue) {
      return metric === 'ttft' && Number(maxValue) >= 1000 ? 's' : 'ms'
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

    /** All-zero scope usage bucket (same shape as an aggregated range). */
    function zeroUsage() {
      return {
        tokens: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        calls: 0,
        prompt: 0,
        cacheHitRate: 0,
        tokensPerSecond: 0,
        decodeTokens: 0,
        decodeMs: 0,
        samples: 0,
      }
    }

    /** Derive prompt / cache-hit / weighted speed on a summed counter bucket. */
    function finishUsage(bucket) {
      bucket.prompt = bucket.input + bucket.cacheRead + bucket.cacheWrite
      bucket.cacheHitRate = bucket.prompt > 0 ? bucket.cacheRead / bucket.prompt : 0
      bucket.tokensPerSecond = bucket.decodeMs > 0 ? bucket.decodeTokens / (bucket.decodeMs / 1000) : 0
      return bucket
    }

    /** One daily row as a scope usage bucket. */
    function usageOfDayRow(row) {
      if (row === null || row === undefined || typeof row !== 'object') return zeroUsage()
      const usage = finishUsage({
        tokens: num(row.tokens),
        input: num(row.input),
        output: num(row.output),
        cacheRead: num(row.cacheRead),
        cacheWrite: num(row.cacheWrite),
        reasoning: num(row.reasoning),
        calls: num(row.calls),
        prompt: 0,
        cacheHitRate: 0,
        tokensPerSecond: 0,
        decodeTokens: num(row.decodeTokens),
        decodeMs: num(row.decodeMs),
        samples: num(row.samples),
      })
      // Host snapshots from before v2 only carry a per-day average speed.
      if (usage.decodeMs <= 0 && typeof row.tokensPerSecond === 'number' && row.tokensPerSecond > 0) {
        usage.tokensPerSecond = row.tokensPerSecond
      }
      return usage
    }

    /** Sum a run of daily rows into one usage bucket (speed stays weighted). */
    function usageOfDayRows(rows) {
      const bucket = zeroUsage()
      let speedWeighted = 0
      let speedWeight = 0
      for (const row of Array.isArray(rows) ? rows : []) {
        bucket.tokens += num(row.tokens)
        bucket.input += num(row.input)
        bucket.output += num(row.output)
        bucket.cacheRead += num(row.cacheRead)
        bucket.cacheWrite += num(row.cacheWrite)
        bucket.reasoning += num(row.reasoning)
        bucket.calls += num(row.calls)
        bucket.decodeTokens += num(row.decodeTokens)
        bucket.decodeMs += num(row.decodeMs)
        bucket.samples += num(row.samples)
        if (typeof row.tokensPerSecond === 'number' && row.tokensPerSecond > 0) {
          const weight = num(row.samples) > 0 ? num(row.samples) : num(row.tokens)
          speedWeighted += row.tokensPerSecond * weight
          speedWeight += weight
        }
      }
      finishUsage(bucket)
      if (bucket.decodeMs <= 0 && speedWeight > 0) bucket.tokensPerSecond = speedWeighted / speedWeight
      return bucket
    }

    /** Lifetime counters from the snapshot's `totals` + `speed` blocks. */
    function usageOfSnapshot(snapshot) {
      if (snapshot === null) return zeroUsage()
      return finishUsage({
        tokens: snapshot.totals.tokens,
        input: snapshot.totals.input,
        output: snapshot.totals.output,
        cacheRead: snapshot.totals.cacheRead,
        cacheWrite: snapshot.totals.cacheWrite,
        reasoning: snapshot.totals.reasoning,
        calls: snapshot.totals.calls,
        prompt: 0,
        cacheHitRate: 0,
        tokensPerSecond: 0,
        decodeTokens: num(snapshot.speed && snapshot.speed.decodeTokens),
        decodeMs: num(snapshot.speed && snapshot.speed.decodeMs),
        samples: num(snapshot.speed && snapshot.speed.samples),
      })
    }

    /** Model → provider labels, taken from the lifetime model table. */
    function providerIndex(snapshot) {
      const index = new Map()
      if (snapshot !== null) {
        for (const row of snapshot.models) {
          if (!index.has(row.model) && row.providers.length > 0) index.set(row.model, row.providers)
        }
      }
      return index
    }

    /** Merge a run of daily `models` entries into one scoped model list. */
    function modelsOfDayRows(rows, snapshot) {
      const providers = providerIndex(snapshot)
      const merged = new Map()
      for (const row of Array.isArray(rows) ? rows : []) {
        for (const entry of Array.isArray(row.models) ? row.models : []) {
          if (entry === null || typeof entry !== 'object' || typeof entry.model !== 'string') continue
          let target = merged.get(entry.model)
          if (target === undefined) {
            target = { model: entry.model, providers: providers.get(entry.model) || [], tokens: 0, calls: 0 }
            merged.set(entry.model, target)
          }
          target.tokens += num(entry.tokens)
          target.calls += num(entry.calls)
        }
      }
      return [...merged.values()].sort((left, right) => right.tokens - left.tokens || left.model.localeCompare(right.model))
    }

    /** One day's compact model split (day scope); empty for a missing row. */
    function modelsOfDayRow(row, snapshot) {
      if (row === null || row === undefined) return []
      return modelsOfDayRows([row], snapshot)
    }

    /**
     * Degraded model share for a range when the Host snapshot predates the
     * per-day model split: scale the lifetime split to the scoped token count,
     * so the panel keeps a truthful ordering and share instead of going empty.
     */
    function scaleLifetimeModels(snapshot, scopeTokens) {
      const lifetime = snapshot === null ? 0 : num(snapshot.totals.tokens)
      if (lifetime <= 0 || num(scopeTokens) <= 0) return []
      const ratio = num(scopeTokens) / lifetime
      return snapshot.models.map((row) => ({
        model: row.model,
        providers: row.providers,
        tokens: Math.round(row.tokens * ratio),
        calls: Math.round(row.calls * ratio),
      }))
    }

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
          reasoning: num(row.reasoning),
          calls: num(row.calls),
          samples: num(row.samples),
          decodeTokens: num(row.decodeTokens),
          decodeMs: num(row.decodeMs),
          tokensPerSecond: rate(row.tokensPerSecond),
          models: Array.isArray(row.models)
            ? row.models
              .filter((item) => item && typeof item === 'object' && typeof item.model === 'string')
              .map((item) => ({ model: item.model, tokens: num(item.tokens), calls: num(item.calls) }))
            : [],
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
          activeDays: num(raw.history && raw.history.activeDays),
          firstDay: typeof (raw.history && raw.history.firstDay) === 'string' ? raw.history.firstDay : '',
          lastDay: typeof (raw.history && raw.history.lastDay) === 'string' ? raw.history.lastDay : '',
          peak: {
            day: typeof (raw.history && raw.history.peak && raw.history.peak.day) === 'string' ? raw.history.peak.day : '',
            tokens: num(raw.history && raw.history.peak && raw.history.peak.tokens),
          },
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

    /** Normalize one day's or range's provider-performance payload. */
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
            tokens: num(row.tokens),
            input: num(row.input),
            output: num(row.output),
            cacheRead: num(row.cacheRead),
            cacheWrite: num(row.cacheWrite),
            reasoning: num(row.reasoning),
            calls: num(row.calls),
            samples: num(row.samples),
            tokensPerSecond: rate(row.tokensPerSecond),
            providers: Array.isArray(row.providers) ? row.providers.map(providerRow).filter((item) => item !== null) : [],
          }))
          .sort((left, right) => left.h - right.h)
        : []
      const days = Array.isArray(raw && raw.days)
        ? raw.days
          .filter((row) => row !== null && typeof row === 'object' && typeof row.d === 'string')
          .map((row) => ({
            d: row.d,
            providers: Array.isArray(row.providers) ? row.providers.map(providerRow).filter((item) => item !== null) : [],
          }))
          .sort((left, right) => left.d.localeCompare(right.d))
        : []
      return {
        date: raw !== null && raw !== undefined && typeof raw.date === 'string' ? raw.date : '',
        from: raw !== null && raw !== undefined && typeof raw.from === 'string' ? raw.from : '',
        to: raw !== null && raw !== undefined && typeof raw.to === 'string' ? raw.to : '',
        providers,
        hours,
        days,
      }
    }

    /** Fetch one day's or range's provider-performance fold. */
    async function loadPerformance(params, signal) {
      const query = params !== null && typeof params === 'object' && typeof params.date === 'string'
        ? `?date=${encodeURIComponent(params.date)}`
        : `?from=${encodeURIComponent(params.from)}&to=${encodeURIComponent(params.to)}`
      const response = await fetch(`${PERF_ROUTE}${query}`, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal,
      })
      if (!response.ok) throw new Error(`performance http ${response.status}`)
      const data = await response.json()
      if (data === null || typeof data !== 'object' || data.ok !== true) throw new Error('performance payload rejected')
      const performance = normalizePerformance(data.performance)
      if (typeof data.date === 'string' && data.date !== '') performance.date = data.date
      if (typeof data.from === 'string' && data.from !== '') performance.from = data.from
      if (typeof data.to === 'string' && data.to !== '') performance.to = data.to
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
.up-head{position:sticky;top:0;z-index:30;display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;padding:8px 2px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 84%,transparent);backdrop-filter:blur(14px) saturate(1.15);-webkit-backdrop-filter:blur(14px) saturate(1.15)}
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
.up-hero-meta{display:flex;align-items:center;gap:12px;flex-wrap:nowrap;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11.5px;min-width:0;overflow:hidden}
.up-hero-meta b{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}
.up-dot{display:inline-block;width:3px;height:3px;border-radius:50%;background:var(--dsw-alias-border-l2);flex:none;vertical-align:middle}
.up-hero:before{content:"";position:absolute;right:-46px;top:-64px;width:190px;height:190px;border-radius:50%;background:radial-gradient(circle at 40% 40%,color-mix(in srgb,var(--up-accent) 26%,transparent),transparent 68%);filter:blur(8px);pointer-events:none;animation:up-drift 22s ease-in-out infinite alternate}
.up-stat-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.up-gauge-wrap{position:relative;width:44px;height:44px;flex:none;align-self:flex-start}
.up-gauge{width:44px;height:44px;display:block;transform:rotate(-90deg)}
.up-gauge-track{stroke:var(--dsw-alias-border-l1)}
.up-gauge-arc{stroke:var(--up-accent);transition:stroke-dashoffset 1s var(--up-ease)}
.up-gauge-label{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.up-cache-body{display:flex;align-items:center;gap:12px;min-width:0}
.up-cache-body .up-stat-value .up-num{font-size:24px}
.up-grid2{display:grid;grid-template-columns:1.15fr 1fr;gap:12px}
.up-grid2>.up-panel{min-height:246px}
.up-grid2>.up-panel>.up-panel-foot{margin-top:auto}
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
.up-perf-reset.is-hidden{display:none}
.up-sk-combo{height:318px}
.up-trend{position:relative}
.up-trend-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.up-trend-readout{color:var(--dsw-alias-label-secondary);font-size:11.5px;font-variant-numeric:tabular-nums}
.up-chart{position:relative;width:100%;margin-top:2px;touch-action:pan-y}
.up-chart svg{display:block;width:100%;height:auto;overflow:visible}
.up-chart-axis{fill:var(--dsw-alias-label-secondary);font-size:10px;font-family:inherit}
.up-chart-grid{stroke:var(--dsw-alias-border-l1);stroke-width:1;stroke-dasharray:3 5}
.up-chart-draw{stroke-dasharray:1;stroke-dashoffset:1;animation:up-draw 1s var(--up-ease) .04s forwards}
.up-chart-cross{stroke:var(--dsw-alias-border-l2);stroke-width:1;stroke-dasharray:3 4}
.up-chart-dot{fill:var(--dsw-alias-bg-base);stroke:var(--up-4);stroke-width:2}
.up-chart-hit{fill:transparent;cursor:crosshair}
.up-chart-tip{position:absolute;pointer-events:none;transform:translate(-50%,-100%);min-width:132px;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 10px 30px -14px rgba(3,20,42,.45);font-size:11.5px;line-height:1.5;z-index:2;transition:opacity .12s ease}
.up-chart-tip-day{color:var(--dsw-alias-label-secondary);font-size:10.5px}
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
  .up-root *,.up-root *::before,.up-root *::after{animation:none!important;transition:none!important}
  .up-rise{opacity:1!important}
  .up-heat-cell{opacity:1!important;transform:none!important}
  .up-model-fill{transform:scaleX(var(--w,0))!important}
  .up-stack-track{transform:none!important}
}
@media (max-width:980px){.up-stats,.up-sk-stats,.up-sk-row{grid-template-columns:1fr 1fr}.up-hero{grid-column:1/-1}}
@media (max-width:900px){.up-grid2,.up-sk-grid2{grid-template-columns:1fr}}
@media (max-width:640px){.up-inner{padding:16px 14px 32px}.up-stats,.up-sk-stats,.up-sk-row{grid-template-columns:1fr}.up-head-actions{margin-left:0}.up-seg:not(.up-seg-metric){--up-seg-w:48px}.up-hero .up-num{font-size:27px}}
/* ---- v2: global scope bar, date picker, day detail ---- */
.up-combo-body{position:relative;min-height:252px;display:flex;flex-direction:column;justify-content:flex-end;margin-top:2px}
.up-combo-chart{margin-top:0}
.up-combo-bar{fill:color-mix(in srgb,var(--up-3) 52%,transparent);transition:fill .16s ease}
.up-combo-bar.is-active{fill:color-mix(in srgb,var(--up-3) 78%,transparent)}
[data-ds-dark-theme] .up-combo-bar{fill:color-mix(in srgb,var(--up-4) 35%,transparent)}
[data-ds-dark-theme] .up-combo-bar.is-active{fill:color-mix(in srgb,var(--up-4) 54%,transparent)}
.up-combo-legend-token{background:color-mix(in srgb,var(--up-3) 62%,transparent);border-radius:2.5px}
[data-ds-dark-theme] .up-combo-legend-token{background:color-mix(in srgb,var(--up-4) 46%,transparent);border-radius:2.5px}
.up-combo-tip{width:max-content;max-width:280px;min-width:172px}
.up-combo-tip .up-chart-tip-row{white-space:nowrap}
.up-combo-tip.is-right{transform:translate(-100%,-100%)}
.up-combo-tip.is-left{transform:translate(0,-100%)}
.up-combo-tip.is-below{transform:translate(-50%,0)}
.up-combo-tip.is-right.is-below{transform:translate(-100%,0)}
.up-combo-tip.is-left.is-below{transform:translate(0,0)}
.up-combo-tip-token{color:var(--dsw-alias-label-primary)}
.up-combo-tip-dot{width:7px;height:7px;border-radius:2px;flex:none;background:color-mix(in srgb,var(--up-3) 62%,transparent)}
[data-ds-dark-theme] .up-combo-tip-dot{background:color-mix(in srgb,var(--up-4) 46%,transparent)}
.up-combo-tip-sep{height:1px;margin:5px -2px;background:var(--dsw-alias-border-l1);opacity:.7}
.up-head:after{content:"";position:absolute;left:0;right:0;top:100%;height:16px;background:linear-gradient(to bottom,color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent),transparent);pointer-events:none}
.up-scope-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;background:color-mix(in srgb,var(--up-accent) 11%,transparent);border:1px solid color-mix(in srgb,var(--up-accent) 26%,transparent);color:var(--up-accent);font-size:10.5px;font-weight:500;letter-spacing:.01em;white-space:nowrap;font-variant-numeric:tabular-nums}
.up-head-actions{row-gap:8px}
.up-seg-pill.is-hidden{opacity:0}
.up-date-wrap{position:relative;display:inline-flex}
.up-date-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;font-variant-numeric:tabular-nums;transition:background-color .16s ease,border-color .16s ease,color .16s ease,transform .16s var(--up-ease)}
.up-date-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.up-date-btn:active{transform:scale(.97)}
.up-date-btn.is-active{background:color-mix(in srgb,var(--up-accent) 12%,transparent);border-color:color-mix(in srgb,var(--up-accent) 42%,transparent);color:var(--up-accent)}
.up-date-btn svg{width:13px;height:13px;display:block;flex:none}
.up-cal{position:absolute;right:0;top:calc(100% + 10px);z-index:50;box-sizing:border-box;width:280px;padding:12px 12px 10px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 24px 60px -24px rgba(3,20,42,.5),0 2px 8px rgba(3,20,42,.08);animation:up-cal-in .22s var(--up-ease) both;transform-origin:top right}
@keyframes up-cal-in{from{opacity:0;transform:translate3d(0,-6px,0) scale(.98)}to{opacity:1;transform:none}}
.up-cal-head{display:flex;align-items:center;gap:6px;padding:1px 1px 8px}
.up-cal-month{font-size:12.5px;font-weight:600;letter-spacing:.01em}
.up-cal-nav{margin-left:auto;display:flex;gap:2px}
.up-cal-nav button{appearance:none;width:26px;height:26px;display:grid;place-items:center;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .13s ease,color .13s ease}
.up-cal-nav button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.up-cal-nav button:disabled{opacity:.3;cursor:default}
.up-cal-nav svg{width:13px;height:13px;display:block}
.up-cal-week{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;padding-bottom:2px}
.up-cal-week span{text-align:center;font-size:10px;line-height:22px;color:var(--dsw-alias-label-secondary);opacity:.85}
.up-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
.up-cal-day{position:relative;appearance:none;height:30px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-variant-numeric:tabular-nums;cursor:pointer;transition:background-color .13s ease,color .13s ease}
.up-cal-day:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.up-cal-day.is-outside{color:var(--dsw-alias-label-secondary);opacity:.5}
.up-cal-day:disabled{opacity:.28;cursor:default}
.up-cal-day.is-today{box-shadow:inset 0 0 0 1px var(--up-accent);font-weight:600}
.up-cal-day.is-selected{background:var(--up-accent);color:#fff;font-weight:600;box-shadow:none}
.up-cal-day.has-data:after{content:"";position:absolute;left:50%;bottom:3.5px;width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.45;transform:translateX(-50%)}
.up-cal-day.is-selected.has-data:after{opacity:.9}
.up-cal-foot{display:flex;align-items:center;gap:8px;margin-top:9px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l1)}
.up-cal-foot .up-refresh{height:26px;padding:0 9px;font-size:11.5px;gap:5px}
.up-cal-hint{margin-left:auto;display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:10.5px}
.up-cal-hint i{width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.5;display:inline-block}
.up-stat-tag{margin-left:6px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;font-weight:400;letter-spacing:0;white-space:nowrap;font-variant-numeric:tabular-nums}
.up-stat-tag b{color:var(--dsw-alias-label-primary);font-weight:500}
.up-delta-big{display:inline-flex;align-items:baseline;gap:5px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.up-delta-big .up-num{font-size:22px;font-weight:600;line-height:1.15}
.up-delta-big .up-arrow{font-size:11px;line-height:1;transform:translateY(-1px)}
.up-delta-big.up{color:var(--up-accent)}
.up-delta-big.down{color:var(--dsw-alias-state-warn-primary)}
.up-stat-dash{font-size:22px;font-weight:600;line-height:1.15;color:var(--dsw-alias-label-secondary);opacity:.7}
.up-peak-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.up-scope-empty{display:flex;align-items:center;gap:10px;padding:11px 14px;border-radius:12px;border:1px dashed var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent);color:var(--dsw-alias-label-secondary);font-size:12px}
.up-scope-empty b{color:var(--dsw-alias-label-primary);font-weight:500}
.up-chart-loading{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;gap:8px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent);color:var(--dsw-alias-label-secondary);font-size:12px;pointer-events:none;animation:up-fade .16s ease both}
.up-chart-now{stroke:var(--up-accent);stroke-width:1;stroke-dasharray:2 4;opacity:.55}
.up-chart-now-label{fill:var(--up-accent);font-size:9.5px;font-family:inherit}
.up-heat-cell.is-outside{opacity:.3!important}
.up-heat-cell.is-outside.is-hover{opacity:1!important}
@media (max-width:980px){.up-head{align-items:flex-start}.up-head-actions{margin-left:0;width:100%;justify-content:flex-end}.up-seg:not(.up-seg-metric){--up-seg-w:52px}.up-seg-metric{--up-seg-w:60px}}
@media (max-width:640px){.up-head{position:static;background:transparent;backdrop-filter:none;-webkit-backdrop-filter:none;padding:2px 2px 0}.up-head:after{display:none}.up-head-actions{justify-content:flex-start}.up-cal{right:-4px;width:min(280px,calc(100vw - 28px))}.up-seg:not(.up-seg-metric){--up-seg-w:46px}.up-seg-metric{--up-seg-w:56px}.up-stat-tag{display:none}}
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

    // --------------------------------------------------------- date picker

    /**
     * Self-drawn month calendar anchored under the date button. Days outside
     * the snapshot window are disabled; days with usage carry a dot, so the
     * picker doubles as a quick activity scan. Escape / outside click closes.
     */
    function CalendarPopover(props) {
      const { month, onChangeMonth, value, today, min, max, dataDays, lang, T, onPick, onToday, onClose } = props
      const panelRef = useRef(null)

      useEffect(() => {
        const onPointerDown = (event) => {
          const target = event.target
          if (target !== null && typeof target === 'object' && typeof target.closest === 'function' && target.closest('.up-date-wrap') !== null) return
          onClose()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [onClose])

      const months = useMemo(() => {
        const cell = (date, outside) => ({ key: keyOfDay(date), outside })
        const lead = (new Date(month.y, month.m - 1, 1).getDay() + 6) % 7
        const total = new Date(month.y, month.m, 0).getDate()
        const cells = []
        for (let index = lead; index > 0; index -= 1) cells.push(cell(new Date(month.y, month.m - 1, 1 - index), true))
        for (let index = 1; index <= total; index += 1) cells.push(cell(new Date(month.y, month.m - 1, index), false))
        while (cells.length % 7 !== 0) cells.push(cell(new Date(month.y, month.m, cells.length - lead - total + 1), true))
        return cells
      }, [month])

      const monthPrefix = `${month.y}-${String(month.m).padStart(2, '0')}`
      const minPrefix = min === '' ? '' : min.slice(0, 7)
      const maxPrefix = max === '' ? '' : max.slice(0, 7)
      const weekNames = lang === 'zh' ? ['一', '二', '三', '四', '五', '六', '日'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      const shiftMonth = (delta) => {
        const next = new Date(month.y, month.m - 1 + delta, 1)
        onChangeMonth({ y: next.getFullYear(), m: next.getMonth() + 1 })
      }

      const navButton = (delta, label, disabled) => h('button', {
        type: 'button',
        disabled,
        'aria-label': label,
        title: label,
        onClick: () => shiftMonth(delta),
        tabIndex: disabled ? -1 : undefined,
      }, h('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: delta > 0 ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        })))

      return h('div', {
        className: 'up-cal',
        ref: panelRef,
        role: 'dialog',
        'aria-label': T['scope.calendarTitle'],
        'data-action': 'calendar',
      },
        h('div', { className: 'up-cal-head' },
          h('span', { className: 'up-cal-month' }, monthLabel(month.y, month.m, lang)),
          h('span', { className: 'up-cal-nav' },
            navButton(-1, T['scope.prevMonth'], minPrefix === '' || monthPrefix <= minPrefix),
            navButton(1, T['scope.nextMonth'], maxPrefix === '' || monthPrefix >= maxPrefix),
          ),
        ),
        h('div', { className: 'up-cal-week' }, weekNames.map((name) => h('span', { key: name }, name))),
        h('div', { className: 'up-cal-grid' },
          months.map((cell) => {
            const disabled = cell.key < min || cell.key > max
            const tokens = dataDays.get(cell.key) || 0
            const classes = `up-cal-day${cell.outside ? ' is-outside' : ''}${cell.key === value ? ' is-selected' : ''}${cell.key === today ? ' is-today' : ''}${tokens > 0 ? ' has-data' : ''}`
            return h('button', {
              key: cell.key,
              type: 'button',
              className: classes,
              disabled,
              'data-day': cell.key,
              'aria-pressed': cell.key === value,
              title: `${fullDate(cell.key, lang)} · ${fmtTokens(tokens, lang)} ${T['unit.tokens']}`,
              onClick: () => onPick(cell.key),
            }, String(Number(cell.key.slice(8, 10))))
          }),
        ),
        h('div', { className: 'up-cal-foot' },
          h('button', {
            type: 'button',
            className: 'up-refresh',
            'data-action': 'back-today',
            disabled: today === '' || (min !== '' && today < min),
            onClick: onToday,
          }, T['scope.backToday']),
          h('span', { className: 'up-cal-hint' }, h('i', { 'aria-hidden': true }), T['scope.legendData']),
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

    /**
     * Usage volume (bars, left axis) plus provider performance lines (right
     * axis) on one shared x axis. Range scopes use one bar per local day and
     * daily provider medians; a single day uses one bar per hour and hourly
     * medians. Hover shows volume and every provider metric in one tooltip,
     * and arrow keys step through the x axis.
     */
    function CombinedChart(props) {
      const { series, xKind, perf, metric, dayOrder, day, todayKey, lang, T } = props
      const [wrapRef, width] = useMeasuredWidth()
      const [hover, setHover] = useState(-1)
      const HEIGHT = 248
      const PAD = { top: 18, right: 54, bottom: 24, left: 46 }
      const innerWidth = Math.max(80, width - PAD.left - PAD.right)
      const innerHeight = HEIGHT - PAD.top - PAD.bottom
      const isHour = xKind === 'hour'

      const tokenRows = useMemo(() => {
        if (!isHour) return Array.isArray(series) ? series : []
        const byHour = new Map()
        for (const row of Array.isArray(series) ? series : []) {
          if (row !== null && typeof row === 'object' && typeof row.h === 'number') byHour.set(row.h, row)
        }
        const output = []
        for (let h = 0; h < 24; h += 1) {
          const found = byHour.get(h)
          output.push({
            h,
            d: '',
            tokens: num(found && found.tokens),
            calls: num(found && found.calls),
            input: num(found && found.input),
            output: num(found && found.output),
            cacheRead: num(found && found.cacheRead),
            cacheWrite: num(found && found.cacheWrite),
            tokensPerSecond: found !== undefined && typeof found.tokensPerSecond === 'number' ? found.tokensPerSecond : 0,
          })
        }
        return output
      }, [series, isHour])

      const count = tokenRows.length
      // Today's curve stops at the current hour: future hours have not happened.
      const currentHour = isHour && day === todayKey ? new Date().getHours() : -1
      const lastVisible = isHour && currentHour >= 0 ? currentHour : count - 1

      const dayIndex = useMemo(() => {
        const map = new Map()
        if (!isHour && Array.isArray(dayOrder)) dayOrder.forEach((key, index) => map.set(key, index))
        return map
      }, [isHour, dayOrder])

      const lines = useMemo(() => {
        if (perf === null || typeof perf !== 'object') return []
        const providers = Array.isArray(perf.providers) ? perf.providers : []
        const output = []
        providers.slice(0, 4).forEach((provider, index) => {
          const points = []
          if (isHour) {
            for (const row of Array.isArray(perf.hours) ? perf.hours : []) {
              const entry = row.providers.find((item) => item.provider === provider.provider)
              if (entry === undefined) continue
              const value = metric === 'ttft' ? entry.ttftMs : entry.tps
              if (value > 0 && row.h <= lastVisible) points.push({ index: row.h, value })
            }
          } else {
            for (const dayRow of Array.isArray(perf.days) ? perf.days : []) {
              const entry = dayRow.providers.find((item) => item.provider === provider.provider)
              if (entry === undefined) continue
              const value = metric === 'ttft' ? entry.ttftMs : entry.tps
              const position = dayIndex.get(dayRow.d)
              if (value > 0 && position !== undefined) points.push({ index: position, value })
            }
          }
          if (points.length > 0) {
            output.push({ provider: provider.provider, color: PROVIDER_COLORS[index % PROVIDER_COLORS.length], points })
          }
        })
        return output
      }, [perf, metric, isHour, dayIndex, lastVisible])

      const tokenMax = useMemo(
        () => niceCeil(Math.max(1, ...tokenRows.map((row) => num(row.tokens)))),
        [tokenRows],
      )
      const metricMax = useMemo(() => {
        let max = 0
        for (const line of lines) for (const point of line.points) max = Math.max(max, point.value)
        return niceCeil(max)
      }, [lines])
      const latencyUnit = perfAxisUnit(metric, metricMax)

      const xOf = useCallback((index) => {
        if (isHour) return PAD.left + (clamp(index, 0, 23) / 23) * innerWidth
        return PAD.left + (count <= 1 ? 0.5 : clamp(index, 0, count - 1) / (count - 1)) * innerWidth
      }, [isHour, count, innerWidth])
      const yToken = useCallback(
        (value) => PAD.top + innerHeight * (1 - clamp(value / Math.max(1, tokenMax), 0, 1)),
        [innerHeight, tokenMax],
      )
      const yMetric = useCallback(
        (value) => PAD.top + innerHeight * (1 - clamp(value / Math.max(1, metricMax), 0, 1)),
        [innerHeight, metricMax],
      )

      const step = isHour ? innerWidth / 23 : count <= 1 ? innerWidth : innerWidth / (count - 1)
      const barWidth = Math.max(2, Math.min(18, step * (isHour ? 0.52 : 0.62)))

      const activeIndex = hover >= 0 && hover <= lastVisible && hover < count ? hover : -1
      const activeRow = activeIndex >= 0 ? tokenRows[activeIndex] : null
      const activeDayKey = activeIndex >= 0 && !isHour && Array.isArray(dayOrder) ? (dayOrder[activeIndex] || '') : ''
      const activeRows = useMemo(() => {
        if (activeIndex < 0) return []
        return lines
          .map((line) => {
            const point = line.points.find((item) => item.index === activeIndex)
            return point === undefined ? null : { line, value: point.value }
          })
          .filter((row) => row !== null)
          .sort((left, right) => right.value - left.value)
      }, [lines, activeIndex])

      const handlePointer = (event) => {
        const element = wrapRef.current
        if (element === null || count === 0) return
        const rect = element.getBoundingClientRect()
        const ratio = clamp((event.clientX - rect.left - PAD.left) / innerWidth, 0, 1)
        const index = isHour
          ? clamp(Math.round(ratio * 23), 0, Math.max(0, lastVisible))
          : clamp(Math.round(ratio * Math.max(0, count - 1)), 0, count - 1)
        setHover((current) => (current === index ? current : index))
      }
      const handleKey = (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const direction = event.key === 'ArrowRight' ? 1 : -1
        const max = isHour ? Math.max(0, lastVisible) : Math.max(0, count - 1)
        setHover((current) => {
          const base = current < 0 ? (direction > 0 ? -1 : max + 1) : current
          return clamp(base + direction, 0, max)
        })
      }

      const axisRows = [0, 0.5, 1].map((fraction) => ({
        y: PAD.top + innerHeight * (1 - fraction),
        tokenLabel: fmtAxis(tokenMax * fraction, lang),
        metricLabel: metric === 'ttft'
          ? fmtPerfAxis(metric, metricMax * fraction, latencyUnit)
          : fraction === 1
            ? `${fmtAxis(metricMax, lang)} ${T['perf.unitSpeed']}`
            : fmtAxis(metricMax * fraction, lang),
      }))
      const tickIndices = isHour
        ? [0, 6, 12, 18, 23]
        : [...new Set([0, Math.round((count - 1) / 3), Math.round(((count - 1) * 2) / 3), count - 1])]

      const tooltipTop = (() => {
        const candidates = []
        if (activeRow !== null) candidates.push(yToken(num(activeRow.tokens)))
        for (const row of activeRows) candidates.push(yMetric(row.value))
        return candidates.length === 0 ? HEIGHT - 20 : Math.min(...candidates)
      })()
      const activeRatio = activeIndex >= 0 ? xOf(activeIndex) / Math.max(1, width) : 0.5
      const tipAlign = activeRatio > 0.78 ? ' is-right' : activeRatio < 0.22 ? ' is-left' : ''
      const tipLeft = tipAlign === ''
        ? clamp(xOf(activeIndex), 128, width - 128)
        : clamp(xOf(activeIndex), 12, width - 12)
      // Flip the tooltip under the point when it would otherwise cover the
      // panel head; keeps the transient card inside the chart card.
      const tipBelow = tooltipTop < 132
      const tipTop = tipBelow
        ? clamp(tooltipTop + 16, 8, HEIGHT - 148)
        : clamp(tooltipTop - 12, 8, HEIGHT - 12)

      return h('div', {
        className: 'up-chart up-combo-chart',
        ref: wrapRef,
        role: 'img',
        tabIndex: 0,
        'aria-label': isHour ? T['combo.a11yHour'] : T['combo.a11yRange'],
        onPointerMove: (event) => {
          if (event.pointerType === 'touch') return
          handlePointer(event)
        },
        onPointerLeave: () => setHover(-1),
        onBlur: () => setHover(-1),
        onKeyDown: handleKey,
      },
        h('svg', { viewBox: `0 0 ${width} ${HEIGHT}`, width: '100%', 'aria-hidden': true },
          axisRows.map((row, index) => h('g', { key: `combo-grid-${index}` },
            h('line', { className: 'up-chart-grid', x1: PAD.left, x2: width - PAD.right, y1: row.y, y2: row.y }),
            h('text', { className: 'up-chart-axis', x: PAD.left - 8, y: row.y, textAnchor: 'end', dominantBaseline: 'middle' }, row.tokenLabel),
            lines.length > 0
              ? h('text', { className: 'up-chart-axis', x: width - PAD.right + 8, y: row.y, textAnchor: 'start', dominantBaseline: 'middle' }, row.metricLabel)
              : null,
          )),
          tickIndices.map((index) => {
            if (isHour) {
              return h('text', {
                key: `combo-x-${index}`,
                className: 'up-chart-axis',
                x: xOf(index),
                y: HEIGHT - 6,
                textAnchor: index === 0 ? 'start' : index === 23 ? 'end' : 'middle',
              }, `${String(index).padStart(2, '0')}:00`)
            }
            const key = Array.isArray(dayOrder) ? dayOrder[index] : undefined
            if (key === undefined) return null
            return h('text', {
              key: `combo-x-${index}`,
              className: 'up-chart-axis',
              x: xOf(index),
              y: HEIGHT - 6,
              textAnchor: index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle',
            }, shortDate(key, lang))
          }),
          tokenRows.map((row, index) => {
            const tokens = num(row.tokens)
            if (tokens <= 0) return null
            const top = yToken(tokens)
            const floor = PAD.top + innerHeight
            return h('rect', {
              key: `combo-bar-${index}`,
              className: `up-combo-bar${index === activeIndex ? ' is-active' : ''}`,
              x: xOf(index) - barWidth / 2,
              y: top,
              width: barWidth,
              height: Math.max(1.5, floor - top),
              rx: Math.min(2.5, barWidth / 2),
            })
          }),
          lines.map((line) => {
            if (line.points.length === 1) {
              const point = line.points[0]
              return h('circle', {
                key: `combo-single-${line.provider}`,
                className: 'up-perf-point',
                cx: xOf(point.index),
                cy: yMetric(point.value),
                r: 3,
                style: { stroke: line.color },
              })
            }
            const path = smoothPath(
              line.points.map((point) => ({ x: xOf(point.index), y: yMetric(point.value) })),
              PAD.top,
              PAD.top + innerHeight,
            )
            return h('path', {
              key: `combo-line-${line.provider}`,
              className: 'up-perf-line up-chart-draw',
              d: path,
              pathLength: 1,
              style: { stroke: line.color },
            })
          }),
          lines.map((line) => line.points.map((point) => h('circle', {
            key: `combo-point-${line.provider}-${point.index}`,
            className: 'up-perf-point',
            cx: xOf(point.index),
            cy: yMetric(point.value),
            r: 2.2,
            style: { stroke: line.color },
          }))),
          currentHour >= 0 ? h('g', null,
            h('line', { className: 'up-chart-now', x1: xOf(currentHour), x2: xOf(currentHour), y1: PAD.top, y2: PAD.top + innerHeight }),
            h('text', { className: 'up-chart-now-label', x: xOf(currentHour) + 4, y: PAD.top - 5 }, T['scope.today']),
          ) : null,
          activeIndex >= 0 ? h('g', null,
            h('line', { className: 'up-chart-cross', x1: xOf(activeIndex), x2: xOf(activeIndex), y1: PAD.top, y2: PAD.top + innerHeight }),
            activeRow !== null && num(activeRow.tokens) > 0
              ? h('circle', { className: 'up-chart-dot', cx: xOf(activeIndex), cy: yToken(num(activeRow.tokens)), r: 3 })
              : null,
            activeRows.map((row) => h('circle', {
              key: `combo-hover-${row.line.provider}`,
              className: 'up-perf-point',
              cx: xOf(activeIndex),
              cy: yMetric(row.value),
              r: 3.4,
              style: { stroke: row.line.color },
            })),
          ) : null,
          h('rect', { className: 'up-chart-hit', x: PAD.left, y: PAD.top, width: innerWidth, height: innerHeight }),
        ),
        activeIndex >= 0 && activeRow !== null
          ? h('div', {
            className: `up-chart-tip up-combo-tip${tipAlign}${tipBelow ? ' is-below' : ''}`,
            style: {
              left: `${tipLeft}px`,
              top: `${tipTop}px`,
            },
          },
            h('div', { className: 'up-chart-tip-day' },
              isHour ? `${hourRangeOf(activeIndex)} · ${fullDate(day, lang)}` : fullDate(activeDayKey, lang)),
            h('div', { className: 'up-chart-tip-row up-combo-tip-token' },
              h('span', { className: 'up-combo-tip-dot' }),
              h('span', null, `${fmtTokens(activeRow.tokens, lang)} ${T['unit.tokens']}`),
              h('span', null, fill(T['trend.calls'], { calls: fmtInt(activeRow.calls) })),
            ),
            (() => {
              const cacheBase = num(activeRow.input) + num(activeRow.cacheRead) + num(activeRow.cacheWrite)
              const hitRate = cacheBase > 0 ? num(activeRow.cacheRead) / cacheBase : 0
              return h('div', { className: 'up-chart-tip-row' },
                h('span', null, `${T['comp.hitRate']} ${fmtPct(hitRate, 0)}`),
                activeRow.tokensPerSecond > 0
                  ? h('span', null, fill(T['trend.speed'], { tps: trimNum(activeRow.tokensPerSecond, 1) }))
                  : null,
              )
            })(),
            h('div', { className: 'up-combo-tip-sep' }),
            activeRows.length === 0
              ? h('div', { className: 'up-chart-tip-row' }, isHour ? T['perf.noSampleHour'] : T['perf.noSampleDay'])
              : activeRows.map((row) => h('div', { className: 'up-perf-tip-row', key: `combo-tip-${row.line.provider}` },
                h('span', { className: 'up-perf-tip-dot', style: { background: row.line.color } }),
                h('span', { className: 'up-perf-tip-name' }, providerLabel(row.line.provider)),
                h('span', null, metric === 'ttft' ? fmtLatency(row.value, lang) : `${trimNum(row.value, 1)} ${T['perf.unitSpeed']}`),
              )),
          )
          : null,
      )
    }

    /**
     * Merged "trend + provider performance" panel. Keeps the metric tabs and
     * the stable-height dimmed-backdrop loading behaviour of the old separate
     * panels, but renders volume and performance on one x axis.
     */
    function CombinedTrendPanel(props) {
      const {
        series, xKind, perf, loading, day, todayKey, dayOrder,
        readout, hint, emptyText, earlyText, onReset, lang, T, delay,
      } = props
      const [metric, setMetric] = useState('tps')
      const metricOptions = [
        { id: 'tps', label: T['perf.tabSpeed'] },
        { id: 'ttft', label: T['perf.tabTtft'] },
      ]
      const metricIndex = metric === 'ttft' ? 1 : 0
      const isDay = xKind === 'hour'
      const isToday = isDay && (day === '' || day === todayKey)
      const rows = Array.isArray(series) ? series : []
      const providers = perf === null || perf === undefined || !Array.isArray(perf.providers) ? [] : perf.providers
      const hasUsage = rows.some((row) => num(row.tokens) > 0) || providers.length > 0
      const anchor = isDay
        ? `hour:${day}`
        : `day:${Array.isArray(dayOrder) && dayOrder.length > 0 ? `${dayOrder[0]}:${dayOrder[dayOrder.length - 1]}` : rows.length}`
      const loadingText = isDay ? T['perf.loading'] : T['perf.loadingRange']
      const legendHint = isDay ? T['perf.hintLegendDay'] : T['perf.hintLegendRange']
      const legend = providers
        .map((provider, index) => ({ provider, index }))
        .filter(({ provider }) => (metric === 'ttft' ? provider.ttftSamples > 0 : provider.speedSamples > 0))
        .slice(0, 4)

      let chartBody = null
      if (earlyText !== undefined && earlyText !== null) {
        chartBody = h('div', { className: 'up-chart-empty' }, earlyText)
      } else if (hasUsage) {
        chartBody = h(CombinedChart, {
          key: anchor,
          series: rows,
          xKind,
          perf: perf === undefined ? null : perf,
          metric,
          dayOrder,
          day,
          todayKey,
          lang,
          T,
        })
      } else if (loading) {
        chartBody = h('div', { className: 'up-chart-empty' }, h('span', { className: 'up-loading-spin' }), loadingText)
      } else {
        chartBody = h('div', { className: 'up-chart-empty' }, emptyText)
      }
      const overlay = loading && hasUsage && (earlyText === undefined || earlyText === null)
        ? h('div', { className: 'up-chart-loading', role: 'status' }, h('span', { className: 'up-loading-spin' }), loadingText)
        : null

      return h('section', {
        className: 'up-card up-panel up-trend up-combo up-rise',
        style: { '--d': `${delay}ms` },
        'aria-busy': loading ? true : undefined,
      },
        h('div', { className: 'up-panel-head' },
          h('h2', { className: 'up-panel-title' }, T['combo.title']),
          h('span', { className: 'up-panel-hint' }, hint),
          h('span', { className: 'up-spacer' }),
          h('span', { className: 'up-trend-readout' }, readout),
          h('div', { className: 'up-seg up-seg-metric', role: 'group', 'aria-label': T['combo.metricA11y'] },
            h('span', { className: 'up-seg-pill', style: { '--i': metricIndex } }),
            metricOptions.map((option) => h('button', {
              key: option.id,
              type: 'button',
              className: `up-seg-btn${option.id === metric ? ' is-active' : ''}`,
              'aria-pressed': option.id === metric,
              'data-metric': option.id,
              onClick: () => setMetric(option.id),
            }, option.label)),
          ),
          h('button', {
            type: 'button',
            className: `up-refresh up-perf-reset${isDay && !isToday ? '' : ' is-hidden'}`,
            onClick: onReset,
            disabled: !isDay || isToday,
            tabIndex: isDay && !isToday ? undefined : -1,
          }, T['perf.reset']),
        ),
        h('div', { className: 'up-combo-body' }, chartBody, overlay),
        h('div', { className: 'up-perf-legend' },
          h('span', { className: 'up-perf-chip', key: 'combo-tokens' },
            h('span', { className: 'up-perf-chip-dot up-combo-legend-token' }),
            T['combo.tokenLegend'],
          ),
          legend.map(({ provider, index }) => h('span', { className: 'up-perf-chip', key: provider.provider },
            h('span', { className: 'up-perf-chip-dot', style: { background: PROVIDER_COLORS[index % PROVIDER_COLORS.length] } }),
            providerLabel(provider.provider),
            h('small', null, fill(T['perf.samples'], { count: fmtInt(provider.samples) })),
          )),
          h('span', { className: 'up-perf-hint' }, legendHint),
        ),
      )
    }

    /** Last N daily buckets laid out as Monday-first week columns. */
    function Heatmap(props) {
      const { daily, lang, T, selectedDay, onSelectDay, rangeFrom, rangeTo } = props
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
                const outside = typeof rangeFrom === 'string' && rangeFrom !== '' && (row.d < rangeFrom || row.d > rangeTo)
                return h('div', {
                  key: `${row.d}`,
                  className: `up-heat-cell${level > 0 ? ` lv${level}` : ''}${row.d === todayKey ? ' is-today' : ''}${row.d === selectedDay ? ' is-selected' : ''}${outside ? ' is-outside' : ''}${index === hover ? ' is-hover' : ''}`,
                  style: { '--i': index },
                  'data-day': row.d,
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


    // ------------------------------------------------------------- composition

    function CompositionPanel(props) {
      const { usage, hint, lang, T, delay } = props
      const totals = usage === null || usage === undefined ? zeroUsage() : usage
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
          h('span', { className: 'up-panel-hint' }, hint),
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
      const { models, totalTokens, totalCalls, hint, emptyText, lang, T, delay } = props
      const rows = Array.isArray(models) ? models : []
      const total = num(totalTokens)
      const top = rows.slice(0, 4)
      const rest = rows.slice(4)
      const restTokens = rest.reduce((sum, row) => sum + row.tokens, 0)
      const maxShare = Math.max(0.0001, ...top.map((row) => (total > 0 ? row.tokens / total : 0)))

      const row = (item, index) => {
        const share = total > 0 ? item.tokens / total : 0
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
          h('span', { className: 'up-panel-hint' }, hint),
        ),
        rows.length === 0
          ? h('div', { className: 'up-empty-inline' }, emptyText === undefined ? T['empty.title'] : emptyText)
          : h('div', { className: 'up-models' },
            top.map((item, index) => row(item, index)),
            rest.length > 0
              ? h('div', { className: 'up-model up-model-other' },
                h('div', { className: 'up-model-top' },
                  h('span', { className: 'up-model-name' }, fill(T['models.other'], { count: rest.length })),
                  h('span', { className: 'up-spacer' }),
                  h('span', { className: 'up-model-value' }, fmtTokens(restTokens, lang)),
                  h('span', { className: 'up-model-share' }, fmtPct(total > 0 ? restTokens / total : 0, 0)),
                ),
                h('div', { className: 'up-model-bar' },
                  h('div', { className: 'up-model-fill', style: { '--w': clamp(restTokens / Math.max(1, total) / maxShare, 0.01, 1), '--d': '380ms' } }),
                ),
              )
              : null,
          ),
        h('div', { className: 'up-panel-foot' },
          h('span', null, T['stat.total'], ' ', h('b', null, fmtTokens(total, lang))),
          h('span', { className: 'up-dot' }),
          h('span', null, fill(T['models.calls'], { calls: fmtInt(totalCalls) })),
        ),
      )
    }

    // ------------------------------------------------------------------ board

    function Skeleton() {
      return h('div', { className: 'up-skeleton', 'aria-hidden': true },
        h('div', { className: 'up-sk-stats' }, h('div', { className: 'up-sk' }), h('div', { className: 'up-sk' }), h('div', { className: 'up-sk' }), h('div', { className: 'up-sk' }), h('div', { className: 'up-sk' })),
        h('div', { className: 'up-sk-grid2' }, h('div', { className: 'up-sk' }), h('div', { className: 'up-sk' })),
        h('div', { className: 'up-sk up-sk-combo' }),
        h('div', { className: 'up-sk up-sk-heat' }),
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
      const [scope, setScope] = useState(() => ({ kind: activeScope.kind, days: activeScope.days, date: activeScope.date }))
      const [calOpen, setCalOpen] = useState(false)
      const [calMonth, setCalMonth] = useState(() => {
        const seed = activeScope.kind === 'day' ? activeScope.date : ''
        const date = dayFromKey(seed)
        const now = date === null ? new Date() : date
        return { y: now.getFullYear(), m: now.getMonth() + 1 }
      })
      const [hidden, setHidden] = useState(false)
      const [perfState, setPerfState] = useState({ key: '', mode: '', loading: false, data: null })

      // The chosen scope is module state too, so remounting the panel (or
      // switching to a conversation and back) keeps the last time window.
      useEffect(() => {
        activeScope = { kind: scope.kind, days: scope.days, date: scope.date }
      }, [scope])

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
      const windowFrom = snapshot === null ? '' : snapshot.window.from
      const dailyRows = snapshot === null ? [] : snapshot.daily
      const isDay = scope.kind === 'day'
      const activeDay = isDay ? scope.date : ''

      // ------------------------------------------------------------ scope change
      const selectDay = useCallback((date) => {
        if (typeof date !== 'string' || date === '') return
        setScope({ kind: 'day', date })
        setCalOpen(false)
      }, [])
      const selectToday = useCallback(() => {
        if (todayKey !== '') setScope({ kind: 'day', date: todayKey })
        setCalOpen(false)
      }, [todayKey])
      const selectSegment = useCallback((id) => {
        setCalOpen(false)
        if (id === 'today') {
          if (todayKey !== '') setScope({ kind: 'day', date: todayKey })
          return
        }
        setScope({ kind: 'range', days: Number(id) })
      }, [todayKey])

      // ------------------------------------------------------------ daily series
      const rangeRows = useMemo(() => {
        if (scope.kind !== 'range' || snapshot === null) return []
        return scope.days === 0 ? dailyRows : dailyRows.slice(-scope.days)
      }, [scope, snapshot, dailyRows])

      const highlightFrom = rangeRows.length > 0 && scope.kind === 'range' && scope.days !== 0 ? rangeRows[0].d : ''
      const highlightTo = rangeRows.length > 0 && scope.kind === 'range' && scope.days !== 0 ? rangeRows[rangeRows.length - 1].d : ''

      // ------------------------------------------------------------ perf request
      const perfRequest = useMemo(() => {
        if (snapshot === null) return null
        if (scope.kind === 'day') {
          if (scope.date === todayKey) return { key: `today:${todayKey}`, mode: 'today', params: null, includesToday: true }
          return { key: `day:${scope.date}`, mode: 'day', params: { date: scope.date }, includesToday: false }
        }
        const rows = rangeRows.length > 0 ? rangeRows : dailyRows
        if (rows.length === 0) return null
        const from = rows[0].d
        const to = rows[rows.length - 1].d
        return { key: `range:${from}:${to}`, mode: 'range', params: { from, to }, includesToday: to === todayKey }
      }, [snapshot, scope, todayKey, rangeRows, dailyRows])

      useEffect(() => {
        if (perfRequest === null) {
          setPerfState({ key: '', mode: '', loading: false, data: null })
          return undefined
        }
        if (perfRequest.mode === 'today') {
          setPerfState({ key: perfRequest.key, mode: 'day', loading: false, data: snapshot === null ? null : snapshot.performance })
          return undefined
        }
        const cached = performanceCache.get(perfRequest.key)
        const fresh = cached !== undefined && (!perfRequest.includesToday || Date.now() - cached.at < PERF_CACHE_MS)
        if (fresh) {
          setPerfState({ key: perfRequest.key, mode: perfRequest.mode, loading: false, data: cached.data })
          return undefined
        }
        // Keep the previous chart visible as a dimmed backdrop under the loader,
        // so switching a scope never collapses the panel (and never clamps the
        // scroll position when the board is scrolled to the bottom).
        setPerfState((current) => ({ key: perfRequest.key, mode: perfRequest.mode, loading: true, data: current.data }))
        let alive = true
        const controller = new AbortController()
        loadPerformance(perfRequest.params, controller.signal)
          .then((data) => {
            if (!alive) return
            performanceCache.set(perfRequest.key, { at: Date.now(), data })
            setPerfState({ key: perfRequest.key, mode: perfRequest.mode, loading: false, data })
          })
          .catch(() => {
            if (!alive || controller.signal.aborted) return
            setPerfState((current) => ({ ...current, loading: false }))
          })
        return () => {
          alive = false
          controller.abort()
        }
      }, [perfRequest, snapshot])

      const perfFresh = perfRequest !== null && perfState.key === perfRequest.key
      const perfLoading = perfRequest !== null && perfRequest.mode !== 'today' && (!perfFresh || perfState.loading)
      const sameMode = isDay ? perfState.mode === 'day' : perfState.mode === 'range'
      let usablePerf = sameMode ? perfState.data : null
      const directTodayPerf = isDay && scope.date === todayKey && snapshot !== null && snapshot.performance.date === todayKey
        ? snapshot.performance
        : null
      if (directTodayPerf !== null) usablePerf = directTodayPerf
      const freshPerf = usablePerf !== null && (
        isDay ? usablePerf.date === activeDay : perfFresh
      )

      // ------------------------------------------------------------- scope stats
      const scopeInfo = useMemo(() => {
        if (snapshot === null) {
          return { usage: zeroUsage(), models: [], delta: null, prevTokens: null, peakDay: null, peakHour: null }
        }
        if (scope.kind === 'day') {
          const index = dailyRows.findIndex((row) => row.d === scope.date)
          const row = index >= 0 ? dailyRows[index] : null
          const previous = index > 0 ? dailyRows[index - 1] : null
          const usage = usageOfDayRow(row)
          const prevTokens = previous === null ? null : num(previous.tokens)
          return {
            usage,
            models: modelsOfDayRow(row, snapshot),
            delta: prevTokens !== null && prevTokens > 0 ? (usage.tokens - prevTokens) / prevTokens : null,
            prevTokens,
            peakDay: null,
            peakHour: null,
          }
        }
        if (scope.days === 0) {
          return {
            usage: usageOfSnapshot(snapshot),
            models: snapshot.models.map((row) => ({ model: row.model, providers: row.providers, tokens: row.tokens, calls: row.calls })),
            delta: null,
            prevTokens: null,
            peakDay: snapshot.history.peak.day === '' ? null : snapshot.history.peak,
            peakHour: null,
          }
        }
        const rows = rangeRows
        const usage = usageOfDayRows(rows)
        const previous = rows.length > 0 && dailyRows.length >= rows.length * 2
          ? usageOfDayRows(dailyRows.slice(-rows.length * 2, -rows.length))
          : null
        let peakDay = null
        for (const row of rows) {
          if (num(row.tokens) > 0 && (peakDay === null || num(row.tokens) > num(peakDay.tokens))) peakDay = row
        }
        const scopedModels = modelsOfDayRows(rows, snapshot)
        return {
          usage,
          models: scopedModels.length > 0 ? scopedModels : scaleLifetimeModels(snapshot, usage.tokens),
          delta: previous !== null && previous.tokens > 0 ? (usage.tokens - previous.tokens) / previous.tokens : null,
          prevTokens: previous === null ? null : previous.tokens,
          peakDay,
          peakHour: null,
        }
      }, [snapshot, scope, dailyRows, rangeRows])

      const peakHour = useMemo(() => {
        if (!isDay || !freshPerf || usablePerf === null) return null
        let best = null
        for (const row of usablePerf.hours) {
          if (num(row.tokens) > 0 && (best === null || num(row.tokens) > num(best.tokens))) best = row
        }
        return best
      }, [isDay, freshPerf, usablePerf])

      const dataDays = useMemo(() => {
        const map = new Map()
        for (const row of dailyRows) map.set(row.d, num(row.tokens))
        return map
      }, [dailyRows])

      const usage = scopeInfo.usage
      const totalTokens = usage.tokens
      const totalCalls = usage.calls
      const cacheRate = usage.cacheHitRate
      const empty = snapshot !== null && !hasAnyUsage(snapshot)
      const scopeEmpty = snapshot !== null && !empty && usage.calls === 0
      const scopeBadge = snapshot === null ? '' : isDay ? T['scope.dayView'] : scopeLabelOf(scope, snapshot, lang)

      // ------------------------------------------------------------ header parts
      const segmentId = isDay ? (scope.date === todayKey ? 'today' : '') : scope.days
      const segmentPillIndex = SCOPE_SEGMENTS.findIndex((item) => item.id === segmentId)
      const segmentOptions = SCOPE_SEGMENTS.map((item) => ({
        id: item.id,
        label: item.id === 'today' ? T['scope.today'] : T[`range.${item.id === 0 ? 'all' : item.id}`],
      }))
      const dateLabel = isDay ? dayBadge(activeDay, lang) : T['scope.anyDay']

      const openCalendar = () => {
        if (calOpen) {
          setCalOpen(false)
          return
        }
        if (snapshot === null) return
        const anchor = isDay ? activeDay : todayKey
        const date = dayFromKey(anchor)
        const now = date === null ? new Date() : date
        setCalMonth({ y: now.getFullYear(), m: now.getMonth() + 1 })
        setCalOpen(true)
      }

      const header = h('header', { className: 'up-head up-rise', style: { '--d': '0ms' } },
        h('div', { className: 'up-head-text' },
          h('div', { className: 'up-title-row' },
            h('span', { className: 'up-live', 'aria-hidden': true }),
            h('h1', { className: 'up-title' }, T['panel.title']),
            scopeBadge === '' ? null : h('span', { className: 'up-scope-badge' }, scopeBadge),
          ),
          h('p', { className: 'up-sub' },
            snapshot === null
              ? T['state.loading']
              : `${T['panel.sub']} · ${fill(T['meta.updated'], { time: fmtClock(snapshot.generatedAt) })}`,
          ),
        ),
        h('div', { className: 'up-head-actions' },
          syncing ? h('span', { className: 'up-sync' }, h('span', { className: 'up-sync-dot' }), T['action.syncing']) : null,
          h('div', { className: 'up-seg up-scope', role: 'group', 'aria-label': T['scope.groupA11y'] },
            h('span', { className: `up-seg-pill${segmentPillIndex < 0 ? ' is-hidden' : ''}`, style: { '--i': Math.max(0, segmentPillIndex) } }),
            segmentOptions.map((option) => h('button', {
              key: String(option.id),
              type: 'button',
              className: `up-seg-btn${option.id === segmentId ? ' is-active' : ''}`,
              'aria-pressed': option.id === segmentId,
              'data-scope': option.id === 0 ? 'all' : String(option.id),
              onClick: () => selectSegment(option.id),
            }, option.label)),
          ),
          h('div', { className: 'up-date-wrap' },
            h('button', {
              type: 'button',
              className: `up-date-btn${isDay ? ' is-active' : ''}`,
              'data-action': 'pick-date',
              'aria-haspopup': 'dialog',
              'aria-expanded': calOpen ? 'true' : 'false',
              'aria-label': T['scope.calendarA11y'],
              title: T['scope.calendarTitle'],
              onClick: openCalendar,
            },
            h('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
              h('rect', { x: 3.5, y: 5, width: 17, height: 15.5, rx: 2.5, stroke: 'currentColor', strokeWidth: 1.8 }),
              h('path', { d: 'M3.5 9.5h17M8 3.5V6M16 3.5V6', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
              h('circle', { cx: 12, cy: 14.5, r: 1.6, fill: 'currentColor' }),
            ),
            h('span', null, dateLabel)),
            calOpen && snapshot !== null
              ? h(CalendarPopover, {
                month: calMonth,
                onChangeMonth: setCalMonth,
                value: isDay ? activeDay : '',
                today: todayKey,
                min: windowFrom,
                max: todayKey,
                dataDays,
                lang,
                T,
                onPick: selectDay,
                onToday: selectToday,
                onClose: () => setCalOpen(false),
              })
              : null,
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

      // ------------------------------------------------------------- stat cards
      const rangeDays = rangeRows.length || (snapshot === null ? scope.days : Math.min(scope.days, dailyRows.length))
      const heroLabel = isDay
        ? T['stat.dayTokens']
        : scope.days === 0
          ? T['stat.total']
          : fill(T['stat.rangeTokens'], { days: rangeDays })
      const heroMeta = h('div', { className: 'up-hero-meta' },
        h('span', null, fill(T['stat.calls'], { calls: fmtInt(totalCalls) })),
        h('span', { className: 'up-dot' }),
        h('span', null, fill(T['stat.avg'], { avg: fmtTokens(totalCalls > 0 ? totalTokens / totalCalls : 0, lang) })),
      )
      const heroTag = isDay ? dayBadge(activeDay, lang) : ''

      let deltaCard = null
      if (isDay || scope.days !== 0) {
        const deltaLabel = isDay ? T['stat.vsPrevDay'] : fill(T['stat.vsPrevDays'], { days: rangeDays })
        const previousText = scopeInfo.prevTokens === null
          ? T['stat.noPrev']
          : fill(isDay ? T['stat.prevDayValue'] : T['stat.prevValue'], { tokens: fmtTokens(scopeInfo.prevTokens, lang) })
        deltaCard = h(StatCard, { T, delay: 60 },
          h('div', { className: 'up-stat-label' }, deltaLabel),
          h('div', { className: 'up-stat-value' },
            scopeInfo.delta === null
              ? h('span', { className: 'up-stat-dash' }, '—')
              : h('span', { className: `up-delta-big ${scopeInfo.delta >= 0 ? 'up' : 'down'}` },
                h('span', { className: 'up-arrow', 'aria-hidden': true }, scopeInfo.delta >= 0 ? '▲' : '▼'),
                h(AnimatedNumber, { value: Math.abs(scopeInfo.delta), mode: 'pctfree', lang }),
              ),
          ),
          h('div', { className: 'up-stat-sub' }, previousText),
        )
      } else {
        const activeDays = snapshot === null ? 0 : snapshot.history.activeDays
        const activeAvg = activeDays > 0 ? (snapshot.history.tokens || snapshot.totals.tokens) / activeDays : 0
        deltaCard = h(StatCard, { T, delay: 60 },
          h('div', { className: 'up-stat-label' }, T['stat.activeAvg']),
          h('div', { className: 'up-stat-value' }, h(AnimatedNumber, { value: activeAvg, mode: 'tokens', lang })),
          h('div', { className: 'up-stat-sub' }, fill(T['stat.activeAvgSub'], { days: fmtInt(activeDays) })),
        )
      }

      let peakCard = null
      if (isDay) {
        peakCard = h(StatCard, { T, delay: 100 },
          h('div', { className: 'up-stat-label' }, T['stat.peakHour']),
          h('div', { className: 'up-stat-value' },
            peakHour === null
              ? h('span', { className: 'up-stat-dash' }, '—')
              : h(AnimatedNumber, { value: peakHour.tokens, mode: 'tokens', lang }),
            peakHour === null ? null : h('span', { className: 'up-hero-unit' }, T['unit.tokens']),
          ),
          h('div', { className: 'up-stat-sub' },
            peakHour === null
              ? T['stat.noPeak']
              : h(React.Fragment, null,
                h('span', { className: 'up-peak-chip' }, hourRangeOf(peakHour.h)),
                ' · ',
                fill(T['stat.calls'], { calls: fmtInt(peakHour.calls) }),
              ),
          ),
        )
      } else {
        const peak = scopeInfo.peakDay
        // Range peaks come from a daily row (`d`), the all-time peak from
        // `history.peak` (`day`); normalise before formatting either one.
        const peakDate = peak === null ? '' : (typeof peak.day === 'string' ? peak.day : (typeof peak.d === 'string' ? peak.d : ''))
        peakCard = h(StatCard, { T, delay: 100 },
          h('div', { className: 'up-stat-label' }, T['stat.peakDay']),
          h('div', { className: 'up-stat-value' },
            peak === null
              ? h('span', { className: 'up-stat-dash' }, '—')
              : h(AnimatedNumber, { value: peak.tokens, mode: 'tokens', lang }),
            peak === null ? null : h('span', { className: 'up-hero-unit' }, T['unit.tokens']),
          ),
          h('div', { className: 'up-stat-sub' },
            peak === null
              ? T['stat.noPeak']
              : h(React.Fragment, null,
                h('span', { className: 'up-peak-chip' }, dayBadge(peakDate, lang)),
                peak.calls === undefined ? null : h(React.Fragment, null, ' · ', fill(T['stat.calls'], { calls: fmtInt(peak.calls) })),
              ),
          ),
        )
      }

      const stats = h('div', { className: 'up-stats' },
        h(StatCard, { T, delay: 20, className: 'up-hero' },
          h('div', { className: 'up-stat-label' }, heroLabel, heroTag === '' ? null : h('span', { className: 'up-stat-tag' }, heroTag)),
          h('div', { className: 'up-stat-value' },
            h(AnimatedNumber, { value: totalTokens, mode: 'tokens', lang }),
            h('span', { className: 'up-hero-unit' }, T['unit.tokens']),
          ),
          heroMeta,
        ),
        deltaCard,
        peakCard,
        h(StatCard, { T, delay: 140 },
          h('div', { className: 'up-stat-label' }, T['stat.speed']),
          h('div', { className: 'up-stat-value' },
            h(AnimatedNumber, { value: usage.tokensPerSecond, mode: 'rate', lang }),
            h('span', { className: 'up-stat-unit' }, T['speed.unit']),
          ),
          h('div', { className: 'up-stat-sub' }, fill(T['stat.speedSub'], {
            decode: fmtTokens(usage.decodeTokens, lang),
            samples: fmtInt(usage.samples),
          })),
        ),
        h(StatCard, { T, delay: 180 },
          h('div', { className: 'up-stat-label' }, T['stat.cache']),
          h('div', { className: 'up-cache-body' },
            h(Gauge, { rate: cacheRate, ready }),
            h('div', { className: 'up-stat-value' }, h(AnimatedNumber, { value: cacheRate, mode: 'pct', lang })),
          ),
          h('div', { className: 'up-stat-sub' }, fill(T['stat.cacheSub'], { tokens: fmtTokens(usage.cacheRead, lang) })),
        ),
      )

      // ------------------------------------------------------------- panels
      const compHint = isDay
        ? fill(T['comp.hintDay'], { date: shortDate(activeDay, lang) })
        : scope.days === 0
          ? T['comp.hintAll']
          : fill(T['comp.hintRange'], { days: rangeDays })
      const modelsHint = isDay
        ? T['models.hintDay']
        : scope.days === 0
          ? T['models.hint']
          : T['models.hintRange']

      const scopeEmptyBanner = scopeEmpty
        ? h('div', { className: 'up-scope-empty up-rise', style: { '--d': '200ms' } },
          h('span', { className: 'up-live', 'aria-hidden': true }),
          h('span', null, isDay ? T['empty.scopeDay'] : T['empty.scopeRange']))
        : null

      // ------------------------------------------- usage trend + performance
      const rangeSummary = usage
      const trendReadout = isDay
        ? h(React.Fragment, null,
          fill(T['trend.dayReadout'], { tokens: fmtTokens(totalTokens, lang), calls: fmtInt(totalCalls) }),
          peakHour === null ? null : h(React.Fragment, null, ' · ', fill(T['trend.hourPeak'], { hour: `${String(peakHour.h).padStart(2, '0')}:00` })),
        )
        : h(React.Fragment, null,
          fill(scope.days === 0 ? T['trend.windowTokens'] : T['trend.rangeTokens'], { days: rangeRows.length, tokens: fmtTokens(rangeSummary.tokens, lang) }),
          ' · ',
          fill(T['trend.calls'], { calls: fmtInt(rangeSummary.calls) }),
          ' · ',
          fill(T['trend.dailyAvg'], { tokens: fmtTokens(rangeSummary.tokens / Math.max(1, rangeRows.length), lang) }),
        )
      const comboHint = isDay
        ? fill(T['combo.hintDay'], { date: dayBadge(activeDay, lang) })
        : scope.days === 0
          ? fill(T['combo.hintAll'], { days: rangeRows.length })
          : T['combo.hintRange']
      const hourlyRows = isDay && usablePerf !== null ? usablePerf.hours : []
      const earlyToday = isDay && scope.date === todayKey && usablePerf !== null && usablePerf.date === todayKey && new Date().getHours() < 1
      // A range change swaps the volume bars from the snapshot immediately; the
      // provider medians arrive from /performance right after, so stale lines
      // from the previous range are never drawn against the new day axis.
      const combinedPerf = isDay ? usablePerf : (perfFresh && !perfState.loading ? usablePerf : null)
      const combinedPanel = h(CombinedTrendPanel, {
        series: isDay ? hourlyRows : rangeRows,
        xKind: isDay ? 'hour' : 'day',
        perf: combinedPerf,
        loading: perfLoading,
        day: activeDay,
        todayKey,
        dayOrder: isDay ? undefined : rangeRows.map((row) => row.d),
        readout: trendReadout,
        hint: comboHint,
        emptyText: isDay
          ? (totalTokens > 0 ? T['combo.emptyHourDetail'] : T['combo.emptyDay'])
          : T['combo.emptyRange'],
        earlyText: earlyToday ? T['trend.earlyDay'] : null,
        onReset: selectToday,
        lang,
        T,
        delay: 240,
      })

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
        body = h(React.Fragment, null,
          stats,
          scopeEmptyBanner,
          empty
            ? h('div', { className: 'up-card up-empty up-rise', style: { '--d': '180ms' } },
              h(EmptyArt),
              h('div', { className: 'up-empty-title' }, T['empty.title']),
              h('p', { className: 'up-empty-hint' }, T['empty.hint']),
            )
            : h(React.Fragment, null,
              h('div', { className: 'up-grid2' },
                h(CompositionPanel, { usage, hint: compHint, lang, T, delay: 180 }),
                h(ModelsPanel, {
                  models: scopeInfo.models,
                  totalTokens,
                  totalCalls,
                  hint: modelsHint,
                  emptyText: scopeEmpty ? (isDay ? T['empty.scopeDay'] : T['empty.scopeRange']) : T['empty.title'],
                  lang,
                  T,
                  delay: 210,
                }),
              ),
              combinedPanel,
              h('section', { className: 'up-card up-panel up-rise', style: { '--d': '270ms' } },
                h('div', { className: 'up-panel-head' },
                  h('h2', { className: 'up-panel-title' }, T['heat.title']),
                  h('span', { className: 'up-panel-hint' }, fill(T['heat.hint'], { days: Math.min(119, dailyRows.length) })),
                ),
                h(Heatmap, {
                  daily: dailyRows,
                  lang,
                  T,
                  selectedDay: isDay ? activeDay : '',
                  rangeFrom: highlightFrom,
                  rangeTo: highlightTo,
                  onSelectDay: (day) => selectDay(day),
                }),
              ),
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
