function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

function progressKey (p) {
  if (!p || typeof p !== 'object') return 'none'
  const cur = p.current
  const tot = p.total
  if (Number.isFinite(cur) && Number.isFinite(tot)) return `${cur}/${tot}`
  return JSON.stringify(p)
}

// Универсальный раннер: вызывает tool повторно, пока verifyToolResult не вернёт done=true,
// либо пока не будет "зависания" (прогресс не меняется) / исчерпания попыток.
export async function runToolTask ({
  cfg,
  mcp,
  tool,
  args,
  from,
  input,
  extractText,
  verifyToolResult,
  appendJournal
}) {
  const basePollMs = Number(cfg.TASK_POLL_MS ?? cfg.POLL_MS ?? 800)
  const stallMax = Number(cfg.TASK_STALL_MAX ?? 4)

  // дефолтные лимиты: для mineResource больше попыток
  const maxAttempts =
    tool === 'mineResource'
      ? Number(cfg.TASK_MAX_ATTEMPTS_MINE ?? 30)
      : Number(cfg.TASK_MAX_ATTEMPTS ?? 6)

  let lastProgKey = null
  let stallCount = 0
  let lastText = ''

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let toolError = null
    let toolText = ''

    try {
      const toolRes = await mcp.callToolLogged(tool, args, { kind: 'task_exec', from, input, attempt })
      toolText = extractText(toolRes)
    } catch (e) {
      toolError = String(e?.message || e)
      toolText = toolError
    }

    lastText = toolText

    const verified = verifyToolResult({ tool, args, resultText: toolText, toolError })

    appendJournal({
      type: 'tool_attempt_verified',
      bootId: mcp.BOOT_ID,
      ts: new Date().toISOString(),
      tool,
      attempt,
      ok: verified.ok,
      done: verified.done,
      progress: verified.progress ?? null,
      meta: verified.meta ?? null
    })

    if (!verified.ok) {
      return { verified, attempts: attempt, lastText, stalled: false }
    }

    if (verified.done) {
      return { verified, attempts: attempt, lastText, stalled: false }
    }

    // done=false: проверяем "зависание"
    const pk = progressKey(verified.progress)
    if (pk === 'none') {
      stallCount++
    } else if (lastProgKey === pk) {
      stallCount++
    } else {
      stallCount = 0
      lastProgKey = pk
    }

    if (stallCount >= stallMax) {
      return {
        verified: {
          ok: false,
          done: true,
          progress: verified.progress ?? null,
          summary: `${tool}: завис/нет прогресса (stall=${stallCount}).`,
          meta: { ...(verified.meta || {}), stallCount, lastProgress: lastProgKey }
        },
        attempts: attempt,
        lastText,
        stalled: true
      }
    }

    await sleep(basePollMs)
  }

  return {
    verified: {
      ok: false,
      done: true,
      progress: null,
      summary: `${tool}: превышен лимит попыток (${maxAttempts}).`,
      meta: { tool, maxAttempts }
    },
    attempts: maxAttempts,
    lastText,
    stalled: false
  }
}
