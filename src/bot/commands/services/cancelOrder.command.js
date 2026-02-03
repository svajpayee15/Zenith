const nacl = require("tweetnacl");
const bs58 = require("bs58");
const axios = require("axios");
const wallet = require("../../../config/agent.wallet.js");

function sortRecursive(item) {
    if (typeof item !== 'object' || item === null) return item;
    if (Array.isArray(item)) return item.map(sortRecursive);
    return Object.keys(item).sort().reduce((acc, key) => {
        acc[key] = sortRecursive(item[key]);
        return acc;
    }, {});
}

async function cancelOrder(walletAddress, symbol, oid) {
    const timestamp = Date.now();
    const expiry = 10000;
    
    const orderIdInt = parseInt(oid);

    const signaturePayload = {
        timestamp: timestamp,
        expiry_window: expiry,
        type: "cancel_order", 
        symbol: symbol,
        order_id: orderIdInt
    };

    const sortedSignaturePayload = sortRecursive(signaturePayload);
    const messageByte = new TextEncoder().encode(JSON.stringify(sortedSignaturePayload));
    
    const signature = nacl.sign.detached(messageByte, wallet.secretKey);
    const signatureString = bs58.encode(signature);

    const requestPayload = {
        account: walletAddress,
        agent_wallet: wallet.publicKey.toBase58(),
        signature: signatureString,
        timestamp: timestamp,
        expiry_window: expiry,
        symbol: symbol, 
        order_id: orderIdInt
    };

    const sortedRequestPayload = sortRecursive(requestPayload)

    try {
        const response = await axios.post(
            "https://api.pacifica.fi/api/v1/orders/create_market",
            sortedRequestPayload
        );

        return { success: true, data: response.data };

    } catch (err) {
        const errorMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        console.error("Cancel Failed:", errorMsg);
        return { data:err, success: false, message: errorMsg };
    }
}

module.exports = cancelOrder;