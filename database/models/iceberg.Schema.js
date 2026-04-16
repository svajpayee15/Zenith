'use strict';

const mongoose = require("mongoose");

// --- Execution Ledger Sub-Schema ---
const TrancheExecutionSchema = new mongoose.Schema({
    trancheIndex: { type: Number, required: true },
    executedAmount: { type: Number, required: true },
    fillPrice: { type: Number, required: true },
    costUsd: { type: Number, required: true },
    latencyMs: { type: Number, default: 0 },
    timestamp: { type: Date, default: Date.now }
}, { _id: false });

// --- Master Dark Pool Schema ---
const icebergSchema = new mongoose.Schema({
    walletAddress: { type: String, required: true, index: true },
    symbol: { type: String, required: true },
    side: { type: String, required: true, enum: ["BUY", "SELL"] }, 
    
    // --- Algorithmic Parameters ---
    targetVolume: { type: Number, required: true },       
    trancheSize: { type: Number, required: true },        
    intervalMs: { type: Number, required: true, min: 500 }, 
    
    // --- The Institutional Firewall ---
    limitPrice: { type: Number, default: null },          
    stagnationTimeoutMs: { type: Number, default: 300000 },
    slippageTolerancePct: { type: Number, default: 0.5 },
    
    // --- Real-Time Execution State ---
    status: { 
        type: String, 
        enum: ['INITIALIZING', 'ROUTING', 'PAUSED_FIREWALL', 'COMPLETED', 'EXPIRED', 'FAILED', 'CANCELLED'], 
        default: 'INITIALIZING' 
    },
    
    // --- Quantitative Metrics (TCA & VWAP) ---
    arrivalPrice: { type: Number, required: true },       // <--- NEW: Crucial for TCA Impact
    filledVolume: { type: Number, default: 0 },
    totalCostUsd: { type: Number, default: 0 },
    averageFillPrice: { type: Number, default: 0 },       
    
    // --- Ledger & Auditing ---
    executionLedger: { type: [TrancheExecutionSchema], default: [] },
    errorMessage: { type: String, default: null },
    
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null }

}, { timestamps: true });

module.exports = mongoose.model("IcebergDarkPool", icebergSchema);