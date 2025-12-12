const mcDataLoader = require('minecraft-data')
const Vec3 = require('vec3')
const { Movements, goals } = require('mineflayer-pathfinder')

class Navigator {
constructor(bot, config, drawer = null) {
    this.bot = bot
    this.config = config
    this.drawer = drawer

    // ---- internal state ----
    this._goalToken = 0
    this._activeToken = 0
    this._active = false

    // ---- pathfinder movements ----
    this.mcData = mcDataLoader(bot.version)
    this.movements = new Movements(bot, this.mcData)

    this.movements.canDig = Boolean(config?.nav?.allowDig)
    this.movements.allowParkour = Boolean(config?.nav?.allowParkour)
    this.movements.allowSprinting = Boolean(config?.nav?.allowSprinting)

    bot.pathfinder.setMovements(this.movements)
}

// -------------------------
// Public API (unchanged)
// -------------------------
stop() {
    // мягкая остановка
    this._cancelActive('stop')
    this.bot.pathfinder.stop()
    this._clearGoalMarker()
}

hardStop() {
    // мгновенная остановка
    this._cancelActive('hardStop')
    this.bot.pathfinder.setGoal(null)
    this._clearGoalMarker()
}

followPlayer(username, range = this.config.nav.followRange) {
    this._cancelActive('followPlayer')

    const player = this.bot.players[username]
    const entity = player?.entity
    if (!entity) return { ok: false, message: 'Player not visible' }

    const goal = new goals.GoalFollow(entity, range)
    this.bot.pathfinder.setGoal(goal, true)
    return { ok: true, message: `Following ${username}` }
}

async gotoXYZ(x, y, z, range = this.config.nav.gotoRange) {
    const token = this._newToken()
    this._setActive(token)

    // рисуем только “финальную” цель (waypoints рисовать отдельно, если захочешь)
    this._setGoalMarker(token, { x, y, z })

    try {
    const start = this.bot.entity.position.clone()
    const target = new Vec3(Number(x), Number(y), Number(z))

    const distXZ = Math.hypot(target.x - start.x, target.z - start.z)
    const longThreshold = this.config?.nav?.longDistance?.threshold ?? 160
    const useLong = distXZ > longThreshold

    if (useLong) {
        await this._gotoLongDistance(token, target, range)
    } else {
        await this._gotoShortDistance(token, target, range)
    }
    } finally {
    // важно: clearing по токену, чтобы “старый” goto не стирал “новую” метку
    this._clearGoalMarker(token)
    this._unsetActive(token)
    }
}

// -------------------------
// Internal: goal selection
// -------------------------
async _gotoShortDistance(token, target, range) {
    this._ensureNotCancelled(token)

    // Если y не задан/NaN — не фиксируем высоту, это устойчивее по рельефу
    const yOk = Number.isFinite(target.y)

    const goal = yOk
    ? new goals.GoalNear(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), range)
    : new goals.GoalNearXZ(Math.floor(target.x), Math.floor(target.z), range)

    await this._gotoWithWatchdogs(token, goal)
}

async _gotoLongDistance(token, target, range) {
    this._ensureNotCancelled(token)

    // шаг waypoint-ов по XZ
    const step = this.config?.nav?.longDistance?.step ?? 96
    const maxLegs = this.config?.nav?.longDistance?.maxLegs ?? 300

    let cur = this.bot.entity.position.clone()

    for (let leg = 0; leg < maxLegs; leg++) {
    this._ensureNotCancelled(token)

    const dx = target.x - cur.x
    const dz = target.z - cur.z
    const dist = Math.hypot(dx, dz)

    // финальный рывок
    if (dist <= step) {
        await this._gotoShortDistance(token, new Vec3(target.x, NaN, target.z), Math.max(range, 2))
        return
    }

    const nx = cur.x + (dx / dist) * step
    const nz = cur.z + (dz / dist) * step

    // waypoint только по XZ
    const waypointGoal = new goals.GoalNearXZ(Math.floor(nx), Math.floor(nz), Math.max(range, 2))
    await this._gotoWithWatchdogs(token, waypointGoal)

    cur = this.bot.entity.position.clone()
    }

    throw new Error('gotoLongDistance: maxLegs exceeded')
}

// -------------------------
// Internal: robust goto
// -------------------------
async _gotoWithWatchdogs(token, goal) {
    this._ensureNotCancelled(token)

    const MAX_RETRIES = this.config?.nav?.robust?.maxRetries ?? 2
    const MAX_STUCK_EVENTS = this.config?.nav?.robust?.maxStuckEvents ?? 3
    const PROGRESS_TIMEOUT_MS = this.config?.nav?.robust?.progressTimeoutMs ?? 5000
    const PROGRESS_EPS = this.config?.nav?.robust?.progressEps ?? 0.15

    let stuckEvents = 0
    let lastPos = this.bot.entity.position.clone()
    let lastProgressAt = Date.now()

    const onReset = async (reason) => {
    if (!this._isActiveToken(token)) return
    if (reason !== 'stuck') return

    stuckEvents++
    if (stuckEvents <= MAX_STUCK_EVENTS) {
        await this._nudgeUnstuck()
    }

    if (stuckEvents >= MAX_STUCK_EVENTS) {
        // ломаем текущую попытку (иначе может бесконечно перепланировать)
        this.bot.pathfinder.setGoal(null)
    }
    }

    const tick = async () => {
    if (!this._isActiveToken(token)) return

    const p = this.bot.entity.position
    if (p.distanceTo(lastPos) > PROGRESS_EPS) {
        lastPos = p.clone()
        lastProgressAt = Date.now()
    } else if (Date.now() - lastProgressAt > PROGRESS_TIMEOUT_MS) {
        // “тихо стоим” — тоже считаем застреванием
        stuckEvents++
        lastProgressAt = Date.now()
        await this._nudgeUnstuck()

        if (stuckEvents >= MAX_STUCK_EVENTS) {
        this.bot.pathfinder.setGoal(null)
        }
    }
    }

    this.bot.on('path_reset', onReset)
    const interval = setInterval(() => { tick().catch(() => {}) }, 250)

    try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        this._ensureNotCancelled(token)

        try {
        stuckEvents = 0
        lastPos = this.bot.entity.position.clone()
        lastProgressAt = Date.now()

        await this.bot.pathfinder.goto(goal)
        return
        } catch (e) {
        if (attempt === MAX_RETRIES) throw e
        await this._nudgeUnstuck()
        }
    }
    } finally {
    clearInterval(interval)
    this.bot.removeListener('path_reset', onReset)
    }
}

async _nudgeUnstuck() {
    // лёгкий “толчок”: назад + в сторону + прыжок
    this.bot.setControlState('back', true)
    await new Promise((r) => setTimeout(r, 220))
    this.bot.setControlState('back', false)

    this.bot.setControlState('left', true)
    this.bot.setControlState('jump', true)
    await new Promise((r) => setTimeout(r, 220))
    this.bot.setControlState('jump', false)
    this.bot.setControlState('left', false)
}

// -------------------------
// Internal: tokens & cancel
// -------------------------
_newToken() {
    this._goalToken = (this._goalToken || 0) + 1
    return this._goalToken
}

_setActive(token) {
    this._active = true
    this._activeToken = token
}

_unsetActive(token) {
    if (this._activeToken === token) {
    this._active = false
    }
}

_isActiveToken(token) {
    return this._active && this._activeToken === token
}

_cancelActive(_reason) {
    // отмена текущей цели (если была) — не даём старому goto жить
    this._active = false
    this.bot.pathfinder.setGoal(null)
}

_ensureNotCancelled(token) {
    if (!this._isActiveToken(token)) {
    throw new Error('Navigator: cancelled')
    }
}

// -------------------------
// Internal: drawing
// -------------------------
_setGoalMarker(token, pos) {
    if (!this.drawer?.setGoal) return
    this.drawer.setGoal(token, pos)
}

_clearGoalMarker(token) {
    if (!this.drawer?.clearGoal) return
    this.drawer.clearGoal(token)
}
}

module.exports = { Navigator }
