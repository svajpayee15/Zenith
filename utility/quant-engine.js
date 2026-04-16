async function getTradeHistory(walletAddress){
    let c_win = 0, c_loss = 0;
    let x̄_win, x̄_loss;
    let Σ_gross_profile = 0, Σ_gross_loses = 0;
    let Σ_squared_gross_loses = 0.001;

    try{

        let cursor = "";
        let has_more = true;

        while(has_more){
            let fetchURL = `https://test-api.pacifica.fi/api/v1/trades/history?account=${walletAddress}`;
            if(cursor) fetchURL += `&cursor=${cursor}`;

            const response = await fetch(fetchURL);
            const tradeHistory = await response.json();

            if(!tradeHistory.success) return "Something went wrong";

            
            (tradeHistory.data).forEach((trade)=>{
                const tradeReturn = parseFloat(trade.pnl) / parseFloat(trade.amount);

                if(tradeReturn > 0){
                    c_win++;
                    Σ_gross_profile += parseFloat(tradeReturn);
                }
                else if(tradeReturn < 0){
                    c_loss++;
                    Σ_gross_loses += parseFloat(tradeReturn);
    
                    Σ_squared_gross_loses += (tradeReturn*tradeReturn);
                }  
            })

            has_more = tradeHistory.has_more;
            cursor = tradeHistory.next_cursor;
        }

        x̄_win = c_win ? Σ_gross_profile / c_win : 0;
        x̄_loss = c_loss ? Σ_gross_loses / c_loss : 0;

        const EV = CalculateExpectedValue(c_win, c_loss, x̄_win, x̄_loss);
        const PF = CalculateProfitFactor(Σ_gross_profile, Σ_gross_loses);
        const MDD = await CalculateMaxDrawDown(walletAddress);
        const SR =  CalculateSortinoRatio(c_win, c_loss, Σ_gross_profile, Σ_gross_loses, Σ_squared_gross_loses);

        return {EV, PF, MDD, SR};
    }
    catch(err){
        console.error(err);
    }
}

async function CalculateMaxDrawDown(walletAddress){
    try{
        // BUG FIX: You forgot to await the .json() parsing here!
        const response = await fetch(`https://test-api.pacifica.fi/api/v1/portfolio?account=${walletAddress}&time_range=all`);
        const portfolio = await response.json();

        if(!portfolio.success || !portfolio.data) return 0;

        let peak = 0;            // The High Water Mark
        let max_drawdown = 0;    // The absolute worst drop
        let cumulative = 0;      // Running equity

        // Loop chronologically through the portfolio snapshots
        // Note: If Pacifica sends newest-first, you need to add .reverse() to the array
        portfolio.data.forEach((stat) => {
            cumulative += parseFloat(stat.pnl);

            // 1. Are we at a new all-time high? Plant the flag.
            if (cumulative > peak) {
                peak = cumulative;
            }

            // 2. Measure the drop from the current flag
            const current_drawdown = peak - cumulative;

            // 3. Is this the worst drop we've ever seen?
            if (current_drawdown > max_drawdown) {
                max_drawdown = current_drawdown;
            }
        });

        return max_drawdown; // Returns the absolute worst USDC drop
    }
    catch(err){
        console.error(err);
        return 0;
    }
}

function CalculateExpectedValue(c_win, c_loss, x̄_win, x̄_loss){
    const p_win = c_win / ( c_win + c_loss );
    const p_loss = c_loss / ( c_win + c_loss );
    const EV = (p_win * x̄_win) - (p_loss * Math.abs(x̄_loss));

    return EV;
}

function CalculateProfitFactor(Σ_gross_profile, Σ_gross_loses){
    let PF;
    if(Σ_gross_loses == 0) PF = 100;
    else PF = Σ_gross_profile / Math.abs(Σ_gross_loses);

    return PF;
}

function CalculateSortinoRatio(c_win, c_loss, Σ_gross_profile, Σ_gross_loses, Σ_squared_gross_loses){
    const σ = Math.sqrt( Σ_squared_gross_loses / ( c_win + c_loss ) ) || 0.001;

    const average_trade_return = ( Σ_gross_profile + Σ_gross_loses ) / ( c_win + c_loss );

    const SR = average_trade_return / σ;

    return SR;
}