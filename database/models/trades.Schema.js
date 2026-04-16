// File: database/models/trade.schema.js
const mongoose = require("mongoose");

const tradesSchema = new mongoose.Schema({
    // Who owns this trade? (Indexed for fast lookups)
    wallet: { type: String, required: true, index: true },
    
    // If tradeType is COPY, who were they copying?
    target: { type: String, required: false },
    
    // Type of execution (Indexed so we can easily separate arrays for math)
    tradeType: { type: String, enum: ["SELF", "COPY"], required: true, index: true },
    
    // Exchange identifiers
    orderId: { type: String, required: true, unique: true },
    
    // Performance of this specific trade
    realizedPnl: { type: Number, required: false },
    status: { type: String, enum: ["OPEN", "CLOSED", "LIQUIDATED"], default: "OPEN" }
}, { timestamps: true });

const Trade = mongoose.model("Trade", tradesSchema);
module.exports = Trade;