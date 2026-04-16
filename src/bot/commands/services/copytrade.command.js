// File: controllers/copyTrade.controller.js
const User = require("../../../../database/models/users.Schema.js"); 
const CopyTrading = require("../../../../database/models/copyTradings.Schema.js");
const { runZenithEngine } = require("../../../../utility/zenithEngine.js");
const pacificaWS = require("../../../config/ws.connection.js"); 

// ==========================================
// 1. THE ORACLE (Fetch & Update Target Wallet with Cache)
// ==========================================
async function getCopyTradeWallet(targetWalletAddress) {
    const existingUser = await User.findOne({ walletAddress: targetWalletAddress });
    
    const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const isStale = !existingUser || 
                    !existingUser.quantMetrics || 
                    !existingUser.quantMetrics.lastEngineRun ||
                    (Date.now() - new Date(existingUser.quantMetrics.lastEngineRun).getTime() > ONE_WEEK_MS);

    if (!isStale) {
        console.log(`[Cache] Using existing metrics for ${targetWalletAddress}`);
        return existingUser;
    }

    console.log(`[Engine] Data stale or missing. Executing Zenith Deep-Scan for: ${targetWalletAddress}`);
    const engineResult = await runZenithEngine(targetWalletAddress);

    if (engineResult.error) throw new Error(`Engine Error: ${engineResult.error}`);

    // The engineResult.metrics now perfectly matches zenithMetricsSchema
    return await User.findOneAndUpdate(
        { walletAddress: targetWalletAddress },
        { 
            $set: { 
                quantMetrics: { 
                    ...engineResult.metrics, 
                    lastEngineRun: new Date() 
                } 
            } 
        },
        { new: true, upsert: true }
    );
}

// ==========================================
// 2. INITIATE COPY TRADE (The Gatekeeper)
// ==========================================
async function copytrade(followerWallet, targetWalletAddress, riskParams) {
    try {
        if (followerWallet === targetWalletAddress) {
            return { success: false, error: "Self-copying is disabled to prevent infinite recursion." };
        }

        const targetUser = await getCopyTradeWallet(targetWalletAddress);
        const metrics = targetUser.quantMetrics;
        let warnings = [];

        // --- INSTITUTIONAL RISK GATING (Updated for new schema) ---
        if (!metrics || !metrics.riskMetrics || !metrics.leaderboard) {
            return { success: false, error: "Failed to load Zenith risk matrix for target wallet." };
        }

        if (metrics.leaderboard.rankTier === "C" || metrics.leaderboard.rankTier === "D") {
            warnings.push(`⚠️ Target is Rank ${metrics.leaderboard.rankTier} (Sub-optimal Risk/Reward).`);
        }
        
        if (metrics.riskMetrics.maxDrawdownPct > 30) {
            warnings.push(`⚠️ Target has historically suffered severe drawdowns (${metrics.riskMetrics.maxDrawdownPct}%).`);
        }
        
        // NEW: Behavioral warning implementation
        if (metrics.behavioral && metrics.behavioral.revengeTradeRatePct > 15) {
            warnings.push(`⚠️ Warning: High probability of revenge trading detected (${metrics.behavioral.revengeTradeRatePct}% rate).`);
        }

        let existingStream = await CopyTrading.findOne({ 
            followerWallet: followerWallet, 
            targetWallet: targetWalletAddress 
        });

        if (existingStream && existingStream.isActive) {
            return { success: false, error: "You are already actively copy-trading this wallet." };
        }

        let newCopyStream;
        
        if (existingStream) {
            existingStream.isActive = true;
            existingStream.portfolioPct = riskParams.portfolioPct || 10;
            existingStream.maxTradeSizeUsd = riskParams.maxTradeSizeUsd;
            existingStream.slippageTolerancePct = riskParams.slippageTolerancePct || 0.5;
            existingStream.maxLeverageCap = riskParams.maxLeverageCap || 5;
            existingStream.targetMetricsSnapshot = metrics; // Stores the new massive schema snapshot
            
            await existingStream.save();
            newCopyStream = existingStream;
            console.log(`[DB] Reactivated dormant stream between ${followerWallet} and ${targetWalletAddress}`);
        } else {
            newCopyStream = await CopyTrading.create({
                followerWallet: followerWallet,
                targetWallet: targetWalletAddress,
                portfolioPct: riskParams.portfolioPct || 10,
                maxTradeSizeUsd: riskParams.maxTradeSizeUsd,
                slippageTolerancePct: riskParams.slippageTolerancePct || 0.5,
                maxLeverageCap: riskParams.maxLeverageCap || 5,
                targetMetricsSnapshot: metrics,
                isActive: true
            });
        }

        pacificaWS.subscribeAccount(targetWalletAddress);
        console.log(`[WS Controller] Stream active. Tracking sequences for: ${targetWalletAddress}`);
        
        return {
            success: true,
            warnings: warnings,
            message: warnings.length > 0 ? "Connected with structural risk warnings." : "Connected successfully.",
            streamId: newCopyStream._id,
            metrics: metrics
        };

    } catch (error) {
        console.error("[CopyTrade Initiation Error]:", error);
        if (error.code === 11000) {
            return { success: false, error: "Stream collision: You are already actively copy-trading this wallet." };
        }
        return { success: false, error: error.message };
    }
}

module.exports = { getCopyTradeWallet, copytrade };