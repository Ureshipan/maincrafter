function norm (s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ')
}

export function extractCoords (text) {
  const t = String(text || '')

  const mx = t.match(/\bx\s*[:=]?\s*(-?\d+)\b/i)
  const my = t.match(/\by\s*[:=]?\s*(-?\d+)\b/i)
  const mz = t.match(/\bz\s*[:=]?\s*(-?\d+)\b/i)
  if (mx && my && mz) {
    return { x: Number(mx[1]), y: Number(my[1]), z: Number(mz[1]), src: 'xyz' }
  }

  const m3 = t.match(/(-?\d+)\s*[, ]\s*(-?\d+)\s*[, ]\s*(-?\d+)/)
  if (m3) {
    return { x: Number(m3[1]), y: Number(m3[2]), z: Number(m3[3]), src: 'triple' }
  }

  const mx2 = t.match(/\bx\s*[:=]?\s*(-?\d+)\b/i)
  const mz2 = t.match(/\bz\s*[:=]?\s*(-?\d+)\b/i)
  if (mx2 && mz2) {
    return { x: Number(mx2[1]), y: null, z: Number(mz2[1]), src: 'xz' }
  }

  return null
}

export function isMemoryIntent (text) {
  const t = norm(text).toLowerCase()
  const triggers = [
    'запомни', 'запомнить',
    'запиши', 'записать',
    'сохрани', 'сохранить',
    'внеси', 'внести',
    'заметь', 'заметить',
    'отметь', 'отметить',
    'зафиксируй', 'зафиксировать',
    'помни', 'помнить',
    'добавь в дневник', 'в дневник',
    'задокументируй', 'задокументировать'
  ]
  return triggers.some(w => t.startsWith(w) || t.includes(` ${w} `))
}

export function parseMemoryFromChat (rawText) {
  const original = norm(rawText)
  if (!isMemoryIntent(original)) return null

  const cut = original.replace(
    /^(запомни|запомнить|запиши|записать|сохрани|сохранить|внеси|внести|заметь|заметить|отметь|отметить|зафиксируй|зафиксировать|помни|помнить)\s*[:,-]?\s*/i,
    ''
  ).trim()

  const coords = extractCoords(cut)

  let label = cut
  if (coords) {
    label = cut
      .replace(/\bx\s*[:=]?\s*-?\d+\b/gi, '')
      .replace(/\by\s*[:=]?\s*-?\d+\b/gi, '')
      .replace(/\bz\s*[:=]?\s*-?\d+\b/gi, '')
      .replace(/-?\d+\s*[, ]\s*-?\d+\s*[, ]\s*-?\d+/, '')
      .replace(/[()]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  if (!label) label = coords ? 'место' : 'заметка'

  label = label
    .replace(/^это\s+/i, '')
    .replace(/^(мой|моя|моё)\s+/i, '')
    .trim()

  if (coords) {
    return {
      kind: 'place',
      label,
      coords,
      text: `Сохранил место "${label}" @ x=${coords.x}, y=${coords.y ?? 'NaN'}, z=${coords.z}.`,
      meta: { label, coords, raw: original, parsedFrom: 'chat' }
    }
  }

  return {
    kind: 'memory',
    text: `Запомнил заметку: "${cut || original}".`,
    meta: { raw: original, parsedFrom: 'chat' }
  }
}
