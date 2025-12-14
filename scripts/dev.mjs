import { loadConfig } from '../src/agent/config.mjs'
import { createCounters, connectMcp } from '../src/agent/mcp.mjs'
import { runAgent } from '../src/agent/agent.mjs'

const cfg = loadConfig()
const counters = createCounters()

const mcp = await connectMcp({ cfg, counters })
await runAgent({ cfg, mcp, counters })
