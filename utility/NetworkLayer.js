
/**
 * Zenith Network Layer
 * Cursor-paginated fetcher with proactive rate-limit awareness.
 * Reads Pacifica's `ratelimit` response header to avoid hammering the API.
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Fetches ALL pages from a Pacifica paginated endpoint.
 * Uses limit=10000 per request to minimise round-trips.
 *
 * @param {string} baseUrl  Full URL including `limit=10000` and all other params
 * @returns {Promise<Array>} Flat array of all records across pages
 */
async function fetchPaginatedData(baseUrl) {
    const allData  = [];
    let cursor     = null;
    let hasMore    = true;
    let retries    = 0;
    const MAX_RETRIES = 6;

    while (hasMore) {
        const url = cursor
            ? `${baseUrl}&cursor=${encodeURIComponent(cursor)}`
            : baseUrl;

        let res;
        try {
            res = await fetch(url);
        } catch (netErr) {
            console.error(`[Network] Connection error — ${_label(baseUrl)}: ${netErr.message}`);
            break;
        }

        // ── Rate-limit header parsing ──────────────────────────────────────
        // Pacifica format: "r=1200, t=30"  (r = remaining credits, t = seconds to reset)
        const rlHdr     = res.headers.get('ratelimit') || '';
        const remaining = _parseRL(rlHdr, 'r', 100);
        const resetSec  = _parseRL(rlHdr, 't', 10);

        // ── 429 handling with exponential back-off ─────────────────────────
        if (res.status === 429) {
            retries++;
            if (retries > MAX_RETRIES) {
                console.error(`[Network] Max retries (${MAX_RETRIES}) hit — aborting ${_label(baseUrl)}`);
                break;
            }
            const waitMs = (resetSec * 1000) + 1500;
            console.warn(`[Network] 429 — waiting ${resetSec}s (attempt ${retries}/${MAX_RETRIES})`);
            await sleep(waitMs);
            continue;
        }

        if (!res.ok) {
            console.error(`[Network] HTTP ${res.status} on ${_label(baseUrl)}`);
            break;
        }

        retries = 0; // reset after a successful response

        let json;
        try {
            json = await res.json();
        } catch (parseErr) {
            console.error(`[Network] JSON parse failure: ${parseErr.message}`);
            break;
        }

        if (!json?.success || !Array.isArray(json.data)) {
            console.warn(`[Network] Unexpected payload shape from ${_label(baseUrl)}`);
            break;
        }

        allData.push(...json.data);

        hasMore = json.has_more === true;
        cursor  = json.next_cursor || null;

        if (hasMore) {
            // Proactive throttle: if credits are nearly exhausted, wait for bucket refill
            const pause = remaining <= 20
                ? (resetSec * 1000) + 500   // proactive full refill wait
                : 150;                       // polite inter-request gap
            await sleep(pause);
        }
    }

    console.log(`[Network] ✓ Fetched ${allData.length} records — ${_label(baseUrl)}`);
    return allData;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _parseRL(header, key, fallback) {
    const m = header.match(new RegExp(`${key}=(\\d+)`));
    return m ? parseInt(m[1], 10) : fallback;
}

function _label(url) {
    // Extract the endpoint path for clean log lines
    try { return new URL(url).pathname.split('/').slice(-2).join('/'); }
    catch { return url.substring(0, 50); }
}

module.exports = { fetchPaginatedData };