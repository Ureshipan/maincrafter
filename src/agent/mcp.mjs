import os from 'node:os'
import process from 'node:process'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { appendJournal } from '../journal.mjs'

function nowIso () { return new Date().toISOString() }

export function createCounters () {
    return {
        chatIn: 0,
        chatOut: 0,
        cmdIn: 0,
        cmdValid: 0,
        cmdInvalid: 0,
        toolCall: 0,
        toolError: 0,
        mcpError: 0,
        ollamaError: 0
    }
}

export async function connectMcp ({ cfg, counters }) {
    const BOOT_ID = `${Date.now()}-${Math.random().toString(16).slice(2)}`

    appendJournal({
        type: 'boot',
        bootId: BOOT_ID,
        ts: nowIso(),
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        hostname: os.hostname(),
        pid: process.pid,
        env: {
        MC_HOST: cfg.MC_HOST,
        MC_PORT: cfg.MC_PORT,
        BOT_USERNAME: cfg.BOT_USERNAME,
        OLLAMA_HOST: cfg.OLLAMA_HOST,
        OLLAMA_MODEL: cfg.OLLAMA_MODEL,
        CHAT_PREFIX: cfg.CHAT_PREFIX,
        CMD_PREFIX: cfg.CMD_PREFIX,
        POLL_MS: cfg.POLL_MS,
        TIME_LIMIT_SEC: cfg.TIME_LIMIT_SEC,
        MAX_HISTORY_MESSAGES: cfg.MAX_HISTORY_MESSAGES,
        SEEN_LIMIT: cfg.SEEN_LIMIT,
        CMD_MAX_RETRIES: cfg.CMD_MAX_RETRIES,
        HEARTBEAT_MS: cfg.HEARTBEAT_MS,
        LOG_POLL: cfg.LOG_POLL,
        ALLOWED_TOOLS: Array.from(cfg.allowedTools)
        }
    })

    const transport = new StdioClientTransport({
        command: 'npx',
        args: ['-y', '--', '@fundamentallabs/minecraft-mcp']
    })

    const client = new Client({ name: 'minecraft-mvp-client', version: '0.3.1' })
    await client.connect(transport)

    appendJournal({ type: 'mcp', bootId: BOOT_ID, ts: nowIso(), text: 'connected' })

    // tool list + schema
    let toolsIndex = new Map()
    let allowedToolDefs = []
    try {
        const tools = await client.listTools()
        const arr = Array.isArray(tools?.tools) ? tools.tools : []
        toolsIndex = new Map(arr.map(t => [t.name, t]))
        allowedToolDefs = arr.filter(t => cfg.allowedTools.has(t.name))

        appendJournal({
        type: 'tools_loaded',
        bootId: BOOT_ID,
        ts: nowIso(),
        total: arr.length,
        allowed: allowedToolDefs.map(t => ({
            name: t.name,
            required: Array.isArray(t?.inputSchema?.required) ? t.inputSchema.required : [],
            props: (t?.inputSchema?.properties && typeof t.inputSchema.properties === 'object')
            ? Object.keys(t.inputSchema.properties)
            : []
        }))
        })
    } catch (e) {
        counters.mcpError++
        appendJournal({ type: 'error', bootId: BOOT_ID, ts: nowIso(), where: 'listTools', error: String(e?.message || e) })
    }

    // callTool wrapper: пишет ВСЁ, кроме успешных readChat polling
    async function callToolLogged (name, args, meta = {}) {
        const t0 = Date.now()
        counters.toolCall++

        try {
        const res = await client.callTool({ name, arguments: args })
        const ms = Date.now() - t0

        // Главная правка: успешный readChat (poll) не пишем в journal вообще
        if (name === 'readChat' && meta?.kind === 'poll' && cfg.LOG_POLL === 'none') {
            return res
        }

        appendJournal({ type: 'tool_call', bootId: BOOT_ID, ts: nowIso(), tool: name, args, ms, meta, result: res })
        return res
        } catch (e) {
        counters.toolError++

        // Ошибки readChat оставляем (иначе будет тяжело отлаживать разрывы/падения MCP)
        appendJournal({
            type: 'tool_error',
            bootId: BOOT_ID,
            ts: nowIso(),
            tool: name,
            args,
            ms: Date.now() - t0,
            meta,
            error: String(e?.message || e)
        })
        throw e
        }
    }

    return { client, BOOT_ID, toolsIndex, allowedToolDefs, callToolLogged }
}
