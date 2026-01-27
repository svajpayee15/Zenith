const approvals = require("../../database/models/approvals.Schema.js");
const bs58 = require("bs58").default || require("bs58");
const axios = require("axios");
const nacl = require("tweetnacl");
const wallet = require("../config/agent.wallet.js");
const { vaasfG, vaasfP } = require("../../utility/auth-api-schema.zod.js");
const preparePayloadforSigning = require("../../utility/signer.js");

const approveGet = async (req, res) => {
  const userId_R = req.query.userId;
  const nonce_R = req.query.nonce;

  const result = vaasfG(userId_R, nonce_R);
  if (!result.success) return res.status(404).json({ message: result });

  const { userId, nonce } = result.data;

  const userApproval = await approvals.findOne({ userId, nonce });

  if (!userApproval) {
    return res.status(404).json({ message: "User request not found." });
  }
  if (userApproval._id.getTimestamp().getTime() + 60000 < Date.now()) {
    return res.json({ message: "Expired." });
  }
  if (userApproval.approved) {
    return res.json({ message: "Already Approved." });
  }

  res.render("approve", { userId, nonce });
};

const approvePost = async (req, res) => {
  const userId_R = req.body.userId;
  const walletAddress_R = req.body.walletAddress;
  const signature_R = req.body.signature;
  const payload_R = req.body.payload;

  const result = vaasfP(userId_R, walletAddress_R, signature_R, payload_R);
  if (!result.success) return res.status(400).json({ message: "Bad Request" });

  const { userId, walletAddress, signature, payload } = result.data;

  const userApproval = await approvals.findOne({ userId });

  if (!userApproval) {
    return res.status(404).json({ message: "User request not found." });
  }
    if (userApproval._id.getTimestamp().getTime() + 60000 < Date.now()) {
    return res.json({ message: "Expired." });
  }
  if (userApproval.approved) {
    return res.json({ message: "Already Approved." });
  }

  const signatureString = bs58.encode(new Uint8Array(signature));

  const ApprovalPayload = {
    account: walletAddress,
    agent_wallet: wallet.publicKey.toBase58(),
    signature: signatureString,
    timestamp: payload.timestamp,
    expiry_window: payload.expiry_window,
    builder_code: payload.data.builder_code,
    max_fee_rate: payload.data.builder_code === "prathamdev69" ? "0.001" : (payload.data.max_fee_rate || "0.001"),
  };

  try {   
    const resp = await axios.post(
      "https://test-api.pacifica.fi/api/v1/account/builder_codes/approve",
      ApprovalPayload
    );

    console.log("Pacifica Approval Success:", resp.status);

    return res.json({ userId: userId_R, wallet: wallet.publicKey.toBase58() });
  } catch (err) {
    console.error(
      "Pacifica Error:",
      err.response ? err.response.data : err.message
    );
    res
      .status(400)
      .json(err.response ? err.response.data : { error: "Request Failed" });
  }
};

module.exports = { approveGet, approvePost };