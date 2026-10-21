/**
 * dsh-usage-panel — Host half.
 *
 * Aggregates Token usage from this machine's session logs and exposes two
 * read-only JSON routes for the Client panel:
 *
 *   GET|HEAD /dsh-usage-panel/snapshot[?refresh=1]
 *   GET|HEAD /dsh-usage-panel/performance[?date=YYYY-MM-DD]
 *   GET|HEAD /dsh-usage-panel/performance?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * A reading is one `assistant/message` event carrying `data.usage` (Anthropic
 * Messages semantics): `inputTokens` is the prompt that missed the cache, while
 * `cacheReadTokens` / `cacheWriteTokens` are separate additive counters — they
 * are not subsets of the input. No pricing, balance, or account access is
 * involved; every number is re-derivable from committed session logs.
 *
 * Snapshot schema v2 adds per-day model / reasoning / decode fields and
 * all-history day statistics; the performance route serves one local day
 * (hourly usage buckets + provider medians) or an inclusive day range
 * (per-day provider medians).
 *
 * The derived caches live on
 * `globalThis[Symbol.for('dsh-usage-panel:cache:v3')]` so a module reload (HMR
 * remount) does not rescan every log: per-session readings are keyed by
 * revision + eventCount, and the whole snapshot is keyed by the signature of
 * every session id + revision plus the effective config. The cached body is
 * additionally tagged with its schema version so a mid-session upgrade cannot
 * serve a v1-shaped body from a previous module generation.
 */

/** The two read-only routes this Host half owns. */
const ROUTE_PATH = '/dsh-usage-panel/snapshot'
const PERF_ROUTE_PATH = '/dsh-usage-panel/performance'
/** Frozen snapshot schema version. */
const SNAPSHOT_VERSION = 2
/** Parallel session-log reads; the log backend is cheap but not free. */
const READ_CONCURRENCY = 6
/**
 * How long an unreadable log stays behind the retry gate. A historical-format
 * session the backend cannot decode must not cost seconds on every poll; a
 * changed revision still retries immediately.
 */
const FAILURE_RETRY_MS = 10 * 60 * 1000
/** Deferred warm-up so the first panel open usually hits a warm cache. */
const WARMUP_DELAY_MS = 4_000
/** Cross-generation caches; `Symbol.for` survives HMR module replacement. */
const CACHE_SYMBOL = Symbol.for('dsh-usage-panel:cache:v3')
const ROUTES_SYMBOL = Symbol.for('dsh-usage-panel:routes')
const SCOPED_SERVICES = ['sessionPersistence', 'webServer']
const CONFIG_DEFAULTS = { historyDays: 182, maxSessions: 800 }
const CONFIG_MIN = { historyDays: 7, maxSessions: 1 }
const CONFIG_MAX = { historyDays: 365, maxSessions: 5_000 }

// ---------------------------------------------------------------- utilities

/** Defensive positive integer: tolerate numbers and numeric strings. */
function clampInteger(value, fallback, min, max) {
  let candidate = Number.NaN
  if (typeof value === 'number') candidate = value
  else if (typeof value === 'string' && value.trim() !== '') candidate = Number(value)
  if (!Number.isFinite(candidate)) return fallback
  const rounded = Math.round(candidate)
  return Math.min(max, Math.max(min, rounded))
}

/** Normalize the row's `config` (there is no `Config` export by design). */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    historyDays: clampInteger(source.historyDays, CONFIG_DEFAULTS.historyDays, CONFIG_MIN.historyDays, CONFIG_MAX.historyDays),
    maxSessions: clampInteger(source.maxSessions, CONFIG_DEFAULTS.maxSessions, CONFIG_MIN.maxSessions, CONFIG_MAX.maxSessions),
  }
}

/** One usage counter: finite, non-negative, integer. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function nowMs() {
  const perf = globalThis.performance
  if (perf !== null && perf !== undefined && typeof perf.now === 'function') return perf.now()
  return Date.now()
}

function elapsedMs(startedAt) {
  const value = nowMs() - startedAt
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/** Offset from UTC in seconds, positive east of Greenwich (harness convention). */
function timezoneOffsetSeconds() {
  const minutes = new Date().getTimezoneOffset()
  return Number.isFinite(minutes) ? -minutes * 60 : 0
}

/** Local calendar day (`YYYY-MM-DD`) for one epoch-ms timestamp. */
function dayKey(timestamp) {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '1970-01-01'
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** The last `days` local calendar days, oldest first, ending today. */
function recentDays(days) {
  const out = []
  const noon = new Date()
  noon.setHours(12, 0, 0, 0)
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(noon)
    date.setDate(noon.getDate() - index)
    out.push(dayKey(date.getTime()))
  }
  return out
}

/** Warn through the scoped logger, never throwing from logging itself. */
function warn(scope, message, error) {
  try {
    scope?.logger?.warn?.(`[dsh-usage-panel] ${message}`, error)
  } catch {
    // Logging is best-effort.
  }
}

// --------------------------------------------------------------- log reading

/** `list()` returns snapshots (`{ header, revision }`); bare headers are legal too. */
function headerOf(item) {
  if (item === null || typeof item !== 'object') return null
  const header = item.header
  if (header !== undefined && header !== null && typeof header === 'object') return header
  return item
}

/** Raw revision token advertised by a list() snapshot, as a string. */
function revisionToken(item) {
  const revision = item !== null && typeof item === 'object' ? item.revision : undefined
  return revision === undefined || revision === null ? '' : String(revision)
}

/**
 * Stable cache key for one session log: revision plus event count when available.
 *
 * Historical-format sessions report a composite revision whose trailing hash is
 * the identity of the in-memory migration materialization; reading the log
 * produces a fresh identity, so the raw token changes on every list() even
 * though nothing was written. The stable key drops that volatile segment, while
 * a real append still changes the size / event counters before it.
 */
function revisionKey(item) {
  const token = revisionToken(item)
  const stable = token.includes(':') ? token.slice(0, token.lastIndexOf(':')) : token
  const eventCount = item !== null && typeof item === 'object' ? item.eventCount : undefined
  const countPart = eventCount === undefined || eventCount === null ? '' : String(eventCount)
  return `${stable}#${countPart}`
}

/**
 * Whether one compact stream chunk is a token delta, per the LLM stream
 * contract. Mirrors the check the session-stats projection applies so the
 * metric below means the same thing as the Chat panel's tok/s.
 */
function isTokenDeltaChunk(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}

/** Time of the first token in one packed delta run. */
function runFirstTokenTime(run) {
  if (run === null || typeof run !== 'object') return undefined
  const fragments = run.type === 'tool-call-chunks' ? run.args : run.texts
  if (!Array.isArray(fragments)) return undefined
  if (run.type === 'tool-call-chunks' && run.name !== undefined) {
    return typeof run.time0 === 'number' ? run.time0 : undefined
  }
  let time = typeof run.time0 === 'number' ? run.time0 : undefined
  const deltas = Array.isArray(run.dt) ? run.dt : []
  for (let index = 0; index < fragments.length; index += 1) {
    if (index > 0) {
      const delta = Number(deltas[index - 1])
      if (!Number.isFinite(delta)) return undefined
      time += delta
    }
    if (time !== undefined && fragments[index] !== '') return time
  }
  return undefined
}

/** Time of the first token in one durable Assistant stream, if any. */
function streamFirstTokenTime(stream) {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const time = record.type === 'chunk'
      ? (isTokenDeltaChunk(record.chunk) && typeof record.time === 'number' ? record.time : undefined)
      : runFirstTokenTime(record)
    if (time !== undefined) return time
  }
  return undefined
}

/** First timestamp carried by a compact stream, used when no step boundary survived. */
function streamStartTime(stream) {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    if (typeof record.time === 'number') return record.time
    if (typeof record.time0 === 'number') return record.time0
  }
  return undefined
}

/**
 * One `assistant/message` usage reading, reduced to the numbers we aggregate,
 * plus the decode window (`dec` ms between first token and settlement, `dt`
 * output tokens generated inside it) used for the output-speed metric.
 */
function readRecords(events) {
  const records = []
  if (!Array.isArray(events)) return records
  const stepStarts = new Map()
  const stepFirstTokens = new Map()
  const stepKey = (data) => (data !== null && typeof data === 'object' ? `${String(data.turn)}:${String(data.step)}` : '')
  for (const event of events) {
    try {
      if (event === null || typeof event !== 'object') continue
      if (event.type === 'step/start' && typeof event.time === 'number') {
        stepStarts.set(stepKey(event.data), event.time)
        continue
      }
      if (event.type === 'assistant/attempt') {
        const key = stepKey(event.data)
        if (event.data !== null && typeof event.data === 'object' && !stepFirstTokens.has(key)) {
          const first = streamFirstTokenTime(event.data.stream)
          if (first !== undefined) stepFirstTokens.set(key, first)
        }
        continue
      }
      if (event.type === 'step/end') {
        const key = stepKey(event.data)
        stepStarts.delete(key)
        stepFirstTokens.delete(key)
        continue
      }
      if (event.type !== 'assistant/message') continue
      const data = event.data
      if (data === null || typeof data !== 'object') continue
      const usage = data.usage
      if (usage === null || typeof usage !== 'object') continue
      const message = data.message
      const source = message !== null && typeof message === 'object' ? message.source : undefined
      const model = source !== null && typeof source === 'object' && typeof source.model === 'string' && source.model !== ''
        ? source.model
        : 'unknown'
      const provider = source !== null && typeof source === 'object' && typeof source.provider === 'string' && source.provider !== ''
        ? source.provider
        : 'unknown'
      const key = stepKey(data)
      const settledAt = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : 0
      const stream = data.stream
      const firstToken = stepFirstTokens.get(key) ?? streamFirstTokenTime(stream)
      const startedAt = stepStarts.get(key) ?? streamStartTime(stream)
      stepStarts.delete(key)
      stepFirstTokens.delete(key)
      const outputTokens = num(usage.outputTokens)
      let decodeMs = 0
      if (typeof firstToken === 'number' && settledAt > firstToken) decodeMs = settledAt - firstToken
      else if (startedAt !== undefined && settledAt > startedAt) decodeMs = settledAt - startedAt
      const ttftMs = typeof firstToken === 'number' && startedAt !== undefined && firstToken >= startedAt
        ? firstToken - startedAt
        : 0
      records.push({
        t: settledAt,
        m: model,
        p: provider,
        i: num(usage.inputTokens),
        o: outputTokens,
        cr: num(usage.cacheReadTokens),
        cw: num(usage.cacheWriteTokens),
        r: num(usage.reasoningTokens),
        dec: decodeMs > 0 && outputTokens > 0 ? decodeMs : 0,
        dt: decodeMs > 0 ? outputTokens : 0,
        ft: ttftMs > 0 ? ttftMs : 0,
      })
    } catch {
      // A single malformed event must never break the whole scan.
    }
  }
  return records
}

async function safeClose(handle) {
  if (handle === null || typeof handle !== 'object' || typeof handle.close !== 'function') return
  try {
    await handle.close()
  } catch {
    // Closing a read-only session log is best-effort.
  }
}

/** Read one session log; tolerates `read()` returning `{ events }` or events. */
async function readSessionRecords(scope, item) {
  const header = headerOf(item)
  const id = header !== null && typeof header.id === 'string' ? header.id : ''
  if (id === '') return []
  const persistence = scope.sessionPersistence
  if (persistence === null || typeof persistence !== 'object' || typeof persistence.open !== 'function') {
    throw new Error('sessionPersistence.open is unavailable')
  }
  const handle = await persistence.open(id, 'read')
  try {
    if (handle === null || typeof handle !== 'object' || typeof handle.read !== 'function') {
      throw new Error('session handle has no read()')
    }
    const result = await handle.read()
    let events = []
    if (Array.isArray(result)) events = result
    else if (result !== null && typeof result === 'object' && Array.isArray(result.events)) events = result.events
    return readRecords(events)
  } finally {
    await safeClose(handle)
  }
}

/**
 * Fold every session log into per-session record lists, reusing the cache for
 * sessions whose revision did not change. At most READ_CONCURRENCY logs are read
 * at once. A log that fails to decode is gate-cached for FAILURE_RETRY_MS instead
 * of being retried on every request, while a changed revision still retries at
 * once. Returns the readings, how many sessions were re-read, how many failed,
 * how many were skipped behind the gate, and a small failure sample.
 */
async function collectRecords(scope, snapshots, store) {
  const records = []
  const changed = []
  const alive = new Set()
  const failures = []
  const now = Date.now()
  let skipped = 0
  for (const item of snapshots) {
    const header = headerOf(item)
    const id = header !== null && typeof header.id === 'string' && header.id !== '' ? header.id : null
    if (id === null) continue
    if (alive.has(id)) continue // Tolerate a list() with duplicate ids: count once.
    alive.add(id)
    const key = revisionKey(item)
    const cached = store.sessions.get(id)
    if (cached !== undefined && cached.key === key) {
      const failedAt = typeof cached.failedAt === 'number' ? cached.failedAt : 0
      if (failedAt > 0 && now - failedAt < FAILURE_RETRY_MS) {
        skipped += 1
        if (failures.length < 8) failures.push({ id, message: typeof cached.error === 'string' ? cached.error : 'read failed earlier' })
        continue
      }
      if (failedAt === 0) {
        for (let index = 0; index < cached.records.length; index += 1) records.push(cached.records[index])
        continue
      }
    }
    changed.push({ id, key, item })
  }

  let rescanned = 0
  let failed = 0
  for (let offset = 0; offset < changed.length; offset += READ_CONCURRENCY) {
    const slice = changed.slice(offset, offset + READ_CONCURRENCY)
    const settled = await Promise.all(slice.map(async (job) => {
      try {
        const value = await readSessionRecords(scope, job.item)
        return { job, value, ok: true }
      } catch (error) {
        warn(scope, `session ${job.id} read failed:`, error)
        return { job, value: [], ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }))
    for (const result of settled) {
      rescanned += 1
      if (result.ok) {
        store.sessions.set(result.job.id, { key: result.job.key, records: result.value, failedAt: 0 })
      } else {
        failed += 1
        store.sessions.set(result.job.id, { key: result.job.key, records: [], failedAt: Date.now(), error: result.message })
        if (failures.length < 8) failures.push({ id: result.job.id, message: result.message })
      }
      for (let index = 0; index < result.value.length; index += 1) records.push(result.value[index])
    }
  }

  // Forget sessions that no longer exist so the cache stays bounded.
  if (store.sessions.size > alive.size * 2 + 32) {
    for (const id of [...store.sessions.keys()]) {
      if (!alive.has(id)) store.sessions.delete(id)
    }
  }
  return { records, rescanned, failed, skipped, failures, sessionIds: [...alive] }
}


/** Earliest moment one gate-cached failed log may be retried (0 = no failures). */
function failureRetryAt(store, snapshots) {
  let earliest = Infinity
  for (const item of snapshots) {
    const header = headerOf(item)
    const id = header !== null && typeof header.id === 'string' ? header.id : null
    if (id === null) continue
    const cached = store.sessions.get(id)
    if (cached === undefined) continue
    const failedAt = typeof cached.failedAt === 'number' ? cached.failedAt : 0
    if (failedAt > 0) earliest = Math.min(earliest, failedAt + FAILURE_RETRY_MS)
  }
  return Number.isFinite(earliest) ? earliest : 0
}

// ------------------------------------------------------------------ folding

function emptyBucket() {
  return {
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    tokens: 0,
    decodeMs: 0,
    decodeTokens: 0,
    speedSamples: 0,
  }
}

function addReading(bucket, record) {
  bucket.calls += 1
  bucket.input += record.i
  bucket.output += record.o
  bucket.cacheRead += record.cr
  bucket.cacheWrite += record.cw
  bucket.reasoning += record.r
  // `reasoningTokens` is reported separately but is part of outputTokens, so
  // the token total must not add it twice.
  bucket.tokens += record.i + record.o + record.cr + record.cw
  if (record.dec > 0) {
    bucket.decodeMs += record.dec
    bucket.decodeTokens += record.dt
    bucket.speedSamples += 1
  }
}

/** Mean decode speed of one bucket: generated tokens per second after first token. */
function speedOf(bucket) {
  const seconds = bucket.decodeMs > 0 ? bucket.decodeMs / 1000 : 0
  return {
    tokensPerSecond: seconds > 0 ? bucket.decodeTokens / seconds : 0,
    decodeTokens: bucket.decodeTokens,
    decodeMs: Math.round(bucket.decodeMs),
    samples: bucket.speedSamples,
  }
}

/**
 * Aggregate readings. `totals` / `byModel` cover all history, `today` / `month`
 * cover the current local day / month, and `byDay` only covers the daily window.
 *
 * The same single pass also accumulates the v2 additions: the per-day per-model
 * token/call table (`daily[].models`) and the all-history day statistics
 * (`history.activeDays` / `firstDay` / `lastDay` / `peak`), which deliberately
 * include readings outside the daily window — history is cumulative.
 */
function fold(records, days) {
  const todayKey = days[days.length - 1]
  const monthKey = todayKey.slice(0, 7)
  const windowDays = new Set(days)
  const totals = emptyBucket()
  const today = emptyBucket()
  const month = emptyBucket()
  const byDay = new Map()
  for (const day of days) byDay.set(day, emptyBucket())
  const byModel = new Map()
  const dayModels = new Map()
  const dayTokens = new Map()

  for (const record of records) {
    addReading(totals, record)
    // A reading without a usable timestamp (t = 0) has no local calendar day:
    // it still counts toward totals/models, but not toward per-day statistics.
    const key = record.t > 0 ? dayKey(record.t) : ''
    if (key !== '') {
      const dayTokensInRecord = record.i + record.o + record.cr + record.cw
      const previousDayTokens = dayTokens.get(key)
      dayTokens.set(key, previousDayTokens === undefined ? dayTokensInRecord : previousDayTokens + dayTokensInRecord)
      let models = dayModels.get(key)
      if (models === undefined) {
        models = new Map()
        dayModels.set(key, models)
      }
      let dayModel = models.get(record.m)
      if (dayModel === undefined) {
        dayModel = { tokens: 0, calls: 0 }
        models.set(record.m, dayModel)
      }
      dayModel.tokens += dayTokensInRecord
      dayModel.calls += 1
    }
    if (key === todayKey) addReading(today, record)
    if (key.startsWith(monthKey)) addReading(month, record)
    const dayBucket = windowDays.has(key) ? byDay.get(key) : undefined
    if (dayBucket !== undefined) addReading(dayBucket, record)
    let model = byModel.get(record.m)
    if (model === undefined) {
      model = { model: record.m, providers: new Set(), bucket: emptyBucket() }
      byModel.set(record.m, model)
    }
    model.providers.add(record.p)
    addReading(model.bucket, record)
  }

  let activeDays = 0
  let firstDay = ''
  let lastDay = ''
  let peakDay = ''
  let peakTokens = 0
  for (const [key, tokens] of dayTokens) {
    activeDays += 1
    if (firstDay === '' || key < firstDay) firstDay = key
    if (lastDay === '' || key > lastDay) lastDay = key
    if (peakDay === '' || tokens > peakTokens || (tokens === peakTokens && key < peakDay)) {
      peakDay = key
      peakTokens = tokens
    }
  }

  return {
    totals,
    today,
    month,
    byDay,
    byModel,
    dayModels,
    todayKey,
    monthKey,
    history: { activeDays, firstDay, lastDay, peak: { day: peakDay, tokens: peakTokens } },
  }
}

function bucketCounts(bucket) {
  return {
    tokens: bucket.tokens,
    input: bucket.input,
    output: bucket.output,
    cacheRead: bucket.cacheRead,
    cacheWrite: bucket.cacheWrite,
    calls: bucket.calls,
    tokensPerSecond: speedOf(bucket).tokensPerSecond,
  }
}

/** Hour usage bucket: the daily-row counters plus reasoning / decode metrics. */
function hourUsageOf(bucket) {
  const speed = speedOf(bucket)
  return {
    ...bucketCounts(bucket),
    reasoning: bucket.reasoning,
    decodeTokens: speed.decodeTokens,
    decodeMs: speed.decodeMs,
    samples: speed.samples,
  }
}

/**
 * Per-model token/call rows for one day (`daily[].models`). Only models that
 * produced tokens that day are listed; ordered by tokens desc, model asc, the
 * same ordering as the global `models[]`. Zero-usage days yield `[]`.
 */
function dailyModelsOf(dayModels, day) {
  const models = dayModels instanceof Map ? dayModels.get(day) : undefined
  const rows = []
  if (models instanceof Map) {
    for (const [model, entry] of models) {
      if (entry.tokens > 0) rows.push({ model, tokens: entry.tokens, calls: entry.calls })
    }
  }
  rows.sort((left, right) => right.tokens - left.tokens || left.model.localeCompare(right.model))
  return rows
}

function shapeTotals(bucket) {
  const prompt = bucket.input + bucket.cacheRead + bucket.cacheWrite
  return {
    tokens: bucket.tokens,
    input: bucket.input,
    output: bucket.output,
    cacheRead: bucket.cacheRead,
    cacheWrite: bucket.cacheWrite,
    reasoning: bucket.reasoning,
    prompt,
    calls: bucket.calls,
    cacheHitRate: prompt > 0 ? bucket.cacheRead / prompt : 0,
  }
}

/** Shape the cacheable snapshot body (`scan.tookMs`/`cold` are per request). */
function shapeBody(settings, days, folded, sessions, truncated, readings, records) {
  const totals = shapeTotals(folded.totals)
  const todayKey = days[days.length - 1]

  const daily = []
  for (const day of days) {
    const bucket = folded.byDay.get(day)
    const dayBucket = bucket === undefined ? emptyBucket() : bucket
    const speed = speedOf(dayBucket)
    daily.push({
      d: day,
      ...bucketCounts(dayBucket),
      reasoning: dayBucket.reasoning,
      samples: speed.samples,
      decodeTokens: speed.decodeTokens,
      decodeMs: speed.decodeMs,
      models: dailyModelsOf(folded.dayModels, day),
    })
  }

  const models = []
  for (const entry of folded.byModel.values()) {
    models.push({
      model: entry.model,
      providers: [...entry.providers].sort(),
      ...bucketCounts(entry.bucket),
      share: totals.tokens > 0 ? entry.bucket.tokens / totals.tokens : 0,
    })
  }
  models.sort((left, right) => right.tokens - left.tokens || left.model.localeCompare(right.model))

  return {
    sessions,
    readings,
    truncated,
    maxSessions: settings.maxSessions,
    window: { days: days.length, from: days[0] ?? null, to: days[days.length - 1] ?? null },
    totals,
    speed: speedOf(folded.totals),
    today: { day: folded.todayKey, ...bucketCounts(folded.today) },
    month: { month: folded.monthKey, ...bucketCounts(folded.month) },
    history: {
      tokens: totals.tokens,
      calls: totals.calls,
      reasoning: folded.totals.reasoning,
      activeDays: folded.history.activeDays,
      firstDay: folded.history.firstDay,
      lastDay: folded.history.lastDay,
      peak: folded.history.peak,
    },
    daily,
    models,
    performance: performanceOf(Array.isArray(records) ? records : [], todayKey),
  }
}

function emptyBody(settings, days) {
  return shapeBody(settings, days, fold([], days), 0, false, 0, [])
}

/** One-line context for `?debug=1` diagnostics. */
function bodyWindow(payload) {
  return {
    from: payload.window.from,
    to: payload.window.to,
    days: payload.window.days,
    sessions: payload.scan.sessions,
    readings: payload.scan.readings,
  }
}

/** Stamp one request's freshness fields onto a cached or freshly built body. */
function materialize(entry, tookMs) {
  const body = entry.body
  return {
    ok: true,
    version: SNAPSHOT_VERSION,
    generatedAt: Date.now(),
    timezoneOffsetSeconds: timezoneOffsetSeconds(),
    scan: {
      sessions: body.sessions,
      readings: body.readings,
      rescanned: entry.rescanned,
      truncated: body.truncated,
      maxSessions: body.maxSessions,
      tookMs,
      cold: entry.cold,
      failed: entry.failed ?? 0,
      skipped: entry.skipped ?? 0,
      retryAt: entry.retryAt ?? 0,
    },
    window: body.window,
    totals: body.totals,
    speed: body.speed,
    today: body.today,
    month: body.month,
    history: body.history,
    daily: body.daily,
    models: body.models,
    performance: body.performance,
  }
}

// ------------------------------------------------------------------- caches

/**
 * Cross-generation cache. If a previous module generation already created it, reuse
 * and patch it instead of throwing away warm per-session readings on HMR.
 */
function cacheStore() {
  const scope = globalThis
  const existing = scope[CACHE_SYMBOL]
  if (existing !== null && existing !== undefined && typeof existing === 'object') {
    if (!(existing.sessions instanceof Map)) existing.sessions = new Map()
    if (!('snapshot' in existing)) existing.snapshot = null
    if (!('inflight' in existing)) existing.inflight = null
    if (!('lastSessions' in existing)) existing.lastSessions = []
    return existing
  }
  const created = { sessions: new Map(), snapshot: null, inflight: null, lastSessions: [] }
  try {
    scope[CACHE_SYMBOL] = created
  } catch {
    // If the global cannot be written the per-request cache is still correct.
  }
  return created
}

/** One in-flight scan per force-mode; concurrent requests share it. */
function trackScan(store, promise, force) {
  const entry = { force, promise }
  store.inflight = entry
  const release = () => {
    if (store.inflight === entry) store.inflight = null
  }
  promise.then(release, release)
  return promise
}

function scanShared(scope, settings, force) {
  const store = cacheStore()
  const current = store.inflight
  if (current !== null && current !== undefined && typeof current === 'object' && current.promise !== undefined) {
    if (!force || current.force === true) return current.promise
    // A forced request cannot reuse a scan that may have served the snapshot
    // cache, so chain behind it (the per-session cache is shared either way).
    const chained = current.promise.catch(() => undefined).then(() => startScan(scope, settings, true))
    return trackScan(store, chained, true)
  }
  return trackScan(store, startScan(scope, settings, force), force)
}

/** One scan: list sessions, reuse/fill per-session readings, fold, cache body. */
async function startScan(scope, settings, force) {
  const store = cacheStore()
  const days = recentDays(settings.historyDays)
  const todayKey = days[days.length - 1]
  const cacheScope = `${settings.historyDays}|${settings.maxSessions}|${todayKey}|${timezoneOffsetSeconds()}`

  let listedOk = false
  let snapshots = []
  try {
    const listed = await scope.sessionPersistence.list()
    if (Array.isArray(listed)) {
      listedOk = true
      snapshots = listed.filter((item) => item !== null && typeof item === 'object')
    } else {
      throw new Error('sessionPersistence.list() did not return an array')
    }
  } catch (error) {
    warn(scope, 'session list failed:', error)
  }

  let truncated = false
  if (snapshots.length > settings.maxSessions) {
    snapshots = snapshots.slice()
      .sort((left, right) => createdAtOf(right) - createdAtOf(left))
      .slice(0, settings.maxSessions)
    truncated = true
  }

  const signatureParts = []
  for (const item of snapshots) {
    const header = headerOf(item)
    const id = header !== null && typeof header.id === 'string' ? header.id : ''
    signatureParts.push(`${id}\u0000${revisionKey(item)}`)
  }
  signatureParts.sort()
  const cacheKey = `${cacheScope}\u0002${signatureParts.join('\u0001')}`

  const now = Date.now()
  const cachedSnapshot = store.snapshot
  // A body folded by an older module generation lacks the v2 fields; treat it
  // as a miss so one incremental re-fold from the still-warm per-session cache
  // upgrades the shape without re-reading any log.
  const cacheShapeOk = cachedSnapshot !== null && cachedSnapshot !== undefined
    && cachedSnapshot.bodyVersion === SNAPSHOT_VERSION
  if (cacheShapeOk) {
    const retryAt = typeof cachedSnapshot.retryAt === 'number' ? cachedSnapshot.retryAt : 0
    if (cachedSnapshot.key === cacheKey && (retryAt === 0 || now < retryAt)) {
      // Same session signature: no log changed since this body was folded.
      return {
        body: cachedSnapshot.body,
        rescanned: 0,
        cold: false,
        failed: cachedSnapshot.failed ?? 0,
        skipped: cachedSnapshot.skipped ?? 0,
        retryAt,
        failures: cachedSnapshot.failures ?? [],
      }
    }
    if (!listedOk && cachedSnapshot.scope === cacheScope) {
      // Fresh data is unavailable this time; a stale good snapshot beats zeros.
      return {
        body: cachedSnapshot.body,
        rescanned: 0,
        cold: false,
        failed: cachedSnapshot.failed ?? 0,
        skipped: cachedSnapshot.skipped ?? 0,
        retryAt,
        failures: cachedSnapshot.failures ?? [],
      }
    }
  }
  if (!listedOk) {
    // No list and no usable cache: return the contract's valid empty structure.
    return { body: emptyBody(settings, days), rescanned: 0, cold: false, failed: 0, skipped: 0, retryAt: 0, failures: [] }
  }

  const collected = await collectRecords(scope, snapshots, store)
  store.lastSessions = collected.sessionIds
  const folded = fold(collected.records, days)
  const body = shapeBody(settings, days, folded, snapshots.length, truncated, collected.records.length, collected.records)
  const retryAt = failureRetryAt(store, snapshots)
  // A gated failure must not force a rescan on every request: the body is cached
  // with the earliest retry time, and the gate opens again on that deadline.
  // Persistent read failures = already-gated sessions plus anything new this scan.
  const failureCount = collected.skipped + collected.failed
  store.snapshot = {
    key: cacheKey,
    scope: cacheScope,
    bodyVersion: SNAPSHOT_VERSION,
    body,
    at: Date.now(),
    retryAt,
    failed: failureCount,
    skipped: collected.skipped,
    failures: collected.failures,
  }
  return {
    body,
    rescanned: collected.rescanned,
    cold: collected.rescanned > 0,
    failed: failureCount,
    skipped: collected.skipped,
    retryAt,
    failures: collected.failures,
  }
}

function createdAtOf(item) {
  const header = headerOf(item)
  const value = header !== null ? header.createdAt : undefined
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// ------------------------------------------------------------- performance

/** Local calendar-day [start, end) range for one `YYYY-MM-DD` key. */
function localDayRange(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey === undefined || dateKey === null ? '' : dateKey))
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const start = new Date(year, month - 1, day)
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) return null
  if (!Number.isFinite(start.getTime())) return null
  const end = new Date(year, month - 1, day + 1)
  return { start: start.getTime(), end: end.getTime(), key: dateKey }
}

/** Local hour (0..23) for one epoch-ms timestamp. */
function localHour(timestamp) {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? 0 : date.getHours()
}

function emptyPerformanceBucket(provider) {
  return { provider, speeds: [], ttfts: [] }
}

/** Largest accepted inclusive day span of the `?from` / `?to` range mode. */
const MAX_PERFORMANCE_RANGE_DAYS = 400

/** Median of a numeric list (0 for an empty list). */
function medianOf(values) {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * Project one bucket to the wire shape the chart consumes. Latency uses the
 * median: a step that stretched over an idle/sleep window must not drag a whole
 * hour's average to minutes. Speed is the median per-call throughput for the
 * same robustness.
 */
function shapePerformanceBucket(bucket) {
  return {
    provider: bucket.provider,
    tps: medianOf(bucket.speeds),
    ttftMs: medianOf(bucket.ttfts),
    speedSamples: bucket.speeds.length,
    ttftSamples: bucket.ttfts.length,
    samples: Math.max(bucket.speeds.length, bucket.ttfts.length),
  }
}

/** Provider rows are ordered by sample count desc, then provider name asc. */
function sortPerformanceBuckets(rows) {
  return rows.sort((left, right) => right.samples - left.samples || left.provider.localeCompare(right.provider))
}

/** Get-or-create one provider bucket inside a `Map<provider, bucket>`. */
function performanceBucketFor(buckets, provider) {
  let bucket = buckets.get(provider)
  if (bucket === undefined) {
    bucket = emptyPerformanceBucket(provider)
    buckets.set(provider, bucket)
  }
  return bucket
}

/** Per-call throughput: output tokens over the decode window, 0 without one. */
function callSpeedOf(record) {
  return record.dec > 0 && record.dt > 0 ? record.dt / (record.dec / 1000) : 0
}

/** Record one reading's speed / first-token samples into one provider bucket. */
function addPerformanceSample(bucket, record, callSpeed) {
  if (callSpeed > 0) bucket.speeds.push(callSpeed)
  if (record.ft > 0) bucket.ttfts.push(record.ft)
}

/**
 * Per-provider, per-hour speed and first-token latency for one local day, plus
 * the v2 hourly usage bucket (`hours[].tokens / … / samples`) that the Client's
 * 24-hour chart reads. A reading contributes to the speed series only with a
 * decode window and to the latency series only with a first-token time; both
 * stay 0 otherwise. Hours without any reading are omitted.
 */
function performanceOf(records, dateKey) {
  const range = localDayRange(dateKey)
  const providers = new Map()
  const hours = new Map()
  if (range !== null && Array.isArray(records)) {
    for (const record of records) {
      if (record === null || typeof record !== 'object') continue
      if (!(record.t >= range.start && record.t < range.end)) continue
      const provider = typeof record.p === 'string' && record.p !== '' ? record.p : 'unknown'
      const hour = localHour(record.t)
      let row = hours.get(hour)
      if (row === undefined) {
        row = { h: hour, usage: emptyBucket(), providers: new Map() }
        hours.set(hour, row)
      }
      addReading(row.usage, record)
      const callSpeed = callSpeedOf(record)
      addPerformanceSample(performanceBucketFor(providers, provider), record, callSpeed)
      addPerformanceSample(performanceBucketFor(row.providers, provider), record, callSpeed)
    }
  }
  const providerList = sortPerformanceBuckets([...providers.values()].map(shapePerformanceBucket))
  const hourList = [...hours.values()]
    .sort((left, right) => left.h - right.h)
    .map((row) => ({
      h: row.h,
      ...hourUsageOf(row.usage),
      providers: sortPerformanceBuckets([...row.providers.values()].map(shapePerformanceBucket)),
    }))
  return {
    date: range === null ? String(dateKey === undefined || dateKey === null ? '' : dateKey) : dateKey,
    providers: providerList,
    hours: hourList,
  }
}

/**
 * Per-provider medians over one inclusive local-day range, plus a per-day
 * breakdown. One pass over the readings; `days` only lists local days with at
 * least one reading (ascending), each day's provider rows use the same median
 * wire shape as the single-day mode. Used by the `/performance?from=&to=` mode
 * and folded from the in-memory records each request (no extra cache).
 */
function performanceRangeOf(records, fromKey, toKey) {
  const fromRange = localDayRange(fromKey)
  const toRange = localDayRange(toKey)
  const providers = new Map()
  const days = new Map()
  if (fromRange !== null && toRange !== null && Array.isArray(records)) {
    for (const record of records) {
      if (record === null || typeof record !== 'object') continue
      if (!(record.t >= fromRange.start && record.t < toRange.end)) continue
      const provider = typeof record.p === 'string' && record.p !== '' ? record.p : 'unknown'
      const day = dayKey(record.t)
      let dayBuckets = days.get(day)
      if (dayBuckets === undefined) {
        dayBuckets = new Map()
        days.set(day, dayBuckets)
      }
      const callSpeed = callSpeedOf(record)
      addPerformanceSample(performanceBucketFor(providers, provider), record, callSpeed)
      addPerformanceSample(performanceBucketFor(dayBuckets, provider), record, callSpeed)
    }
  }
  const providerList = sortPerformanceBuckets([...providers.values()].map(shapePerformanceBucket))
  const dayList = [...days.keys()]
    .sort()
    .map((day) => ({
      d: day,
      providers: sortPerformanceBuckets([...(days.get(day)?.values() ?? [])].map(shapePerformanceBucket)),
    }))
  return {
    from: typeof fromKey === 'string' ? fromKey : '',
    to: typeof toKey === 'string' ? toKey : '',
    providers: providerList,
    days: dayList,
  }
}

/**
 * Calendar-day ordinal for one validated `YYYY-MM-DD` key. Built from the UTC
 * components so a DST shift inside the range cannot bend the span arithmetic.
 */
function dayOrdinal(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof dateKey === 'string' ? dateKey : '')
  if (match === null) return null
  const value = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isFinite(value) ? Math.floor(value / 86_400_000) : null
}

/**
 * Resolve the `/performance` query into a day or range request. Range mode is
 * entered when either `from` or `to` is present; both must then be valid
 * `YYYY-MM-DD` keys with `from <= to` and a span of at most
 * MAX_PERFORMANCE_RANGE_DAYS days. The single-day mode keeps the v1 behaviour
 * (`?date=` optional, default today) and its `invalid-date` error code.
 */
function parsePerformanceQuery(search) {
  const fromRaw = search.get('from')
  const toRaw = search.get('to')
  if (fromRaw !== null || toRaw !== null) {
    const from = typeof fromRaw === 'string' ? fromRaw.trim() : ''
    const to = typeof toRaw === 'string' ? toRaw.trim() : ''
    if (from === '' || to === '') return { mode: 'invalid', error: 'invalid-range' }
    if (localDayRange(from) === null || localDayRange(to) === null) return { mode: 'invalid', error: 'invalid-range' }
    const fromOrdinal = dayOrdinal(from)
    const toOrdinal = dayOrdinal(to)
    if (fromOrdinal === null || toOrdinal === null) return { mode: 'invalid', error: 'invalid-range' }
    if (toOrdinal < fromOrdinal || toOrdinal - fromOrdinal > MAX_PERFORMANCE_RANGE_DAYS) {
      return { mode: 'invalid', error: 'invalid-range' }
    }
    return { mode: 'range', from, to }
  }
  const rawDate = search.get('date')
  const requested = typeof rawDate === 'string' && rawDate.trim() !== '' ? rawDate.trim() : dayKey(Date.now())
  if (localDayRange(requested) === null) return { mode: 'invalid', error: 'invalid-date' }
  return { mode: 'day', date: requested }
}

/** Cached records of the sessions the latest scan considers alive. */
function liveSessionRecords(store) {
  const ids = Array.isArray(store.lastSessions) ? store.lastSessions : [...store.sessions.keys()]
  const records = []
  for (const id of ids) {
    const entry = store.sessions.get(id)
    if (entry === undefined || entry.failedAt > 0 || !Array.isArray(entry.records)) continue
    for (const record of entry.records) records.push(record)
  }
  return records
}

// ------------------------------------------------------------------- routes

function routeTable() {
  const scope = globalThis
  const existing = scope[ROUTES_SYMBOL]
  if (existing instanceof Map) return existing
  const created = new Map()
  try {
    scope[ROUTES_SYMBOL] = created
  } catch {
    // Fall through with an unshared table; route registration still works.
  }
  return created
}

/**
 * Claim one exact route, releasing a stale generation's handler first: HMR can
 * mount a new generation before the old route is disposed, and `register()`
 * throws on a duplicate `(kind, path)`.
 */
function installRoute(scope, route) {
  const key = `${route.kind}:${route.path}`
  const table = routeTable()
  const previous = table.get(key)
  if (previous !== undefined && previous !== null) {
    try {
      if (typeof previous === 'function') previous()
      else if (typeof previous.dispose === 'function') previous.dispose()
    } catch {
      // The previous webserver may already be gone.
    }
    if (table.get(key) === previous) table.delete(key)
  }
  try {
    if (scope.webServer === null || typeof scope.webServer !== 'object' || typeof scope.webServer.register !== 'function') {
      throw new Error('webServer.register is unavailable')
    }
    const dispose = scope.webServer.register(route)
    const entry = { dispose }
    table.set(key, entry)
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // Already released.
      }
      if (table.get(key) === entry) table.delete(key)
    }
  } catch (error) {
    warn(scope, `route ${key} could not be registered; keeping any existing handler:`, error)
    return () => {}
  }
}

/** Write one JSON response. HEAD gets the same headers with no body. */
function respond(res, status, payload, headOnly) {
  if (res === null || typeof res !== 'object' || typeof res.writeHead !== 'function') return
  let body = '{"ok":false,"error":"snapshot-failed"}'
  let finalStatus = status
  try {
    body = JSON.stringify(payload)
  } catch {
    finalStatus = 500
  }
  let length = 0
  try {
    length = Buffer.byteLength(body)
  } catch {
    length = body.length
  }
  try {
    res.writeHead(finalStatus, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': length,
      'cache-control': 'no-store',
    })
    if (typeof res.end === 'function') res.end(headOnly === true ? undefined : body)
  } catch {
    try {
      res.end?.()
    } catch {
      // The client may already be gone.
    }
  }
}

/** Uppercased HTTP method of one request (defaults to GET). */
function requestMethod(req) {
  return req !== null && req !== undefined && typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
}

/** Whether one request is a HEAD (its response must carry headers only). */
function isHeadRequest(req) {
  return requestMethod(req) === 'HEAD'
}

function createHandler(scope, settings) {
  return (req, res) => {
    let promise
    try {
      promise = handleRequest(scope, settings, req, res)
    } catch (error) {
      warn(scope, 'request handling failed:', error)
      respond(res, 500, { ok: false, error: 'snapshot-failed' }, isHeadRequest(req))
      return undefined
    }
    return promise.catch((error) => {
      warn(scope, 'request handling failed:', error)
      respond(res, 500, { ok: false, error: 'snapshot-failed' }, isHeadRequest(req))
    })
  }
}

async function handleRequest(scope, settings, req, res) {
  const method = requestMethod(req)
  if (method !== 'GET' && method !== 'HEAD') {
    respond(res, 405, { ok: false, error: 'method-not-allowed' }, method === 'HEAD')
    return
  }
  const headOnly = method === 'HEAD'
  let forceRefresh = false
  let debug = false
  try {
    const rawUrl = req !== null && req !== undefined && typeof req.url === 'string' && req.url !== '' ? req.url : ROUTE_PATH
    const search = new URL(rawUrl, 'http://127.0.0.1').searchParams
    forceRefresh = search.get('refresh') === '1'
    debug = search.get('debug') === '1'
  } catch {
    forceRefresh = false
  }
  try {
    const startedAt = nowMs()
    const entry = await scanShared(scope, settings, forceRefresh)
    const payload = materialize(entry, elapsedMs(startedAt))
    if (debug) payload.diagnostics = {
      failures: entry.failures ?? [],
      retryAt: entry.retryAt ?? 0,
      readMs: payload.scan.tookMs,
      window: bodyWindow(payload),
    }
    respond(res, 200, payload, headOnly)
  } catch (error) {
    warn(scope, 'snapshot failed:', error)
    respond(res, 500, { ok: false, error: 'snapshot-failed' }, headOnly)
  }
}

function createPerformanceHandler(scope, settings) {
  return (req, res) => {
    let promise
    try {
      promise = handlePerformanceRequest(scope, settings, req, res)
    } catch (error) {
      warn(scope, 'performance request handling failed:', error)
      respond(res, 500, { ok: false, error: 'performance-failed' }, isHeadRequest(req))
      return undefined
    }
    return promise.catch((error) => {
      warn(scope, 'performance request handling failed:', error)
      respond(res, 500, { ok: false, error: 'performance-failed' }, isHeadRequest(req))
    })
  }
}

/**
 * Serve `/performance` in both modes:
 *
 * - `?date=YYYY-MM-DD` (default today): one local day, `performance.hours[]`
 *   carries the v2 hourly usage buckets next to the per-provider medians.
 * - `?from=YYYY-MM-DD&to=YYYY-MM-DD`: inclusive range, `performance.days[]`
 *   plus range-wide provider medians. Invalid / reversed / over-long ranges
 *   are rejected with 400 `invalid-range` before any scan.
 *
 * Both modes fold from the records the shared scan already cached in memory;
 * they never trigger a full rescan on their own (`force = false`).
 */
async function handlePerformanceRequest(scope, settings, req, res) {
  const method = requestMethod(req)
  if (method !== 'GET' && method !== 'HEAD') {
    respond(res, 405, { ok: false, error: 'method-not-allowed' }, method === 'HEAD')
    return
  }
  const headOnly = method === 'HEAD'
  let query
  try {
    const rawUrl = req !== null && req !== undefined && typeof req.url === 'string' && req.url !== '' ? req.url : PERF_ROUTE_PATH
    query = parsePerformanceQuery(new URL(rawUrl, 'http://127.0.0.1').searchParams)
  } catch {
    // An unparsable URL degrades to the v1 default: today's single-day view.
    query = { mode: 'day', date: dayKey(Date.now()) }
  }
  if (query.mode === 'invalid') {
    respond(res, 400, { ok: false, error: query.error }, headOnly)
    return
  }
  const startedAt = nowMs()
  try {
    // Warm/incremental scan first: it fills the per-session record cache this
    // fold reads, and reuses the same revision gate the snapshot route uses.
    await scanShared(scope, settings, false)
    const store = cacheStore()
    const records = liveSessionRecords(store)
    const tookMs = elapsedMs(startedAt)
    const payload = query.mode === 'range'
      ? {
        ok: true,
        version: SNAPSHOT_VERSION,
        generatedAt: Date.now(),
        tookMs,
        from: query.from,
        to: query.to,
        performance: performanceRangeOf(records, query.from, query.to),
      }
      : {
        ok: true,
        version: SNAPSHOT_VERSION,
        generatedAt: Date.now(),
        date: query.date,
        tookMs,
        performance: performanceOf(records, query.date),
      }
    respond(res, 200, payload, headOnly)
  } catch (error) {
    warn(scope, 'performance fold failed:', error)
    respond(res, 500, { ok: false, error: 'performance-failed' }, headOnly)
  }
}

// --------------------------------------------------------------------- apply

export const name = 'dsh-usage-panel'
/** Services are acquired through the scoped `ctx.inject` below. */
export const inject = []

/** Return an effect-registering callback that schedules the deferred warm-up. */
function warmUpEffect(scope, settings) {
  return () => {
    const timer = setTimeout(() => {
      scanShared(scope, settings, false).catch(() => {
        // Warm-up is opportunistic: failures are silent by contract.
      })
    }, WARMUP_DELAY_MS)
    if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
    return () => {
      try {
        clearTimeout(timer)
      } catch {
        // The runtime is already gone.
      }
    }
  }
}

function mount(scope, settings) {
  if (scope === null || typeof scope !== 'object') return
  if (scope.webServer === null || typeof scope.webServer !== 'object' || typeof scope.webServer.register !== 'function') {
    warn(scope, 'webServer service is unavailable; routes not registered')
    return
  }

  const disposeRoute = installRoute(scope, {
    kind: 'exact',
    path: ROUTE_PATH,
    handler: createHandler(scope, settings),
  })
  const disposePerformanceRoute = installRoute(scope, {
    kind: 'exact',
    path: PERF_ROUTE_PATH,
    handler: createPerformanceHandler(scope, settings),
  })

  if (typeof scope.effect !== 'function') {
    warn(scope, 'ctx.effect is unavailable; keeping the route without a managed warm-up')
    return
  }
  try {
    scope.effect(() => () => {
      disposeRoute()
      disposePerformanceRoute()
    }, 'dsh-usage-panel: routes')
    scope.effect(warmUpEffect(scope, settings), 'dsh-usage-panel: warm-up')
  } catch (error) {
    warn(scope, 'lifecycle registration failed; disposing the routes:', error)
    disposeRoute()
    disposePerformanceRoute()
  }
}

export function apply(ctx, config) {
  if (ctx === null || ctx === undefined || typeof ctx !== 'object') return
  const settings = normalizeConfig(config)
  try {
    if (typeof ctx.inject !== 'function') {
      warn(ctx, 'ctx.inject is unavailable; Host half is inert')
      return
    }
    ctx.inject(SCOPED_SERVICES, (scope) => {
      try {
        mount(scope === null || scope === undefined ? ctx : scope, settings)
      } catch (error) {
        warn(scope === null || scope === undefined ? ctx : scope, 'mount failed:', error)
      }
    })
  } catch (error) {
    warn(ctx, 'service injection failed:', error)
  }
}
