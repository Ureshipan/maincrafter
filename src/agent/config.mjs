import 'dotenv/config'

export function loadConfig () {
    const MC_HOST = process.env.MC_HOST || 'localhost'
    const MC_PORT = Number(process.env.MC_PORT || '25565')
    const BOT_USERNAME = process.env.BOT_USERNAME || 'MAIncrafter'

    const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434'
    const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen-ram'

    const CHAT_PREFIX = process.env.CHAT_PREFIX || '\\'
    const CMD_PREFIX = process.env.CMD_PREFIX || `${CHAT_PREFIX}!`

    const POLL_MS = Number(process.env.POLL_MS || '800')
    const TIME_LIMIT_SEC = Number(process.env.CHAT_TIME_LIMIT_SEC || '60')

    const MAX_HISTORY_MESSAGES = Number(process.env.MAX_HISTORY_MESSAGES || '20')
    const SEEN_LIMIT = Number(process.env.SEEN_LIMIT || '800')

    const CMD_MAX_RETRIES = Number(process.env.CMD_MAX_RETRIES || '2')
    const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || '30000')

    const DEFAULT_ALLOWED_TOOLS = [
        'goToKnownLocation',
        'goToSomeone',
        'mineResource',
        'eatFood',
        'runAway',
        'attackSomeone'
    ]

    const allowedTools = new Set(
        (process.env.ALLOWED_TOOLS
        ? process.env.ALLOWED_TOOLS.split(',').map(s => s.trim()).filter(Boolean)
        : DEFAULT_ALLOWED_TOOLS)
    )

    // Шаг 1+: подавляем запись polling readChat в journal
    // none -> никогда не писать успешные readChat в journal (рекомендуется)
    // (ошибки readChat всё равно будут логироваться)
    const LOG_POLL = (process.env.LOG_POLL || 'none').trim()

    return {
        MC_HOST,
        MC_PORT,
        BOT_USERNAME,
        OLLAMA_HOST,
        OLLAMA_MODEL,
        CHAT_PREFIX,
        CMD_PREFIX,
        POLL_MS,
        TIME_LIMIT_SEC,
        MAX_HISTORY_MESSAGES,
        SEEN_LIMIT,
        CMD_MAX_RETRIES,
        HEARTBEAT_MS,
        allowedTools,
        LOG_POLL
    }
}
