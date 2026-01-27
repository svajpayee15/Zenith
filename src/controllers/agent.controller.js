const vpaaf = require("../../utility/auth-agent-schema.zod.js");
const axios = require("axios");
const bs58 = require("bs58");
const nacl = require("tweetnacl");
const approvals = require("../../database/models/approvals.Schema.js");
const preparePayloadforSigning = require("../../utility/signer.js");

async function bind(req, res) {
    const userId_R = req.body.userId;
    const payload_R = req.body.payload;

    const result = vpaaf(userId_R, payload_R);
    if (!result.success) return res.status(400).json({ message: "Bad Request" });

    const { userId, payload } = result.data;

    // --- START LOCAL VERIFICATION ---
    try {
        const messageObj = { ...payload };
        const signatureFromPayload = messageObj.signature;
        delete messageObj.signature; // Remove signature to reconstruct original message

        const messageString = preparePayloadforSigning(messageObj);
        const messageUint8 = new TextEncoder().encode(messageString);
        const signatureUint8 = new Uint8Array(signatureFromPayload);
        const publicKeyUint8 = bs58.decode(payload.account); // Signer is the user (account)

        const isSignatureValid = nacl.sign.detached.verify(
            messageUint8,
            signatureUint8,
            publicKeyUint8
        );

        if (!isSignatureValid) {
            return res.status(401).json({ error: "Local cryptographic verification failed." });
        }

        // Re-attach signature in base58 for Pacifica API
        payload.signature = bs58.encode(signatureUint8);
    } catch (err) {
        return res.status(500).json({ error: "Verification processing error." });
    }
    // --- END LOCAL VERIFICATION ---

    try {
        const response = await axios.post("https://test-api.pacifica.fi/api/v1/agent/bind", payload);

        if (response.data.success || response.success) {
            await approvals.findOneAndUpdate(
                { userId: userId },
                { walletAddress: payload.account, signature: payload.signature, approved: true }
            );
            return res.status(200).json({ message: "ok" });
        }
    } catch (err) {
        console.error("Pacifica Bind Error:", err.response?.data || err.message);
        return res.status(400).json({ message: err.response?.data || "Pacifica API Error" });
    }
}

async function revoke(req, res) {
    const userId_R = req.body.userId;
    const payload_R = req.body.payload;

    const result = vpaaf(userId_R, payload_R);
    if (!result.success) return res.status(400).json({ message: "Bad Request" });

    const { userId, payload } = result.data;

    // --- START LOCAL VERIFICATION ---
    try {
        const messageObj =   { 
                    timestamp: payload.timestamp,
                    expiry_window: payload.expiry_window,
                    type: "revoke_agent_wallet",
                    data: { agent_wallet: payload.agent_wallet };
        }
        const signatureFromPayload = payload.signature;

        const messageString = preparePayloadforSigning(messageObj);
        const messageUint8 = new TextEncoder().encode(messageString);
        const signatureUint8 = new Uint8Array(signatureFromPayload);
        const publicKeyUint8 = bs58.decode(payload.account);

        console.log(payload)
        
        const isSignatureValid = nacl.sign.detached.verify(
            messageUint8,
            signatureUint8,
            publicKeyUint8
        );

        if (!isSignatureValid) {
            return res.status(401).json({ error: "Local cryptographic verification failed." });
        }

        payload.signature = bs58.encode(signatureUint8);
    } catch (err) {
        return res.status(500).json({ error: "Verification processing error." });
    }
    // --- END LOCAL VERIFICATION ---

    try {
      console.log(payload)
        const response = await axios.post("https://test-api.pacifica.fi/api/v1/agent/revoke", payload);

        if (response.data.success) {
            await approvals.deleteOne({ userId: userId });
            return res.status(200).json({ message: "ok" });
        } else {
            throw new Error("Pacifica rejection");
        }
    } catch (err) {
        console.error("Pacifica Revoke Error:", err.response?.data || err.message);
        return res.status(400).json({ message: err.response?.data || "Pacifica API Error" });
    }
}

module.exports = { bind, revoke };