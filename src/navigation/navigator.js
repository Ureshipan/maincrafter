const mcDataLoader = require('minecraft-data')
const { Movements, goals } = require('mineflayer-pathfinder')
const { drawGoalMarker, clearGoalMarker } = require('../debug/draw')

class Navigator {
constructor(bot, config, drawer = null) {
    this.bot = bot
    this.config = config
    this.drawer = drawer

    this.mcData = mcDataLoader(bot.version)
    this.movements = new Movements(bot, this.mcData)

    // Настройки поведения
    this.movements.canDig = Boolean(config.nav.allowDig)
    this.movements.allowParkour = Boolean(config.nav.allowParkour)
    this.movements.allowSprinting = Boolean(config.nav.allowSprinting)

    // применяем
    bot.pathfinder.setMovements(this.movements)
}

stop() {
    // мягкая остановка (дойдёт до следующей ноды)
    this.bot.pathfinder.stop() // описано в API pathfinder [web:265]
    this.drawer?.clearGoal?.()
}

hardStop() {
    // мгновенная остановка (может остановиться “в воздухе”, использовать аккуратно)
    this.bot.pathfinder.setGoal(null)
    this.drawer?.clearGoal?.()
}

async _nudgeUnstuck() {
    // 250–400мс обычно достаточно
    this.bot.setControlState('back', true)
    await new Promise(r => setTimeout(r, 250))
    this.bot.setControlState('back', false)

    this.bot.setControlState('left', true)
    this.bot.setControlState('jump', true)
    await new Promise(r => setTimeout(r, 250))
    this.bot.setControlState('jump', false)
    this.bot.setControlState('left', false)
}

async gotoXYZ(x, y, z, range = this.config.nav.gotoRange) {
    const token = (this._goalToken = (this._goalToken || 0) + 1)
    this.drawer?.setGoal?.(token, { x, y, z })

    const goalXZ = new goals.GoalNearXZ(Math.floor(x), Math.floor(z), range)
    const goalXYZ = new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), range)

    const MAX_RETRIES = 2
    let stuckCount = 0

    const onReset = async (reason) => {
        if (reason !== 'stuck') return
        stuckCount++
        if (stuckCount === 1) await this._nudgeUnstuck()
        if (stuckCount >= 3) this.bot.pathfinder.setGoal(null) // сброс goal [web:144]
    }

    this.bot.on('path_reset', onReset) // событие pathfinder [web:144]

    try {
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            stuckCount = 0
            if (y == -1000) {
                return await this.bot.pathfinder.goto(goalXZ) // [web:144]
            } else {
                return await this.bot.pathfinder.goto(goalXYZ)
            }
        } catch (e) {
            if (attempt === MAX_RETRIES) throw e
            await this._nudgeUnstuck()
        }
        }
    } finally {
        this.bot.removeListener('path_reset', onReset)
        this.drawer?.clearGoal?.(token)
    }
}

followPlayer(username, range = this.config.nav.followRange) {
    const player = this.bot.players[username]
    const entity = player?.entity
    if (!entity) return { ok: false, message: 'Player not visible' }

    const goal = new goals.GoalFollow(entity, range)
    this.bot.pathfinder.setGoal(goal, true) // dynamic=true чтобы цель обновлялась [web:265]
    return { ok: true, message: `Following ${username}` }
}
}

module.exports = { Navigator }
