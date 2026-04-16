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

async function updateLeverage(walletAddress, symbol, lev) {
    const timestamp = Date.now();
    const expiry_window = 60000;

    const signatureData = { 
        leverage: parseInt(lev),
        symbol: symbol.toUpperCase()
    };

    const signaturePayload = {
        expiry_window: expiry_window,
        timestamp: timestamp,
        type: "update_leverage",
        data: signatureData // Nested
    };

    const sortedSignaturePayload = sortRecursive(signaturePayload);
    console.log(sortedSignaturePayload)
    const messageByte = new TextEncoder().encode(JSON.stringify(sortedSignaturePayload));
    const signatureBytes = nacl.sign.detached(messageByte, wallet.secretKey);
    const signatureString = bs58.encode(signatureBytes);

    
    const requestPayload = {
        account: walletAddress,
        agent_wallet: wallet.publicKey.toBase58(),
        signature: signatureString,
        timestamp: timestamp,
        expiry_window: expiry_window,
        ...signatureData // <--- SENDING NESTED OBJECT
    };

    console.log("📤 Sending Payload:", JSON.stringify(requestPayload, null, 2));

    try {
        const response = await axios.post(
            "https://test-api.pacifica.fi/api/v1/account/leverage", 
            requestPayload, 
            { headers: { "Content-Type": "application/json" } }
        );

        console.log("✅ Success:", response.data);
        return response.data;
    } catch (e) {
        console.error("❌ Error:", e.response?.data || e.message);
        throw e;
    }
}

module.exports = updateLeverage;