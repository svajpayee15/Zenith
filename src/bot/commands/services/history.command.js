const axios = require("axios");

async function history(walletAddress, cursor) {
  // Added limit=5 to ensure pagination matches Discord UI
  let url = `https://api.pacifica.fi/api/v1/positions?account=${walletAddress}&limit=5`;
  
  if (cursor) {
      url += `&cursor=${cursor}`;
  }

  const apiResponse = await axios.get(url);
  return apiResponse;
}

module.exports = history;