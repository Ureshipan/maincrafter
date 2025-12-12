const Vec3 = require('vec3')

function drawGoalMarker(bot, pos, color = 0xffcc00) {
const p = new Vec3(Math.floor(pos.x) + 0.5, Math.floor(pos.y), Math.floor(pos.z) + 0.5)

const s = 0.8 // размер крестика
bot.viewer.drawLine('goal_x', [p.offset(-s, 0, 0), p.offset(s, 0, 0)], color) // ось X [web:297]
bot.viewer.drawLine('goal_z', [p.offset(0, 0, -s), p.offset(0, 0, s)], color) // ось Z [web:297]
bot.viewer.drawLine('goal_y', [p.offset(0, -pos.y-100, 0), p.offset(0, -pos.y+100, 0)], color) // вертикаль [web:297]
}

function clearGoalMarker(bot) {
bot.viewer.erase('goal_x')
bot.viewer.erase('goal_z')
bot.viewer.erase('goal_y')
}

module.exports = { drawGoalMarker, clearGoalMarker }
