const cooldowns = new Map();

const LIMITS = {
    'trade': { max: 8, window: 5000 }, 
    'view':  { max: 20, window: 5000 }, 
    'global':{ max: 60, window: 60000 } 
};

function checkRateLimit(userId, type = 'global') {
    const config = LIMITS[type] || LIMITS['global'];
    const key = `${userId}-${type}`;
    const now = Date.now();

    if (!cooldowns.has(key)) {
        cooldowns.set(key, [now]);
        return true;
    }

    let timestamps = cooldowns.get(key);
    
    timestamps = timestamps.filter(time => now - time < config.window);
    
    if (timestamps.length >= config.max) {
        return false;
    }

    timestamps.push(now);
    cooldowns.set(key, timestamps);
    
    return true;
}

module.exports = { checkRateLimit };