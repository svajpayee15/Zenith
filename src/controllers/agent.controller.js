const vpaaf = require("../../utility/auth-agent-schema.zod.js")
const axios = require("axios")
const bs58 = require("bs58")
const approvals = require("../../database/models/approvals.Schema.js");

async function bind(req,res){
  const userId_R = req.body.userId;
  const payload_R = req.body.payload;

  const result = vpaaf(userId_R, payload_R);
  if(!result.success) return res.status(400).json({ message: "Bad Request"});

  const { userId, payload } = result.data;

  const signatureBytes = new Uint8Array(payload.signature);
  payload.signature = bs58.encode(signatureBytes);

  try{
  const response = await axios.post("https://test-api.pacifica.fi/api/v1/agent/bind", payload)

  if(response.success || response.data.success){
      await approvals.findOneAndUpdate(
          { userId: userId },
          { walletAddress: payload.account , signature: payload.signature, approved: true }
        );

      return res.status(200).json({ message: "ok"})
  }
  }
  catch(err){
    console.log(err)
    return res.status(400).json({ message: err})
  }
}

async function revoke(req,res){
  const userId_R = req.body.userId;
  const payload_R = req.body.payload;
  console.log("REVOKING AGENT WALLET")

  const result = vpaaf(userId_R, payload_R);
  console.log(result)
  if(!result.success) return res.status(400).json({ message: "Bad Request"});

  const { userId, payload } = result.data;

  const signatureBytes = new Uint8Array(payload.signature);
  payload.signature = bs58.encode(signatureBytes);

  try{
  const response = await axios.post("https://test-api.pacifica.fi/api/v1/agent/revoke", payload)
  console.log("Pacifica Agent Revoke:",response.status)

  if(response.data.success){
      await approvals.deleteOne({ userId: userId });

      return res.status(200).json({ message: "ok"})
  }
  else{
    throw new Error(JSON.stringify(response))
  }
  }
  catch(err){
    console.log(err)
    return res.status(400).json({ message: err})
  }
}

module.exports = { bind, revoke}