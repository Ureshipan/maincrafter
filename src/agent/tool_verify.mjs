function short (s, max = 260) {
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
  if (m) return { current: Number(m[1]), total: Number(m[2]) }

  // "3/20"
  m = t.match(/\b(\d+)\s*\/\s*(\d+)\b/)
  if (m) return { current: Number(m[1]), total: Number(m[2]) }

  // "3 of 20" (без mined)
  m = t.match(/\b(\d+)\s+of\s+(\d+)\b/i)
  if (m) return { current: Number(m[1]), total: Number(m[2]) }

  return null
}

export function verifyToolResult ({ tool, args, resultText, toolError }) {
  if (toolError) {
    return {
      ok: false,
      done: true,
      progress: null,
      summary: `${tool}: ошибка выполнения.`,
      meta: { tool, args, error: short(toolError) }
    }
  }

  const raw = String(resultText ?? '')
  const json = tryParseJson(raw)

  // Если tool вернул структурированный ответ — используем
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

  // --- STRICT режим для mineResource ---
  // done=true ТОЛЬКО если распознали прогресс и current>=total.
  if (tool === 'mineResource') {
    const p = parseProgressMined(raw)

    if (p && Number.isFinite(p.current) && Number.isFinite(p.total) && p.total > 0) {
      const done = p.current >= p.total
      return {
        ok: true,
        done,
        progress: { current: p.current, total: p.total },
        summary: done
          ? `Добыча завершена (${p.current}/${p.total}).`
          : `Добыча в процессе (${p.current}/${p.total}).`,
        meta: {
          tool,
          resource: args?.name ?? null,
          requested: Number(args?.count ?? p.total),
          mined: p.current
        }
      }
    }

    // прогресс не распознали => НЕ финализируем
    return {
      ok: true,
      done: false,
      progress: null,
      summary: 'Добыча в процессе.',
      meta: {
        tool,
        resource: args?.name ?? null,
        requested: Number(args?.count ?? NaN)
      }
    }
  }

  // Остальные tools считаем одношаговыми (done=true если не было исключения)
  return {
    ok: true,
    done: true,
    progress: null,
    summary: `${tool}: выполнено.`,
    meta: { tool }
  }
}
