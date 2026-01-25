const mongoose = require("mongoose")

const approvalSchema = new mongoose.Schema({
    nonce: {
        type: String,
        length: 32,
        required: true,
        unique: true
    },
    userId: {
        type: String,
        required: true,
        unique: true
    },
    walletAddress: {
        type: String,
    },
    signature: {
        type: String,
    },
    approved: {
        type: Boolean,
        default: false
    },
    expireAt: { 
        type: Date, 
        required: true,
        index:{
            expireAfterSeconds:0,
            partialFilterExpression: { approved: false }
        }
    }
}, { timestamps: true })

const approval = mongoose.model("approval", approvalSchema)

module.exports = approval