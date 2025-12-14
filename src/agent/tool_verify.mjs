function short (s, max = 220) {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ')
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

function tryParseJson (text) {
  const s = String(text ?? '').trim()
  if (!s) return null
  if (s.startsWith('{') && s.endsWith('}')) {
    try { return JSON.parse(s) } catch {}
  }
  const i = s.indexOf('{')
  const j = s.lastIndexOf('}')
  if (i >= 0 && j > i) {
    try { return JSON.parse(s.slice(i, j + 1)) } catch {}
  }
  return null
}

function parseProgressMined (text) {
  const t = String(text ?? '')

  // "mined 3 of 20"
  let m = t.match(/\bmined\s+(\d+)\s+of\s+(\d+)\b/i)
  if (m) return { cur: Number(m[1]), total: Number(m[2]) }

  // "3/20"
  m = t.match(/\b(\d+)\s*\/\s*(\d+)\b/)
  if (m) return { cur: Number(m[1]), total: Number(m[2]) }

  // "3 of 20" (без mined)
  m = t.match(/\b(\d+)\s+of\s+(\d+)\b/i)
  if (m) return { cur: Number(m[1]), total: Number(m[2]) }

  return null
}

function looksDone (text) {
  const t = String(text ?? '').toLowerCase()
  return (
    /\b(done|completed|complete|finished|success|ok)\b/.test(t) ||
    /\barrived\b/.test(t) ||
    /\breached\b/.test(t)
  )
}

export function verifyToolResult ({ tool, args, resultText, toolError }) {
  // Ошибка tool вызова — считаем финалом (done=true), чтобы записать в дневник 1 раз
  if (toolError) {
    return {
      ok: false,
      done: true,
      progress: null,
      summary: `${tool}: ошибка выполнения.`,
      meta: { tool, args, error: short(toolError, 260) }
    }
  }

  const raw = String(resultText ?? '')
  const json = tryParseJson(raw)

  // Если tool когда-то вернёт структурированный ответ — используем его
  if (json && typeof json === 'object') {
    const ok = typeof json.ok === 'boolean' ? json.ok : true
    const done = typeof json.done === 'boolean' ? json.done : true
    return {
      ok,
      done,
      progress: json.progress ?? null,
      summary: `${tool}: ${ok ? 'выполнено' : 'ошибка'}.`,
      meta: { tool, args, json }
    }
  }

  // Спец-логика для mineResource: не писать прогресс, писать только финал
  if (tool === 'mineResource') {
    const p = parseProgressMined(raw)
    if (p && Number.isFinite(p.cur) && Number.isFinite(p.total) && p.total > 0) {
      const done = p.cur >= p.total
      return {
        ok: true,
        done,
        progress: { current: p.cur, total: p.total },
        summary: done ? `Добыча завершена (${p.cur}/${p.total}).` : `Добыча в процессе (${p.cur}/${p.total}).`,
        meta: {
          tool,
          resource: args?.name ?? null,
          requested: Number(args?.count ?? p.total),
          mined: p.cur
        }
      }
    }

    // Если прогресс не распознали: по умолчанию считаем, что вызов завершился
    const done = looksDone(raw) || true
    return {
      ok: true,
      done,
      progress: null,
      summary: done ? 'Добыча завершена.' : 'Добыча в процессе.',
      meta: {
        tool,
        resource: args?.name ?? null,
        requested: Number(args?.count ?? NaN),
        mined: Number(args?.count ?? NaN)
      }
    }
  }

  // Для навигации/боя/еды: это “одношаговые” tools — считаем done=true
  return {
    ok: true,
    done: true,
    progress: null,
    summary: `${tool}: выполнено.`,
    meta: { tool }
  }
}
