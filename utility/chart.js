// src/bot/commands/services/chart.service.js
const axios = require('axios');
const QuickChart = require('quickchart-js');

const API_URL = 'https://api.pacifica.fi/api/v1/kline';

// Map Mako buttons to Pacifica API intervals & calculate limits
// limit: 50 candles is the sweet spot for Discord embeds
const TIME_CONFIG = {
    '5m':  { apiInterval: '5m',  ms: 5 * 60 * 1000,       limit: 40 }, 
    '1h':  { apiInterval: '1h',  ms: 60 * 60 * 1000,      limit: 48 }, // 2 Days
    '1d':  { apiInterval: '1d',  ms: 24 * 60 * 60 * 1000, limit: 30 }, // 1 Month
    '1w':  { apiInterval: '1w',  ms: 7 * 24 * 60 * 60 * 1000, limit: 52 }, // 1 Year
    '30d': { apiInterval: '1M',  ms: 30 * 24 * 60 * 60 * 1000, limit: 12 } // 1 Year (Monthly)
};

async function generateChartImage(symbol, timeframe) {
    console.log(`⏳ [Chart Service] Fetching ${timeframe} for ${symbol}...`);

    try {
        // 1. Get Config
        const config = TIME_CONFIG[timeframe] || TIME_CONFIG['1d'];
        
        // 2. Calculate Time
        const now = Date.now();
        const startTime = now - (config.limit * config.ms);

        // 3. Fetch from Pacifica
        const response = await axios.get(API_URL, {
            params: {
                symbol: symbol.toUpperCase(),
                interval: config.apiInterval,
                start_time: startTime,
                end_time: now
            }
        });

        if (!response.data.success) {
            console.error("❌ [Chart Service] API Error:", response.data);
            return null;
        }

        const candles = response.data.data;
        
        // 4. Format Data for Chart.js v3
        const chartData = candles.map(c => ({
            x: c.t,             // Time
            o: parseFloat(c.o), // Open
            h: parseFloat(c.h), // High
            l: parseFloat(c.l), // Low
            c: parseFloat(c.c)  // Close
        }));

        // 5. Generate Image
        const chart = new QuickChart();
        chart.setWidth(800);
        chart.setHeight(400);
        chart.setBackgroundColor("#020B1C"); // Mako Midnight Abyss
        
        // ⚠️ CRITICAL: Force Chart.js Version 3
        chart.setVersion('3'); 

        chart.setConfig({
            type: 'candlestick',
            data: {
                datasets: [{
                    label: `${symbol.toUpperCase()}/USD`,
                    data: chartData,
                    color: {
                        up: '#00FF94',      // Apex Green
                        down: '#FF2950',    // Crash Red
                        unchanged: '#999'
                    },
                    borderColor: {
                        up: '#00FF94',
                        down: '#FF2950',
                        unchanged: '#999'
                    }
                }]
            },
            options: {
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: timeframe === '5m' ? 'minute' : 'day'
                        },
                        grid: { 
                            color: '#1A3A63',
                            borderColor: '#1A3A63'
                        },
                        ticks: { color: '#E6F1FF' }
                    },
                    y: {
                        grid: { 
                            color: '#1A3A63',
                            borderColor: '#1A3A63'
                        },
                        ticks: { 
                            color: '#E6F1FF',
                            callback: (val) => `$${val}`
                        }
                    }
                }
            }
        });

        // 6. Return the URL
        const url = await chart.getShortUrl();
        return url;

    } catch (error) {
        console.error("❌ [Chart Service] Failed:", error.message);
        return null;
    }
}

module.exports = { generateChartImage };