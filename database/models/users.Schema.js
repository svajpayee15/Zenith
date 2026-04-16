const mongoose = require("mongoose");
// Make sure to import the sub-schema we created!
const zenithMetricsSchema = require("./zenithMetrics.Schema.js"); 

const userSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: false,
        unique: true,
        sparse: true
    },
    elo: {
        type: Number,
        default: 1200
    },
    walletAddress: {
        type: String,
        required: true, // Made this true since Mako relies on it
        unique: true,
        index: true
    },
    
    // ==========================================
    // THE MISSING PIECE:
    // This tells Mongoose it is allowed to save the math engine data here
    // ==========================================
    quantMetrics: { 
        type: zenithMetricsSchema, 
        default: () => ({}) 
    }

    // (You can delete your old flat EV, PF, MDD, WR fields here, 
    // because they are now safely nested inside quantMetrics)

}, { timestamps: true });

const User = mongoose.model("User", userSchema);

module.exports = User;