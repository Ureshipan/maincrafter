require('dotenv').config();
const mineflayer = require('mineflayer')

const bot = mineflayer.createBot({
    host: process.env.MC_HOST || '127.0.0.1',
    port: Number(process.env.MC_PORT || 25565),
    username: process.env.MC_USERNAME || 'TestBot',
    auth: 'offline', // для online-mode=false
    version: process.env.MC_VERSION || false
})

bot.once('spawn', () => {
    console.log('[OK] spawned')
    bot.chat('I am online')
})

bot.on('kicked', (reason) => console.log('[KICKED]', reason))
bot.on('error', (err) => console.log('[ERROR]', err))