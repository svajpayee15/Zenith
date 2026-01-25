require("dotenv").config()
const { Keypair } = require("@solana/web3.js")
const bs58 = require("bs58")

const bs58PK = process.env.AGENT_PRIVATE_KEY
const uint8APK = bs58.decode(bs58PK)

const wallet = Keypair.fromSecretKey(uint8APK)

console.log(`Agent Wallet Public Key: ${wallet.publicKey.toBase58()}`)

module.exports = wallet

