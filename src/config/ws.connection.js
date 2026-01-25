const WebSocket = require("ws");

const WS_URL = process.env.WS_URL || "wss://test-ws.pacifica.fi/ws";

class PacificaWS {
    constructor() {
        this.ws = null;
        this.prices = new Map(); 
        this.positions = new Map(); // Stores active positions by Symbol
        this.orders = new Map(); 
        this.userTrades = new Map(); 
        this.accountStats = new Map(); 
        this.isConnected = false;
        
        // Track wallets we are listening to
        this.activeSubscriptions = new Set();

        this.connect();
    }

    connect() {
        this.ws = new WebSocket(WS_URL);

        this.ws.on("open", () => {
            console.log("✅ [Pacifica] Connected");
            this.isConnected = true;
            this.subscribeGlobal();
            this.startHeartbeat();
            
            // Re-subscribe to all wallets on reconnect
            this.activeSubscriptions.forEach(account => this.sendSubscribe(account));
        });

        this.ws.on("message", (raw) => {
            try {
                const msg = JSON.parse(raw);
                if (msg.channel === "pong") return;

                // --- 1. Market Data ---
                if (msg.channel === "prices" && Array.isArray(msg.data)) {
                    msg.data.forEach(token => {
                        if (token.symbol) this.prices.set(token.symbol.toUpperCase(), token);
                    });
                }

                // --- 2. Account Info (Balance) ---
                if (msg.channel === "account_info" && msg.data) {
                    const info = msg.data;
                    // Heuristic: Broadcast to active subs since API doesn't send wallet ID in update
                    if (this.activeSubscriptions.size > 0) {
                        for (const wallet of this.activeSubscriptions) {
                            this.accountStats.set(wallet, info);
                        }
                    }
                }

                // --- 3. Account Positions (Live Tracking) ---
                if (msg.channel === "account_positions" && Array.isArray(msg.data)) {
                    msg.data.forEach(pos => {
                        // Docs: s=symbol, a=amount, p=entry, m=margin, f=funding, i=isolated, l=liq
                        if (pos.s) {
                            const symbol = pos.s.toUpperCase();
                            const amount = parseFloat(pos.a);

                            // If amount is 0, position is closed -> remove from cache
                            if (amount === 0) {
                                this.positions.delete(symbol);
                            } else {
                                // Update/Set live position data
                                this.positions.set(symbol, pos);
                            }
                        }
                    });
                }

                // --- 4. Account Orders ---
                if (msg.channel === "account_orders" && Array.isArray(msg.data)) {
                    msg.data.forEach(order => {
                        if (order.i) this.orders.set(order.i, order);
                    });
                }

                // --- 5. Account Trades ---
                if (msg.channel === "account_trades" && Array.isArray(msg.data)) {
                    msg.data.forEach(trade => {
                        if (trade.u) { 
                            const wallet = trade.u;
                            if (!this.userTrades.has(wallet)) this.userTrades.set(wallet, []);
                            const list = this.userTrades.get(wallet);
                            if (!list.some(t => t.i === trade.i)) {
                                list.push(trade);
                                if (list.length > 20) list.shift();
                            }
                        }
                    });
                }

            } catch (e) { /* ignore */ }
        });

        this.ws.on("close", () => {
            console.log("❌ Disconnected. Reconnecting...");
            this.isConnected = false;
            this.positions.clear(); 
            setTimeout(() => this.connect(), 5000);
        });
    }

    // --- GETTERS ---
    getPrice(symbol) { return this.prices.get(symbol.toUpperCase()); }
    getAllPositions() { return Array.from(this.positions.values()); }
    
    // Returns the live position object if it exists
    getPosition(symbol) { return this.positions.get(symbol.toUpperCase()); }
    
    getOrder(orderId) { return this.orders.get(orderId); }
    getUserTrades(wallet) { return this.userTrades.get(wallet) || []; }
    getAccountInfo(wallet) { return this.accountStats.get(wallet) || null; }

    // --- SUBSCRIPTION MANAGER ---
    sendSubscribe(accountAddress) {
        if (this.ws.readyState === WebSocket.OPEN) {
            const channels = ["account_info", "account_positions", "account_orders", "account_trades"];
            channels.forEach(source => {
                this.ws.send(JSON.stringify({
                    method: "subscribe",
                    params: { source, account: accountAddress }
                }));
            });
        }
    }

    subscribeAccount(accountAddress) {
        if (!accountAddress) return;
        if (!this.activeSubscriptions.has(accountAddress)) {
            this.activeSubscriptions.add(accountAddress);
            this.sendSubscribe(accountAddress);
        }
    }

    subscribeGlobal() {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ method: "subscribe", params: { source: "prices" } }));
        }
    }

    startHeartbeat() {
        setInterval(() => {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ method: "ping" }));
            }
        }, 30000);
    }
}

module.exports = new PacificaWS();