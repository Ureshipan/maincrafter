function attachChatCommands(bot, navigator) {
bot.on('chat', async (username, message) => {
    if (username === bot.username) return

    const [cmd, ...args] = message.trim().split(/\s+/)

    try {
    if (cmd === '!come') {
        const res = navigator.followPlayer(username)
        bot.chat(res.ok ? res.message : `Can't follow: ${res.message}`)
        return
    }

    if (cmd === '!goto') {
        // !goto x y z
        const x = Number(args[0])
        const y = Number(args[1])
        const z = Number(args[2])
        if ([x, y, z].some(Number.isNaN)) {
        bot.chat('Usage: !goto <x> <y> <z>')
        return
        }

        bot.chat(`Going to ${x} ${y} ${z}`)
        await navigator.gotoXYZ(x, y, z)
        bot.chat('Arrived')
        return
    }

    if (cmd === '!stop') {
        navigator.stop()
        bot.chat('Stopping')
        return
    }

    if (cmd === '!hardstop') {
        navigator.hardStop()
        bot.chat('Hard stop')
        return
    }

    if (cmd === '!pos') {
        const p = bot.entity.position
        bot.chat(`pos: ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`)
        return
    }
    } catch (e) {
    bot.chat(`Error: ${e.message}`)
    }
})
}

module.exports = { attachChatCommands }
