import 'dotenv/config'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { appendJournal } from '../src/journal.mjs'
import { ollamaReply } from '../src/ollama.mjs'

// ---- env ----
const MC_HOST = process.env.MC_HOST || 'localhost'
const MC_PORT = Number(process.env.MC_PORT || '25565')
const BOT_USERNAME = process.env.BOT_USERNAME || 'MAIncrafter'

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen-ram'

// \текст — обычный диалог
// \!текст — команда (план + инструменты)
const CHAT_PREFIX = process.env.CHAT_PREFIX || '\\'
const CMD_PREFIX = process.env.CMD_PREFIX || `${CHAT_PREFIX}!`

const POLL_MS = Number(process.env.POLL_MS || '800')
const TIME_LIMIT_SEC = Number(process.env.CHAT_TIME_LIMIT_SEC || '60')

const MAX_HISTORY_MESSAGES = Number(process.env.MAX_HISTORY_MESSAGES || '20')
const SEEN_LIMIT = Number(process.env.SEEN_LIMIT || '800')

// Сколько раз просить модель исправить JSON-план при ошибке валидации
const CMD_MAX_RETRIES = Number(process.env.CMD_MAX_RETRIES || '2')

// Allowlist инструментов (можно переопределить через env ALLOWED_TOOLS="a,b,c")
const DEFAULT_ALLOWED_TOOLS = [
  'goToKnownLocation',
  'goToSomeone',
  'mineResource',
  'eatFood',
  'runAway',
  'attackSomeone'
]

const ALLOWED_TOOLS = new Set(
  (process.env.ALLOWED_TOOLS
    ? process.env.ALLOWED_TOOLS.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_TOOLS)
)

// ---- helpers ----
function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

function extractText (toolRes) {
  const c = toolRes?.content
  if (Array.isArray(c)) {
    return c.map(part => {
      if (typeof part === 'string') return part
      if (part?.type === 'text' && typeof part.text === 'string') return part.text
      if (typeof part?.text === 'string') return part.text
      return JSON.stringify(part)
    }).join('\n')
  }
  if (typeof c === 'string') return c
  return JSON.stringify(toolRes)
}

// [18:43:16] <Nick>: message
function parseChatLine (line) {
  const m = line.match(/^\[\d{2}:\d{2}:\d{2}\]\s*<([^>]+)>:\s*(.+)$/)
  if (!m) return null
  return { user: m[1], msg: m[2], raw: line }
}

function makeSeenSet (limit = 500) {
  const set = new Set()
  const queue = []
  return {
    has: (k) => set.has(k),
    add: (k) => {
      if (set.has(k)) return
      set.add(k)
      queue.push(k)
      while (queue.length > limit) {
        const old = queue.shift()
        set.delete(old)
      }
    }
  }
}

function pushHistory (history, item, max = MAX_HISTORY_MESSAGES) {
  history.push(item)
  while (history.length > max) history.shift()
}

function sanitizeReply (text) {
  const s = (text || '').trim().replace(/\s+/g, ' ')
  return s.slice(0, 240) // ниже 256 лимита sendChat (с запасом)
}

function extractJson (text) {
  if (!text) return null
  const trimmed = text.trim()

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try { return JSON.parse(trimmed) } catch { /* ignore */ }
  }

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null

  const candidate = trimmed.slice(firstBrace, lastBrace + 1)
  try { return JSON.parse(candidate) } catch { return null }
}

// ---- generic string similarity (для "type" -> "name", "amount" -> "count" и т.п.) ----
function levenshtein (a, b) {
  a = String(a || '')
  b = String(b || '')
  const n = a.length
  const m = b.length
  if (n === 0) return m
  if (m === 0) return n

  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 0; i <= n; i++) dp[i][0] = i
  for (let j = 0; j <= m; j++) dp[0][j] = j

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      )
    }
  }
  return dp[n][m]
}

function similarity (a, b) {
  a = String(a || '').toLowerCase()
  b = String(b || '').toLowerCase()
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  const dist = levenshtein(a, b)
  return 1 - (dist / maxLen)
}

function isPlainObject (v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function toNumberMaybe (v) {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const t = v.trim()
    if (t === '') return v
    const n = Number(t)
    if (!Number.isNaN(n)) return n
  }
  return v
}

function normalizeArgsKeysBySchema (args, schema) {
  if (!isPlainObject(args)) return {}
  const props = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {}
  const knownKeys = Object.keys(props)

  // быстрый выход
  if (knownKeys.length === 0) return { ...args }

  const out = { ...args }

  // 1) если у args есть неизвестные ключи — попробуем сматчить их к ближайшему известному
  for (const k of Object.keys(out)) {
    if (knownKeys.includes(k)) continue

    // Найдём ближайший известный ключ
    let best = null
    let bestScore = 0
    for (const cand of knownKeys) {
      const s = similarity(k, cand)
      if (s > bestScore) { bestScore = s; best = cand }
    }

    // порог: достаточно строгий, чтобы не “ломать” нормальные поля
    if (best && bestScore >= 0.72 && !(best in out)) {
      out[best] = out[k]
      delete out[k]
    }
  }

  return out
}

function coerceArgsTypesBySchema (args, schema) {
  if (!isPlainObject(args)) return {}
  const props = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {}
  const out = { ...args }

  for (const [k, v] of Object.entries(out)) {
    const prop = props[k]
    const t = prop?.type

    if (t === 'integer' || t === 'number') {
      const nv = toNumberMaybe(v)
      out[k] = (t === 'integer' && typeof nv === 'number') ? Math.trunc(nv) : nv
    }

    if (t === 'boolean') {
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase()
        if (s === 'true') out[k] = true
        else if (s === 'false') out[k] = false
      }
    }
  }

  return out
}

function filterArgsBySchema (args, schema) {
  if (!isPlainObject(args)) return {}
  const props = schema?.properties && typeof schema.properties === 'object' ? schema.properties : null
  if (!props) return { ...args }

  const allowed = new Set(Object.keys(props))
  const out = {}
  for (const [k, v] of Object.entries(args)) {
    if (allowed.has(k)) out[k] = v
  }
  return out
}

function validateAgainstSchema (toolName, args, schema) {
  const required = Array.isArray(schema?.required) ? schema.required : []
  const missing = []

  for (const r of required) {
    if (!(r in args)) missing.push(r)
  }

  if (missing.length > 0) {
    return { ok: false, reason: `missing_${missing.join('_')}`, missing }
  }

  // Доп. мягкая проверка типов только для чисел/булей (остальное оставляем модели/скилу)
  return { ok: true, reason: null, missing: [] }
}

function buildToolsPrompt (allowedToolDefs) {
  // Делаем компактно: tool + required + list properties.
  // (Это сильнее всего влияет на “соблюдай формат”.)
  const blocks = []
  for (const t of allowedToolDefs) {
    const schema = t?.inputSchema || {}
    const req = Array.isArray(schema.required) ? schema.required : []
    const props = schema?.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : []
    blocks.push(
      `- ${t.name}: required=[${req.join(', ')}], props=[${props.join(', ')}]`
    )
  }
  return blocks.join('\n')
}

// ---- MCP client setup ----
const transport = new StdioClientTransport({
  command: 'npx',
  args: ['-y', '--', '@fundamentallabs/minecraft-mcp']
})

const client = new Client({ name: 'minecraft-mvp-client', version: '0.2.0' })
await client.connect(transport)
appendJournal({ type: 'mcp', text: 'connected' })

await client.callTool({
  name: 'joinGame',
  arguments: { username: BOT_USERNAME, host: MC_HOST, port: MC_PORT }
})
appendJournal({ type: 'bot', text: `joined: ${BOT_USERNAME}@${MC_HOST}:${MC_PORT}` })

// Забираем список tools и их inputSchema прямо у MCP сервера (без хардкода схем)
let toolsIndex = new Map()
let allowedToolDefs = []
try {
  const tools = await client.listTools()
  const arr = Array.isArray(tools?.tools) ? tools.tools : []
  toolsIndex = new Map(arr.map(t => [t.name, t]))

  allowedToolDefs = arr.filter(t => ALLOWED_TOOLS.has(t.name))
  appendJournal({
    type: 'tools_loaded',
    allowed: allowedToolDefs.map(t => t.name),
    total: arr.length
  })
} catch (e) {
  appendJournal({ type: 'error', where: 'listTools', error: String(e?.message || e) })
}

const toolsPrompt = buildToolsPrompt(allowedToolDefs)

await client.callTool({
  name: 'sendChat',
  arguments: { message: `online (chat=${CHAT_PREFIX}, cmd=${CMD_PREFIX}, model=${OLLAMA_MODEL})` }
})

const seen = makeSeenSet(SEEN_LIMIT)

// Истории раздельно: болтовня и команды
const chatHistory = [] // { role: 'user'|'assistant', content }
const cmdHistory = []  // { user, input, plan, tool, args, result, valid, reason }

// флаг, чтобы не запускать два запроса к модели одновременно
let inFlight = false

const chatSystemPrompt =
  'Ты Minecraft-бот. Отвечай только по-русски, коротко и дружелюбно. ' +
  `Ты отвечаешь только когда игрок пишет сообщение с префиксом "${CHAT_PREFIX}". ` +
  'Не упоминай MCP, инструменты и внутреннюю логику.'

const cmdSystemPrompt =
  'Ты планировщик действий Minecraft-бота. ' +
  'Тебе даёт задачу игрок, а ты ВОЗВРАЩАЕШЬ ТОЛЬКО JSON без пояснений.\n' +
  'Формат строго такой:\n' +
  '{ "say": "короткий ответ в чат (может быть пустой)",\n' +
  '  "tool": string | null,\n' +
  '  "args": object }\n' +
  'Правила:\n' +
  '- tool должен быть либо null, либо одним из разрешённых инструментов.\n' +
  '- args должен содержать ВСЕ required поля inputSchema выбранного tool.\n' +
  '- Никакого текста вне JSON.\n' +
  'Разрешённые инструменты и их схемы:\n' +
  toolsPrompt

// ---- main loop ----
while (true) {
  let chatRes
  try {
    chatRes = await client.callTool({
      name: 'readChat',
      arguments: {
        count: 100,
        filterType: 'chat',
        timeLimit: TIME_LIMIT_SEC
      }
    })
  } catch (e) {
    appendJournal({ type: 'error', where: 'readChat', error: String(e?.message || e) })
    await sleep(POLL_MS)
    continue
  }

  const text = extractText(chatRes)
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean)

  const newChatMsgs = [] // обычный диалог (\)
  const newCmdMsgs = []  // команды (\!)

  for (const line of lines) {
    if (
      line.startsWith('===') ||
      line.startsWith('Showing') ||
      line.startsWith('Filtered') ||
      line.startsWith('From last') ||
      line.startsWith('==================')
    ) continue

    const parsed = parseChatLine(line)
    if (!parsed) continue

    if (seen.has(parsed.raw)) continue
    seen.add(parsed.raw)

    if (parsed.user === BOT_USERNAME) {
      pushHistory(chatHistory, { role: 'assistant', content: parsed.msg })
      continue
    }

    if (parsed.msg.startsWith(CMD_PREFIX)) {
      const clean = parsed.msg.slice(CMD_PREFIX.length).trim()
      if (clean) newCmdMsgs.push({ user: parsed.user, msg: clean })
    } else if (parsed.msg.startsWith(CHAT_PREFIX)) {
      const clean = parsed.msg.slice(CHAT_PREFIX.length).trim()
      if (clean) newChatMsgs.push({ user: parsed.user, msg: clean })
    }
  }

  if (inFlight) {
    await sleep(POLL_MS)
    continue
  }

  if (newCmdMsgs.length > 0) {
    const last = newCmdMsgs.at(-1)
    inFlight = true
    try {
      await handleCommand(last)
    } catch (e) {
      appendJournal({ type: 'error', where: 'handleCommand', error: String(e?.message || e) })
    } finally {
      inFlight = false
    }
    await sleep(POLL_MS)
    continue
  }

  if (newChatMsgs.length > 0) {
    const last = newChatMsgs.at(-1)
    inFlight = true
    try {
      await handleChat(last)
    } catch (e) {
      appendJournal({ type: 'error', where: 'handleChat', error: String(e?.message || e) })
    } finally {
      inFlight = false
    }
    await sleep(POLL_MS)
    continue
  }

  await sleep(POLL_MS)
}

// ---- handlers ----
async function handleChat (last) {
  pushHistory(chatHistory, { role: 'user', content: `${last.user}: ${last.msg}` })
  appendJournal({ type: 'chat_in', from: last.user, msg: last.msg })

  const historyText = chatHistory
    .map(h => (h.role === 'user' ? `USER ${h.content}` : `BOT ${h.content}`))
    .join('\n')

  const reply = await ollamaReply({
    ollamaHost: OLLAMA_HOST,
    model: OLLAMA_MODEL,
    system: chatSystemPrompt,
    user:
      `История беседы:\n${historyText}\n\n` +
      `Новое сообщение: ${last.user}: ${last.msg}\n\n` +
      'Ответь одним коротким сообщением:'
  })

  const out = sanitizeReply(reply)
  if (!out) return

  await client.callTool({
    name: 'sendChat',
    arguments: { message: out }
  })

  pushHistory(chatHistory, { role: 'assistant', content: out })
  appendJournal({ type: 'chat_out', message: out })
}

async function handleCommand (last) {
  appendJournal({ type: 'cmd_in', from: last.user, msg: last.msg })

  const cmdHistoryText = cmdHistory
    .slice(-10)
    .map((h, i) => `${i + 1}) ${h.user}: ${h.input} -> ${h.tool || 'no-tool'} (${h.valid ? 'ok' : 'bad'})`)
    .join('\n')

  // 1) первая попытка планирования
  let planText = await ollamaReply({
    ollamaHost: OLLAMA_HOST,
    model: OLLAMA_MODEL,
    system: cmdSystemPrompt,
    user:
      `Игрок: ${last.user}\n` +
      `Команда: ${last.msg}\n\n` +
      `Недавние команды:\n${cmdHistoryText || '(нет)'}\n\n` +
      'Верни ТОЛЬКО JSON-план.'
  })

  let final = await validateAndMaybeRepairPlan({
    lastUser: last.user,
    lastMsg: last.msg,
    planText,
    toolsIndex,
    allowedToolDefs
  })

  // ретраи (если JSON/валидация плохие)
  for (let attempt = 1; attempt <= CMD_MAX_RETRIES && !final.ok; attempt++) {
    const repairPrompt =
      'Ты вернул неверный JSON-план.\n' +
      `Ошибка: ${final.reason}\n` +
      (final.missing?.length ? `Не хватает required полей: ${final.missing.join(', ')}\n` : '') +
      'Исправь и верни ТОЛЬКО JSON-план строго в формате.\n' +
      'Разрешённые инструменты и их схемы:\n' +
      toolsPrompt

    planText = await ollamaReply({
      ollamaHost: OLLAMA_HOST,
      model: OLLAMA_MODEL,
      system: cmdSystemPrompt,
      user:
        `Игрок: ${last.user}\n` +
        `Команда: ${last.msg}\n\n` +
        `Твой прошлый (неверный) план:\n${planText}\n\n` +
        `${repairPrompt}`
    })

    final = await validateAndMaybeRepairPlan({
      lastUser: last.user,
      lastMsg: last.msg,
      planText,
      toolsIndex,
      allowedToolDefs
    })

    appendJournal({ type: 'cmd_repair_attempt', attempt, ok: final.ok, reason: final.reason })
    if (final.ok) break
  }

  const record = {
    user: last.user,
    input: last.msg,
    rawPlan: planText,
    plan: final.plan,
    tool: final.ok ? (final.tool || null) : null,
    args: final.ok ? (final.args || {}) : {},
    valid: final.ok,
    reason: final.ok ? null : final.reason
  }

  if (!final.ok) {
    appendJournal({ type: 'cmd_plan_invalid', details: record })

    // если в JSON было say — попробуем сказать
    const fallbackSay = sanitizeReply(final.plan?.say || '')
    if (fallbackSay) {
      await client.callTool({ name: 'sendChat', arguments: { message: fallbackSay } })
    }

    pushHistory(cmdHistory, record)
    return
  }

  // сказать игроку (если нужно)
  if (final.say) {
    const say = sanitizeReply(final.say)
    if (say) {
      await client.callTool({ name: 'sendChat', arguments: { message: say } })
      appendJournal({ type: 'cmd_say', message: say })
    }
  }

  if (!final.tool) {
    pushHistory(cmdHistory, { ...record, result: 'no_tool' })
    return
  }

  // вызов MCP-инструмента
  let toolResult = null
  let toolError = null
  try {
    toolResult = await client.callTool({ name: final.tool, arguments: final.args })
    appendJournal({ type: 'tool_call', tool: final.tool, args: final.args, result: toolResult })
  } catch (e) {
    toolError = String(e?.message || e)
    appendJournal({ type: 'tool_error', tool: final.tool, args: final.args, error: toolError })
  }

  pushHistory(cmdHistory, { ...record, result: toolError ? `error: ${toolError}` : 'ok' })
}

async function validateAndMaybeRepairPlan ({ lastUser, lastMsg, planText, toolsIndex, allowedToolDefs }) {
  const rawPlan = extractJson(planText)

  if (!rawPlan || typeof rawPlan !== 'object') {
    return { ok: false, reason: 'not_object', plan: rawPlan, tool: null, args: {}, say: '' }
  }

  const say = typeof rawPlan.say === 'string' ? rawPlan.say : ''
  const toolName = rawPlan.tool
  const args0 = isPlainObject(rawPlan.args) ? rawPlan.args : {}

  // tool=null допускается
  if (!toolName) {
    return { ok: true, reason: null, plan: rawPlan, tool: null, args: {}, say }
  }

  // allowlist
  if (!ALLOWED_TOOLS.has(toolName)) {
    return { ok: false, reason: 'unknown_tool', plan: rawPlan, tool: null, args: {}, say }
  }

  const toolDef = toolsIndex.get(toolName)
  const schema = toolDef?.inputSchema || {}

  // 1) нормализация ключей (generic similarity)
  let args = normalizeArgsKeysBySchema(args0, schema)

  // 2) фильтрация по schema.properties (чтобы модель не пихала мусор)
  args = filterArgsBySchema(args, schema)

  // 3) приведение типов (числа/инт/бул)
  args = coerceArgsTypesBySchema(args, schema)

  // 4) мягкое “контекстное заполнение”:
  // если в schema реально есть required userName, и модель его не дала — логично трактовать "ко мне"
  // как "userName = автор команды". Это не привязка к конкретному tool, а к имени required поля.
  const required = Array.isArray(schema?.required) ? schema.required : []
  if (required.includes('userName') && !('userName' in args)) {
    args.userName = lastUser
  }

  const v = validateAgainstSchema(toolName, args, schema)
  if (!v.ok) {
    return { ok: false, reason: v.reason, missing: v.missing, plan: rawPlan, tool: null, args: {}, say }
  }

  // ok
  // (Если toolDef отсутствует — всё равно пробуем вызвать, но обычно он есть)
  return { ok: true, reason: null, plan: rawPlan, tool: toolName, args, say }
}
