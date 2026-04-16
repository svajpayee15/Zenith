'use strict';

/**
 * Zenith Scorer
 *
 * Produces a single composite 0–1000 score from all metric categories.
 * Designed for hackathon leaderboard differentiation.
 *
 * Components (weights):
 *   30% — Sharpe Ratio     (risk-adjusted daily returns — most robust signal)
 *   25% — Calmar Ratio     (CAGR vs max drawdown — capital preservation)
 *   20% — Profit Factor    (raw edge — does their strategy have positive expectancy)
 *   15% — Omega Ratio      (full return distribution quality)
 *   10% — Win Rate         (consistency, secondary to PF)
 *
 * Penalty multipliers applied after:
 *   - Trade count     → penalises insufficient statistical significance
 *   - Max drawdown    → severe ruin risk penalty
 *   - Liquidations    → compounding penalty per liquidation event
 *   - Overtrading     → gamma-style decay for extreme overtraders
 *
 * Tier thresholds:
 *   S  (Elite)     — 750+
 *   A  (Advanced)  — 550–749
 *   B  (Solid)     — 350–549
 *   C  (Developing)— 150–349
 *   D  (Risky)     — 0–149
 */

function computeZenithScore(metrics) {
    const { tradeStats, ratios, riskMetrics, behavioral, overview } = metrics;

    const sharpe      = ratios?.sharpeAnnualized ?? 0;
    const calmar      = ratios?.calmarRatio      ?? 0;
    const pf          = tradeStats?.profitFactor ?? 0;
    const omega       = ratios?.omegaRatio       ?? 0;
    const winRate     = (tradeStats?.winRatePct  ?? 0) / 100;
    const maxDD       = riskMetrics?.maxDrawdownPct ?? 0;
    const liqCount    = riskMetrics?.liquidationCount ?? 0;
    const tradeCount  = overview?.totalTrades ?? 0;
    const overtrade   = behavioral?.overtradingScore ?? 0;

    // ── Normalize each component to [0, 1] ─────────────────────────────────────
    // Target ceiling: top-1% crypto perp trader
    const sharpeNorm  = _clamp(sharpe  / 3.0, 0, 1);   // 3.0  → S-tier Sharpe
    const calmarNorm  = _clamp(calmar  / 5.0, 0, 1);   // 5.0  → excellent Calmar
    const pfNorm      = _clamp((pf - 1) / 2.5, 0, 1);  // PF 3.5 → full score
    const omegaNorm   = _clamp((omega - 1) / 3.0, 0, 1); // Omega 4 → full score
    const winRateNorm = _clamp((winRate - 0.3) / 0.4, 0, 1); // 70%+ → full score

    // ── Weighted composite ────────────────────────────────────────────────────
    const rawScore = (
        sharpeNorm  * 0.30 +
        calmarNorm  * 0.25 +
        pfNorm      * 0.20 +
        omegaNorm   * 0.15 +
        winRateNorm * 0.10
    );

    // ── Statistical confidence multiplier ────────────────────────────────────
    // Needs 50+ trades for full credit; 10 trades = 20% score
    const tradeConfidence = _clamp(tradeCount / 50, 0.05, 1);

    // ── Drawdown penalty ─────────────────────────────────────────────────────
    // >90% drawdown = ruin territory → hard cap at 40% score
    // >70% drawdown = severe penalty
    const ddPenalty = maxDD > 90 ? 0.40
                    : maxDD > 70 ? 0.65
                    : maxDD > 50 ? 0.85
                    : 1.0;

    // ── Liquidation penalty ──────────────────────────────────────────────────
    // Each liquidation decays score by 15% (compounding)
    const liqPenalty = Math.pow(0.85, liqCount);

    // ── Overtrading penalty ──────────────────────────────────────────────────
    // Score > 80 starts penalising (erratic, likely emotion-driven)
    const overtradePenalty = overtrade > 80 ? 0.80
                           : overtrade > 60 ? 0.92
                           : 1.0;

    // ── Final score ───────────────────────────────────────────────────────────
    const zenithScore = Math.round(
        _clamp(rawScore * 1000 * tradeConfidence * ddPenalty * liqPenalty * overtradePenalty, 0, 1000)
    );

    const tier = zenithScore >= 750 ? 'S'
               : zenithScore >= 550 ? 'A'
               : zenithScore >= 350 ? 'B'
               : zenithScore >= 150 ? 'C'
               : 'D';

    // Diagnostic breakdown (useful for debugging and UI display)
    const breakdown = {
        components: {
            sharpe:  _pct(sharpeNorm  * 0.30 * 100),
            calmar:  _pct(calmarNorm  * 0.25 * 100),
            pf:      _pct(pfNorm      * 0.20 * 100),
            omega:   _pct(omegaNorm   * 0.15 * 100),
            winRate: _pct(winRateNorm * 0.10 * 100),
        },
        penalties: {
            tradeConfidence: _pct(tradeConfidence),
            drawdown:        _pct(ddPenalty),
            liquidation:     _pct(liqPenalty),
            overtrading:     _pct(overtradePenalty),
        },
    };

    return { zenithScore, tier, breakdown };
}

function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function _pct(v) { return Number(v.toFixed(3)); }

module.exports = { computeZenithScore };