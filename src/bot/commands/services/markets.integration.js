const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ComponentType,
} = require("discord.js");
const axios = require("axios");
const pacificaWS = require("../../../config/ws.connection.js");

const { generateChartImage } = require("../../../../utility/chart.js");

const marketOrder = require("./markets.command.js");
const fetchTrades = require("./history.command.js");
const updateLeverage = require("./leverage.command.js");
const getAccountInfo = require("./account.command.js");
const toggleMargin = require("./margin.command.js");

const API_BASE = "https://test-api.pacifica.fi/api/v1";

function formatError(err) {
  if (!err) return "Unknown Error";
  if (typeof err === "string") return err;
  if (err.response && err.response.data) {
    const d = err.response.data;
    if (typeof d === "string") return d;
    if (d.error)
      return typeof d.error === "object" ? JSON.stringify(d.error) : d.error;
    if (d.message) return d.message;
    return JSON.stringify(d);
  }
  return err.message || JSON.stringify(err);
}

function roundStep(value, step) {
  if (!step || step === 0) return value;
  const inverse = 1.0 / step;
  return Math.floor(value * inverse) / inverse;
}

async function fetchMarket(approvals, interaction) {
  let symbol = interaction.options.getString("symbol").toUpperCase();

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }

  let viewState = "dashboard";
  let pendingSide = null;
  let isBusy = false;

  // --- CHART STATE ---
  let chartTimeframe = "1d"; // Default 1 Day
  // Initial fetch
  let chartUrl = await generateChartImage(symbol, "1d"); 

  let orderParams = {
    amount: 0.0,
    enteredValue: 0.0, // Store what the user actually typed
    enteredType: 'token', // 'token' or 'usd'
    slippage: 0.5,
    tp: null,
    sl: null,
    reduceOnly: false,
  };

  let accountSettings = {
    leverage: "20x",
    marginMode: "CROSS",
  };

  let marketConstraints = {
    max_leverage: 20,
    isolated_only: false,
    min_order_size: 10,
    lot_size: 0.001,
    tick_size: 0.1,
  };

  const userRecord = await approvals.findOne({
    userId: interaction.user.id,
    approved: true,
  });

  if (userRecord && pacificaWS.subscribeAccount) {
    pacificaWS.subscribeAccount(userRecord.walletAddress);
  }

  const refreshMarketData = async (targetSymbol) => {
    try {
      const [infoRes, settingsRes] = await Promise.all([
        axios.get(`${API_BASE}/info`),
        userRecord
          ? axios.get(
              `${API_BASE}/account/settings?account=${userRecord.walletAddress}`,
            )
          : Promise.resolve({ data: { success: false } }),
      ]);

      if (infoRes.data && infoRes.data.success) {
        const marketInfo = infoRes.data.data.find((m) => {
          const s = m.symbol.toUpperCase();
          return (
            s === targetSymbol ||
            s === `${targetSymbol}USD` ||
            targetSymbol === `${s}USD`
          );
        });

        if (marketInfo) {
          marketConstraints.max_leverage = parseInt(
            marketInfo.max_leverage,
            10,
          );
          marketConstraints.isolated_only = marketInfo.isolated_only;
          marketConstraints.min_order_size = parseFloat(
            marketInfo.min_order_size,
          );
          marketConstraints.lot_size = parseFloat(marketInfo.lot_size);
          marketConstraints.tick_size = parseFloat(marketInfo.tick_size);
        }
      }

      if (settingsRes.data && settingsRes.data.success) {
        const userSettings = settingsRes.data.data.find((s) => {
          const sSym = s.symbol.toUpperCase();
          return sSym === targetSymbol || sSym === `${targetSymbol}USD`;
        });

        if (userSettings) {
          const safeLev = Math.min(
            parseInt(userSettings.leverage),
            marketConstraints.max_leverage,
          );
          accountSettings.leverage = `${safeLev}x`;
          accountSettings.marginMode = userSettings.isolated
            ? "ISOLATED"
            : "CROSS";
        } else {
          accountSettings.leverage = `${marketConstraints.max_leverage}x`;
          accountSettings.marginMode = marketConstraints.isolated_only
            ? "ISOLATED"
            : "CROSS";
        }
      }
    } catch (e) {
      console.error(`[Market Refresh] Error:`, formatError(e));
    }
  };

  await refreshMarketData(symbol);

  let historyData = [];
  let pageIndex = 0;
  let selectedTrade = null;

  let data = pacificaWS.getPrice(symbol);
  if (!data) {
    await new Promise((r) => setTimeout(r, 2000));
    data = pacificaWS.getPrice(symbol);
  }

  if (!data)
    return interaction.editReply({
      content: `❌ Stream offline for **${symbol}**. Please try again later.`,
    });

  let prevPrice = parseFloat(data.mark);
  let prevOracle = parseFloat(data.oracle);

  const renderDashboard = (tokenData) => {
    const currentPrice = parseFloat(tokenData.mark);
    const currentOracle = parseFloat(tokenData.oracle);
    const volume = parseFloat(tokenData.volume_24h).toLocaleString();

    const priceUp = currentPrice >= prevPrice;
    const oracleUp = currentOracle >= prevOracle;

    prevPrice = currentPrice;
    prevOracle = currentOracle;

    const signPrice = priceUp ? "+" : "-";
    const signOracle = oracleUp ? "+" : "-";
    const mainColor = priceUp ? 0x00ff00 : 0xff0000;

    const embed = new EmbedBuilder()
      .setTitle(`📊 Market: ${tokenData.symbol} / USD`)
      .setColor(mainColor)
      .addFields(
        {
          name: "💵 Price",
          value: `\`\`\`diff\n${signPrice} $${currentPrice.toFixed(4)}\n\`\`\``,
          inline: true,
        },
        {
          name: "🔮 Oracle",
          value: `\`\`\`diff\n${signOracle} $${currentOracle.toFixed(4)}\n\`\`\``,
          inline: true,
        },
        {
          name: "📊 24h Vol",
          value: `\`\`\`\n$${volume}\n\`\`\``,
          inline: true,
        },
        {
          name: "⚡ Funding",
          value: `\`\`\`\n${tokenData.funding}\n\`\`\``,
          inline: true,
        },
      )
      .setImage(chartUrl) // Chart Attached
      .setTimestamp()
      .setFooter({ text: `Updates every 2.5s • TF: ${chartTimeframe}` });

    // --- CHART BUTTONS ROW ---
    const chartRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("tf_5m").setLabel("5m").setStyle(chartTimeframe === '5m' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("tf_1h").setLabel("1h").setStyle(chartTimeframe === '1h' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("tf_1d").setLabel("1d").setStyle(chartTimeframe === '1d' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("tf_1w").setLabel("1w").setStyle(chartTimeframe === '1w' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("tf_30d").setLabel("30d").setStyle(chartTimeframe === '30d' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("init_long")
        .setLabel("🟢 Long")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("init_short")
        .setLabel("🔴 Short")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("view_account")
        .setLabel("🏦 Account")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("open_history")
        .setLabel("📜 History")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("switch_market")
        .setLabel("🔍 Switch")
        .setStyle(ButtonStyle.Secondary),
    );

    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("close_terminal")
        .setLabel("🔴 Close Terminal")
        .setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [chartRow, row, row2] };
  };

  const renderAccountInfo = async () => {
    const accStats = userRecord
      ? await getAccountInfo(userRecord.walletAddress)
      : null;

    const embed = new EmbedBuilder()
      .setTitle("🏦 Account Overview")
      .setColor(0x0099ff)
      .setTimestamp();

    if (accStats) {
      const equity = parseFloat(accStats.account_equity).toFixed(2);
      const balance = parseFloat(accStats.balance).toFixed(2);
      const marginUsed = parseFloat(accStats.total_margin_used).toFixed(2);
      const available = parseFloat(accStats.available_to_spend).toFixed(2);
      const pending = parseFloat(accStats.pending_balance).toFixed(2);
      const equityVal = parseFloat(accStats.account_equity);
      const marginVal = parseFloat(accStats.total_margin_used);
      const usageRaw = equityVal > 0 ? (marginVal / equityVal) * 100 : 0;
      const usage = usageRaw.toFixed(1);

      embed.addFields(
        { name: "💰 Equity", value: `\`$${equity}\``, inline: true },
        { name: "🏦 Balance", value: `\`$${balance}\``, inline: true },
        { name: "💳 Available", value: `\`$${available}\``, inline: true },
        { name: "📉 Margin Used", value: `\`$${marginUsed} (${usage}%)\``, inline: true },
        { name: "⏳ Pending Bal", value: `\`$${pending}\``, inline: true },
        { name: "📊 Positions", value: `\`${accStats.positions_count || 0}\``, inline: true },
        { name: "📝 Orders", value: `\`${accStats.orders_count || 0}\``, inline: true },
      );
    } else {
      embed.setDescription(userRecord ? "❌ Failed to fetch data." : "❌ Wallet not linked.");
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("back").setLabel("⬅️ Back to Market").setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [row] };
  };

  const renderStrategySetup = (tokenData, side) => {
    const isLong = side === "long";
    const color = isLong ? 0x00ff00 : 0xff0000;
    const currentPrice = parseFloat(tokenData.mark);
    const priceUp = currentPrice >= prevPrice;
    prevPrice = currentPrice;
    const signPrice = priceUp ? "+" : "-";

    const marginLabel = accountSettings.marginMode === "CROSS" ? "🔀 Margin: CROSS" : "🔒 Margin: ISOLATED";
    const marginStyle = accountSettings.marginMode === "CROSS" ? ButtonStyle.Secondary : ButtonStyle.Primary;
    const reduceLabel = orderParams.reduceOnly ? "📉 Reduce Only: ON" : "📉 Reduce Only: OFF";
    const reduceStyle = orderParams.reduceOnly ? ButtonStyle.Primary : ButtonStyle.Secondary;

    const embed = new EmbedBuilder()
      .setTitle(`⚙️ Configure ${isLong ? "Long" : "Short"} Strategy`)
      .setDescription(`Market: **${symbol}**`)
      .setColor(color)
      .addFields(
        { name: "Live Price", value: `\`\`\`diff\n${signPrice} $${currentPrice.toFixed(4)}\n\`\`\``, inline: false },
        { name: "Margin Mode", value: `\`\`\`\n${accountSettings.marginMode}\n\`\`\``, inline: true },
        { name: "Leverage", value: `\`\`\`\n${accountSettings.leverage}\n\`\`\``, inline: true },
        { name: "Reduce Only", value: `\`\`\`\n${orderParams.reduceOnly ? "YES" : "NO"}\n\`\`\``, inline: true },
        { name: "Market Specs", value: `Max Lev: **${marketConstraints.max_leverage}x**\nTick Size: **${marketConstraints.tick_size}**`, inline: false },
      );

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("setup_toggle_margin").setLabel(marginLabel).setStyle(marginStyle).setDisabled(marketConstraints.isolated_only),
      new ButtonBuilder().setCustomId("setup_set_leverage").setLabel(`⚖️ Lev: ${accountSettings.leverage}`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup_toggle_reduce").setLabel(reduceLabel).setStyle(reduceStyle),
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("continue_to_size").setLabel("➡️ Continue to Size").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("back").setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [row1, row2] };
  };

  const renderConfirmation = (tokenData, side) => {
    const currentPrice = parseFloat(tokenData.mark);
    const isLong = side === "long";
    const color = isLong ? 0x00ff00 : 0xff0000;
    const priceUp = currentPrice >= prevPrice;
    prevPrice = currentPrice;
    const signPrice = priceUp ? "+" : "-";
    
    // Calculate values
    const positionValue = currentPrice * orderParams.amount;
    const levInt = parseInt(accountSettings.leverage.toString().replace("x", "")) || 1;
    const marginUsed = positionValue / levInt;
    
    const tpDisplay = orderParams.tp ? `$${orderParams.tp}` : "None";
    const slDisplay = orderParams.sl ? `$${orderParams.sl}` : "None";

    // --- SMART DISPLAY LOGIC ---
    let sizeDisplay = "";
    if (orderParams.enteredType === 'usd') {
        // Show USD first because that's what they typed
        sizeDisplay = `$${orderParams.enteredValue.toFixed(2)} (≈ ${orderParams.amount} ${tokenData.symbol})`;
    } else {
        // Show Token Amount first
        sizeDisplay = `${orderParams.amount} ${tokenData.symbol} (≈ $${positionValue.toFixed(2)})`;
    }

    const embed = new EmbedBuilder()
      .setTitle(`🛡️ Confirm ${isLong ? "Long" : "Short"} Position`)
      .setColor(color)
      .addFields(
        { name: "Live Price", value: `\`\`\`diff\n${signPrice} $${currentPrice.toFixed(4)}\n\`\`\``, inline: false },
        { name: "📦 Size", value: `\`\`\`\n${sizeDisplay}\n\`\`\``, inline: true }, // Updated Field
        { name: "⚖️ Leverage", value: `\`\`\`\n${accountSettings.leverage}\n\`\`\``, inline: true },
        { name: "💰 Est. Cost", value: `\`\`\`\n$${marginUsed.toFixed(2)}\n\`\`\``, inline: true },
        { name: "💵 Margin Mode", value: `\`\`\`\n${accountSettings.marginMode}\n\`\`\``, inline: true },
        { name: "⚙️ Slippage", value: `\`\`\`\n${orderParams.slippage}%\n\`\`\``, inline: true },
        { name: "🎯 TP / SL", value: `\`\`\`\nTP: ${tpDisplay}\nSL: ${slDisplay}\n\`\`\``, inline: true },
        { name: "📉 Reduce Only", value: `\`\`\`\n${orderParams.reduceOnly ? "YES" : "NO"}\n\`\`\``, inline: true },
      )
      .setFooter({ text: "⚠️ Execution price may vary due to volatility" });

    const rowControls = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("confirm_trade").setLabel("✅ Place Order").setStyle(isLong ? ButtonStyle.Success : ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("back_to_strategy").setLabel("⚙️ Edit Settings").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("back").setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [rowControls] };
  };

  const renderHistory = (allTrades) => {
    const embed = new EmbedBuilder().setTitle("📜 Trade History (Open Positions)").setColor(0x2b2d31);
    if (!allTrades || !Array.isArray(allTrades)) allTrades = [];
    const start = pageIndex * 5;
    const end = start + 5;
    const pageItems = allTrades.slice(start, end);
    const canGoNext = allTrades.length > end;
    const canGoPrev = pageIndex > 0;
    const startIndex = start + 1;

    if (pageItems.length === 0) {
      embed.setDescription("```\nNo open positions found.\n```");
    } else {
      const list = pageItems.map((t, i) => {
          const sideRaw = t.side ? t.side.toLowerCase() : "";
          const isShort = sideRaw.includes("short") || sideRaw === "ask";
          const emoji = isShort ? "🔴" : "🟢";
          const typeLabel = isShort ? "SHORT" : "LONG ";
          const globalIndex = startIndex + i;
          return `**${globalIndex}.** ${emoji} **${t.symbol}** ${typeLabel} | \`${t.amount}\` @ \`$${parseFloat(t.entry_price || t.price).toFixed(4)}\``;
        }).join("\n\n");
      embed.setDescription(list);
      embed.setFooter({ text: `Page ${pageIndex + 1}/${Math.ceil(allTrades.length / 5)}` });
    }

    const components = [];
    const tradeRow = new ActionRowBuilder();
    if (pageItems.length > 0) {
      pageItems.forEach((_, idx) => {
        const absoluteIndex = start + idx;
        tradeRow.addComponents(new ButtonBuilder().setCustomId(`trade_idx_${absoluteIndex}`).setLabel(`${startIndex + idx}`).setStyle(ButtonStyle.Secondary));
      });
      components.push(tradeRow);
    }
    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("history_prev").setLabel("⬅️ Prev").setStyle(ButtonStyle.Primary).setDisabled(!canGoPrev),
      new ButtonBuilder().setCustomId("back").setLabel("🏠 Terminal").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("history_next").setLabel("Next ➡️").setStyle(ButtonStyle.Primary).setDisabled(!canGoNext),
    );
    components.push(navRow);
    return { embeds: [embed], components: components };
  };

  const renderTradeDetails = (trade, currentMarketData, livePosition) => {
    const isLive = !!livePosition;
    const sideStr = isLive ? livePosition.d : trade.side || "";
    const isShort = sideStr.toLowerCase().includes("ask") || sideStr.toLowerCase().includes("short");
    const color = isShort ? 0xff0000 : 0x00ff00;
    const markPrice = parseFloat(currentMarketData.mark);
    const entryPrice = parseFloat(isLive ? livePosition.p : trade.entry_price || trade.price);
    const amount = parseFloat(isLive ? livePosition.a : trade.amount);
    let pnl = 0;
    if (isShort) pnl = (entryPrice - markPrice) * amount;
    else pnl = (markPrice - entryPrice) * amount;
    const invested = parseFloat(isLive ? livePosition.m : trade.margin || trade.initial_margin || 0);
    const pnlPercent = invested !== 0 ? (pnl / invested) * 100 : 0;
    const pnlSign = pnl >= 0 ? "+" : "-";
    const posValue = (amount * markPrice).toFixed(2);
    const isIso = isLive ? livePosition.i : trade.isolated || false;
    const marginMode = isIso ? "ISOLATED" : "CROSS";
    const liqPrice = isLive ? livePosition.l : trade.liquidation_price;

    const embed = new EmbedBuilder()
      .setTitle(`🔎 Trade Details: ${trade.symbol}`)
      .setColor(color)
      .addFields(
        { name: "Side", value: `\`\`\`diff\n${isShort ? "- SHORT" : "+ LONG"}\n\`\`\``, inline: true },
        { name: "PnL (ROI)", value: `\`\`\`diff\n${pnlSign} $${Math.abs(pnl).toFixed(2)} (${pnlPercent.toFixed(2)}%)\n\`\`\``, inline: true },
        { name: "Size / Value", value: `\`\`\`\n${amount} ${trade.symbol}\n(≈ $${posValue})\n\`\`\``, inline: true },
        { name: "Entry", value: `\`\`\`\n$${entryPrice.toFixed(4)}\n\`\`\``, inline: true },
        { name: "Mark", value: `\`\`\`\n$${markPrice.toFixed(4)}\n\`\`\``, inline: true },
        { name: "Liquidation", value: `\`\`\`\n${liqPrice || "N/A"}\n\`\`\``, inline: true },
        { name: "🎯 TP / SL", value: `\`\`\`\nTP: ${trade.tp_trigger_price ? `$${trade.tp_trigger_price}` : "None"}\nSL: ${trade.sl_trigger_price ? `$${trade.sl_trigger_price}` : "None"}\n\`\`\``, inline: true },
        { name: "💰 Margin", value: `\`\`\`\n$${invested.toFixed(2)} (${marginMode})\n\`\`\``, inline: true },
        { name: "⚡ Funding Rate", value: `\`\`\`\n${currentMarketData.funding || "0.00%"}\n\`\`\``, inline: true },
      )
      .setTimestamp(trade.created_at);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("close_trade_action").setLabel("Close Position").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("back_to_history").setLabel("⬅️ Back to List").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("back").setLabel("🏠 Terminal").setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [row] };
  };

  const message = await interaction.editReply(renderDashboard(data));

  const interval = setInterval(async () => {
    if (isBusy) return;
    try {
      if (viewState === "history" || viewState === "success" || viewState === "executing" || viewState === "expired" || viewState === "closed") return;

      const latest = pacificaWS.getPrice(symbol);
      if (!latest) return;

      if (viewState === "dashboard") await interaction.editReply(renderDashboard(latest));
      else if (viewState === "strategy_setup") await interaction.editReply(renderStrategySetup(latest, pendingSide));
      else if (viewState === "preview") await interaction.editReply(renderConfirmation(latest, pendingSide));
      else if (viewState === "trade_details" && selectedTrade) {
        const tradeMarket = selectedTrade.symbol === symbol ? latest : pacificaWS.getPrice(selectedTrade.symbol);
        let livePos = pacificaWS.getPosition ? pacificaWS.getPosition(selectedTrade.symbol) : null;
        if (tradeMarket) await interaction.editReply(renderTradeDetails(selectedTrade, tradeMarket, livePos));
      }
    } catch (e) {
      if (e.code === 10062 || e.code === 40060) clearInterval(interval);
    }
  }, 2500);

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 840_000,
  });

  const handleHistoryFetch = async (targetPageIndex) => {
    try {
      const res = await fetchTrades(userRecord.walletAddress);
      if (res && res.data && res.data.success) {
        historyData = res.data.data;
        pageIndex = targetPageIndex;
        viewState = "history";
        return renderHistory(historyData);
      }
    } catch (err) {
      console.error("History Fetch Error:", err);
    }
    return null;
  };

  collector.on("collect", async (i) => {
    if (i.user.id !== interaction.user.id)
      return i.reply({ content: "🚫 Session locked.", ephemeral: true });

    collector.resetTimer();
    isBusy = true;
    const latest = pacificaWS.getPrice(symbol);

    try {
      // --- CHART BUTTON LOGIC ---
      if (["tf_5m", "tf_1h", "tf_1d", "tf_1w", "tf_30d"].includes(i.customId)) {
        await i.deferUpdate();
        const newTf = i.customId.replace("tf_", "");
        if (newTf !== chartTimeframe) {
            chartTimeframe = newTf;
            const newUrl = await generateChartImage(symbol, chartTimeframe);
            if (newUrl) chartUrl = newUrl;
        }
        viewState = "dashboard";
        await i.editReply(renderDashboard(latest));
        return;
      }

      if (i.customId === "close_terminal" || i.customId === "stop") {
        clearInterval(interval);
        collector.stop("user_closed");
        viewState = "closed";
        await i.update({
          embeds: [new EmbedBuilder().setTitle("🔴 Terminal Session Ended").setDescription("Securely disconnected.").setColor(0x000000).setTimestamp()],
          components: [],
        });
        isBusy = false;
        return;
      }

      if (i.customId === "back") {
        viewState = "dashboard";
        pendingSide = null;
        await i.update(renderDashboard(latest));
      }

      if (i.customId === "view_account") {
        viewState = "account";
        await i.update(await renderAccountInfo());
      } else if (i.customId === "init_long" || i.customId === "init_short") {
        pendingSide = i.customId === "init_long" ? "long" : "short";
        viewState = "strategy_setup";
        await i.update(renderStrategySetup(latest, pendingSide));
      } else if (i.customId === "setup_toggle_margin") {
        if (!marketConstraints.isolated_only) {
          await i.deferUpdate();
          const currentMode = accountSettings.marginMode;
          const targetMode = currentMode === "CROSS" ? "ISOLATED" : "CROSS";
          const isIsolated = targetMode === "ISOLATED";

          try {
            const history = await axios.get(`${API_BASE}/positions?account=${userRecord.walletAddress}`);
            history.data.data.forEach((position) => {
              if (symbol.toUpperCase() == position.symbol) {
                throw new Error("Cannot change margin mode while position or order is open, please close it first.");
              }
            });

            await toggleMargin(userRecord.walletAddress, symbol, isIsolated);
            accountSettings.marginMode = targetMode;
            await i.editReply(renderStrategySetup(latest, pendingSide));
          } catch (err) {
            await i.followUp({ content: `❌ Error: ${formatError(err)}`, ephemeral: true });
          }
        } else {
          await i.reply({ content: "⚠️ This market only supports Isolated margin.", ephemeral: true });
        }
      } else if (i.customId === "setup_toggle_reduce") {
        orderParams.reduceOnly = !orderParams.reduceOnly;
        await i.update(renderStrategySetup(latest, pendingSide));
      } else if (i.customId === "setup_set_leverage") {
        const modal = new ModalBuilder().setCustomId("lev_modal").setTitle("Set Leverage");
        const levInput = new TextInputBuilder().setCustomId("lev").setLabel(`Leverage (1-${marketConstraints.max_leverage}x)`).setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(levInput));
        await i.showModal(modal);

        try {
          const sub = await i.awaitModalSubmit({ time: 60000, filter: (s) => s.user.id === i.user.id });
          const lev = parseInt(sub.fields.getTextInputValue("lev"));

          if (isNaN(lev) || lev < 1 || lev > marketConstraints.max_leverage) {
            await sub.reply({ content: `❌ Invalid leverage. Use 1-${marketConstraints.max_leverage}.`, ephemeral: true });
          } else {
            await updateLeverage(userRecord.walletAddress, symbol, lev);
            accountSettings.leverage = `${lev}x`;
            await sub.update(renderStrategySetup(latest, pendingSide));
          }
        } catch (e) {}
      } else if (i.customId === "continue_to_size" || i.customId === "back_to_strategy") {
        if (i.customId === "back_to_strategy") {
          viewState = "strategy_setup";
          await i.update(renderStrategySetup(latest, pendingSide));
        } else {
          // --- DUAL INPUT MODAL LOGIC ---
          const modal = new ModalBuilder().setCustomId("trade_modal").setTitle(pendingSide === "long" ? `Long ${symbol}` : `Short ${symbol}`);
          let defaultAmt = orderParams.amount;
          if (defaultAmt <= 0) {
            const price = parseFloat(latest.mark);
            if (price > 0) {
              const rec = 12 / price;
              defaultAmt = roundStep(rec, marketConstraints.lot_size);
            }
          }

          // 1. TOKEN AMOUNT (Optional)
          const amt = new TextInputBuilder()
            .setCustomId("amt")
            .setLabel(`Amount (${symbol})`)
            .setPlaceholder("e.g. 0.5")
            .setValue(defaultAmt > 0 ? defaultAmt.toString() : "")
            .setStyle(TextInputStyle.Short)
            .setRequired(false);

          // 2. USD AMOUNT (Optional)
          const usdInput = new TextInputBuilder()
            .setCustomId("usd_amt")
            .setLabel("OR Amount in USD ($)")
            .setPlaceholder("e.g. 100")
            .setStyle(TextInputStyle.Short)
            .setRequired(false);

          const slip = new TextInputBuilder().setCustomId("slip").setLabel("Slippage %").setValue(orderParams.slippage.toString()).setStyle(TextInputStyle.Short).setRequired(true);
          const tp = new TextInputBuilder().setCustomId("tp").setLabel("TP (Optional)").setStyle(TextInputStyle.Short).setRequired(false);
          const sl = new TextInputBuilder().setCustomId("sl").setLabel("SL (Optional)").setStyle(TextInputStyle.Short).setRequired(false);

          if (orderParams.tp) tp.setValue(orderParams.tp.toString());
          if (orderParams.sl) sl.setValue(orderParams.sl.toString());

          modal.addComponents(
            new ActionRowBuilder().addComponents(amt),
            new ActionRowBuilder().addComponents(usdInput), // ADD USD INPUT
            new ActionRowBuilder().addComponents(slip),
            new ActionRowBuilder().addComponents(tp),
            new ActionRowBuilder().addComponents(sl),
          );

          await i.showModal(modal);

          try {
            const sub = await i.awaitModalSubmit({ time: 60_000, filter: (s) => s.user.id === i.user.id });
            
            const rawAmt = sub.fields.getTextInputValue("amt").trim();
            const rawUsd = sub.fields.getTextInputValue("usd_amt").trim();

            // --- STRICT VALIDATION START ---
            if (rawAmt.length > 0 && rawUsd.length > 0) {
                 return sub.reply({ content: "⚠️ **Ambiguous Input:** Please fill EITHER the Token Amount OR the USD Amount, not both.", ephemeral: true });
            }
            if (rawAmt.length === 0 && rawUsd.length === 0) {
                 return sub.reply({ content: "❌ **Missing Input:** Please enter a trade size.", ephemeral: true });
            }

            let newAmt = 0;

            if (rawAmt.length > 0) {
                // USER ENTERED TOKEN
                newAmt = parseFloat(rawAmt);
                orderParams.enteredType = 'token';
                orderParams.enteredValue = newAmt;
            } else {
                // USER ENTERED USD
                const usdValue = parseFloat(rawUsd);
                if (isNaN(usdValue) || usdValue <= 0) {
                     return sub.reply({ content: "❌ Invalid USD Amount.", ephemeral: true });
                }
                const currentMark = parseFloat(latest.mark);
                if (currentMark > 0) {
                    newAmt = usdValue / currentMark;
                    orderParams.enteredType = 'usd';
                    orderParams.enteredValue = usdValue; // Store raw USD input
                } else {
                    return sub.reply({ content: "❌ Market data invalid (Price is 0).", ephemeral: true });
                }
            }
            // --- STRICT VALIDATION END ---

            newAmt = roundStep(newAmt, marketConstraints.lot_size);
            const newSlip = parseFloat(sub.fields.getTextInputValue("slip"));
            let newTp = parseFloat(sub.fields.getTextInputValue("tp"));
            let newSl = parseFloat(sub.fields.getTextInputValue("sl"));
            if (isNaN(newTp)) newTp = null;
            if (isNaN(newSl)) newSl = null;

            if (isNaN(newAmt) || newAmt <= 0) {
              return sub.reply({ content: "❌ Invalid Amount.", ephemeral: true });
            } else if (newAmt * latest.mark < marketConstraints.min_order_size) {
              return sub.reply({ content: `❌ Trade size too small. Min is $${marketConstraints.min_order_size}.`, ephemeral: true });
            }

            if (userRecord && !orderParams.reduceOnly) {
              const accStats = await getAccountInfo(userRecord.walletAddress);
              if (accStats && accStats.available_to_spend) {
                const avail = parseFloat(accStats.available_to_spend);
                const lev = parseInt(accountSettings.leverage.toString().replace("x", "")) || 1;
                const estimatedCost = (latest.mark * newAmt) / lev;
                if (estimatedCost > avail) {
                  return sub.reply({ content: `❌ **Insufficient Balance.**\nRequired: ~$${estimatedCost.toFixed(2)}\nAvailable: $${avail.toFixed(2)}`, ephemeral: true });
                }
              }
            }

            const currentP = parseFloat(latest.mark);
            const isLong = pendingSide === "long";

            if (newTp) {
              newTp = roundStep(newTp, marketConstraints.tick_size);
              if (isLong && newTp <= currentP) return sub.reply({ content: `❌ Invalid TP. Long TP must be > $${currentP}.`, ephemeral: true });
              if (!isLong && newTp >= currentP) return sub.reply({ content: `❌ Invalid TP. Short TP must be < $${currentP}.`, ephemeral: true });
            }

            if (newSl) {
              newSl = roundStep(newSl, marketConstraints.tick_size);
              if (isLong && newSl >= currentP) return sub.reply({ content: `❌ Invalid SL. Long SL must be < $${currentP}.`, ephemeral: true });
              if (!isLong && newSl <= currentP) return sub.reply({ content: `❌ Invalid SL. Short SL must be > $${currentP}.`, ephemeral: true });
            }

            // UPDATE ORDER PARAMS WITH NEW AMOUNT AND SLIP/TP/SL
            orderParams = { ...orderParams, amount: newAmt, slippage: newSlip, tp: newTp, sl: newSl };
            
            viewState = "preview";
            await sub.update(renderConfirmation(pacificaWS.getPrice(symbol), pendingSide));
          } catch (e) {}
        }
      } else if (i.customId === "confirm_trade") {
        await i.deferUpdate();
        viewState = "executing";

        if (!userRecord) {
          viewState = "dashboard";
          await i.followUp({ content: "❌ Wallet not linked!", ephemeral: true });
        } else {
          try {
            const side = pendingSide === "long" ? "bid" : "ask";
            const receipt = await marketOrder(userRecord.walletAddress, symbol, orderParams.amount, orderParams.slippage, side, orderParams.tp, orderParams.sl, orderParams.reduceOnly, userRecord.builderCode);
            if (!receipt || receipt.success === false) throw new Error(receipt?.data?.error || "Unknown error");

            if (interaction.channel) {
              const tpMsg = orderParams.tp ? `$${orderParams.tp}` : "None";
              const slMsg = orderParams.sl ? `$${orderParams.sl}` : "None";
              const successEmbed = new EmbedBuilder()
                .setTitle(`✅ ${symbol} ${pendingSide === "long" ? "Long" : "Short"} Executed`)
                .setColor(pendingSide === "long" ? 0x00ff00 : 0xff0000)
                .addFields(
                  { name: "Entry", value: `\`\`\`\n$${latest.mark}\n\`\`\``, inline: true },
                  { name: "Size", value: `\`\`\`\n${orderParams.amount}\n\`\`\``, inline: true },
                  { name: "Lev/Margin", value: `\`\`\`\n${accountSettings.leverage} / ${accountSettings.marginMode}\n\`\`\``, inline: true },
                  { name: "TP/SL", value: `\`\`\`diff\n+ TP: ${tpMsg}\n- SL: ${slMsg}\n\`\`\``, inline: true },
                )
                .setFooter({ text: `Executed by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() });
              await interaction.channel.send({ embeds: [successEmbed] });
            }

            const ephemeralConfirm = new EmbedBuilder().setTitle("✅ Order Placed").setDescription("Order executed successfully. Public alert sent.").setColor(0x00ff00);
            const postTradeRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("back").setLabel("⬅️ Back to Terminal").setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId("switch_market").setLabel("🔍 Switch").setStyle(ButtonStyle.Primary));
            viewState = "success";
            await i.editReply({ embeds: [ephemeralConfirm], components: [postTradeRow] });
          } catch (err) {
            viewState = "success";
            const errorMsg = formatError(err);
            const failEmbed = new EmbedBuilder().setTitle("❌ Failed").setColor(0xff0000).setDescription(`**Error:** ${errorMsg}`);
            const postTradeRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("back").setLabel("⬅️ Back").setStyle(ButtonStyle.Secondary));
            await i.editReply({ embeds: [failEmbed], components: [postTradeRow] });
          }
        }
      } else if (i.customId === "switch_market") {
        const modal = new ModalBuilder().setCustomId("switch_modal").setTitle("Switch Market");
        const input = new TextInputBuilder().setCustomId("new_symbol").setLabel("Symbol").setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await i.showModal(modal);

        try {
          const sub = await i.awaitModalSubmit({ time: 30_000, filter: (s) => s.user.id === i.user.id });
          const newSym = sub.fields.getTextInputValue("new_symbol").toUpperCase();
          if (!pacificaWS.getPrice(newSym)) {
            await sub.reply({ content: `❌ **${newSym}** not found.`, ephemeral: true });
          } else {
            symbol = newSym;
            viewState = "dashboard";
            // RESET CHART WHEN SWITCHING
            chartTimeframe = "1d";
            chartUrl = await generateChartImage(newSym, "1d");
            
            await refreshMarketData(newSym);
            await sub.update(renderDashboard(pacificaWS.getPrice(newSym)));
          }
        } catch (e) {}
      } else if (["open_history", "history_next", "history_prev", "back_to_history"].includes(i.customId)) {
        await i.deferUpdate();
        if (i.customId === "back_to_history") {
          viewState = "history";
          await i.editReply(renderHistory(historyData));
          return;
        }
        let targetPage = pageIndex;
        if (i.customId === "open_history") targetPage = 0;
        else if (i.customId === "history_next") targetPage++;
        else if (i.customId === "history_prev") targetPage = Math.max(0, targetPage - 1);

        const payload = await handleHistoryFetch(targetPage);
        if (payload) await i.editReply(payload);
        else await i.followUp({ content: "❌ Failed to fetch history.", ephemeral: true });
      } else if (i.customId === "close_trade_action") {
        await i.deferUpdate();
        viewState = "executing";

        if (!userRecord) {
          viewState = "trade_details";
          await i.followUp({ content: "❌ Wallet not linked!", ephemeral: true });
        } else {
          try {
            const originalSide = selectedTrade.side.toLowerCase();
            let closingSide = originalSide.includes("bid") || originalSide.includes("long") || originalSide.includes("buy") ? "ask" : "bid";
            const receipt = await marketOrder(userRecord.walletAddress, selectedTrade.symbol, selectedTrade.amount, orderParams.slippage, closingSide, null, null, true);

            if (!receipt || receipt.success === false) throw new Error(receipt?.data?.error || "Failed to close position");

            if (interaction.channel) {
              const closeEmbed = new EmbedBuilder()
                .setTitle(`🔒 Position Closed: ${selectedTrade.symbol}`)
                .setColor(0x555555)
                .addFields({ name: "Close Price", value: `\`\`\`\n$${latest.mark}\n\`\`\``, inline: true }, { name: "Size", value: `\`\`\`\n${selectedTrade.amount}\n\`\`\``, inline: true })
                .setFooter({ text: `Closed by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() });
              await interaction.channel.send({ embeds: [closeEmbed] });
            }

            const successEmbed = new EmbedBuilder().setTitle(`✅ Position Closed`).setDescription("Public notification sent.").setColor(0x00ff00);
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("back").setLabel("🏠 Return to Terminal").setStyle(ButtonStyle.Secondary));
            viewState = "success";
            await i.editReply({ embeds: [successEmbed], components: [row] });
          } catch (err) {
            viewState = "trade_details";
            const errorMsg = formatError(err);
            const failEmbed = new EmbedBuilder().setTitle("❌ Close Failed").setColor(0xff0000).setDescription(`**Error:** ${errorMsg}`);
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("back_to_history").setLabel("⬅️ Back to Trade").setStyle(ButtonStyle.Secondary));
            await i.editReply({ embeds: [failEmbed], components: [row] });
          }
        }
      } else if (i.customId.startsWith("trade_idx_")) {
        const absoluteIndex = parseInt(i.customId.split("_")[2]);
        selectedTrade = historyData[absoluteIndex];
        viewState = "trade_details";
        await i.update(renderTradeDetails(selectedTrade, latest, null));
      }
    } catch (error) {
      console.error("Interaction Error:", error);
    } finally {
      isBusy = false;
    }
  });

  collector.on("end", async (collected, reason) => {
    clearInterval(interval);
    if (reason === "time") {
      try {
        await interaction.editReply({ components: [] });
      } catch (e) {}
    }
  });
}

module.exports = fetchMarket;