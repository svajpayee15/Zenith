// File: database/models/copyTrading.schema.js
const mongoose = require("mongoose");
const zenithMetricsSchema = require("./zenithMetrics.Schema.js"); // The shared quant sub-schema

const copyTradingSchema = new mongoose.Schema({
    // ==========================================
    // 1. RELATIONSHIP IDENTIFIERS (Pure Web3)
    // ==========================================
    followerWallet: { type: String, required: true, index: true }, 
    targetWallet: { type: String, required: true, index: true }, 
    
    // ==========================================
    // 2. CORE RISK CONTROLS
    // ==========================================
    portfolioPct: { type: Number, required: true, default: 10, min: 0.001, max: 100 }, // Renamed from 'portfolio' for clarity
    maxTradeSizeUsd: { type: Number, required: true }, // Renamed from 'maxSize' for exact unit clarity
    tradeLimitCount: { type: Number, required: false }, // Renamed from 'tradeLimit'
    volumeLimitUsd: { type: Number, required: false }, // Renamed from 'volumeLimit'
    
    // ==========================================
    // 3. ADVANCED INSTITUTIONAL GUARDS
    // ==========================================
    slippageTolerancePct: { type: Number, default: 0.5 }, // e.g., 0.5% max deviance from whale price
    maxLeverageCap: { type: Number, default: 5 }, // Safety net against whale degens
    dailyLossLimitUsd: { type: Number, required: false }, // Circuit breaker
    assetBlacklist: { type: [String], default: [] }, // e.g., ["PEPE", "WIF"]
    
    // ==========================================
    // 4. LIVE SESSION TRACKING
    // ==========================================
    sessionVolumeUsd: { type: Number, default: 0 },
    sessionPnl: {
        total: { type: Number, default: 0 },
        oneDay: { type: Number, default: 0 },
        oneWeek: { type: Number, default: 0 },
        oneMonth: { type: Number, default: 0 },
    },
    
    // ==========================================
    // 5. THE AUDIT SNAPSHOT
    // ==========================================
    // Locked stats of the target exactly when the user clicked "Copy"
    targetMetricsSnapshot: { type: zenithMetricsSchema, default: () => ({}) },
    
    // ==========================================
    // 6. STATE
    // ==========================================
    isActive: { type: Boolean, default: true }
}, { timestamps: true });

// Prevent a wallet from opening two simultaneous active streams on the exact same target
copyTradingSchema.index({ followerWallet: 1, targetWallet: 1 }, { unique: true });

const CopyTrading = mongoose.model("CopyTrading", copyTradingSchema);
module.exports = CopyTrading;
