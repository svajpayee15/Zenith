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

async function marketOrder(walletAddress, symbol, amount, slippage_percent, side, tp, sl, reduce_only) {

  const timestampOfSignature = Date.now();

  const dataObject = {
      amount: amount.toString(),
      builder_code: "prathamdev69",
      symbol: symbol,
      side: side,
      slippage_percent: slippage_percent.toString(),
      reduce_only: reduce_only,
  };

  if (tp) {
      dataObject.take_profit = {
          stop_price: tp.toString(),
          limit_price: tp.toString(),
      };
  }

  if (sl) {
      dataObject.stop_loss = {
          stop_price: sl.toString(),
          limit_price: sl.toString(),
      };
  }

  const signaturePayload = {
    data: dataObject,
    expiry_window: 30000,
    timestamp: timestampOfSignature,
    type: "create_market_order",
  };

  const sortedPayload = sortRecursive(signaturePayload);
  const messageByte = new TextEncoder().encode(JSON.stringify(sortedPayload));
  const signature = nacl.sign.detached(messageByte, wallet.secretKey);
  const signatureBase58 = bs58.encode(signature);

  const payloadRaw = {
    account: walletAddress,
    agent_wallet: wallet.publicKey.toBase58(),
    signature: signatureBase58,    
    timestamp: timestampOfSignature,
    expiry_window: 30000,
    ...dataObject
  };

    console.log(`🚀 Executing ${payloadRaw}`);


  try {
    const resp = await axios.post(
      "https://api.pacifica.fi/api/v1/orders/create_market",
      payloadRaw
    );

    return { success: true, ...resp.data };

  } catch (err) {
     const errorData = err.response ? err.response.data : err.message;
     console.error("❌ Pacifica Error:", errorData);
     return { success: false, data: errorData };
  }
}

module.exports = marketOrder;