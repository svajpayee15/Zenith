const mongoose = require("mongoose")

const tradesSchema = new mongoose.Schema({
   wallet: {type:String, required: true},
   target: {type: String, required: false},
   assetPair: {type: String, required: true},
   leverage: {type: Number, required: true},
   margin: {type: {
    marginType:{
        type: String,
        enum:["CROSS", "ISOLATED"],
        required: true
    },
    Amount: {type: Number, required: true}
   }, required: true},
   direction: {type: String, enum: ["LONG","SHORT"], required: true},
   markPrice: {type: Number, required: true},
   pnl: {type: Number, required: true},
   status: {type: String, enum: ["OPEN","CLOSE"]},
   liquidation: {type: Number, required: false},
   takeProfit: {type: Number, required: false},
   stopLoss: {type: Number, required: false},
   funding: {type: Number, required: false},
   reduceOnly: {type: Boolean, required: true},
   TIF: {type: String, enum: ["GTC","IOC","ALO","TOB"]},
}, { timestamps: true })

const approval = mongoose.model("tradesSchema", tradesSchema)

module.exports = approval