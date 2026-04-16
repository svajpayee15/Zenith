/**
 * Zenith Quant Engine v2.0 — Institutional Grade
 * ═══════════════════════════════════════════════
 *
 * Architecture:
 *   networkLayer   → cursor-paginated API fetcher with proactive rate limiting
 *   equityBuilder  → ground-truth equity curve from /account/balance/history
 *   metricsEngine  → full metric suite (10 categories, 60+ metrics)
 *   zenithScorer   → composite 0–1000 score + tier
 *
 * Key fixes vs v1:
 *   ✓  Sharpe uses DAILY balance-history returns (not per-trade) — eliminates √N inflation
 *   ✓  Starting equity = actual first deposit (no synthetic baseline)
 *   ✓  Return% = real simpleReturn + TWR + CAGR (3 views, not 1 fabricated one)
 *   ✓  Fee = actual `fee` field from API, not estimated notional % 
 *   ✓  Drawdown = from true equity curve, not trade reconstruction
 */
const { fetchPaginatedData } = require('./NetworkLayer.js');
const { buildEquityData } = require('./EquityBuilder.js');
const { computeAllMetrics } = require('./MetricsEngine.js');
const { computeZenithScore } = require('./ZenithScorer.js');

const BASE    = 'https://api.pacifica.fi/api/v1';
const LIMIT   = 10000; // Max records per request — minimise pagination round-trips

/**
 * Main entry point.
 *
 * @param {string} walletAddress — Solana wallet address
 * @returns {Promise<Object>}    — Full analysis result (ready to persist to MongoDB)
 */
async function runZenithEngine(walletAddress) {
    console.log(`\n[Zenith v2] ═══ Starting analysis: ${walletAddress} ═══`);
    const t0 = Date.now();

    try {
        // ── Phase 1: Parallel data acquisition ──────────────────────────────────
        // All three endpoints are fetched in parallel; each handles its own pagination.
        console.log('[Zenith] Phase 1 — Fetching trades, funding, balance history...');
        const [rawTrades, rawFunding, rawBalance] = await Promise.all([
            fetchPaginatedData(`${BASE}/trades/history?account=${walletAddress}&limit=${LIMIT}`),
            fetchPaginatedData(`${BASE}/funding/history?account=${walletAddress}&limit=${LIMIT}`),
            fetchPaginatedData(`${BASE}/account/balance/history?account=${walletAddress}&limit=${LIMIT}`),
        ]);

        console.log(`[Zenith] Fetched: ${rawTrades.length} trades | ${rawFunding.length} funding | ${rawBalance.length} balance events`);

        if (!rawBalance.length && !rawTrades.length) {
            return { error: 'No trading history found for this wallet. Account is dormant.' };
        }

        // ── Phase 2: Equity foundation ───────────────────────────────────────────
        // Constructs the ground-truth equity curve from balance history.
        // All equity-based metrics (Sharpe, Sortino, Drawdown, Returns) flow from here.
        console.log('[Zenith] Phase 2 — Building equity curve...');
        const equityData = buildEquityData(rawBalance, rawFunding);

        // ── Phase 3: Full metric computation ─────────────────────────────────────
        console.log('[Zenith] Phase 3 — Computing metrics...');
        const metrics = computeAllMetrics(rawTrades, rawFunding, equityData);

        // ── Phase 4: Zenith scoring ───────────────────────────────────────────────
        console.log('[Zenith] Phase 4 — Scoring...');
        const scoring = computeZenithScore(metrics);

        const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
        console.log(`[Zenith] ✓ Complete in ${elapsed}s | Score: ${scoring.zenithScore} | Tier: ${scoring.tier}\n`);

        return {
            wallet:            walletAddress,
            analysisTimestamp: new Date().toISOString(),
            scoring,
            metrics,
            equityCurve:       equityData.dailySnapshots,  // Downsampled daily snapshots for charting
        };

    } catch (err) {
        console.error(`[Zenith] Fatal error for ${walletAddress}:`, err);
        return { error: `Engine failure: ${err.message}` };
    }
}

module.exports = { runZenithEngine }