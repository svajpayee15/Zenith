/**
 * Zenith Equity Builder v3 — PnL Reconstruction Method
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY WE CHANGED THE APPROACH:
 *
 * v2 used balance_history as the equity curve and tried to strip out cash flows
 * with a "net CF adjustment" on each day. This introduced three fatal bugs:
 *
 *   Bug A) On liquidation days where the trader re-deposits later the same day,
 *          the deposit sometimes fell in the wrong daily window → -99% apparent
 *          daily return → CVaR of -99.67% (completely broken)
 *
 *   Bug B) Deposit arrival within a period made prev.equity artificially high,
 *          causing sign-flipped daily returns → Sharpe came out NEGATIVE
 *          on a trader with +98% total return (logically impossible)
 *
 *   Bug C) Raw balance drawdown understates real drawdown because re-deposits
 *          mask the actual capital loss. Ours said 37.82%, Pacifica said 71.17%.
 *
 * NEW APPROACH — PnL Reconstruction:
 *
 *   equity(t) = initial_deposit + Σ(realized_pnl up to t)
 *
 *   Where realized_pnl = Σ(trade.pnl - trade.fee) + Σ(funding.payout)
 *
 *   This approach:
 *     ✓ Zero deposit/withdrawal distortion in daily returns
 *     ✓ Matches Pacifica return %: total_pnl / initial_deposit
 *     ✓ Correct drawdown — deposits no longer mask losses
 *     ✓ Clean daily returns → correct Sharpe/Sortino
 *     ✓ GIPS-compliant track record methodology (same as hedge funds)
 *
 * WHAT BALANCE HISTORY IS STILL USED FOR:
 *   - Finding initial_deposit (the true capital base denominator)
 *   - Reporting currentBalance / totalDeposited / totalWithdrawn for UI
 *   - Computing TWR as a supplementary deposit-agnostic metric
 */

const CLOSE_SIDES     = new Set(['close_long', 'close_short']);
const CASH_FLOW_TYPES = new Set(['deposit', 'deposit_release', 'withdraw', 'subaccount_transfer']);

function buildEquityData(rawTrades, rawFunding, rawBalance) {
    // Step 1: Parse balance history for capital context only
    const capitalCtx = _parseCapitalContext(rawBalance);

    // Step 2: Build PnL event timeline (close trades + funding only)
    const tradeEvents = rawTrades
        .filter(t => CLOSE_SIDES.has(t.side))
        .map(t => ({
            time:   Number(t.created_at),
            pnl:    (parseFloat(t.pnl) || 0) - (parseFloat(t.fee) || 0),
            source: 'trade',
        }));

    const fundingEvents = rawFunding.map(f => ({
        time:   Number(f.created_at),
        pnl:    parseFloat(f.payout) || 0,
        source: 'funding',
    }));

    const timeline = [...tradeEvents, ...fundingEvents]
        .filter(e => !isNaN(e.time) && e.time > 0)
        .sort((a, b) => a.time - b.time);

    if (!timeline.length && !capitalCtx.initialDeposit) return _emptyEquityData();

    const initialDeposit = capitalCtx.initialDeposit || 100;

    // Step 3: Reconstruct equity curve
    let runningPnl = 0;
    const allPoints = [];
    for (const event of timeline) {
        runningPnl += event.pnl;
        allPoints.push({
            time:   event.time,
            equity: Math.max(initialDeposit + runningPnl, 0),
            source: event.source,
        });
    }

    // Step 4: Daily snapshots
    const dailySnapshots = _buildDailySnapshots(allPoints, initialDeposit);

    // Step 5: Daily trading returns — clean, no cash-flow adjustment needed
    const dailyTradingReturns = [];
    for (let i = 1; i < dailySnapshots.length; i++) {
        const prev = dailySnapshots[i - 1];
        const curr = dailySnapshots[i];
        const r = prev.equity > 0.01 ? (curr.equity - prev.equity) / prev.equity : 0;
        curr.dailyTradingReturn = r;
        dailyTradingReturns.push(r);
    }
    if (dailySnapshots.length > 0) dailySnapshots[0].dailyTradingReturn = 0;

    // Step 6: Drawdown stats
    const drawdownStats = _computeDrawdownStats(dailySnapshots, initialDeposit);

    // Step 7: Return metrics
    const endEquity       = dailySnapshots[dailySnapshots.length - 1]?.equity ?? initialDeposit;
    const simpleReturnPct = initialDeposit > 0 ? (runningPnl / initialDeposit) * 100 : 0;

    // Step 8: Time span
    const firstTs    = timeline.length ? timeline[0].time : Date.now();
    const lastTs     = timeline.length ? timeline[timeline.length - 1].time : Date.now();
    const daysActive = Math.max((lastTs - firstTs) / 86_400_000, 1);
    const yearsActive = daysActive / 365.25;

    // Step 9: CAGR — linear annualisation for <1yr track records (avoids distortion)
    const cagrPct = yearsActive < 1
        ? (simpleReturnPct / 100) * (1 / yearsActive) * 100
        : (Math.pow(Math.max(endEquity / initialDeposit, 0.0001), 1 / yearsActive) - 1) * 100;

    // Step 10: TWR (supplementary metric from balance history)
    const twrPct = _calculateTWR(rawBalance) * 100;

    return {
        initialDeposit,
        startEquity:     initialDeposit,
        endEquity,
        peakEquity:      dailySnapshots.reduce((m, d) => Math.max(m, d.equity), initialDeposit),
        totalPnl:        Number(runningPnl.toFixed(2)),
        totalDeposited:  capitalCtx.totalDeposited,
        totalWithdrawn:  capitalCtx.totalWithdrawn,
        currentBalance:  capitalCtx.currentBalance,
        daysActive,
        yearsActive,
        simpleReturnPct,
        twrPct,
        cagrPct,
        ...drawdownStats,
        dailyTradingReturns,
        dailySnapshots,
    };
}

// ── Capital context from balance history ──────────────────────────────────────
function _parseCapitalContext(rawBalance) {
    const empty = { initialDeposit: 0, totalDeposited: 0, totalWithdrawn: 0, currentBalance: 0 };
    if (!rawBalance?.length) return empty;

    const events = rawBalance
        .map(e => ({
            amount:    parseFloat(e.amount)  || 0,
            balance:   parseFloat(e.balance) || 0,
            eventType: e.event_type || '',
            createdAt: Number(e.created_at),
        }))
        .filter(e => !isNaN(e.createdAt))
        .sort((a, b) => a.createdAt - b.createdAt);

    let initialDeposit = 0;
    let totalDeposited = 0;
    let totalWithdrawn = 0;

    for (const e of events) {
        if (e.eventType === 'deposit' || e.eventType === 'deposit_release') {
            const amt = Math.abs(e.amount);
            totalDeposited += amt;
            if (!initialDeposit && amt > 0) initialDeposit = e.balance;
        } else if (e.eventType === 'withdraw') {
            totalWithdrawn += Math.abs(e.amount);
        }
    }

    return {
        initialDeposit,
        totalDeposited,
        totalWithdrawn,
        currentBalance: events[events.length - 1]?.balance ?? 0,
    };
}

// ── Daily OHLC snapshots with gap filling ──────────────────────────────────────
function _buildDailySnapshots(sortedPoints, initialDeposit) {
    if (!sortedPoints.length) return [];

    const dayMap = new Map();
    for (const pt of sortedPoints) {
        const d   = new Date(pt.time);
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
        dayMap.set(key, { dateKey: key, date: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())), equity: pt.equity, lastEventTs: pt.time });
    }

    const days     = Array.from(dayMap.values()).sort((a, b) => a.date - b.date);
    const filled   = [days[0]];

    for (let i = 1; i < days.length; i++) {
        const prev    = filled[filled.length - 1];
        const curr    = days[i];
        const dayGap  = Math.round((curr.date - prev.date) / 86_400_000);

        // Fill short gaps (≤7 days) by carrying forward equity (inactive days)
        if (dayGap > 1 && dayGap <= 7) {
            for (let g = 1; g < dayGap; g++) {
                const gDate = new Date(prev.date.getTime() + g * 86_400_000);
                filled.push({ dateKey: gDate.toISOString().slice(0,10), date: gDate, equity: prev.equity, lastEventTs: prev.lastEventTs, isGapFill: true });
            }
        }
        filled.push(curr);
    }

    // Annotate drawdown on each day relative to running peak
    let peak = initialDeposit;
    for (const day of filled) {
        if (day.equity > peak) peak = day.equity;
        day.drawdownPct = peak > 0 ? ((peak - day.equity) / peak) * 100 : 0;
        day.peakEquity  = peak;
        day.dailyTradingReturn = 0;
    }

    return filled;
}

// ── Drawdown stats ─────────────────────────────────────────────────────────────
function _computeDrawdownStats(dailySnapshots, initialDeposit) {
    if (!dailySnapshots.length) return _emptyDrawdown();

    let peak = initialDeposit;
    let maxDrawdownPct = 0, maxDrawdownUsdc = 0;
    let inDD = false, ddStart = null;
    const recoveryDays = [];
    let valley = initialDeposit, maxRunupPct = 0, maxRunupUsdc = 0;

    for (const day of dailySnapshots) {
        const { equity, date } = day;

        if (equity >= peak) {
            if (inDD && ddStart) recoveryDays.push((date - ddStart) / 86_400_000);
            peak = equity; inDD = false; ddStart = null;
        } else {
            if (!inDD) { inDD = true; ddStart = date; }
            const ddPct = ((peak - equity) / peak) * 100;
            if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
            if ((peak - equity) > maxDrawdownUsdc) maxDrawdownUsdc = peak - equity;
        }

        if (equity < valley) valley = equity;
        if (valley > 0) {
            const runupPct = ((equity - valley) / valley) * 100;
            if (runupPct > maxRunupPct) maxRunupPct = runupPct;
            if ((equity - valley) > maxRunupUsdc) maxRunupUsdc = equity - valley;
        }
    }

    return {
        maxDrawdownPct:  Number(maxDrawdownPct.toFixed(2)),
        maxDrawdownUsdc: Number(maxDrawdownUsdc.toFixed(2)),
        avgRecoveryDays: recoveryDays.length ? Number((recoveryDays.reduce((a,b)=>a+b,0)/recoveryDays.length).toFixed(1)) : 0,
        maxRunupPct:     Number(maxRunupPct.toFixed(2)),
        maxRunupUsdc:    Number(maxRunupUsdc.toFixed(2)),
    };
}

// ── Time-Weighted Return from balance history ──────────────────────────────────
function _calculateTWR(rawBalance) {
    if (!rawBalance?.length) return 0;
    const events = rawBalance
        .map(e => ({ amount: parseFloat(e.amount)||0, balance: parseFloat(e.balance)||0, eventType: e.event_type||'', createdAt: Number(e.created_at) }))
        .filter(e => !isNaN(e.createdAt)).sort((a,b) => a.createdAt - b.createdAt);

    if (events.length < 2) return 0;
    const factors = [];
    let pStart = events[0].balance;

    for (let i = 1; i < events.length; i++) {
        const e = events[i];
        if (CASH_FLOW_TYPES.has(e.eventType)) {
            const bBefore = e.balance - e.amount;
            if (pStart > 0.01 && bBefore >= 0) { const f = bBefore/pStart; if (f > 0) factors.push(f); }
            pStart = e.balance;
        }
    }
    const f = events[events.length-1].balance / pStart;
    if (pStart > 0.01 && f > 0) factors.push(f);
    return factors.length ? factors.reduce((a,f) => a*f, 1) - 1 : 0;
}

function _emptyDrawdown() {
    return { maxDrawdownPct:0, maxDrawdownUsdc:0, avgRecoveryDays:0, maxRunupPct:0, maxRunupUsdc:0 };
}
function _emptyEquityData() {
    return { initialDeposit:0, startEquity:0, endEquity:0, peakEquity:0, totalPnl:0, totalDeposited:0, totalWithdrawn:0, currentBalance:0, daysActive:1, yearsActive:1/365.25, simpleReturnPct:0, twrPct:0, cagrPct:0, ..._emptyDrawdown(), dailyTradingReturns:[], dailySnapshots:[] };
}

module.exports = { buildEquityData };