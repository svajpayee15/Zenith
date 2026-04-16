/**
 * Zenith Institutional Risk Engine - MAKO LEADERBOARD EDITION
 * Built for Pacifica API - Path Dependent, Tail-Risk Adjusted, 1/4 Kelly.
 * UPGRADED: True Net-PnL with Funding Rates, Volume-Weighted Fee Drag, & 10k Limit.
 */

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// 1. MAIN ENGINE (The Orchestrator)
// ==========================================
async function runZenithEngine(walletAddress) {
    try {
        console.log(`[Zenith] Initializing Full Net-PnL scan for ${walletAddress}...`);
        
        // 🛑 INSTITUTIONAL FIX: Using limit=10000 to pull massive data chunks instantly
        const tradesUrl = `https://api.pacifica.fi/api/v1/trades/history?account=${walletAddress}&limit=10000`;
        const rawTrades = await fetchPaginatedData(tradesUrl);

        await sleep(250); // Buffer between heavy endpoint requests

        // 🛑 INSTITUTIONAL FIX: Pulling lifetime funding history to calculate True Net-PnL
        const fundingUrl = `https://api.pacifica.fi/api/v1/funding/history?account=${walletAddress}&limit=10000`;
        const rawFunding = await fetchPaginatedData(fundingUrl);

        if (!rawTrades.length) {
            return { error: "No actionable trade history found. Account is dormant." };
        }

        // Pass both trades and funding to the simulation layer
        const { equityCurve, logReturns, rawROIs, timeStats } = buildEquityCurve(rawTrades, rawFunding);
        
        if (!equityCurve.length) {
            return { error: "Failed to construct equity curve due to bad data." };
        }

        const metrics = calculateRiskMetrics(equityCurve, logReturns, rawROIs, timeStats);

        return {
            wallet: walletAddress,
            analysis_timestamp: new Date().toISOString(),
            metrics: metrics,
            curve: equityCurve 
        };

    } catch (error) {
        console.error(`[Zenith Engine Fatal Error] ${walletAddress}:`, error);
        return { error: "Engine execution failed. Check console logs." };
    }
}

// ==========================================
// 2. SIMULATION LAYER (Funding + Volume Fees)
// ==========================================
function buildEquityCurve(trades, funding = []) {
    // 1. Map Trades (Applying volume-based exchange fees)
    const tradeEvents = trades.map(t => {
        const rawPnl = parseFloat(t.pnl || t.n) || 0;
        const price = parseFloat(t.price || t.p) || 1;
        const amount = parseFloat(t.amount || t.a) || 0;
        const notional = price * amount;
        
        // Exchange Fee Drag: Assume standard 0.05% (5 BPS) per trade on the full notional volume
        const feeDrag = notional * 0.0005; 
        const netTradePnl = rawPnl - feeDrag;

        return { 
            time: new Date(t.created_at || t.t).getTime(), 
            pnl: netTradePnl, 
            notional: notional,
            type: 'TRADE' 
        };
    });

    // 2. Map Funding Payments (The silent killer for high-leverage whales)
    const fundingEvents = funding.map(f => {
        const fundingPayment = parseFloat(f.payout || f.amount || f.n) || 0;
        return {
            time: new Date(f.created_at || f.t).getTime(),
            pnl: fundingPayment, // Funding can be positive (rebate) or negative (fee)
            notional: 0,
            type: 'FUNDING'
        };
    });

    // 3. Merge and sort chronological timeline
    const timeline = [...tradeEvents, ...fundingEvents].sort((a, b) => a.time - b.time);

    // --- Absolute Capital Pre-Scan (Finding true starting baseline) ---
    let runningPnl = 0;
    let peakRunning = 0;
    let maxAbsoluteDrawdown = 0;
    let totalNotional = 0;
    let tradeCount = 0;

    for (const event of timeline) {
        runningPnl += event.pnl;
        if (event.type === 'TRADE') {
            totalNotional += event.notional;
            tradeCount++;
        }
        
        if (runningPnl > peakRunning) peakRunning = runningPnl;
        const currentAbsDD = peakRunning - runningPnl;
        if (currentAbsDD > maxAbsoluteDrawdown) maxAbsoluteDrawdown = currentAbsDD;
    }

    const avgNotional = tradeCount > 0 ? totalNotional / tradeCount : 1000;
    
    // Starting equity = Worst Drawdown + 2% tight survival margin to match exchange MDD severity
    let startingEquity = maxAbsoluteDrawdown > 0 ? maxAbsoluteDrawdown * 1.02 : avgNotional * 0.1; 
    if (startingEquity <= 0) startingEquity = 100; 

    // --- True Net % Return Simulation ---
    let currentEquity = startingEquity; 
    let peakEquity = startingEquity;
    let maxDrawdown = 0;
    
    const equityCurve = [];
    const logReturns = [];
    const rawROIs = []; 

    for (const event of timeline) {
        const prevEquity = currentEquity;
        currentEquity = currentEquity + event.pnl;

        if (currentEquity <= 0) currentEquity = startingEquity * 0.01; // Liquidation floor

        const portfolioRoi = (currentEquity - prevEquity) / prevEquity;

        const safeCurrent = Math.max(currentEquity, 0.0001);
        const safePrev = Math.max(prevEquity, 0.0001);
        
        const logReturn = Math.log(safeCurrent / safePrev);
        
        // We only track statistical trade returns, funding is just passive equity bleed
        if (logReturn !== 0 && event.type === 'TRADE') {
            logReturns.push(logReturn);
            rawROIs.push(portfolioRoi);
        }

        if (currentEquity > peakEquity) peakEquity = currentEquity;
        const currentDD = (peakEquity - currentEquity) / peakEquity;
        if (currentDD > maxDrawdown) maxDrawdown = currentDD;

        equityCurve.push({ time: event.time, equity: currentEquity, drawdown: currentDD });
    }

    const firstEventTime = timeline.length > 0 ? timeline[0].time : Date.now();
    const lastEventTime = timeline.length > 0 ? timeline[timeline.length - 1].time : Date.now();
    const daysActive = Math.max((lastEventTime - firstEventTime) / (1000 * 60 * 60 * 24), 1); 

    return { equityCurve, logReturns, rawROIs, timeStats: { daysActive } };
}

// ==========================================
// 3. MATH LAYER (Institutional Kernels)
// ==========================================
function calculateRiskMetrics(curve, logReturns, rois, timeStats) {
    const sum = (arr) => arr.reduce((a, b) => a + b, 0);
    const avg = (arr) => arr.length > 0 ? sum(arr) / arr.length : 0;
    const safeDiv = (num, den) => (den && Math.abs(den) > 0.000001) ? (num / den) : 0; 

    const startEquity = curve[0].equity;
    const endEquity = curve[curve.length - 1].equity;
    const totalROI = (endEquity - startEquity) / startEquity;
    const yearsActive = Math.max(timeStats.daysActive / 365.25, 0.01);
    
    // Linear Annualization for short track records
    let annualizedReturn = 0;
    if (yearsActive < 1) {
        annualizedReturn = totalROI * (1 / yearsActive); 
    } else {
        annualizedReturn = Math.pow(Math.max((endEquity / startEquity), 0), (1 / yearsActive)) - 1;
    }

    const maxDrawdown = Math.max(...curve.map(point => point.drawdown));

    const wins = rois.filter(r => r > 0);
    const losses = rois.filter(r => r < 0);
    const totalTrades = rois.length;
    const winRate = totalTrades > 0 ? (wins.length / totalTrades) : 0;
    
    const grossProfit = sum(wins);
    const grossLoss = Math.abs(sum(losses));
    const profitFactor = safeDiv(grossProfit, grossLoss);

    const avgWin = avg(wins);
    const avgLoss = avg(losses);
    const largestWin = wins.length > 0 ? Math.max(...wins) : 0;
    const largestLoss = losses.length > 0 ? Math.min(...losses) : 0;

    const riskReward = safeDiv(avgWin, Math.abs(avgLoss));
    const rawEV = (winRate * avgWin) - ((1 - winRate) * Math.abs(avgLoss));
    const expectancy = safeDiv(rawEV, Math.abs(avgLoss));

    const meanLogReturn = avg(logReturns);
    const variance = logReturns.reduce((acc, r) => acc + Math.pow(r - meanLogReturn, 2), 0) / (logReturns.length || 1);
    const stdDev = Math.sqrt(variance);

    const skewness = safeDiv(logReturns.reduce((acc, r) => acc + Math.pow(r - meanLogReturn, 3), 0) / (logReturns.length || 1), Math.pow(stdDev, 3));
    const kurtosis = safeDiv(logReturns.reduce((acc, r) => acc + Math.pow(r - meanLogReturn, 4), 0) / (logReturns.length || 1), Math.pow(stdDev, 4));

    const z = -1.645;
    const z_cf = z + (Math.pow(z, 2) - 1) * skewness / 6 + (Math.pow(z, 3) - 3 * z) * (kurtosis - 3) / 24 - (2 * Math.pow(z, 3) - 5 * z) * Math.pow(skewness, 2) / 36;
    const var95 = meanLogReturn + z_cf * stdDev;

    const tradesPerYear = totalTrades / yearsActive;
    const annualizedVolatility = stdDev * Math.sqrt(Math.max(tradesPerYear, 1));
    
    const downsideReturns = logReturns.filter(r => r < 0);
    const downsideVariance = downsideReturns.length > 0 
        ? downsideReturns.reduce((acc, r) => acc + Math.pow(r, 2), 0) / downsideReturns.length 
        : 0;
    const downsideDev = Math.sqrt(downsideVariance);
    const annualizedDownsideVol = downsideDev * Math.sqrt(Math.max(tradesPerYear, 1));

    const sharpe = annualizedVolatility > 0 ? (annualizedReturn / annualizedVolatility) : 0;
    const sortino = annualizedDownsideVol > 0 ? (annualizedReturn / annualizedDownsideVol) : 0;
    
    const calmar = safeDiv(annualizedReturn, maxDrawdown);
    const recoveryFactor = safeDiv(totalROI, maxDrawdown);

    const riskFreeRate = 0.0; 
    let trueKelly = variance > 0 ? safeDiv((meanLogReturn - riskFreeRate), variance) : 0;
    const safeKellyFraction = Math.max(Math.min(trueKelly * 0.25, 1), 0); 

    let currentLosingStreak = 0;
    let maxLosingStreak = 0;
    for (const r of rois) {
        if (r < 0) {
            currentLosingStreak++;
            maxLosingStreak = Math.max(maxLosingStreak, currentLosingStreak);
        } else {
            currentLosingStreak = 0;
        }
    }

    let zenithScore = 0;
    const ruinPenalty = maxDrawdown > 0.5 ? 0.2 : 1; 

    const sharpeScore = Math.max(Math.min(sharpe / 2, 1), 0) * 400; 
    const calmarScore = Math.max(Math.min(calmar / 3, 1), 0) * 300; 
    const pfScore = Math.max(Math.min((profitFactor - 1) / 2, 1), 0) * 300; 
    
    zenithScore = (sharpeScore + calmarScore + pfScore) * ruinPenalty;
    if (totalTrades < 30) zenithScore *= (totalTrades / 30); 
    zenithScore = Math.max(0, Math.min(zenithScore, 1000));

    const format = (val, dec = 2) => val !== null && !isNaN(val) ? Number(Number(val).toFixed(dec)) : 0;

    return {
        leaderboard: {
            zenithRankScore: Math.round(zenithScore), 
            rankTier: zenithScore > 800 ? "S" : zenithScore > 600 ? "A" : zenithScore > 300 ? "B" : "C",
        },
        overview: {
            daysActive: format(timeStats.daysActive, 1),
            totalTrades: totalTrades,
            totalReturnPct: format(totalROI * 100),
            cagrPct: format(annualizedReturn * 100), 
        },
        tradeStats: {
            winRatePct: format(winRate * 100),
            profitFactor: format(profitFactor, 3),
            avgWinPct: format(avgWin * 100),
            avgLossPct: format(avgLoss * 100),
            largestWinPct: format(largestWin * 100),
            largestLossPct: format(largestLoss * 100),
        },
        riskMetrics: {
            maxDrawdownPct: format(maxDrawdown * 100),
            maxLosingStreak: maxLosingStreak,
            historicalVaR95Pct: format(var95 * 100), 
            riskRewardRatio: format(riskReward),
            expectancyRatio: format(expectancy, 3),
            safeKellySizingPct: format(safeKellyFraction * 100) 
        },
        ratios: {
            sharpeRatioAnnualized: format(sharpe, 3),
            sortinoRatioAnnualized: format(sortino, 3),
            calmarRatio: format(calmar, 3),
            recoveryFactor: format(recoveryFactor, 3)
        }
    };
}

// ==========================================
// 4. NETWORK LAYER (Dynamic Proactive Fetcher)
// ==========================================
async function fetchPaginatedData(baseUrl) {
    let allData = [];
    let hasMore = true;
    let cursor = "";
    let retryCount = 0;
    const maxRetries = 5;

    while (hasMore) {
        try {
            const url = cursor ? `${baseUrl}&cursor=${cursor}` : baseUrl;
            const res = await fetch(url);
            
            const rateLimitHeader = res.headers.get('ratelimit');
            let remainingCredits = 100; 
            let secondsUntilRefresh = 10; 

            if (rateLimitHeader) {
                const rMatch = rateLimitHeader.match(/r=(\d+)/);
                const tMatch = rateLimitHeader.match(/t=(\d+)/);
                
                if (rMatch) remainingCredits = parseInt(rMatch[1], 10) / 10; 
                if (tMatch) secondsUntilRefresh = parseInt(tMatch[1], 10);
            }

            if (res.status === 429) {
                retryCount++;
                if (retryCount > maxRetries) {
                    console.error(`[Fetch Error] Hit max retries (429) for ${baseUrl}. Aborting pagination.`);
                    break; 
                }
                
                const waitMs = (secondsUntilRefresh * 1000) + 1000; 
                console.warn(`[Rate Limit 429] Hit the wall. Waiting exactly ${secondsUntilRefresh}s based on API headers...`);
                await sleep(waitMs);
                continue; 
            }

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            
            retryCount = 0;
            const json = await res.json();
            if (!json.success || !json.data) break;

            allData.push(...json.data);
            hasMore = json.has_more || false;
            cursor = json.next_cursor || "";

            if (hasMore) {
                if (remainingCredits <= 15) {
                    const waitMs = (secondsUntilRefresh * 1000) + 500;
                    console.log(`[Rate Limit] Proactive Pause: Only ${remainingCredits} credits left. Waiting ${secondsUntilRefresh}s for bucket to refill.`);
                    await sleep(waitMs);
                } else {
                    await sleep(100); 
                }
            }

        } catch (error) {
            console.error(`[Fetch Error] ${baseUrl}:`, error.message);
            break; 
        }
    }
    return allData;
}

module.exports = { runZenithEngine };