const { drawGoalMarker, clearGoalMarker } = require('./draw')

function createDrawer(bot) {
return {
    goal: (pos) => { if (bot.viewer) drawGoalMarker(bot, pos) },
    clearGoal: () => { if (bot.viewer) clearGoalMarker(bot) }
}
}

module.exports = { createDrawer }
