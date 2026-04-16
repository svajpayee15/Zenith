'use strict';

// ============================================================================
// File: src/bot/commands/services/iceberg.command.js
// Description: Zenith Institutional Dark Pool Engine (Ghost Slicer & VWAP)
// Version: 5.3.0 - Minimum Notional Value Shield & Dynamic Dust Sweeping
// ============================================================================

const IcebergPool = require("../../../../database/models/iceberg.Schema.js");
const marketOrder = require("./markets.command.js"); 
const pacificaWS = require("../../../config/ws.connection.js");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Core Autonomous Execution Worker.
 * Handles API routing, firewall checks, Ghost Slicing, and zero-latency VWAP math.
 */
async function _executeDarkPoolLoop(icebergId, builderCode = null) {
    try {
        let algo = await IcebergPool.findById(icebergId);
        if (!algo) return;

        algo.status = 'ROUTING';
        
        // Record the exact Arrival Price for Implementation Shortfall calculations
        const initialLiveData = pacificaWS.getPrice(algo.symbol);
        if (initialLiveData && !isNaN(parseFloat(initialLiveData.mark))) {
            algo.arrivalPrice = parseFloat(initialLiveData.mark);
        }
        
        await algo.save();
        if (pacificaWS.internalBus) pacificaWS.internalBus.emit('ICEBERG_UPDATE', algo); 

        let pauseStartTime = null;
        let trancheCounter = 0;

        // --- THE ENGINE LOOP ---
        while (algo.filledVolume < algo.targetVolume && ['ROUTING', 'PAUSED_FIREWALL'].includes(algo.status)) {
            
            // 🛑 THE ABORT FIX: Sync local memory with MongoDB before firing
            const dbCheck = await IcebergPool.findById(icebergId).select('status');
            if (dbCheck && (dbCheck.status === 'CANCELLED' || dbCheck.status === 'EXPIRED')) {
                console.log(`[Zenith Engine] UI Abort Signal caught. Terminating Algo ${icebergId}.`);
                break; 
            }

            // 1. FAST ORACLE PING: Zero-latency memory fetch
            const liveData = pacificaWS.getPrice(algo.symbol);
            if (!liveData || isNaN(parseFloat(liveData.mark))) {
                await sleep(algo.intervalMs);
                continue; 
            }
            const currentMarkPrice = parseFloat(liveData.mark);

            // 2. The Institutional Firewall (Price Bounds Check)
            let firewallBreached = false;
            if (algo.side === 'BUY' && algo.limitPrice && currentMarkPrice > algo.limitPrice) firewallBreached = true;
            if (algo.side === 'SELL' && algo.limitPrice && currentMarkPrice < algo.limitPrice) firewallBreached = true;

            if (firewallBreached) {
                if (algo.status !== 'PAUSED_FIREWALL') {
                    algo.status = 'PAUSED_FIREWALL';
                    pauseStartTime = Date.now();
                    await algo.save();
                    if (pacificaWS.internalBus) pacificaWS.internalBus.emit('ICEBERG_UPDATE', algo);
                    console.log(`[Zenith Engine] Firewall triggered for ${algo.symbol} at $${currentMarkPrice}. Halting execution.`);
                }

                // --- STAGNATION KILL SWITCH ---
                const timeStagnantMs = Date.now() - pauseStartTime;
                if (timeStagnantMs >= algo.stagnationTimeoutMs) {
                    algo.status = 'EXPIRED';
                    algo.errorMessage = `Sequence aborted: Price ($${currentMarkPrice}) outside firewall limits for ${algo.stagnationTimeoutMs / 1000}s.`;
                    algo.completedAt = Date.now();
                    await algo.save();
                    if (pacificaWS.internalBus) pacificaWS.internalBus.emit('ICEBERG_UPDATE', algo);
                    console.log(`[Zenith Engine] Kill Switch Activated. Algo ${icebergId} expired.`);
                    break; 
                }

                await sleep(algo.intervalMs);
                continue; 
            }

            // Firewall cleared. Resume if paused.
            if (algo.status === 'PAUSED_FIREWALL') {
                algo.status = 'ROUTING';
                pauseStartTime = null;
                await algo.save();
                if (pacificaWS.internalBus) pacificaWS.internalBus.emit('ICEBERG_UPDATE', algo);
            }

            // 3. INSTITUTIONAL GHOST SLICING & DUST SWEEPING
            // Dynamically pull the exact lot size and minimum order size constraints from WS Memory
            const marketConfig = pacificaWS.marketInfo?.get(algo.symbol);
            const lotSize = marketConfig && marketConfig.lot_size ? parseFloat(marketConfig.lot_size) : 0.0001;
            const minOrderUsd = marketConfig && marketConfig.min_order_size ? parseFloat(marketConfig.min_order_size) : 10;
            const inverse = 1.0 / lotSize;

            // FIX: Neutralize Javascript IEEE 754 float drift
            const rawRemaining = algo.targetVolume - algo.filledVolume;
            const cleanRemaining = Math.round(rawRemaining * inverse) / inverse;

            // Failsafe: If the remaining amount is 0, we're done
            if (cleanRemaining <= 0) {
                algo.status = 'COMPLETED';
                algo.completedAt = Date.now();
                await algo.save();
                if (pacificaWS.internalBus) pacificaWS.internalBus.emit('ICEBERG_UPDATE', algo);
                break;
            }

            // Calculate the absolute minimum tokens allowed by the exchange for this tranche
            const minTokensAllowed = Math.ceil((minOrderUsd / currentMarkPrice) * inverse) / inverse;

            const sizeJitter = 0.8 + (Math.random() * 0.4); 
            let executionSize = Math.floor((algo.trancheSize * sizeJitter) * inverse) / inverse;
            
            // 🛑 INSTITUTIONAL MINIMUM SHIELD: Ensure tranche is > $10
            if (executionSize < minTokensAllowed) {
                executionSize = minTokensAllowed;
            }
            
            // 🧹 DUST SWEEPER: If executing this slice leaves behind un-executable dust (< $10),
            // or if the slice is larger than the remaining amount, sweep the entire rest of the order now.
            if (executionSize >= cleanRemaining || (cleanRemaining - executionSize) < minTokensAllowed) {
                executionSize = cleanRemaining;
            }

            const apiSide = algo.side === 'BUY' ? 'bid' : 'ask';

            // 4. Execution Routing
            try {
                const execStartMs = Date.now();
                
                const receipt = await marketOrder(
                    algo.walletAddress, 
                    algo.symbol, 
                    executionSize, 
                    algo.slippageTolerancePct, 
                    apiSide, 
                    null, null, false, builderCode
                );

                if (!receipt || receipt.success === false) {
                    throw new Error(receipt?.data?.error || "Order rejected by matching engine.");
                }

                const latency = Date.now() - execStartMs;

                // Robust NaN Failsafe
                let exactFillPrice = currentMarkPrice;
                if (receipt.data) {
                    const recPrice = receipt.data.executed_price || receipt.data.price || receipt.data.p || receipt.data.entry_price;
                    if (recPrice && !isNaN(parseFloat(recPrice))) {
                        exactFillPrice = parseFloat(recPrice);
                    }
                }
                if (isNaN(exactFillPrice) || exactFillPrice <= 0) exactFillPrice = currentMarkPrice;

                const trancheCostUsd = executionSize * exactFillPrice;

                // 5. Update State & Quant Metrics (VWAP Math)
                trancheCounter++;
                algo.filledVolume += executionSize;
                
                // Prevent corrupted DB float propagation
                if (isNaN(algo.totalCostUsd)) algo.totalCostUsd = 0;
                
                algo.totalCostUsd += trancheCostUsd;
                algo.averageFillPrice = algo.totalCostUsd / algo.filledVolume;

                algo.executionLedger.push({
                    trancheIndex: trancheCounter,
                    executedAmount: executionSize,
                    fillPrice: exactFillPrice,
                    costUsd: trancheCostUsd,
                    latencyMs: latency
                });

                // Final Clean Check
                const finalRemaining = Math.round((algo.targetVolume - algo.filledVolume) * inverse) / inverse;
                if (finalRemaining <= 0) {
                    algo.filledVolume = algo.targetVolume; // Perfect UI alignment
                    algo.status = 'COMPLETED';
                    algo.completedAt = Date.now();
                }

                await algo.save();
                
                if (pacificaWS.internalBus) pacificaWS.internalBus.emit('ICEBERG_UPDATE', algo); 

                // INSTITUTIONAL GHOST TIMING (Randomized intervals)
                if (algo.status !== 'COMPLETED') {
                    const timeJitter = 0.5 + (Math.random() * 1.0); // 50% to 150% interval time
                    await sleep(algo.intervalMs * timeJitter); 
                }

            } catch (err) {
                algo.status = 'FAILED';
                algo.errorMessage = err.message || "Tranche execution failure.";
                algo.completedAt = Date.now();
                await algo.save();
                if (pacificaWS.internalBus) pacificaWS.internalBus.emit('ICEBERG_UPDATE', algo); 
                console.error(`[Zenith Engine] Engine Failure:`, err);
                break; 
            }
        }
    } catch (err) {
        console.error(`[Zenith Engine Fatal Error]:`, err);
    }
}

/**
 * Initializes the algorithm and spawns the background worker.
 */
async function launchIceberg(walletAddress, symbol, side, targetVolume, trancheSize, intervalMs, limitPrice, slippage, builderCode = null) {
    try {
        const standardSide = side.toLowerCase() === "long" ? "BUY" : "SELL";

        // Extract Arrival Price synchronously before DB creation
        const liveData = pacificaWS.getPrice(symbol);
        const exactArrivalPrice = (liveData && !isNaN(parseFloat(liveData.mark))) ? parseFloat(liveData.mark) : 0;

        const newAlgo = await IcebergPool.create({
            walletAddress,
            symbol: symbol.toUpperCase(),
            side: standardSide,
            targetVolume,
            trancheSize,
            intervalMs,
            limitPrice,
            slippageTolerancePct: slippage,
            totalCostUsd: 0,
            filledVolume: 0,
            averageFillPrice: 0,
            arrivalPrice: exactArrivalPrice 
        });

        _executeDarkPoolLoop(newAlgo._id, builderCode).catch(console.error);

        return { success: true, icebergId: newAlgo._id, arrivalPrice: exactArrivalPrice };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

module.exports = { launchIceberg };