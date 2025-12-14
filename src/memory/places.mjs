import fs from 'node:fs/promises'
import path from 'node:path'

const PLACES_PATH = process.env.PLACES_PATH || 'data/places.json'

function nowIso () { return new Date().toISOString() }

async function ensureDirForFile (filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
}

function isPlainObject (v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function normalizeKey (label) {
  const s = String(label ?? '')
    .trim()
    .toLowerCase()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9а-яё_-]/gi, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return s || null
}

function shortLabel (label) {
  const s = String(label ?? '').trim().replace(/\s+/g, ' ')
  return s.length > 60 ? s.slice(0, 59) + '…' : s
}

export async function loadPlaces () {
  try {
    const raw = await fs.readFile(PLACES_PATH, 'utf8')
    const json = JSON.parse(raw)
    if (!isPlainObject(json)) throw new Error('places.json not object')

    if (!isPlainObject(json.places)) json.places = {}
    if (!json.version) json.version = 1
    return json
  } catch (e) {
    if (String(e?.code || '').toUpperCase() === 'ENOENT') {
      return { version: 1, updatedAt: nowIso(), places: {} }
    }
    // Если файл сломан — стартуем “пустым”, чтобы бот не падал
    return { version: 1, updatedAt: nowIso(), places: {} }
  }
}

export async function savePlaces (db) {
  await ensureDirForFile(PLACES_PATH)
  const out = {
    version: db?.version || 1,
    updatedAt: nowIso(),
    places: isPlainObject(db?.places) ? db.places : {}
  }
  await fs.writeFile(PLACES_PATH, JSON.stringify(out, null, 2), 'utf8')
  return out
}

export async function upsertPlace ({ label, coords, from }) {
  const key = normalizeKey(label)
  if (!key) return { ok: false, reason: 'bad_label' }

  const x = Number(coords?.x)
  const yRaw = coords?.y
  const z = Number(coords?.z)

  if (!Number.isFinite(x) || !Number.isFinite(z)) return { ok: false, reason: 'bad_coords' }
  const y = Number.isFinite(Number(yRaw)) ? Number(yRaw) : null

  const db = await loadPlaces()
  const prev = db.places[key]

  const now = nowIso()
  const next = {
    key,
    label: shortLabel(label),
    x,
    y,
    z,
    createdAt: prev?.createdAt || now,
    createdBy: prev?.createdBy || (from || null),
    updatedAt: now,
    updatedBy: from || null,
    lastUsedAt: prev?.lastUsedAt || null,
    notes: prev?.notes || null
  }

  db.places[key] = next
  await savePlaces(db)

  return { ok: true, place: next, existed: Boolean(prev) }
}

export async function getPlace (labelOrKey) {
  const key = normalizeKey(labelOrKey)
  if (!key) return null
  const db = await loadPlaces()
  return db.places[key] || null
}

export async function listPlaces () {
  const db = await loadPlaces()
  return Object.values(db.places || {}).sort((a, b) => String(a.label).localeCompare(String(b.label)))
}

// Для промпта: короткий список "label: x y z"
export async function formatPlacesForPrompt ({ maxLines = 20 } = {}) {
  const places = await listPlaces()
  const tail = places.slice(0, maxLines)

  if (tail.length === 0) return '(нет сохранённых мест)'

  return tail.map(p => {
    const y = (p.y === null || typeof p.y === 'undefined') ? 'NaN' : p.y
    return `- ${p.label} (key=${p.key}): x=${p.x}, y=${y}, z=${p.z}`
  }).join('\n')
}
