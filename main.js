const { exec } = require('child_process');

console.log("🚀 Starting Pacifica Trading System...");

// 1. Start the Bot
try {
    console.log("🤖 Initializing Bot...");
    require('./src/bot/index.js');
} catch (error) {
    console.error("❌ Bot failed to start:", error);
}

// 2. Start the Server
try {
    console.log("🌍 Initializing Server...");
    require('./server.js');
} catch (error) {
    console.error("❌ Server failed to start:", error);
}