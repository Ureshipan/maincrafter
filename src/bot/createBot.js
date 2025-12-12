const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')

function createBot(config) {
const bot = mineflayer.createBot({
    host: config.mc.host,
    port: config.mc.port,
    username: config.mc.username,
    auth: config.mc.auth,
    version: config.mc.version
})

bot.loadPlugin(pathfinder)

bot.on('kicked', (reason) => console.log('[KICKED]', reason))
bot.on('error', (err) => console.log('[ERROR]', err))

return bot
}

module.exports = { createBot }
