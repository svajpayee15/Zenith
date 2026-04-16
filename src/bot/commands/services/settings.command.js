// File: src/bot/commands/services/settings.command.js

const axios = require("axios");

/**
 * Fetches the user's current account settings (Leverage, Margin Mode) from Pacifica.
 * @param {string} walletAddress - The user's public wallet address.
 * @returns {Promise<Object>} The API response containing margin_settings and spot_settings.
 */
async function getAccountSettings(walletAddress) {
    try {
        const response = await axios.get(`https://test-api.pacifica.fi/api/v1/account/settings?account=${walletAddress}`);
        return response.data;
    } catch (error) {
        console.error("[Settings API Error]", error?.response?.data || error.message);
        return { success: false, error: error?.response?.data || error.message };
    }
}

module.exports = getAccountSettings;