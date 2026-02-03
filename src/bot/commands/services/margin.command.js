const wallet = require("../../../config/agent.wallet.js");
const nacl = require("tweetnacl");
const bs58 = require("bs58");
const axios = require("axios");

function sortRecursive(item) {
    if (typeof item !== 'object' || item === null) return item;
    if (Array.isArray(item)) return item.map(sortRecursive);
    return Object.keys(item).sort().reduce((acc, key) => {
        acc[key] = sortRecursive(item[key]);
        return acc;
    }, {});
}

async function toggleMargin(userWalletAddress, symbol, isIsolated){
    
    const signaturePayload = { 
        is_isolated: isIsolated,
        symbol: symbol
    }

    const finalSignaturePayload = { 
        data: signaturePayload, 
        expiry_window: 10000,
        timestamp: Date.now(),
        type: "update_margin_mode"
    }

    const sortedSignaturePayload = sortRecursive(finalSignaturePayload)

    const messageByte = new TextEncoder().encode(JSON.stringify(sortedSignaturePayload))
    const signature = nacl.sign.detached(messageByte, wallet.secretKey)
    const signatureString = bs58.encode(signature)

    const requestPayload = {
        account: userWalletAddress, 
        agent_wallet: wallet.publicKey.toBase58(), 
        expiry_window: finalSignaturePayload.expiry_window, 
        timestamp: finalSignaturePayload.timestamp, 
        signature: signatureString, 
        is_isolated: isIsolated, 
        symbol: symbol
    }

    const sortedRequestPayload = sortRecursive(requestPayload)

    try{
    const response = await axios.post("https://api.pacifica.fi/api/v1/account/margin", sortedRequestPayload, { headers: { "Content-Type": "application/json" } })
    console.log("✅ Success:", response.data);
    return response.data;
    } catch(e){
        console.error("❌ Error:", e.response?.data || e.message);
        throw e;
    }
}

module.exports = toggleMargin