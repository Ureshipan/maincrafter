const config = require('./config')
const { createBot } = require('./bot/createBot')
const { Navigator } = require('./navigation/navigator')
const { attachChatCommands } = require('./bot/chatCommands')
const { createDrawer } = require('./debug/drawer')

const Vec3 = require('vec3')
const { mineflayer: mineflayerViewer } = require('prismarine-viewer')

const bot = createBot(config)

bot.once('spawn', () => {
    console.log('[OK] spawned')

    const drawer = createDrawer(bot)
    const navigator = new Navigator(bot, config, drawer)
    attachChatCommands(bot, navigator)

    bot.chat('Bot online. Commands: !come !goto x y z !stop !pos')

    mineflayerViewer(bot, { port: 3007, firstPerson: true })


    function frontDir(bot) {
        const yaw = bot.entity.yaw
        const dx = -Math.sin(yaw)
        const dz = -Math.cos(yaw)
        const sx = Math.abs(dx) > Math.abs(dz) ? Math.sign(dx) : 0
        const sz = Math.abs(dz) >= Math.abs(dx) ? Math.sign(dz) : 0
        return new Vec3(sx, 0, sz)
    }

    bot.on('path_reset', (reason) => {
        if (reason !== 'stuck') return

        const p = bot.entity.position.floored()
        const f = frontDir(bot)

        const frontFeet = bot.blockAt(p.plus(f))
        const frontHead = bot.blockAt(p.plus(f).offset(0, 1, 0))
        const stepTop = bot.blockAt(p.plus(f).offset(0, 2, 0))      // “потолок” над будущей позицией
        const landing = bot.blockAt(p.plus(f).offset(0, 1, 0))       // где окажутся ноги после прыжка (y+1)

        console.log('[stuck] pos=', p,
            'frontFeet=', frontFeet?.name,
            'frontHead=', frontHead?.name,
            'stepTop=', stepTop?.name,
            'landing=', landing?.name
        )
    })
})
