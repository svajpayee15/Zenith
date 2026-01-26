const axios = require('axios');
const QuickChart = require('quickchart-js');

const API_URL = 'https://api.pacifica.fi/api/v1/kline';

const TIME_CONFIG = {
    '5m':  { apiInterval: '5m',  ms: 5 * 60 * 1000,       limit: 40 },
    '1h':  { apiInterval: '1h',  ms: 60 * 60 * 1000,      limit: 48 },
    '1d':  { apiInterval: '1d',  ms: 24 * 60 * 60 * 1000, limit: 30 },
    '1w':  { apiInterval: '4h',  ms: 4 * 60 * 60 * 1000,  limit: 42 },
    '30d': { apiInterval: '1d',  ms: 24 * 60 * 60 * 1000, limit: 30 } 
};

async function generateChartImage(symbol, timeframe) {
    console.log(`⏳ Fetching ${timeframe} for ${symbol}...`);

    try {
        const config = TIME_CONFIG[timeframe] || TIME_CONFIG['1d'];
        
        const now = Date.now();
        const startTime = now - (config.limit * config.ms);

        const response = await axios.get(API_URL, {
            params: {
                symbol: symbol.toUpperCase(),
                interval: config.apiInterval,
                start_time: startTime,
                end_time: now
            }
        });

        if (!response.data.success) {
            console.error("❌ API Error:", response.data);
            return null;
        }

        const candles = response.data.data;
        
        if (!candles || candles.length === 0) {
            return null;
        }

        const chartData = candles.map(c => ({
            x: c.t,             
            o: parseFloat(c.o), 
            h: parseFloat(c.h), 
            l: parseFloat(c.l), 
            c: parseFloat(c.c)  
        }));

        const chart = new QuickChart();
        chart.setWidth(800);
        chart.setHeight(400);
        chart.setBackgroundColor("#020B1C"); 
        
        chart.setVersion('3'); 

        chart.setConfig({
            type: 'candlestick',
            data: {
                datasets: [{
                    label: `${symbol.toUpperCase()}/USD`,
                    data: chartData,
                    color: {
                        up: '#00FF94',      
                        down: '#FF2950',    
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
                            unit: (timeframe === '5m' || timeframe === '1h') ? 'minute' : 'day',
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

        const url = await chart.getShortUrl();
        return url;

    } catch (error) {
        console.error("❌ Chart Failed:", error.message);
        return null;
    }
}

module.exports = { generateChartImage };