import { appendJournal } from '../journal.mjs'
import { ollamaReply } from '../ollama.mjs'

import { parseMemoryFromChat } from '../memory/chat_memory.mjs'
import { upsertPlace, formatPlacesForPrompt } from '../memory/places.mjs'

import { verifyToolResult } from './tool_verify.mjs'

import { maybeStore, readDiaryTail, formatDiaryForPrompt } from '../memory/diary.mjs'

function nowIso () { return new Date().toISOString() }

function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

function sanitizeReply (text) {
  const s = String(text || '').trim().replace(/\s+/g, ' ')
  return s.slice(0, 240)
}

function extractJson (text) {
  if (!text) return null
  const trimmed = String(text).trim()

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try { return JSON.parse(trimmed) } catch { /* ignore */ }
  }

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null

  const candidate = trimmed.slice(firstBrace, lastBrace + 1)
  try { return JSON.parse(candidate) } catch { return null }
}

function isPlainObject (v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function makeSeenSet (limit = 500) {
  const set = new Set()
  const queue = []
  return {
    size: () => set.size,
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

function pushHistory (history, item, max) {
  history.push(item)
  while (history.length > max) history.shift()
}

// [18:43:16] <Nick>: message
function parseChatLine (line) {
  const m = String(line || '').match(/^\[\d{2}:\d{2}:\d{2}\]\s*<([^>]+)>:\s*(.+)$/)
  if (!m) return null
  return { user: m[1], msg: m[2], raw: line }
}

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

function buildToolsPrompt (allowedToolDefs) {
  const blocks = []
  for (const t of allowedToolDefs) {
    const schema = t?.inputSchema || {}
    const req = Array.isArray(schema.required) ? schema.required : []
    const props = schema?.properties && typeof schema.properties === 'object'
      ? Object.keys(schema.properties)
      : []
    blocks.push(`- ${t.name}: required=[${req.join(', ')}], props=[${props.join(', ')}]`)
  }
  return blocks.join('\n')
}

// ---- schema-based args normalization ----
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
  return 1 - (levenshtein(a, b) / maxLen)
}

function normalizeArgsKeysBySchema (args, schema) {
  if (!isPlainObject(args)) return {}
  const props = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {}
  const knownKeys = Object.keys(props)
  if (knownKeys.length === 0) return { ...args }

  const out = { ...args }
  for (const k of Object.keys(out)) {
    if (knownKeys.includes(k)) continue

    let best = null
    let bestScore = 0
    for (const cand of knownKeys) {
      const s = similarity(k, cand)
      if (s > bestScore) { bestScore = s; best = cand }
    }

    if (best && bestScore >= 0.72 && !(best in out)) {
      out[best] = out[k]
      delete out[k]
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

    if (t === 'boolean' && typeof v === 'string') {
      const s = v.trim().toLowerCase()
      if (s === 'true') out[k] = true
      else if (s === 'false') out[k] = false
    }
  }

  return out
}

function validateRequired (args, schema) {
  const required = Array.isArray(schema?.required) ? schema.required : []
  const missing = required.filter(r => !(r in args))
  return { ok: missing.length === 0, missing }
}

function validateAndNormalizePlan ({ cfg, lastUser, planText, toolsIndex }) {
  const rawPlan = extractJson(planText)
  if (!rawPlan || typeof rawPlan !== 'object') {
    return { ok: false, reason: 'not_object', plan: rawPlan, tool: null, args: {}, say: '' }
  }

  const say = typeof rawPlan.say === 'string' ? rawPlan.say : ''
  const toolName = rawPlan.tool
  const args0 = isPlainObject(rawPlan.args) ? rawPlan.args : {}

  if (!toolName) return { ok: true, reason: null, plan: rawPlan, tool: null, args: {}, say }

  if (!cfg.allowedTools.has(toolName)) {
    return { ok: false, reason: 'unknown_tool', plan: rawPlan, tool: null, args: {}, say }
  }

  const toolDef = toolsIndex.get(toolName)
  const schema = toolDef?.inputSchema || {}

  let args = normalizeArgsKeysBySchema(args0, schema)
  args = filterArgsBySchema(args, schema)
  args = coerceArgsTypesBySchema(args, schema)

  // Мягкая подстановка: если tool требует userName — считаем "ко мне" = автор команды
  const req = Array.isArray(schema?.required) ? schema.required : []
  if (req.includes('userName') && !('userName' in args)) args.userName = lastUser

  const v = validateRequired(args, schema)
  if (!v.ok) {
    return { ok: false, reason: 'missing_required', missing: v.missing, plan: rawPlan, tool: null, args: {}, say }
  }

  return { ok: true, reason: null, plan: rawPlan, tool: toolName, args, say }
}

export async function runAgent ({ cfg, mcp, counters }) {
  // join & announce
  await mcp.callToolLogged('joinGame', { username: cfg.BOT_USERNAME, host: cfg.MC_HOST, port: cfg.MC_PORT })
  await mcp.callToolLogged('sendChat', { message: `online (chat=${cfg.CHAT_PREFIX}, cmd=${cfg.CMD_PREFIX}, model=${cfg.OLLAMA_MODEL})` })

  // один раз в дневник: запуск
  await maybeStore({
    kind: 'status',
    from: cfg.BOT_USERNAME,
    ok: true,
    text: `Бот запущен. Префиксы: chat=${cfg.CHAT_PREFIX}, cmd=${cfg.CMD_PREFIX}. Модель: ${cfg.OLLAMA_MODEL}.`
  })

  const seen = makeSeenSet(cfg.SEEN_LIMIT)
  const chatHistory = []
  const cmdHistory = []
  let inFlight = false
  let lastActivityAt = Date.now()

  // heartbeat (в журнал, не в дневник)
  const hb = setInterval(() => {
    appendJournal({
      type: 'heartbeat',
      bootId: mcp.BOOT_ID,
      ts: nowIso(),
      inFlight,
      seenSize: seen.size(),
      counters: { ...counters },
      lastActivityAgoMs: Date.now() - lastActivityAt,
      tools: { allowedTools: mcp.allowedToolDefs.map(t => t.name), totalTools: mcp.toolsIndex.size }
    })
  }, cfg.HEARTBEAT_MS)
  hb.unref?.()

  const toolsPrompt = buildToolsPrompt(mcp.allowedToolDefs)

  const chatSystemPrompt =
    'Ты Minecraft-бот. Отвечай только по-русски, коротко и дружелюбно. ' +
    `Ты отвечаешь только когда игрок пишет сообщение с префиксом "${cfg.CHAT_PREFIX}". ` +
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

  while (true) {
    let chatRes
    try {
      chatRes = await mcp.callToolLogged(
        'readChat',
        { count: 100, filterType: 'chat', timeLimit: cfg.TIME_LIMIT_SEC },
        { kind: 'poll' }
      )
    } catch {
      counters.mcpError++
      await sleep(cfg.POLL_MS)
      continue
    }

    const text = extractText(chatRes)
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean)

    const newChatMsgs = []
    const newCmdMsgs = []

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

      if (parsed.user === cfg.BOT_USERNAME) {
        pushHistory(chatHistory, { role: 'assistant', content: parsed.msg }, cfg.MAX_HISTORY_MESSAGES)
        continue
      }

      if (parsed.msg.startsWith(cfg.CMD_PREFIX)) {
        const clean = parsed.msg.slice(cfg.CMD_PREFIX.length).trim()
        if (clean) newCmdMsgs.push({ user: parsed.user, msg: clean })
      } else if (parsed.msg.startsWith(cfg.CHAT_PREFIX)) {
        const clean = parsed.msg.slice(cfg.CHAT_PREFIX.length).trim()
        if (clean) newChatMsgs.push({ user: parsed.user, msg: clean })
      }
    }

    if (inFlight) {
      await sleep(cfg.POLL_MS)
      continue
    }

    // ----- COMMANDS -----
    if (newCmdMsgs.length > 0) {
      const last = newCmdMsgs.at(-1)
      inFlight = true

      try {
        counters.cmdIn++
        lastActivityAt = Date.now()

        appendJournal({ type: 'cmd_in', bootId: mcp.BOOT_ID, ts: nowIso(), from: last.user, msg: last.msg })

        const cmdHistoryText = cmdHistory
          .slice(-10)
          .map((h, i) => `${i + 1}) ${h.user}: ${h.input} -> ${h.tool || 'no-tool'} (${h.valid ? 'ok' : 'bad'})`)
          .join('\n')

        const placesBlock = await formatPlacesForPrompt({ maxLines: 25 })

        let planText = await ollamaReply({
          ollamaHost: cfg.OLLAMA_HOST,
          model: cfg.OLLAMA_MODEL,
          system: cmdSystemPrompt,
          user:
            `Известные места (используй их координаты, если игрок просит пойти к месту):\n${placesBlock}\n\n` +
            `Игрок: ${last.user}\n` +
            `Команда: ${last.msg}\n\n` +
            `Недавние команды:\n${cmdHistoryText || '(нет)'}\n\n` +
            'Верни ТОЛЬКО JSON-план.'
        })

        let final = validateAndNormalizePlan({ cfg, lastUser: last.user, planText, toolsIndex: mcp.toolsIndex })

        for (let attempt = 1; attempt <= cfg.CMD_MAX_RETRIES && !final.ok; attempt++) {
          planText = await ollamaReply({
            ollamaHost: cfg.OLLAMA_HOST,
            model: cfg.OLLAMA_MODEL,
            system: cmdSystemPrompt,
            user:
              `Игрок: ${last.user}\nКоманда: ${last.msg}\n\n` +
              `Твой прошлый (неверный) план:\n${planText}\n\n` +
              `Ошибка: ${final.reason}\n` +
              (final.missing?.length ? `Не хватает required: ${final.missing.join(', ')}\n` : '') +
              'Исправь и верни ТОЛЬКО JSON.'
          })

          final = validateAndNormalizePlan({ cfg, lastUser: last.user, planText, toolsIndex: mcp.toolsIndex })
          appendJournal({ type: 'cmd_repair_attempt', bootId: mcp.BOOT_ID, ts: nowIso(), attempt, ok: final.ok, reason: final.reason })
        }

        if (!final.ok) {
          counters.cmdInvalid++

          const record = {
            user: last.user,
            input: last.msg,
            rawPlan: planText,
            plan: final.plan,
            tool: null,
            args: {},
            valid: false,
            reason: final.reason
          }

          appendJournal({ type: 'cmd_plan_invalid', bootId: mcp.BOOT_ID, ts: nowIso(), details: record })
          pushHistory(cmdHistory, record, 80)

          await maybeStore({
            kind: 'cmd_invalid',
            from: last.user,
            ok: false,
            text: `Команда не распознана/невалидный план: "${last.msg}" (reason=${final.reason}).`
          })

          const fallbackSay = sanitizeReply(final.plan?.say || '')
          if (fallbackSay) await mcp.callToolLogged('sendChat', { message: fallbackSay }, { kind: 'cmd_fallback_say' })
          continue
        }

        counters.cmdValid++

        const record = {
          user: last.user,
          input: last.msg,
          rawPlan: planText,
          plan: final.plan,
          tool: final.tool,
          args: final.args,
          valid: true,
          reason: null
        }
        pushHistory(cmdHistory, record, 80)

        if (final.say) {
          const say = sanitizeReply(final.say)
          if (say) await mcp.callToolLogged('sendChat', { message: say }, { kind: 'cmd_say' })
        }

        if (final.tool) {
          let toolResText = ''
          let toolError = null

          try {
            const toolRes = await mcp.callToolLogged(final.tool, final.args, { kind: 'cmd_exec', from: last.user, input: last.msg })
            toolResText = extractText(toolRes)
          } catch (e) {
            toolError = String(e?.message || e)
            toolResText = toolError
          }

          const verified = verifyToolResult({
            tool: final.tool,
            args: final.args,
            resultText: toolResText,
            toolError
          })

          appendJournal({
            type: 'tool_verified',
            bootId: mcp.BOOT_ID,
            ts: nowIso(),
            tool: final.tool,
            ok: verified.ok,
            done: verified.done,
            progress: verified.progress || null,
            meta: verified.meta || null
          })

          // В дневник пишем только финал (done) или ошибку
          if (verified.done || !verified.ok) {
            await maybeStore({
              kind: 'tool_fact',
              from: last.user,
              tool: final.tool,
              ok: verified.ok,
              text: verified.summary || `${final.tool}: ${verified.ok ? 'выполнено' : 'ошибка'}.`,
              meta: { ...(verified.meta || {}), args: final.args }
            })
          }
        } else {
          await maybeStore({
            kind: 'cmd_no_tool',
            from: last.user,
            ok: true,
            text: `Команда обработана без tool: "${last.msg}".`
          })
        }
      } catch (e) {
        counters.ollamaError++
        appendJournal({ type: 'error', bootId: mcp.BOOT_ID, ts: nowIso(), where: 'command_flow', error: String(e?.message || e) })
        await maybeStore({ kind: 'error', from: cfg.BOT_USERNAME, ok: false, text: `Ошибка в command_flow: ${String(e?.message || e)}` })
      } finally {
        inFlight = false
        await sleep(cfg.POLL_MS)
      }

      continue
    }

    // ----- CHAT -----
    if (newChatMsgs.length > 0) {
      const last = newChatMsgs.at(-1)
      inFlight = true

      try {
        counters.chatIn++
        lastActivityAt = Date.now()

        pushHistory(chatHistory, { role: 'user', content: `${last.user}: ${last.msg}` }, cfg.MAX_HISTORY_MESSAGES)
        appendJournal({ type: 'chat_in', bootId: mcp.BOOT_ID, ts: nowIso(), from: last.user, msg: last.msg })

        const mem = parseMemoryFromChat(last.msg)
        if (mem) {
          if (mem.kind === 'place' && mem.coords) {
            const r = await upsertPlace({ label: mem.label, coords: mem.coords, from: last.user })
            const y = (mem.coords.y === null || typeof mem.coords.y === 'undefined') ? 'NaN' : mem.coords.y

            const ack = r.ok
              ? `Ок, сохранил место "${mem.label}" (x=${mem.coords.x}, y=${y}, z=${mem.coords.z}).`
              : 'Не смог сохранить место (проверь название и координаты).'

            await mcp.callToolLogged('sendChat', { message: ack }, { kind: 'chat_place_ack' })
            continue
          }

          await maybeStore({ kind: mem.kind, from: last.user, ok: true, text: mem.text, meta: mem.meta })
          await mcp.callToolLogged('sendChat', { message: 'Ок, записал в дневник.' }, { kind: 'chat_memory_ack' })
          continue
        }

        // Подмешиваем хвост дневника как “память”
        const diary = await readDiaryTail(30)
        const diaryBlock = formatDiaryForPrompt(diary, { maxLines: 10, maxChars: 1200 })

        const historyText = chatHistory
          .map(h => (h.role === 'user' ? `USER ${h.content}` : `BOT ${h.content}`))
          .join('\n')

        const reply = await ollamaReply({
          ollamaHost: cfg.OLLAMA_HOST,
          model: cfg.OLLAMA_MODEL,
          system: chatSystemPrompt,
          user:
            `Память (дневник последних событий):\n${diaryBlock || '(пока пусто)'}\n\n` +
            `История беседы:\n${historyText}\n\n` +
            `Новое сообщение: ${last.user}: ${last.msg}\n\n` +
            'Ответь одним коротким сообщением:'
        })

        const out = sanitizeReply(reply)
        if (out) {
          await mcp.callToolLogged('sendChat', { message: out }, { kind: 'chat_reply' })
          counters.chatOut++
          pushHistory(chatHistory, { role: 'assistant', content: out }, cfg.MAX_HISTORY_MESSAGES)
          appendJournal({ type: 'chat_out', bootId: mcp.BOOT_ID, ts: nowIso(), message: out })
        }
      } catch (e) {
        counters.ollamaError++
        appendJournal({ type: 'error', bootId: mcp.BOOT_ID, ts: nowIso(), where: 'chat_flow', error: String(e?.message || e) })
        await maybeStore({ kind: 'error', from: cfg.BOT_USERNAME, ok: false, text: `Ошибка в chat_flow: ${String(e?.message || e)}` })
      } finally {
        inFlight = false
        await sleep(cfg.POLL_MS)
      }

      continue
    }

    await sleep(cfg.POLL_MS)
  }
}
