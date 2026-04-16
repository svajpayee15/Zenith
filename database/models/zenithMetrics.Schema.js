'use strict';

// File: database/models/zenithMetrics.schema.js
const mongoose = require("mongoose");

// ── Histogram bin (20 bins of daily return distribution) ──────────────────────
const HistogramBinSchema = new mongoose.Schema({
    bucketMin:  { type: Number, default: 0 },
    bucketMax:  { type: Number, default: 0 },
    count:      { type: Number, default: 0 },
    frequency:  { type: Number, default: 0 },
}, { _id: false });

// ── Per-symbol breakdown (top 10 by absolute PnL) ────────────────────────────
const PerSymbolSchema = new mongoose.Schema({
    symbol:              { type: String },
    trades:              { type: Number, default: 0 },
    winRatePct:          { type: Number, default: 0 },
    totalNetPnlUsdc:     { type: Number, default: 0 },
    totalFeesUsdc:       { type: Number, default: 0 },
    pnlContributionPct:  { type: Number, default: 0 },
}, { _id: false });

// ── Scoring breakdown (for UI transparency) ───────────────────────────────────
const ScoringBreakdownSchema = new mongoose.Schema({
    components: {
        sharpe:  { type: Number, default: 0 },
        calmar:  { type: Number, default: 0 },
        pf:      { type: Number, default: 0 },
        omega:   { type: Number, default: 0 },
        winRate: { type: Number, default: 0 },
    },
    penalties: {
        tradeConfidence: { type: Number, default: 0 },
        drawdown:        { type: Number, default: 0 },
        liquidation:     { type: Number, default: 0 },
        overtrading:     { type: Number, default: 0 },
    },
}, { _id: false });

// ══════════════════════════════════════════════════════════════════════════════
// ZENITH METRICS — MASTER SUB-SCHEMA
// Mirrors the exact output shape of runZenithEngine() → computeAllMetrics()
// Used both in Trader (live metrics) and CopyTrading (snapshot at copy-time)
// ══════════════════════════════════════════════════════════════════════════════

const zenithMetricsSchema = new mongoose.Schema({

    // ── Leaderboard ────────────────────────────────────────────────────────────
    leaderboard: {
        zenithScore:      { type: Number, default: 0, min: 0, max: 1000 },
        rankTier:         { type: String, enum: ["S", "A", "B", "C", "D"], default: "D" },
        scoringBreakdown: { type: ScoringBreakdownSchema, default: () => ({}) },
    },

    // ── Overview ───────────────────────────────────────────────────────────────
    overview: {
        daysActive:          { type: Number, default: 0 },
        totalTrades:         { type: Number, default: 0 },
        openPositions:       { type: Number, default: 0 },
        startingBalance:     { type: Number, default: 0 },   // USDC — first real deposit
        currentBalance:      { type: Number, default: 0 },   // USDC
        peakBalance:         { type: Number, default: 0 },   // USDC — all-time high
        totalDeposited:      { type: Number, default: 0 },   // USDC
        totalWithdrawn:      { type: Number, default: 0 },   // USDC
        totalFeesPaid:       { type: Number, default: 0 },   // USDC
        netFundingPaid:      { type: Number, default: 0 },   // USDC (negative = net payer)
        // Three return views — all stored for full transparency
        simpleReturnPct:     { type: Number, default: 0 },   // (end-start)/start — matches Pacifica
        twrPct:              { type: Number, default: 0 },   // Time-Weighted Return — deposit-agnostic
        cagrPct:             { type: Number, default: 0 },   // Compounded Annual Growth Rate
    },

    // ── Trade Statistics ───────────────────────────────────────────────────────
    tradeStats: {
        winRatePct:              { type: Number, default: 0 },
        profitFactor:            { type: Number, default: 0 },
        grossProfitUsdc:         { type: Number, default: 0 },
        grossLossUsdc:           { type: Number, default: 0 },
        netPnlUsdc:              { type: Number, default: 0 },
        avgWinUsdc:              { type: Number, default: 0 },
        avgLossUsdc:             { type: Number, default: 0 },
        largestWinUsdc:          { type: Number, default: 0 },
        largestLossUsdc:         { type: Number, default: 0 },
        riskRewardRatio:         { type: Number, default: 0 },
        expectancyUsdc:          { type: Number, default: 0 },   // Expected USDC per trade
        expectancyRatio:         { type: Number, default: 0 },   // Normalised by avg loss
        avgHoldTimeMinutes:      { type: Number, default: 0 },
        medianHoldTimeMinutes:   { type: Number, default: 0 },
    },

    // ── Risk Metrics ───────────────────────────────────────────────────────────
    riskMetrics: {
        maxDrawdownPct:      { type: Number, default: 0 },
        maxDrawdownUsdc:     { type: Number, default: 0 },
        avgRecoveryDays:     { type: Number, default: 0 },
        maxRunupPct:         { type: Number, default: 0 },
        var95DailyPct:       { type: Number, default: 0 },   // Cornish-Fisher 1-day 95% VaR
        cvar95DailyPct:      { type: Number, default: 0 },   // Expected Shortfall
        maxLosingStreak:     { type: Number, default: 0 },
        maxWinningStreak:    { type: Number, default: 0 },
        liquidationCount:    { type: Number, default: 0 },
    },

    // ── Ratios ─────────────────────────────────────────────────────────────────
    ratios: {
        sharpeAnnualized:    { type: Number, default: 0 },   // Daily return basis — NOT per-trade
        sortinoAnnualized:   { type: Number, default: 0 },
        calmarRatio:         { type: Number, default: 0 },
        omegaRatio:          { type: Number, default: 0 },
        tailRatio:           { type: Number, default: 0 },
        gainToPainRatio:     { type: Number, default: 0 },
        sterlingRatio:       { type: Number, default: 0 },
        recoveryFactor:      { type: Number, default: 0 },
    },

    // ── Position Sizing ────────────────────────────────────────────────────────
    positionSizing: {
        fullKellyPct:        { type: Number, default: 0 },
        halfKellyPct:        { type: Number, default: 0 },
        quarterKellyPct:     { type: Number, default: 0 },
        optimalFPct:         { type: Number, default: 0 },   // Vince Optimal-f via grid search
    },

    // ── Behavioral ─────────────────────────────────────────────────────────────
    behavioral: {
        avgTradesPerDay:       { type: Number, default: 0 },
        busiestDayTrades:      { type: Number, default: 0 },
        overtradingScore:      { type: Number, default: 0 },   // 0 (calm) → 100 (extreme)
        revengeTrades:         { type: Number, default: 0 },   // Opens within 15min of a loss
        revengeTradeRatePct:   { type: Number, default: 0 },
        liquidationCount:      { type: Number, default: 0 },
    },

    // ── Distribution Statistics ────────────────────────────────────────────────
    distribution: {
        skewness:            { type: Number, default: 0 },
        excessKurtosis:      { type: Number, default: 0 },   // kurtosis - 3  (normal = 0)
        fatTailCoefficient:  { type: Number, default: 0 },   // CVaR/VaR — >1 means fat tails
        returnHistogram:     { type: [HistogramBinSchema], default: [] },  // 20-bin daily returns
    },

    // ── Streak Analysis ────────────────────────────────────────────────────────
    streaks: {
        maxWinStreak:         { type: Number, default: 0 },
        maxLoseStreak:        { type: Number, default: 0 },
        currentStreak:        { type: Number, default: 0 },   // +N = win streak, -N = lose streak
        avgWinStreakLength:    { type: Number, default: 0 },
        avgLoseStreakLength:   { type: Number, default: 0 },
    },

    // ── Per-Symbol Breakdown (top 10 by |PnL|) ────────────────────────────────
    perSymbol: { type: [PerSymbolSchema], default: [] },

    // ── Funding Summary ────────────────────────────────────────────────────────
    fundingSummary: {
        totalPayments:       { type: Number, default: 0 },
        netFundingUsdc:      { type: Number, default: 0 },
        totalReceivedUsdc:   { type: Number, default: 0 },
        totalPaidUsdc:       { type: Number, default: 0 },
        avgPayoutUsdc:       { type: Number, default: 0 },
    },

    // ── Engine metadata ────────────────────────────────────────────────────────
    lastEngineRun: { type: Date, default: Date.now },

}, { _id: false });

// Export schema only — NOT a model (this is a sub-document used by Trader + CopyTrading)
module.exports = zenithMetricsSchema;