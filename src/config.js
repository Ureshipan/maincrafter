require('dotenv').config()

module.exports = {
mc: {
    host: process.env.MC_HOST || '127.0.0.1',
    port: Number(process.env.MC_PORT || 25565),
    username: process.env.MC_USERNAME || 'MAIncrafter',
    auth: process.env.MC_AUTH || 'offline',   // ok для online-mode=false
    version: process.env.MC_VERSION || false
},

nav: {
    followRange: 2,
    gotoRange: 1,
    // важно: можно выключать "умения" pathfinder по мере отладки
    allowDig: true,
    allowParkour: true,
    allowSprinting: true
}
}
