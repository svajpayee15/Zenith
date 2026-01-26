const axios = require('axios');
const QuickChart = require('quickchart-js');

const CONFIG = {
    symbol: 'BTC',
    timeframe: '1d',
    apiUrl: 'https://api.pacifica.fi/api/v1/kline' 
};

async function generateDemoChart() {
    console.log(`⏳ Fetching ${CONFIG.timeframe} data for ${CONFIG.symbol}...`);

    try {
        const now = Date.now();
        let startTime;
        let limit = 50; 

        if (CONFIG.timeframe === '1d') startTime = now - (limit * 24 * 60 * 60 * 1000);
        else if (CONFIG.timeframe === '1h') startTime = now - (limit * 60 * 60 * 1000);
        else startTime = now - (limit * 5 * 60 * 1000); 

        const response = await axios.get(CONFIG.apiUrl, {
            params: {
                symbol: CONFIG.symbol,
                interval: CONFIG.timeframe,
                start_time: startTime,
                end_time: now
            }
        });

        if (!response.data.success) {
            console.error("❌ API Error:", response.data);
            return;
        }

        const candles = response.data.data;
        console.log(`✅ Received ${candles.length} candles from Pacifica.`);

        const chartData = candles.map(c => ({
            x: c.t,             // Time (x-axis)
            o: parseFloat(c.o), // Open
            h: parseFloat(c.h), // High
            l: parseFloat(c.l), // Low
            c: parseFloat(c.c)  // Close
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
                    label: `${CONFIG.symbol}/USD`,
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
                            unit: CONFIG.timeframe === '5m' ? 'minute' : 'day'
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
        console.log("Chart url:", url);

    } catch (error) {
        console.error("❌ Failed to generate chart:", error.message);
    }
}

generateDemoChart();