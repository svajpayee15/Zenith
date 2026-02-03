const axios = require("axios");

const API_BASE = "https://api.pacifica.fi/api/v1";

async function getAccountInfo(walletAddress) {
    try {
        // Direct URL construction as requested
        const response = await axios.get(`${API_BASE}/account?account=${walletAddress}`);

        if(response.data.success){
            return response.data.data;
        }

        return null

    } catch (error) {
        // Log error but return null so the bot handles it gracefully
        console.error("[Account API] Error:", error.response?.data || error.message);
        return null;
    }
}

module.exports = getAccountInfo;