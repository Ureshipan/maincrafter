import fs from 'node:fs'
import path from 'node:path'

const dir = path.resolve('data')
const file = path.join(dir, 'journal.ndjson')

export function appendJournal(entry) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8')
}
