const mongoose = require("mongoose");

const copyExecutionSchema = new mongoose.Schema({
    // ==========================================
    // 1. THE RELATIONSHIP LINK
    // ==========================================
    // Ties this specific trade back to the master copy-trade settings
    copyStreamId: { type: mongoose.Schema.Types.ObjectId, ref: 'CopyTrading', required: true, index: true },
    followerWallet: { type: String, required: true, index: true },
    targetWallet: { type: String, required: true, index: true },

    // ==========================================
    // 2. THE TARGET'S BLUEPRINT (What the whale did)
    // ==========================================
    symbol: { type: String, required: true },
    side: { type: String, enum: ["BUY", "SELL", "LONG", "SHORT", "CLOSE"], required: true },
    
    whaleExecution: {
        price: { type: Number, required: true },
        amount: { type: Number, required: true },
        executedAt: { type: Date, required: true } // Exact millisecond Pacifica fired the WS event
    },

    // ==========================================
    // 3. THE FOLLOWER'S REALITY (What your bot achieved)
    // ==========================================
    followerExecution: {
        orderId: { type: String, required: false }, // Will be null if the trade failed
        price: { type: Number, required: false },
        amount: { type: Number, required: false },
        
        // Institutional Metrics
        slippagePct: { type: Number, required: false }, // Difference between whale and follower price
        latencyMs: { type: Number, required: false }, // Execution speed tracking
        
        status: { type: String, enum: ["SUCCESS", "FAILED", "SKIPPED"], required: true },
        
        // If it failed or skipped, WHY? (e.g., "Asset Blacklisted", "Insufficient Margin")
        reason: { type: String, required: false } 
    }
}, { timestamps: true });

// Compound index so a user can easily pull up their specific copy history for a specific whale
copyExecutionSchema.index({ followerWallet: 1, targetWallet: 1, createdAt: -1 });

const CopyExecution = mongoose.model("CopyExecution", copyExecutionSchema);

module.exports = CopyExecution;