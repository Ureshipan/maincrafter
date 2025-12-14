import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const DIARY_PATH = process.env.DIARY_PATH || 'data/diary.ndjson'

// Порог "важности": ниже — не пишем
const DIARY_MIN_SCORE = Number(process.env.DIARY_MIN_SCORE || '3')

// Лимиты на шум (скользящее окно)
const DIARY_MAX_PER_MIN = Number(process.env.DIARY_MAX_PER_MIN || '18')
const DIARY_MAX_PER_10S = Number(process.env.DIARY_MAX_PER_10S || '6')

// Дедуп: одинаковое/почти одинаковое подряд
const DIARY_DEDUP_WINDOW_MS = Number(process.env.DIARY_DEDUP_WINDOW_MS || '20000')

// Агрегация майнинга: вместо 100 строк — 1 сводка
const MINE_ROLLUP_FLUSH_MS = Number(process.env.MINE_ROLLUP_FLUSH_MS || '30000')
const MINE_ROLLUP_MIN_TOTAL = Number(process.env.MINE_ROLLUP_MIN_TOTAL || '2')

// ---- in-memory state (на процесс) ----
const state = {
  // timestamps успешных записей (ms)
  writes: [],
  // последние записи для дедупа: [{t, key, textNorm}]
  recent: [],
  // майнинг-агрегатор: key = `${from}|${resource}`
  mineAgg: new Map(),
  // таймер флаша
  timer: null
}

function nowIso () { return new Date().toISOString() }
function nowMs () { return Date.now() }

function safeJsonLine (obj) {
  return JSON.stringify(obj).replace(/\r?\n/g, ' ') + '\n'
}

async function ensureDirForFile (filePath) {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
}

function short (s, max = 280) {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ')
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

function normText (s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s:.,-]/gu, '')
    .trim()
}

function hashText (s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex')
}

function withinWindow (arr, ms) {
  const cut = nowMs() - ms
  while (arr.length && arr[0] < cut) arr.shift()
  return arr.length
}

function isSpamByRateLimit () {
  // чистим хвосты
  withinWindow(state.writes, 60_000)
  const perMin = state.writes.length

  const writes10s = state.writes.filter(t => t >= nowMs() - 10_000).length
  if (perMin >= DIARY_MAX_PER_MIN) return { ok: false, reason: 'rate_per_min' }
  if (writes10s >= DIARY_MAX_PER_10S) return { ok: false, reason: 'rate_per_10s' }

  return { ok: true }
}

function isDupRecent (kind, tool, text) {
  const t = nowMs()
  const cut = t - DIARY_DEDUP_WINDOW_MS
  state.recent = state.recent.filter(r => r.t >= cut)

  const textNorm = normText(text)
  const key = `${kind || ''}|${tool || ''}|${hashText(textNorm)}`

  // точный дедуп
  if (state.recent.some(r => r.key === key)) return true

  // “почти” дедуп (очень похожие строки): для простоты — по нормализованному префиксу
  const pref = textNorm.slice(0, 80)
  if (pref && state.recent.some(r => r.textNorm.startsWith(pref) || pref.startsWith(r.textNorm.slice(0, 80)))) {
    return true
  }

  state.recent.push({ t, key, textNorm })
  return false
}

function scoreEntry (entry) {
  const kind = entry.kind || 'fact'
  const tool = entry.tool || null
  const ok = entry.ok
  const text = String(entry.text || '')

  let score = 0

  // базовая важность по типам
  if (kind === 'error') score += 10
  else if (kind === 'status') score += 2
  else if (kind === 'memory') score += 8
  else if (kind === 'tool_fact' || kind === 'tool_rollup') score += 5
  else if (kind === 'cmd_invalid') score += 1
  else score += 2

  // ошибки/неуспех важнее
  if (ok === false) score += 4

  // “сигнальные” вещи
  if (/\b(x|y|z)\s*[:=]\s*-?\d+\b/i.test(text) || /-?\d+\s*,\s*-?\d+/.test(text)) score += 3
  if (/(дом|база|сундук|спавн|портал|координат)/i.test(text)) score += 2
  if (tool === 'runAway' || tool === 'attackSomeone') score += 2

  // “мусорные” типы ещё сильнее вниз
  if (kind === 'poll' || kind === 'heartbeat' || kind === 'readChat') score -= 100

  return score
}

// --- публичные API ---
export async function appendDiary (entry) {
  await ensureDirForFile(DIARY_PATH)
  await fs.appendFile(DIARY_PATH, safeJsonLine(entry), 'utf8')
}

export async function readDiaryTail (n = 30) {
  try {
    const buf = await fs.readFile(DIARY_PATH, 'utf8')
    const lines = buf.split('\n').map(s => s.trim()).filter(Boolean)
    const tail = lines.slice(Math.max(0, lines.length - n))

    const out = []
    for (const line of tail) {
      try { out.push(JSON.parse(line)) } catch { /* ignore */ }
    }
    return out
  } catch (e) {
    if (String(e?.code || '').toUpperCase() === 'ENOENT') return []
    return []
  }
}

export function formatDiaryForPrompt (entries, { maxLines = 12, maxChars = 1200 } = {}) {
  const sliced = (entries || []).slice(-maxLines)
  const lines = []

  for (const e of sliced) {
    const t = e?.ts ? String(e.ts).slice(11, 19) : ''
    const who = e?.from ? `${e.from}: ` : ''
    const text = e?.text ? e.text : JSON.stringify(e)
    lines.push(`- ${t} ${who}${text}`.trim())
  }

  let out = lines.join('\n')
  if (out.length > maxChars) out = out.slice(out.length - maxChars)
  return out
}

// ---- mining rollup ----
async function flushMineAgg ({ force = false } = {}) {
  const now = nowMs()

  for (const [key, agg] of state.mineAgg.entries()) {
    const age = now - agg.lastAt
    const shouldFlush = force || age >= MINE_ROLLUP_FLUSH_MS
    if (!shouldFlush) continue

    // не пишем совсем мелочь
    if ((agg.total || 0) < MINE_ROLLUP_MIN_TOTAL) {
      state.mineAgg.delete(key)
      continue
    }

    const text = `Добыча (сводка): за последние ~${Math.round((Math.min(now - agg.firstAt, MINE_ROLLUP_FLUSH_MS)) / 1000)}с добыто ${agg.total} ${agg.resource}.`
    await appendDiary({
      ts: nowIso(),
      kind: 'tool_rollup',
      from: agg.from || null,
      tool: 'mineResource',
      ok: true,
      text,
      meta: { resource: agg.resource, total: agg.total }
    })

    state.writes.push(now)
    state.mineAgg.delete(key)
  }
}

export function startDiary () {
  if (state.timer) return
  state.timer = setInterval(() => {
    flushMineAgg({ force: false }).catch(() => {})
  }, Math.max(5_000, Math.min(MINE_ROLLUP_FLUSH_MS, 30_000)))
  state.timer.unref?.()
}

// Главная функция: умный гейт
export async function maybeStore (entry) {
  if (!entry || typeof entry !== 'object') return false

  startDiary()

  // перед любым решением — пробуем сбросить накопленный майнинг
  await flushMineAgg({ force: false })

  const ts = entry.ts || nowIso()
  const kind = entry.kind || 'fact'
  const text = short(entry.text || '')
  const tool = entry.tool || null

  if (!text) return false

  // явная форс-запись
  if (entry?.meta?.force === true) {
    await appendDiary({
      ts,
      kind,
      from: entry.from || null,
      tool,
      ok: typeof entry.ok === 'boolean' ? entry.ok : null,
      text,
      meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : null
    })
    state.writes.push(nowMs())
    return true
  }

  // агрегируем mineResource (успехи) вместо записи каждой операции
  if (kind === 'tool_fact' && tool === 'mineResource' && entry.ok !== false) {
    const resource = entry?.meta?.resource || entry?.meta?.name || entry?.meta?.item || null
    const count = Number(entry?.meta?.count ?? entry?.meta?.total ?? NaN)

    if (resource && Number.isFinite(count) && count > 0) {
      const k = `${entry.from || 'unknown'}|${resource}`
      const cur = state.mineAgg.get(k) || {
        from: entry.from || null,
        resource,
        total: 0,
        firstAt: nowMs(),
        lastAt: nowMs()
      }
      cur.total += count
      cur.lastAt = nowMs()
      state.mineAgg.set(k, cur)
      return false
    }

    // если meta не распознали — пусть идёт обычный гейт
  }

  // скорость/лимиты
  const rl = isSpamByRateLimit()
  if (!rl.ok && kind !== 'error') return false

  // дедуп
  if (isDupRecent(kind, tool, text) && kind !== 'error') return false

  // скоринг
  const score = scoreEntry({ ...entry, text })
  if (score < DIARY_MIN_SCORE) return false

  await appendDiary({
    ts,
    kind,
    from: entry.from || null,
    tool,
    ok: typeof entry.ok === 'boolean' ? entry.ok : null,
    text,
    meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : null
  })

  state.writes.push(nowMs())
  return true
}

// Нормализованная выжимка tool call → entry под maybeStore
export function summarizeToolResult ({ tool, args, resultText, ok, from }) {
  const a = args && typeof args === 'object' ? args : {}
  const res = short(resultText || '', 220)

  if (tool === 'mineResource') {
    const name = a.name ? String(a.name) : 'resource'
    const count = Number.isFinite(Number(a.count)) ? Number(a.count) : null
    const want = count ? `${count} ${name}` : name

    return {
      kind: 'tool_fact',
      from,
      tool,
      ok,
      text: ok
        ? `Добыча: выполнено "${want}". Результат: ${res}`
        : `Добыча: ошибка при "${want}". Ошибка/результат: ${res}`,
      meta: { resource: name, count: count ?? 1 }
    }
  }

  if (tool === 'goToSomeone') {
    const u = a.userName ? String(a.userName) : 'player'
    return {
      kind: 'tool_fact',
      from,
      tool,
      ok,
      text: ok
        ? `Движение: подхожу к игроку "${u}". Результат: ${res}`
        : `Движение: не смог подойти к "${u}". Ошибка/результат: ${res}`,
      meta: { userName: u }
    }
  }

  if (tool === 'goToKnownLocation') {
    const name = a.name ? String(a.name) : 'точка'
    return {
      kind: 'tool_fact',
      from,
      tool,
      ok,
      text: ok
        ? `Навигация: иду к "${name}". Результат: ${res}`
        : `Навигация: не смог дойти до "${name}". Ошибка/результат: ${res}`,
      meta: { name, x: a.x, y: a.y, z: a.z }
    }
  }

  return {
    kind: 'tool_fact',
    from,
    tool,
    ok,
    text: ok
      ? `Tool "${tool}": выполнено. Результат: ${res}`
      : `Tool "${tool}": ошибка. Ошибка/результат: ${res}`,
    meta: { args: a }
  }
}
