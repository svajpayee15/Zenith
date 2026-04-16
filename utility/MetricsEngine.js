
/**
 * Zenith Metrics Engine
 *
 * Computes the full institutional-grade metric suite:
 *   → Trade Statistics     (win rate, PF, expectancy, hold time)
 *   → Risk Metrics         (VaR, CVaR, streaks)
 *   → Ratios               (Sharpe, Sortino, Calmar, Omega, Tail, GTP, Sterling)
 *   → Position Sizing      (Full/Half/Quarter Kelly, Optimal-f via grid search)
 *   → Behavioral Analysis  (overtrading score, revenge trades, hold patterns)
 *   → Distribution Stats   (skewness, excess kurtosis, fat-tail coefficient, histogram)
 *   → Streak Analysis      (win/lose streaks, avg lengths, current streak)
 *   → Per-Symbol Breakdown (top 10 by absolute PnL contribution)
 *   → Funding Summary      (net funding, received vs paid)
 *
 * KEY DESIGN DECISION: Sharpe and all ratio calculations use DAILY cash-flow-adjusted
 * returns from balance history — NOT per-trade returns. This eliminates the √(tradesPerYear)
 * annualisation inflation that inflated the original engine's Sharpe ~6x.
 */

// ══════════════════════════════════════════════════════════════
// ENTRY POINT
// ══════════════════════════════════════════════════════════════

function computeAllMetrics(rawTrades, rawFunding, equityData) {
    // ── Parse & classify all trade events ─────────────────────────────────────
    const allTrades    = _parseTrades(rawTrades);
    const closeTrades  = allTrades.filter(t => t.isClose);
    const openTrades   = allTrades.filter(t => t.isOpen);

    if (!closeTrades.length && !equityData.dailyTradingReturns.length) {
        return _emptyMetrics();
    }

    const dailyR = equityData.dailyTradingReturns; // convenience alias

    // ── Compute all categories ─────────────────────────────────────────────────
    const holdTimes      = _computeHoldTimes(allTrades);        // needs open + close
    const tradeStats     = _computeTradeStats(closeTrades, holdTimes);
    const riskMetrics    = _computeRiskMetrics(closeTrades, dailyR, equityData);
    const ratios         = _computeRatios(dailyR, equityData, tradeStats);
    const positionSizing = _computePositionSizing(tradeStats);
    const behavioral     = _computeBehavioral(allTrades, closeTrades, equityData.daysActive);
    const distribution   = _computeDistribution(dailyR);
    const streaks        = _computeStreaks(closeTrades);
    const perSymbol      = _computePerSymbol(closeTrades);
    const fundingSummary = _computeFundingSummary(rawFunding);

    return {
        overview: _buildOverview(closeTrades, openTrades, equityData, fundingSummary),
        tradeStats,
        riskMetrics,
        ratios,
        positionSizing,
        behavioral,
        distribution,
        streaks,
        perSymbol,
        fundingSummary,
    };
}

// ══════════════════════════════════════════════════════════════
// SECTION 1 — TRADE PARSER
// ══════════════════════════════════════════════════════════════

function _parseTrades(raw) {
    return raw
        .map(t => {
            const pnl    = parseFloat(t.pnl)   || 0;
            const fee    = parseFloat(t.fee)   || 0;
            const netPnl = pnl - fee;               // True net PnL per fill
            const side   = t.side || '';
            const isClose = side === 'close_long'  || side === 'close_short';
            const isOpen  = side === 'open_long'   || side === 'open_short';
            const isLong  = side === 'close_long'  || side === 'open_long';
            const cause   = t.cause || 'normal';

            return {
                historyId:     t.history_id,
                symbol:        t.symbol        || 'UNKNOWN',
                amount:        parseFloat(t.amount)      || 0,
                price:         parseFloat(t.price)       || 0,
                entryPrice:    parseFloat(t.entry_price) || 0,
                fee,
                pnl,
                netPnl,
                side,
                isClose,
                isOpen,
                isLong,
                isShort:      side === 'close_short' || side === 'open_short',
                isWin:        isClose && netPnl > 0,
                isLoss:       isClose && netPnl <= 0,
                isLiquidation: ['market_liquidation', 'backstop_liquidation', 'adl_liquidation'].includes(cause),
                eventType:    t.event_type || '',
                cause,
                createdAt:    Number(t.created_at),
            };
        })
        .filter(t => !isNaN(t.createdAt))
        .sort((a, b) => a.createdAt - b.createdAt);
}

// ══════════════════════════════════════════════════════════════
// SECTION 2 — HOLD TIME RECONSTRUCTION
// ══════════════════════════════════════════════════════════════

/**
 * Reconstructs position-level hold times by matching open→close fills (FIFO per symbol).
 * Returns array of hold durations in minutes.
 */
function _computeHoldTimes(allTrades) {
    // { symbol: { longs: [openTimestamp,...], shorts: [openTimestamp,...] } }
    const queues   = new Map();
    const holdMins = [];

    for (const t of allTrades) {
        if (!queues.has(t.symbol)) queues.set(t.symbol, { longs: [], shorts: [] });
        const q = queues.get(t.symbol);

        if      (t.side === 'open_long')    q.longs.push(t.createdAt);
        else if (t.side === 'open_short')   q.shorts.push(t.createdAt);
        else if (t.side === 'close_long'  && q.longs.length)  holdMins.push((t.createdAt - q.longs.shift())  / 60_000);
        else if (t.side === 'close_short' && q.shorts.length) holdMins.push((t.createdAt - q.shorts.shift()) / 60_000);
    }

    return holdMins.filter(h => h >= 0);
}

// ══════════════════════════════════════════════════════════════
// SECTION 3 — TRADE STATISTICS
// ══════════════════════════════════════════════════════════════

function _computeTradeStats(closeTrades, holdTimes) {
    if (!closeTrades.length) return _emptyTradeStats();

    const wins   = closeTrades.filter(t => t.netPnl > 0);
    const losses = closeTrades.filter(t => t.netPnl <= 0);

    const winRate     = wins.length / closeTrades.length;
    const grossProfit = _sum(wins.map(t => t.netPnl));
    const grossLoss   = Math.abs(_sum(losses.map(t => t.netPnl)));

    const profitFactor = grossLoss > 0
        ? grossProfit / grossLoss
        : grossProfit > 0 ? 999 : 0;

    const avgWinUsdc  = wins.length   ? grossProfit / wins.length   : 0;
    const avgLossUsdc = losses.length ? grossLoss   / losses.length : 0;

    const largestWinUsdc  = wins.length   ? Math.max(...wins.map(t => t.netPnl))   : 0;
    const largestLossUsdc = losses.length ? Math.min(...losses.map(t => t.netPnl)) : 0;

    // Risk/Reward
    const riskRewardRatio = avgLossUsdc > 0 ? avgWinUsdc / avgLossUsdc : 0;

    // Expectancy: expected USDC per trade
    const expectancyUsdc  = (winRate * avgWinUsdc) - ((1 - winRate) * avgLossUsdc);
    // Normalised expectancy ratio (vs average loss)
    const expectancyRatio = avgLossUsdc > 0 ? expectancyUsdc / avgLossUsdc : 0;

    // Hold times
    const avgHoldMins    = _avg(holdTimes);
    const medianHoldMins = _median(holdTimes);

    return {
        winRatePct:            _f(winRate * 100),
        profitFactor:          _f(profitFactor, 3),
        grossProfitUsdc:       _f(grossProfit),
        grossLossUsdc:         _f(grossLoss),
        netPnlUsdc:            _f(grossProfit - grossLoss),
        avgWinUsdc:            _f(avgWinUsdc),
        avgLossUsdc:           _f(-avgLossUsdc),      // stored as negative
        largestWinUsdc:        _f(largestWinUsdc),
        largestLossUsdc:       _f(largestLossUsdc),   // already negative
        riskRewardRatio:       _f(riskRewardRatio, 3),
        expectancyUsdc:        _f(expectancyUsdc),
        expectancyRatio:       _f(expectancyRatio, 3),
        avgHoldTimeMinutes:    _f(avgHoldMins, 1),
        medianHoldTimeMinutes: _f(medianHoldMins, 1),
    };
}

// ══════════════════════════════════════════════════════════════
// SECTION 4 — RISK METRICS
// ══════════════════════════════════════════════════════════════

function _computeRiskMetrics(closeTrades, dailyR, equityData) {
    // ── VaR & CVaR using DAILY returns (Cornish-Fisher adjusted) ─────────────
    const n   = dailyR.length;
    const μ   = _avg(dailyR);
    const σ   = _std(dailyR, μ);
    const S   = _skewness(dailyR, μ, σ);
    const K   = _kurtosis(dailyR, μ, σ);   // excess kurtosis

    // Cornish-Fisher expansion for 95% VaR
    const z     = -1.645;
    const z_cf  = z
        + ((z ** 2 - 1) * S) / 6
        + ((z ** 3 - 3 * z) * K) / 24
        - ((2 * z ** 3 - 5 * z) * S ** 2) / 36;

    const var95Daily = σ > 0 ? (μ + z_cf * σ) * 100 : 0; // as %

    // CVaR (Expected Shortfall) — mean of worst 5% of daily returns
    const sorted5     = [...dailyR].sort((a, b) => a - b);
    const cutoff      = Math.max(Math.floor(n * 0.05), 1);
    const tail        = sorted5.slice(0, cutoff);
    const cvar95Daily = tail.length ? _avg(tail) * 100 : var95Daily;

    // ── Streak analysis from trade returns ────────────────────────────────────
    const { maxWinStreak, maxLoseStreak } = _streakCounts(closeTrades);

    // ── Liquidation events ────────────────────────────────────────────────────
    const liquidationCount = closeTrades.filter(t => t.isLiquidation).length;

    return {
        maxDrawdownPct:      _f(equityData.maxDrawdownPct),
        maxDrawdownUsdc:     _f(equityData.maxDrawdownUsdc),
        avgRecoveryDays:     _f(equityData.avgRecoveryDays, 1),
        maxRunupPct:         _f(equityData.maxRunupPct),
        var95DailyPct:       _f(var95Daily),   // 1-day 95% VaR as %
        cvar95DailyPct:      _f(cvar95Daily),  // Expected Shortfall
        maxLosingStreak:     maxLoseStreak,
        maxWinningStreak:    maxWinStreak,
        liquidationCount,
    };
}

// ══════════════════════════════════════════════════════════════
// SECTION 5 — RATIO SUITE
// Uses daily cash-flow-adjusted returns — the institutional standard.
// ══════════════════════════════════════════════════════════════

function _computeRatios(dailyR, equityData, tradeStats) {
    if (!dailyR.length) return _emptyRatios();

    const μ          = _avg(dailyR);
    const σ          = _std(dailyR, μ);
    const annFactor  = Math.sqrt(365);

    // ── Sharpe ────────────────────────────────────────────────────────────────
    const sharpe = σ > 0 ? (μ / σ) * annFactor : 0;

    // ── Sortino (downside deviation only) ────────────────────────────────────
    const negR       = dailyR.filter(r => r < 0);
    const σDownside  = negR.length > 0
        ? Math.sqrt(negR.reduce((s, r) => s + r ** 2, 0) / negR.length)
        : 0;
    const sortino = σDownside > 0 ? (μ / σDownside) * annFactor : 0;

    // ── Calmar ────────────────────────────────────────────────────────────────
    const calmar = equityData.maxDrawdownPct > 0
        ? equityData.cagrPct / equityData.maxDrawdownPct
        : 0;

    // ── Omega (threshold = 0) ─────────────────────────────────────────────────
    //    Ω = Σmax(r,0) / Σmax(-r,0)  — continuous analogue of Profit Factor
    const posSum = dailyR.reduce((s, r) => s + Math.max(r, 0), 0);
    const negSum = dailyR.reduce((s, r) => s + Math.max(-r, 0), 0);
    const omega  = negSum > 0 ? posSum / negSum : posSum > 0 ? 999 : 1;

    // ── Tail Ratio ────────────────────────────────────────────────────────────
    //    P95 / |P5| — right tail vs left tail magnitude
    const sortedR    = [...dailyR].sort((a, b) => a - b);
    const p95        = _percentile(sortedR, 95);
    const p5         = _percentile(sortedR, 5);
    const tailRatio  = Math.abs(p5) > 0.00001 ? p95 / Math.abs(p5) : 0;

    // ── Gain-to-Pain (Schwager) ───────────────────────────────────────────────
    //    Sum of all returns / |Sum of all negative returns|
    const totalReturn = dailyR.reduce((s, r) => s + r, 0);
    const totalPain   = Math.abs(dailyR.filter(r => r < 0).reduce((s, r) => s + r, 0));
    const gainToPain  = totalPain > 0 ? totalReturn / totalPain : totalReturn > 0 ? 999 : 0;

    // ── Sterling Ratio ────────────────────────────────────────────────────────
    //    CAGR / Avg Annual Drawdown (simplified to maxDD for <1yr track records)
    const sterling = equityData.maxDrawdownPct > 0
        ? equityData.cagrPct / equityData.maxDrawdownPct
        : 0;

    // ── Recovery Factor ───────────────────────────────────────────────────────
    const recoveryFactor = equityData.maxDrawdownPct > 0
        ? equityData.simpleReturnPct / equityData.maxDrawdownPct
        : 0;

    return {
        sharpeAnnualized:   _f(sharpe,       3),
        sortinoAnnualized:  _f(sortino,      3),
        calmarRatio:        _f(calmar,       3),
        omegaRatio:         _f(omega,        3),
        tailRatio:          _f(tailRatio,    3),
        gainToPainRatio:    _f(gainToPain,   3),
        sterlingRatio:      _f(sterling,     3),
        recoveryFactor:     _f(recoveryFactor, 3),
    };
}

// ══════════════════════════════════════════════════════════════
// SECTION 6 — POSITION SIZING
// ══════════════════════════════════════════════════════════════

function _computePositionSizing(tradeStats) {
    const W = tradeStats.winRatePct / 100;
    const R = tradeStats.riskRewardRatio;

    // Full Kelly: fraction of capital to bet for max geometric growth
    // K = W - (1-W)/R  =  (W*(R+1) - 1) / R
    const fullKelly = W > 0 && R > 0
        ? Math.max((W * (R + 1) - 1) / R, 0)
        : 0;

    // Conservative fractions
    const halfKelly    = fullKelly * 0.5;
    const quarterKelly = fullKelly * 0.25;

    // Optimal-f (Ralph Vince, 1990)
    // Grid search for f* that maximises geometric mean HPR on actual PnL distribution.
    // We use the tradeStats values since we don't have raw pnl array here.
    // For the full grid search, pass actual pnl values.
    const optimalF = _gridSearchOptimalF(W, R);

    return {
        fullKellyPct:    _f(Math.min(fullKelly    * 100, 100)),
        halfKellyPct:    _f(Math.min(halfKelly    * 100, 100)),
        quarterKellyPct: _f(Math.min(quarterKelly * 100, 100)),
        optimalFPct:     _f(Math.min(optimalF     * 100, 100)),
    };
}

/**
 * Grid search implementation of Vince's Optimal-f.
 * For a simplified binary W/R distribution, searches f ∈ [0,1] at 0.01 step.
 * Maximises the Geometric Mean HPR: E[ln(1 + f * r / |worstLoss|)]
 */
function _gridSearchOptimalF(winRate, rr) {
    if (!winRate || !rr || winRate <= 0 || rr <= 0) return 0;

    // Synthesise a representative trade distribution (1000 trials)
    const trades = [];
    const n = 1000;
    for (let i = 0; i < Math.round(n * winRate); i++) trades.push(rr);
    for (let i = 0; i < Math.round(n * (1 - winRate)); i++) trades.push(-1);
    if (!trades.length) return 0;

    const worstLoss = 1; // normalised
    let bestF = 0, bestGMR = -Infinity;

    for (let f = 0.01; f <= 1.0; f += 0.01) {
        let logSum = 0;
        let valid  = true;

        for (const r of trades) {
            const hpr = 1 + (f * r / worstLoss);
            if (hpr <= 0) { valid = false; break; }
            logSum += Math.log(hpr);
        }

        if (!valid) break; // increasing f will only make it worse
        const gmr = logSum / trades.length;
        if (gmr > bestGMR) { bestGMR = gmr; bestF = f; }
    }

    return bestF;
}

// ══════════════════════════════════════════════════════════════
// SECTION 7 — BEHAVIORAL ANALYSIS
// ══════════════════════════════════════════════════════════════

function _computeBehavioral(allTrades, closeTrades, daysActive) {
    const sorted = [...closeTrades].sort((a, b) => a.createdAt - b.createdAt);

    // ── Overtrading Score (0 = calm, 100 = extreme overtrading) ───────────────
    const tradesPerDay  = closeTrades.length / Math.max(daysActive, 1);
    const freqScore     = Math.min(tradesPerDay / 20, 1); // 20 trades/day = max

    // Inter-trade interval Coefficient of Variation (measures erratic timing)
    const intervals = [];
    for (let i = 1; i < sorted.length; i++) {
        intervals.push((sorted[i].createdAt - sorted[i - 1].createdAt) / 60_000); // minutes
    }
    const avgInterval = _avg(intervals);
    const stdInterval = _std(intervals, avgInterval);
    const cv          = avgInterval > 0 ? stdInterval / avgInterval : 0;
    const cvScore     = Math.min(cv / 3, 1); // CV of 3 = max

    const overtradingScore = Math.round((freqScore * 0.6 + cvScore * 0.4) * 100);

    // ── Revenge Trade Detection ────────────────────────────────────────────────
    //    A revenge trade = an OPEN within 15 minutes of a losing CLOSE
    const REVENGE_WINDOW_MS = 15 * 60_000;
    const openTrades        = allTrades.filter(t => t.isOpen).sort((a, b) => a.createdAt - b.createdAt);
    const losingCloses      = sorted.filter(t => t.netPnl <= 0);

    let revengeCount = 0;
    for (const loss of losingCloses) {
        const hasRevenge = openTrades.some(o =>
            o.createdAt > loss.createdAt &&
            o.createdAt <= loss.createdAt + REVENGE_WINDOW_MS
        );
        if (hasRevenge) revengeCount++;
    }

    const revengeTradeRatePct = losingCloses.length > 0
        ? (revengeCount / losingCloses.length) * 100
        : 0;

    // ── Activity distribution ─────────────────────────────────────────────────
    const dayBuckets = new Map();
    for (const t of sorted) {
        const d   = new Date(t.createdAt);
        const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
        dayBuckets.set(key, (dayBuckets.get(key) || 0) + 1);
    }
    const tradeCounts    = Array.from(dayBuckets.values());
    const busiestDayTrades = tradeCounts.length ? Math.max(...tradeCounts) : 0;

    return {
        avgTradesPerDay:      _f(tradesPerDay, 2),
        busiestDayTrades,
        overtradingScore,
        revengeTrades:        revengeCount,
        revengeTradeRatePct:  _f(revengeTradeRatePct),
        liquidationCount:     closeTrades.filter(t => t.isLiquidation).length,
    };
}

// ══════════════════════════════════════════════════════════════
// SECTION 8 — DISTRIBUTION STATISTICS
// ══════════════════════════════════════════════════════════════

function _computeDistribution(dailyR) {
    if (dailyR.length < 3) return _emptyDistribution();

    const μ  = _avg(dailyR);
    const σ  = _std(dailyR, μ);
    const S  = _skewness(dailyR, μ, σ);
    const K  = _kurtosis(dailyR, μ, σ);  // excess kurtosis

    // Fat-tail coefficient: CVaR / VaR ratio
    // Ratio > 1 means the tail is heavier than a normal distribution predicts
    const sorted   = [...dailyR].sort((a, b) => a - b);
    const var5pct  = _percentile(sorted, 5);
    const cutoff   = Math.max(Math.floor(dailyR.length * 0.05), 1);
    const tailMean = _avg(sorted.slice(0, cutoff));
    const fatTailCoefficient = var5pct < 0
        ? Math.abs(tailMean / var5pct)
        : 1;

    // 20-bin return histogram (as % returns)
    const pctReturns = dailyR.map(r => r * 100);
    const histogram  = _buildHistogram(pctReturns, 20);

    return {
        skewness:            _f(S, 4),
        excessKurtosis:      _f(K, 4),
        fatTailCoefficient:  _f(fatTailCoefficient, 3),
        returnHistogram:     histogram,
    };
}

function _buildHistogram(values, numBins) {
    if (!values.length) return [];
    const min  = Math.min(...values);
    const max  = Math.max(...values);
    const range = max - min;
    if (range === 0) return [{ bucketMin: min, bucketMax: max, count: values.length, frequency: 1 }];

    const binWidth = range / numBins;
    const bins = Array.from({ length: numBins }, (_, i) => ({
        bucketMin:  _f(min + i * binWidth),
        bucketMax:  _f(min + (i + 1) * binWidth),
        count:      0,
        frequency:  0,
    }));

    for (const v of values) {
        const idx = Math.min(Math.floor((v - min) / binWidth), numBins - 1);
        bins[idx].count++;
    }

    for (const bin of bins) {
        bin.frequency = _f(bin.count / values.length, 4);
    }

    return bins;
}

// ══════════════════════════════════════════════════════════════
// SECTION 9 — STREAK ANALYSIS
// ══════════════════════════════════════════════════════════════

function _computeStreaks(closeTrades) {
    if (!closeTrades.length) return _emptyStreaks();

    const sorted = [...closeTrades].sort((a, b) => a.createdAt - b.createdAt);

    let maxWin  = 0, maxLose = 0;
    let curWin  = 0, curLose = 0;
    const winStreakLengths  = [];
    const loseStreakLengths = [];

    for (const t of sorted) {
        if (t.netPnl > 0) {
            curWin++;
            if (curLose > 0) { loseStreakLengths.push(curLose); curLose = 0; }
        } else {
            curLose++;
            if (curWin > 0) { winStreakLengths.push(curWin); curWin = 0; }
        }
        maxWin  = Math.max(maxWin,  curWin);
        maxLose = Math.max(maxLose, curLose);
    }

    if (curWin  > 0) winStreakLengths.push(curWin);
    if (curLose > 0) loseStreakLengths.push(curLose);

    // Current streak: positive = win streak, negative = lose streak
    let currentStreak = 0;
    for (const t of [...sorted].reverse()) {
        if (currentStreak === 0) {
            currentStreak = t.netPnl > 0 ? 1 : -1;
        } else if (currentStreak > 0 && t.netPnl > 0) {
            currentStreak++;
        } else if (currentStreak < 0 && t.netPnl <= 0) {
            currentStreak--;
        } else {
            break;
        }
    }

    return {
        maxWinStreak:        maxWin,
        maxLoseStreak:       maxLose,
        currentStreak,
        avgWinStreakLength:  _f(_avg(winStreakLengths),  1),
        avgLoseStreakLength: _f(_avg(loseStreakLengths), 1),
    };
}

// Internal helper for riskMetrics (doesn't need full streak analysis)
function _streakCounts(closeTrades) {
    let maxWinStreak = 0, maxLoseStreak = 0;
    let curW = 0, curL = 0;
    for (const t of closeTrades) {
        if (t.netPnl > 0) { curW++; curL = 0; }
        else               { curL++; curW = 0; }
        maxWinStreak  = Math.max(maxWinStreak,  curW);
        maxLoseStreak = Math.max(maxLoseStreak, curL);
    }
    return { maxWinStreak, maxLoseStreak };
}

// ══════════════════════════════════════════════════════════════
// SECTION 10 — PER-SYMBOL BREAKDOWN
// ══════════════════════════════════════════════════════════════

function _computePerSymbol(closeTrades) {
    const map = new Map();

    for (const t of closeTrades) {
        if (!map.has(t.symbol)) map.set(t.symbol, { trades: 0, wins: 0, totalPnl: 0, totalFees: 0 });
        const s = map.get(t.symbol);
        s.trades++;
        if (t.netPnl > 0) s.wins++;
        s.totalPnl   += t.netPnl;
        s.totalFees  += t.fee;
    }

    const totalAbsPnl = Array.from(map.values()).reduce((s, v) => s + Math.abs(v.totalPnl), 0);

    return Array.from(map.entries())
        .map(([symbol, s]) => ({
            symbol,
            trades:              s.trades,
            winRatePct:          _f((s.wins / s.trades) * 100),
            totalNetPnlUsdc:     _f(s.totalPnl),
            totalFeesUsdc:       _f(s.totalFees),
            pnlContributionPct:  _f(totalAbsPnl > 0 ? (s.totalPnl / totalAbsPnl) * 100 : 0),
        }))
        .sort((a, b) => Math.abs(b.totalNetPnlUsdc) - Math.abs(a.totalNetPnlUsdc))
        .slice(0, 10);
}

// ══════════════════════════════════════════════════════════════
// SECTION 11 — FUNDING SUMMARY
// ══════════════════════════════════════════════════════════════

function _computeFundingSummary(rawFunding) {
    const payouts = rawFunding.map(f => parseFloat(f.payout) || 0);
    const net     = payouts.reduce((a, b) => a + b, 0);
    const received = payouts.filter(p => p > 0).reduce((a, b) => a + b, 0);
    const paid     = Math.abs(payouts.filter(p => p < 0).reduce((a, b) => a + b, 0));

    return {
        totalPayments: payouts.length,
        netFundingUsdc:      _f(net),
        totalReceivedUsdc:   _f(received),
        totalPaidUsdc:       _f(paid),
        avgPayoutUsdc:       _f(payouts.length ? net / payouts.length : 0),
    };
}

// ══════════════════════════════════════════════════════════════
// SECTION 12 — OVERVIEW BUILDER
// ══════════════════════════════════════════════════════════════

function _buildOverview(closeTrades, openTrades, equityData, fundingSummary) {
    const totalFeesPaid = closeTrades.reduce((s, t) => s + t.fee, 0);

    return {
        daysActive:          _f(equityData.daysActive, 1),
        totalTrades:         closeTrades.length,
        openPositions:       openTrades.length,
        startingBalance:     _f(equityData.startBalance),
        currentBalance:      _f(equityData.endBalance),
        peakBalance:         _f(equityData.peakBalance),
        totalDeposited:      _f(equityData.totalDeposited),
        totalWithdrawn:      _f(equityData.totalWithdrawn),
        totalFeesPaid:       _f(totalFeesPaid),
        netFundingPaid:      _f(fundingSummary.netFundingUsdc),
        // Returns — all three for full transparency
        simpleReturnPct:     _f(equityData.simpleReturnPct),   // Pacifica-style
        twrPct:              _f(equityData.twrPct),             // Deposit-adjusted skill measure
        cagrPct:             _f(equityData.cagrPct),            // Annualised
    };
}

// ══════════════════════════════════════════════════════════════
// MATH UTILITIES
// ══════════════════════════════════════════════════════════════

function _sum(arr)  { return arr.reduce((a, b) => a + b, 0); }
function _avg(arr)  { return arr.length ? _sum(arr) / arr.length : 0; }

function _std(arr, mean) {
    const μ = mean !== undefined ? mean : _avg(arr);
    if (arr.length < 2) return 0;
    const variance = arr.reduce((s, v) => s + (v - μ) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
}

function _median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function _skewness(arr, μ, σ) {
    if (!arr.length || σ < 0.000001) return 0;
    return arr.reduce((s, v) => s + ((v - μ) / σ) ** 3, 0) / arr.length;
}

function _kurtosis(arr, μ, σ) {
    // Returns EXCESS kurtosis (normal = 0)
    if (!arr.length || σ < 0.000001) return 0;
    return (arr.reduce((s, v) => s + ((v - μ) / σ) ** 4, 0) / arr.length) - 3;
}

function _percentile(sortedArr, pct) {
    if (!sortedArr.length) return 0;
    const idx = (pct / 100) * (sortedArr.length - 1);
    const lo  = Math.floor(idx);
    const hi  = Math.ceil(idx);
    if (lo === hi) return sortedArr[lo];
    return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

/** Format to N decimal places, returning a plain number */
function _f(val, dec = 2) {
    const n = Number(val);
    return isNaN(n) ? 0 : Number(n.toFixed(dec));
}

// ══════════════════════════════════════════════════════════════
// ZERO-VALUE FALLBACKS
// ══════════════════════════════════════════════════════════════

function _emptyTradeStats() {
    return {
        winRatePct: 0, profitFactor: 0, grossProfitUsdc: 0, grossLossUsdc: 0,
        netPnlUsdc: 0, avgWinUsdc: 0, avgLossUsdc: 0, largestWinUsdc: 0,
        largestLossUsdc: 0, riskRewardRatio: 0, expectancyUsdc: 0,
        expectancyRatio: 0, avgHoldTimeMinutes: 0, medianHoldTimeMinutes: 0,
    };
}

function _emptyRatios() {
    return {
        sharpeAnnualized: 0, sortinoAnnualized: 0, calmarRatio: 0,
        omegaRatio: 0, tailRatio: 0, gainToPainRatio: 0,
        sterlingRatio: 0, recoveryFactor: 0,
    };
}

function _emptyDistribution() {
    return { skewness: 0, excessKurtosis: 0, fatTailCoefficient: 0, returnHistogram: [] };
}

function _emptyStreaks() {
    return { maxWinStreak: 0, maxLoseStreak: 0, currentStreak: 0, avgWinStreakLength: 0, avgLoseStreakLength: 0 };
}

function _emptyMetrics() {
    return {
        overview: {}, tradeStats: _emptyTradeStats(), riskMetrics: {},
        ratios: _emptyRatios(), positionSizing: {}, behavioral: {},
        distribution: _emptyDistribution(), streaks: _emptyStreaks(),
        perSymbol: [], fundingSummary: {},
    };
}

module.exports = { computeAllMetrics };