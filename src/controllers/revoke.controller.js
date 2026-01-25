const approvals = require("../../database/models/approvals.Schema.js");
const bs58 = require("bs58").default || require("bs58");
const axios = require("axios");
const wallet = require("../config/agent.wallet.js")
const { vaasfG, vaasfP } = require("../../utility/auth-api-schema.zod.js");

const revokeGet = async (req, res) => {
  const userId_R = req.query.userId
  const nonce_R = req.query.nonce

  const result = vaasfG(userId_R, nonce_R);
  if (!result.success) return res.status(404).json({ message: "Bad Request" });

  const { userId, nonce } = result.data;

  if (!userId || !nonce) {
    res.status(404).json({ message: "Bad Request." });
  }

  const userApproval = await approvals.findOne({ userId, nonce });

  console.log(userApproval._id.getTimestamp().getTime() + 60000 < Date.now())
  console.log(userApproval._id.getTimestamp().getTime() + 60000)
  console.log(Date.now())

  if (userApproval.updatedAt.getTime() + 60000 < Date.now()) {
    return res.json({ message: "Expired." });
  }
  if (userApproval && userApproval.approved) {
    return res.render("revoke", { userId, nonce });
  }

  return res.json({ message: "Not Found." });
};

const revokePost = async (req, res) => {
  const userId_R = req.body.userId;
  const walletAddress_R = req.body.walletAddress;
  const signature_R = req.body.signature;
  const payload_R = req.body.payload;

  const result = vaasfP(userId_R, walletAddress_R, signature_R, payload_R);
  if (!result.success) return res.status(404).json({ message: "Bad Request" });

  const { userId, walletAddress, signature, payload } = result.data;

  const userApproval = await approvals.findOne({ userId });
  
   if (userApproval.updatedAt.getTime() + 60000 < Date.now()) {
    return res.json({ message: "Expired." });
  }

  if (userApproval && userApproval.approved) {
    const signatureBytes = new Uint8Array(signature);
    const signatureString = bs58.encode(signatureBytes);

   const ApprovalPayload = {
    account: walletAddress,
    agent_wallet: null,
    builder_code: payload.data.builder_code,
    expiry_window: payload.expiry_window,
    signature: signatureString,
    timestamp: payload.timestamp,
  };

    try {
      const resp = await axios.post(
        "https://test-api.pacifica.fi/api/v1/account/builder_codes/revoke",
        ApprovalPayload
      );

      console.log("Pacifica Success:", resp.status);

     return res.json({ userId: userId_R, wallet: wallet.publicKey.toBase58() });
    } catch (err) { 
      console.log(err.response.data)
      res
        .status(400)
        .json(err.response ? err.response.data : { error: "Request Failed" });
    }
  }
};

module.exports = { revokeGet, revokePost };
