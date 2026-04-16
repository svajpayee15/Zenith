// File: config/ws.connection.js

const WebSocket = require("ws");
const EventEmitter = require("events"); // NEW: Native Node.js Event Bus
const CopyTrading = require("../../database/models/copyTradings.Schema.js"); 
const CopyExecution = require("../../database/models/copyExecution.schema.js");

const WS_URL = "wss://test-ws.pacifica.fi/ws";
const REST_BASE = "https://test-api.pacifica.fi/api/v1"; 

/**
 * ============================================================================
 * CLASS: PacificaWS (Master WebSocket & Event Hub)
 * ============================================================================
 * Description: 
 * This is the central nervous system of the Zenith Trading Engine.
 * It maintains a persistent, self-healing WebSocket connection to the Pacifica
 * Matching Engine, manages live state across the platform, and handles the
 * execution routing for the 1:1 Whale Mirroring protocol.
 * * NEW: It now features an `internalBus` (EventEmitter) to broadcast real-time
 * state changes from background workers (like the Iceberg Dark Pool) directly
 * to the Discord UI components without polling the database.
 * ============================================================================
 */
class PacificaWS {
    /**
     * Initializes the core state maps, tracking sets, and spawns the Event Bus.
     * Maps are utilized over objects for O(1) read/write performance under load.
     */
    constructor() {
        this.ws = null;
        
        // --- STATE MAPS ---
        this.prices = new Map(); 
        this.positions = new Map(); 
        this.orders = new Map(); 
        this.userTrades = new Map(); 
        this.accountStats = new Map(); 
        this.marketInfo = new Map(); 
        this.whaleState = new Map(); 
        
        // --- CONNECTION TRACKING ---
        this.isConnected = false;
        this.activeSubscriptions = new Set();
        this.processedWhaleTrades = new Set(); 

        // --- THE INTERNAL EVENT BUS (For Iceberg / UI Updates) ---
        this.internalBus = new EventEmitter();
        this.internalBus.setMaxListeners(150); // High limit for multiple active Discord sessions

        // Boot sequence
        this.connect();
    }

    /**
     * Fetches static market constraints (lot sizes, tick sizes, leverage limits)
     * from the REST API to cache locally, avoiding rate limits during execution.
     */
    async loadMarkets() {
        try {
            console.log(`[WS Engine] Fetching market constraints from ${REST_BASE}/info...`);
            const res = await fetch(`${REST_BASE}/info`);
            const json = await res.json();
            if (json.success && json.data) {
                json.data.forEach(market => {
                    this.marketInfo.set(market.symbol.toUpperCase(), market);
                });
                console.log(`[WS Engine] Loaded rules for ${this.marketInfo.size} markets.`);
            }
        } catch (err) {
            console.error("[WS Engine] Failed to load market info:", err.message);
        }
    }

    /**
     * Establishes the WebSocket connection, binds event listeners, and handles
     * automatic reconnection on disconnects. Subscribes to global price feeds
     * and automatically re-subscribes active whale wallets for the Copy Engine.
     */
    connect() {
        this.ws = new WebSocket(WS_URL);

        this.ws.on("open", async () => {
            console.log("✅ [Pacifica WS] Connected successfully.");
            this.isConnected = true;
            this.subscribeGlobal();
            this.startHeartbeat();
            
            await this.loadMarkets();

            // Re-bind active sessions
            this.activeSubscriptions.forEach(account => this.sendSubscribe(account));

            // Boot Copy-Trading targets
            try {
                const activeStreams = await CopyTrading.find({ isActive: true }).select('targetWallet');
                const uniqueTargets = new Set(activeStreams.map(s => s.targetWallet));
                
                uniqueTargets.forEach(wallet => {
                    this.subscribeAccount(wallet);
                });
                console.log(`[WS Engine] Boot complete. Listening to ${uniqueTargets.size} active whales.`);
            } catch (err) {
                console.error("[WS Engine] Failed to load whales on boot:", err.message);
            }
        });

        /**
         * Master Message Trap
         * Parses incoming binary streams, updates internal state maps, and 
         * intercepts execution events to trigger the Mirroring Engine.
         */
        this.ws.on("message", (raw) => {
            try {
                const msg = JSON.parse(raw);
                if (msg.channel === "pong") return;
                
                // --- PRICE FEED PARSING ---
                if (msg.channel === "prices") {
                    if (Array.isArray(msg.data)) {
                        msg.data.forEach(token => {
                            if (token.symbol) this.prices.set(token.symbol.toUpperCase(), token);
                        });
                    }
                    return; 
                }

                // --- LIVE WHALE STATE TRACKING ---
                if (msg.channel === "account_leverage" && msg.data) {
                    this.whaleState.set(`${msg.data.u}_${msg.data.s}_leverage`, parseInt(msg.data.l));
                }
                if (msg.channel === "account_margin" && msg.data) {
                    this.whaleState.set(`${msg.data.u}_${msg.data.s}_isolated`, msg.data.i);
                }

                // --- TRADE EXECUTION TRAP (Unified ID Tracking) ---
                if (msg.channel === "account_trades" && Array.isArray(msg.data)) {
                    msg.data.forEach(trade => {
                        if (!trade.u) return;
                        
                        const uniqueId = trade.i || trade.h; 
                        
                        if (!this.processedWhaleTrades.has(uniqueId)) {
                            this.processedWhaleTrades.add(uniqueId);
                            setTimeout(() => this.processedWhaleTrades.delete(uniqueId), 3600000);

                            console.log(`[WS Engine] 🚨 Whale Trade Executed (Channel 1): ${trade.u} | ${trade.ts || trade.d} ${trade.a} ${trade.s}`);
                            this.triggerCopyTradeMirroring(trade).catch(console.error);
                        }
                    });
                }
                
                if (msg.channel === "account_order_updates" && Array.isArray(msg.data)) {
                    msg.data.forEach(order => {
                        if (!order.u) return;
                        
                        const isFillEvent = order.oe === "fulfill_market" || order.oe === "fulfill_limit";
                        const uniqueId = order.i; 

                        if (isFillEvent && !this.processedWhaleTrades.has(uniqueId)) {
                            this.processedWhaleTrades.add(uniqueId);
                            setTimeout(() => this.processedWhaleTrades.delete(uniqueId), 3600000);

                            console.log(`[WS Engine] 🚨 Whale Trade Executed (Channel 2 Fallback): ${order.u} | ${order.d} ${order.f} ${order.s}`);
                            
                            const mappedTrade = {
                                u: order.u, s: order.s,
                                ts: order.d === "bid" ? "open_long" : "open_short", 
                                p: order.p, a: order.f, t: Date.now()
                            };
                            this.triggerCopyTradeMirroring(mappedTrade).catch(console.error);
                        }
                    });
                }

            } catch (e) { /* ignore parse errors to prevent crash loops */ }
        });

        this.ws.on("close", () => {
            console.log("❌ Disconnected. Reconnecting...");
            this.isConnected = false;
            setTimeout(() => this.connect(), 5000);
        });
    }

    // --- STATE GETTERS ---
    getPrice(symbol) { return this.prices.get(symbol.toUpperCase()); }
    getAllPositions() { return Array.from(this.positions.values()); }
    getPosition(symbol) { return this.positions.get(symbol.toUpperCase()); }
    getOrder(orderId) { return this.orders.get(orderId); }
    getUserTrades(wallet) { return this.userTrades.get(wallet) || []; }
    getAccountInfo(wallet) { return this.accountStats.get(wallet) || null; }

    /**
     * Transmits subscription requests to the exchange.
     */
    sendSubscribe(accountAddress) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const channels = ["account_info", "account_positions", "account_trades", "account_order_updates", "account_leverage", "account_margin"];
            channels.forEach(source => {
                this.ws.send(JSON.stringify({ method: "subscribe", params: { source, account: accountAddress } }));
            });
        }
    }

    /**
     * Binds a target wallet to the WebSocket stream, enabling live data flow.
     */
    subscribeAccount(accountAddress) {
        if (!accountAddress) return;
        if (!this.activeSubscriptions.has(accountAddress)) {
            this.activeSubscriptions.add(accountAddress);
            this.sendSubscribe(accountAddress);
        }
    }

    /**
     * Subscribes to the overarching global price stream.
     */
    subscribeGlobal() {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ method: "subscribe", params: { source: "prices" } }));
        }
    }

    /**
     * Maintains connection vitality to prevent exchange timeouts.
     */
    startHeartbeat() {
        setInterval(() => {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ method: "ping" }));
            }
        }, 30000);
    }

    /**
     * ========================================================================
     * THE MASTER 1:1 MIRROR ENGINE
     * ========================================================================
     * Orchestrates the copy-trading logic. Maps exchange actions, enforces
     * risk parameters, dynamically aligns leverage/margin, and records
     * executions to the MongoDB ledger.
     */
    async triggerCopyTradeMirroring(whaleTrade) {
        
        const marketOrder = require("../bot/commands/services/markets.command.js"); 
        const updateLeverage = require("../bot/commands/services/leverage.command.js"); 
        const toggleMargin = require("../bot/commands/services/margin.command.js");

        const whaleWallet = whaleTrade.u;
        const symbol = whaleTrade.s;
        const rawSide = whaleTrade.ts || whaleTrade.d || ""; 
        const whalePrice = parseFloat(whaleTrade.p) || 0; 
        const whaleAmountFilled = parseFloat(whaleTrade.a) || parseFloat(whaleTrade.f) || 0;

        let mappedSide = "bid";
        let isReduceOnly = false;

        const sideLower = rawSide.toLowerCase();
        if (sideLower.includes("open_long") || sideLower === "bid") {
            mappedSide = "bid"; isReduceOnly = false;
        } else if (sideLower.includes("open_short") || sideLower === "ask") {
            mappedSide = "ask"; isReduceOnly = false;
        } else if (sideLower.includes("close_long")) {
            mappedSide = "ask"; isReduceOnly = true;
        } else if (sideLower.includes("close_short")) {
            mappedSide = "bid"; isReduceOnly = true;
        } else {
            return;
        }
        
        const activeStreams = await CopyTrading.find({ targetWallet: whaleWallet, isActive: true });
        if (activeStreams.length === 0) return;

        const whaleLiveLev = this.whaleState.get(`${whaleWallet}_${symbol}_leverage`);
        const whaleLiveIso = this.whaleState.get(`${whaleWallet}_${symbol}_isolated`);
        const marketConfig = this.marketInfo.get(symbol);
        const lotSize = marketConfig ? parseFloat(marketConfig.lot_size) : 1; 
        const decimalPlaces = lotSize.toString().includes('.') ? lotSize.toString().split('.')[1].length : 0;

        const delay = (ms) => new Promise(res => setTimeout(res, ms));

        const executionPromises = activeStreams.map(async (stream) => {
            const follower = stream.followerWallet;
            
            let executionLog = new CopyExecution({
                copyStreamId: stream._id, followerWallet: follower, targetWallet: whaleWallet,
                symbol: symbol, 
                side: mappedSide === 'bid' ? 'BUY' : 'SELL', // Safe Enum mapping
                whaleExecution: { price: whalePrice, amount: whaleAmountFilled, executedAt: new Date(whaleTrade.t || Date.now()) }
            });

            try {
                // Ensure array exists to prevent mapping errors
                const blacklistArray = Array.isArray(stream.assetBlacklist) ? stream.assetBlacklist : [];
                
                if (blacklistArray.includes(symbol) || blacklistArray.includes(symbol.replace("USD", ""))) {
                    throw new Error(`Asset ${symbol} is explicitly blacklisted by user settings.`);
                }

                // 1:1 Sizing Logic
                let targetTokenAmount = whaleAmountFilled;
                if (whalePrice > 0) {
                    const maxTokensAllowed = stream.maxTradeSizeUsd / whalePrice;
                    if (targetTokenAmount > maxTokensAllowed) targetTokenAmount = maxTokensAllowed; 
                }

                const inverse = 1.0 / lotSize;
                let roundedAmount = Math.floor(targetTokenAmount * inverse) / inverse;

                if (roundedAmount <= 0) throw new Error(`Calculated mirror size smaller than exchange lot size (${lotSize}).`);
                const finalAmountStr = roundedAmount.toFixed(decimalPlaces);

                // A. Sync Margin Mode
                if (whaleLiveIso !== undefined) {
                    try { 
                        await toggleMargin(follower, symbol, whaleLiveIso); 
                        await delay(200); 
                    } catch (e) {
                        const errMsg = e.response?.data?.error || e.message;
                        if (!errMsg.includes("already")) console.log(`⚠️ [Copy Engine] Margin sync skipped: ${errMsg}`);
                    }
                }

                // B. Sync Leverage
                let finalLeverage = parseInt(stream.maxLeverageCap) || 1; 
                if (whaleLiveLev) {
                    finalLeverage = Math.min(parseInt(whaleLiveLev), finalLeverage);
                }
                
                try { 
                    await updateLeverage(follower, symbol, finalLeverage); 
                    await delay(200); 
                } catch (e) {
                    const errMsg = e.response?.data?.error || e.message;
                    if (!errMsg.includes("already")) console.log(`⚠️ [Copy Engine] Leverage sync rejected for ${follower}: ${errMsg}`);
                }

                // C. Fire Market Order
                const startTime = Date.now();
                const restResponse = await marketOrder(
                    follower, symbol, finalAmountStr, 
                    stream.slippageTolerancePct.toString(), 
                    mappedSide, null, null, isReduceOnly 
                );
                
                if (!restResponse.success) throw new Error(`API Rejected: ${JSON.stringify(restResponse.data)}`);

                // 🛑 THE FIX: Robust Order ID extraction
                const robustOrderId = restResponse.data?.i || restResponse.data?.id || restResponse.data?.orderId || restResponse.data?.order_id || restResponse.id || "UNKNOWN";

                console.log(`[Copy Engine] ✅ Successfully copied trade for ${follower} at ${finalLeverage}x leverage`);
                
                executionLog.followerExecution = {
                    orderId: robustOrderId.toString(),
                    amount: parseFloat(finalAmountStr),
                    latencyMs: Date.now() - startTime,
                    status: "SUCCESS"
                };

                // 🛑 THE FIX: Update Stream Session Volume!
                const tradeUsdValue = parseFloat(finalAmountStr) * (whalePrice || parseFloat(latest.mark) || 1);
                await CopyTrading.updateOne(
                    { _id: stream._id },
                    { 
                        $inc: { 
                            sessionVolume: tradeUsdValue,
                            totalTradesCopied: 1 
                        } 
                    }
                );

            } catch (err) {
                console.error(`[Copy Engine] ❌ Failed to copy trade for ${follower}:`, err.message);
                executionLog.followerExecution = {
                    status: err.message.includes("blacklisted") ? "SKIPPED" : "FAILED",
                    reason: err.message
                };
            } finally {
                await executionLog.save();
            }
        });

        await Promise.all(executionPromises);
    }
}

// Export the singleton instance (which now includes .internalBus)
module.exports = new PacificaWS();