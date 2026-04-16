// ============================================================================
// File: src/bot/commands/services/markets.integration.js
// Description: Zenith Institutional Trading Terminal & Quant Routing Hub
// Version: 5.0.0 - Enterprise Edition (Implementation Shortfall & Real-Time Sync)
// Architecture: Monolithic UI Controller mapped to Event-Driven Backend
// ============================================================================

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

// ============================================================================
// INFRASTRUCTURE & EVENT BUS INJECTION
// ============================================================================
// We extract the internal Event Emitter from the WebSocket connection to enable
// zero-latency Pub/Sub updates between the Iceberg backend worker and the Discord UI.
const pacificaWS = require("../../../config/ws.connection.js");
const internalBus = pacificaWS.internalBus; 

// --- UTILITIES ---
const { generateChartImage } = require("../../../../utility/chart.js");

// --- MANUAL TRADING IMPORTS ---
const marketOrder = require("./markets.command.js");
const fetchTrades = require("./history.command.js");
const updateLeverage = require("./leverage.command.js");
const getAccountInfo = require("./account.command.js");
const toggleMargin = require("./margin.command.js");
const getAccountSettings = require("./settings.command.js"); 

// --- ALGORITHMIC ROUTING IMPORTS ---
const { launchIceberg } = require("./iceberg.command.js"); 
const IcebergPool = require("../../../../database/models/iceberg.Schema.js");

// --- COPY TRADING IMPORTS ---
const { copytrade, getCopyTradeWallet } = require("./copytrade.command.js"); 
const CopyTrading = require("../../../../database/models/copyTradings.Schema.js"); 
const CopyExecution = require("../../../../database/models/copyExecution.Schema.js"); 

// ============================================================================
// CONSTANTS & ENTERPRISE CONFIGURATION
// ============================================================================
const API_BASE = "https://test-api.pacifica.fi/api/v1";

const UI_COLORS = {
    SUCCESS: 0x00ff00,
    DANGER: 0xff0000,
    PRIMARY: 0x0099ff,
    WARNING: 0xFFA500,
    NEUTRAL: 0x2b2d31,
    DARK_POOL_ACTIVE: 0x00A3FF,
    TIER_S: 0xFFD700,
    TIER_A: 0xC0C0C0,
    TIER_B: 0xCD7F32,
    TIER_C: 0xFF0000,
    TIER_D: 0x555555
};

const ERROR_DICTIONARY = {
    10062: "DISCORD_INTERACTION_TIMEOUT",
    50027: "DISCORD_WEBHOOK_EXPIRED",
    INSUFFICIENT_MARGIN: "REJECTED_INSUFFICIENT_MARGIN",
    RATE_LIMITED: "EXCHANGE_RATE_LIMIT_EXCEEDED"
};

/**
 * ============================================================================
 * HELPER FUNCTIONS
 * ============================================================================
 */

/**
 * Institutional Error Formatter
 * Safely parses nested API errors, validation errors, and network timeouts.
 * Prevents UI crashes by sanitizing raw error objects into human-readable strings.
 * @param {any} err - The raw error object caught in the try/catch block.
 * @returns {string} A safe, human-readable error string.
 */
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

/**
 * Precision Rounding Engine
 * Rounds a float value to the nearest valid step size defined by the exchange.
 * Crucial for algorithmic splitting (Iceberg) to ensure tranches aren't rejected.
 * @param {number} value - The raw calculated amount.
 * @param {number} step - The minimum increment step (e.g., lot_size or tick_size).
 * @returns {number} The cleanly rounded value safe for API submission.
 */
function roundStep(value, step) {
  if (!step || step === 0) return value;
  const inverse = 1.0 / step;
  return Math.floor(value * inverse) / inverse;
}

/**
 * Calculates Implementation Shortfall (IS) in Basis Points (bps).
 * Evaluates the performance of the algorithmic execution against the initial decision price.
 * @param {number} arrivalPrice - The market price when the algorithm was deployed.
 * @param {number} vwap - The final volume-weighted average fill price.
 * @param {string} side - "BUY" or "SELL"
 * @returns {number} The shortfall in basis points.
 */
function calculateImplementationShortfall(arrivalPrice, vwap, side) {
    if (!arrivalPrice || !vwap || arrivalPrice === 0) return 0;
    const delta = side === 'BUY' ? (vwap - arrivalPrice) : (arrivalPrice - vwap);
    return (delta / arrivalPrice) * 10000; // Return in basis points
}

/**
 * ============================================================================
 * MAIN TERMINAL CONTROLLER
 * ============================================================================
 * Handles live WS data, order execution, copy trading logic, Dark Pool slicing,
 * and institutional risk metrics via interactive Discord Components.
 * @param {Object} approvals - The Mongoose model for User approvals.
 * @param {Object} interaction - The Discord interaction object.
 */
async function fetchMarket(approvals, interaction) {
  let symbol = interaction.options.getString("symbol").toUpperCase();

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }

  // --- CORE TERMINAL STATE ---
  let viewState = "dashboard";
  let pendingSide = null;
  let isBusy = false;

  // --- CHART STATE ---
  let chartTimeframe = "1d"; 
  let chartUrl = await generateChartImage(symbol, "1d"); 

  // --- ORDER PARAMETERS ---
  let orderParams = {
    amount: 0.0,
    enteredValue: 0.0, 
    enteredType: 'token', 
    slippage: 0.5,
    tp: null,
    sl: null,
    reduceOnly: false,
  };

  // --- ACCOUNT SETTINGS (Dynamically fetched now) ---
  let accountSettings = {
    leverage: "20x",
    marginMode: "CROSS",
  };

  // --- MARKET CONSTRAINTS ---
  let marketConstraints = {
    max_leverage: 20,
    isolated_only: false,
    min_order_size: 10,
    lot_size: 0.001,
    tick_size: 0.1,
  };

  // --- COPY TRADING STATE VARIABLES ---
  let copyTargetWallet = null;
  let copyTargetMetrics = null;
  let copyRiskParams = {
    portfolioPct: 100, 
    maxTradeSizeUsd: 100,
    slippageTolerancePct: 0.5,
    maxLeverageCap: 5
  };
  
  // Dashboard Pagination & Selection State
  let copyDashPageIndex = 0;
  let copyDashActiveStreams = [];
  let selectedCopyStreamId = null;

  // Copy Trade History Pagination State
  let copyExecPageIndex = 0;
  let copyExecutionsList = [];
  let selectedCopyExecution = null;

  // --- ICEBERG / DARK POOL STATE VARIABLES ---
  let icebergHistoryData = [];
  let icebergPageIndex = 0;
  let selectedIcebergTradeId = null;

  // --- REAL-TIME PRICE MEMORY ---
  let globalPrevMark = 0;
  let globalPrevOracle = 0;

  // --- USER AUTHENTICATION ---
  const userRecord = await approvals.findOne({
    userId: interaction.user.id,
    approved: true,
  });

  if (userRecord && pacificaWS.subscribeAccount) {
    pacificaWS.subscribeAccount(userRecord.walletAddress);
  }

  /**
   * ============================================================================
   * DATA REFRESH PROTOCOLS
   * ============================================================================
   */
  const refreshMarketData = async (targetSymbol) => {
    try {
      const [infoRes, settingsRes] = await Promise.all([
        axios.get(`${API_BASE}/info`),
        userRecord
          ? getAccountSettings(userRecord.walletAddress) 
          : Promise.resolve({ success: false })
      ]);

      // Parse Market Information
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
          marketConstraints.max_leverage = parseInt(marketInfo.max_leverage, 10);
          marketConstraints.isolated_only = marketInfo.isolated_only;
          marketConstraints.min_order_size = parseFloat(marketInfo.min_order_size);
          marketConstraints.lot_size = parseFloat(marketInfo.lot_size);
          marketConstraints.tick_size = parseFloat(marketInfo.tick_size);
        }
      }

      // Parse User Account Settings for accurate UI display
      if (settingsRes && settingsRes.success && settingsRes.data) {
        const marginSettings = settingsRes.data.margin_settings || [];
        const userSettings = marginSettings.find((s) => {
          const sSym = s.symbol.toUpperCase();
          return sSym === targetSymbol || sSym === `${targetSymbol}USD`;
        });

        if (userSettings) {
          const safeLev = Math.min(parseInt(userSettings.leverage), marketConstraints.max_leverage);
          accountSettings.leverage = `${safeLev}x`;
          accountSettings.marginMode = userSettings.isolated ? "ISOLATED" : "CROSS";
        } else {
          accountSettings.leverage = `${marketConstraints.max_leverage}x`;
          accountSettings.marginMode = marketConstraints.isolated_only ? "ISOLATED" : "CROSS";
        }
      }
    } catch (e) {
      console.error(`[Market Refresh] Error:`, formatError(e));
    }
  };

  await refreshMarketData(symbol);

  // --- LOCAL HISTORY STATE ---
  let historyData = [];
  let pageIndex = 0;
  let selectedTrade = null;

  // --- WEBSOCKET INITIALIZATION WAIT ---
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

  /**
   * ============================================================================
   * CORE UI RENDERING FUNCTIONS
   * ============================================================================
   */

  /**
   * Renders the primary live trading dashboard.
   * @param {Object} tokenData - Live WS data for the selected symbol.
   */
  const renderDashboard = (tokenData) => {
    const currentPrice = parseFloat(tokenData.mark);
    const currentOracle = parseFloat(tokenData.oracle);
    const volume = parseFloat(tokenData.volume_24h).toLocaleString();

    const priceUp = currentPrice >= prevPrice;
    const oracleUp = currentOracle >= prevOracle;

    prevPrice = currentPrice;
    prevOracle = currentOracle;

    // Sync global memory for the Dark Pool renderer
    globalPrevMark = currentPrice;
    globalPrevOracle = currentOracle;

    const signPrice = priceUp ? "+" : "-";
    const signOracle = oracleUp ? "+" : "-";
    const mainColor = priceUp ? UI_COLORS.SUCCESS : UI_COLORS.DANGER;

    const embed = new EmbedBuilder()
      .setTitle(`📊 Market: ${tokenData.symbol} / USD`)
      .setColor(mainColor)
      .addFields(
        { name: "💵 Price", value: `\`\`\`diff\n${signPrice} $${currentPrice.toFixed(4)}\n\`\`\``, inline: true },
        { name: "🔮 Oracle", value: `\`\`\`diff\n${signOracle} $${currentOracle.toFixed(4)}\n\`\`\``, inline: true },
        { name: "📊 24h Vol", value: `\`\`\`\n$${volume}\n\`\`\``, inline: true },
        { name: "⚡ Funding", value: `\`\`\`\n${tokenData.funding}\n\`\`\``, inline: true },
      )
      .setImage(chartUrl)
      .setTimestamp()
      .setFooter({ text: `Updates every 2.5s • TF: ${chartTimeframe}` });

    const chartRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("tf_5m").setLabel("5m").setStyle(chartTimeframe === '5m' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("tf_1h").setLabel("1h").setStyle(chartTimeframe === '1h' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("tf_1d").setLabel("1d").setStyle(chartTimeframe === '1d' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("tf_1w").setLabel("1w").setStyle(chartTimeframe === '1w' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("tf_30d").setLabel("30d").setStyle(chartTimeframe === '30d' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("init_long").setLabel("🟢 Long").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("init_short").setLabel("🔴 Short").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("view_account").setLabel("🏦 Account").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("open_history").setLabel("📜 Normal Positions").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("switch_market").setLabel("🔍 Switch").setStyle(ButtonStyle.Secondary),
    );

    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("open_iceberg_history").setLabel("🧊 Dark Pool Ledger").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("open_copy_menu").setLabel("👥 Copy Trading Engine").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("close_terminal").setLabel("🔴 Close Terminal").setStyle(ButtonStyle.Danger),
    );

    return { embeds: [embed], components: [chartRow, row, row2] };
  };

  /**
   * Renders the user's overall account profile (Equity, Margin, Balance).
   */
  const renderAccountInfo = async () => {
    const accStats = userRecord ? await getAccountInfo(userRecord.walletAddress) : null;

    const embed = new EmbedBuilder()
      .setTitle("🏦 Account Overview")
      .setColor(UI_COLORS.PRIMARY)
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

  /**
   * Renders the initial strategy setup panel (Leverage, Margin, Reduce Only selection).
   * INSTITUTIONAL FIX: Houses the Dark Pool execution to map parameters.
   */
  const renderStrategySetup = (tokenData, side) => {
    const isLong = side === "long";
    const color = isLong ? UI_COLORS.SUCCESS : UI_COLORS.DANGER;
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
      new ButtonBuilder().setCustomId("continue_to_size").setLabel("➡️ Standard Order").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("init_iceberg").setLabel("🧊 Deploy Dark Pool").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("back").setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [row1, row2] };
  };

  /**
   * Renders the final execution confirmation panel for standard trades.
   */
  const renderConfirmation = (tokenData, side) => {
    const currentPrice = parseFloat(tokenData.mark);
    const isLong = side === "long";
    const color = isLong ? UI_COLORS.SUCCESS : UI_COLORS.DANGER;
    const priceUp = currentPrice >= prevPrice;
    prevPrice = currentPrice;
    const signPrice = priceUp ? "+" : "-";
    
    const positionValue = currentPrice * orderParams.amount;
    const levInt = parseInt(accountSettings.leverage.toString().replace("x", "")) || 1;
    const marginUsed = positionValue / levInt;
    
    const tpDisplay = orderParams.tp ? `$${orderParams.tp}` : "None";
    const slDisplay = orderParams.sl ? `$${orderParams.sl}` : "None";

    let sizeDisplay = "";
    if (orderParams.enteredType === 'usd') {
        sizeDisplay = `$${orderParams.enteredValue.toFixed(2)} (≈ ${orderParams.amount} ${tokenData.symbol})`;
    } else {
        sizeDisplay = `${orderParams.amount} ${tokenData.symbol} (≈ $${positionValue.toFixed(2)})`;
    }

    const embed = new EmbedBuilder()
      .setTitle(`🛡️ Confirm ${isLong ? "Long" : "Short"} Position`)
      .setColor(color)
      .addFields(
        { name: "Live Price", value: `\`\`\`diff\n${signPrice} $${currentPrice.toFixed(4)}\n\`\`\``, inline: false },
        { name: "📦 Size", value: `\`\`\`\n${sizeDisplay}\n\`\`\``, inline: true },
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

  /**
   * ============================================================================
   * ICEBERG & DARK POOL HISTORY
   * ============================================================================
   * Provides an institutional ledger view of all algorithmic runs.
   */
  const renderIcebergHistory = () => {
      const embed = new EmbedBuilder()
          .setTitle("🧊 Dark Pool Ledger (Historical Algos)")
          .setColor(UI_COLORS.DARK_POOL_ACTIVE)
          .setDescription("Review the performance and slicing history of proprietary iceberg deployments.");

      const itemsPerPage = 5;
      const start = icebergPageIndex * itemsPerPage;
      const end = start + itemsPerPage;
      const pageItems = icebergHistoryData.slice(start, end);
      const totalPages = Math.ceil(icebergHistoryData.length / itemsPerPage) || 1;

      if (pageItems.length === 0) {
          embed.setDescription("```\nNo historical dark pool deployments found.\n```");
      } else {
          const list = pageItems.map((algo, i) => {
              const statusIcon = algo.status === 'COMPLETED' ? "✅" : (algo.status === 'FAILED' || algo.status === 'CANCELLED' || algo.status === 'EXPIRED' ? "❌" : "⏳");
              const globalIndex = start + i + 1;
              const fillPct = ((algo.filledVolume / algo.targetVolume) * 100).toFixed(1);
              return `**${globalIndex}.** ${statusIcon} **${algo.symbol}** [${algo.side}] | Target: \`${algo.targetVolume}\` | Filled: \`${fillPct}%\`\nStatus: \`${algo.status}\` | Date: <t:${Math.floor(new Date(algo.createdAt).getTime()/1000)}:R>`;
          }).join("\n\n");
          
          embed.setDescription(`Select an algorithm below to view its VWAP metrics or cancel it.\n\n${list}`);
          embed.setFooter({ text: `Page ${icebergPageIndex + 1} of ${totalPages}` });
      }

      const components = [];
      const row1 = new ActionRowBuilder();
      
      if (pageItems.length > 0) {
          pageItems.forEach((_, idx) => {
              const absoluteIndex = start + idx;
              row1.addComponents(
                  new ButtonBuilder()
                      .setCustomId(`iceberg_trade_idx_${absoluteIndex}`)
                      .setLabel(`${start + idx + 1}`)
                      .setStyle(ButtonStyle.Secondary)
              );
          });
          components.push(row1);
      }

      const navRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("iceberg_history_prev").setLabel("⬅️ Prev").setStyle(ButtonStyle.Primary).setDisabled(icebergPageIndex === 0),
          new ButtonBuilder().setCustomId("back").setLabel("🏠 Terminal").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("iceberg_history_next").setLabel("Next ➡️").setStyle(ButtonStyle.Primary).setDisabled(end >= icebergHistoryData.length),
      );
      components.push(navRow);

      return { embeds: [embed], components: components };
  };

  /**
   * Renders the live or static status of a specific Iceberg Dark Pool order.
   * Doubles as the detail view from the history tab.
   * INSTITUTIONAL FIX: Incorporates Transaction Cost Analysis (Implementation Shortfall).
   */
  const renderIcebergStatus = (order) => {
      // Fetch live data directly from WS memory for instantaneous UI updates
      const liveData = pacificaWS.getPrice(order.symbol);
      const markPrice = liveData ? parseFloat(liveData.mark) : 0;
      const oraclePrice = liveData ? parseFloat(liveData.oracle) : 0;
      
      const priceUp = markPrice >= globalPrevMark;
      const oracleUp = oraclePrice >= globalPrevOracle;
      if (liveData) {
          globalPrevMark = markPrice;
          globalPrevOracle = oraclePrice;
      }

      const length = 20;
      const percentage = Math.min(order.filledVolume / order.targetVolume, 1);
      const filledLength = Math.round(length * percentage);
      const progressBar = `[${"▓".repeat(filledLength)}${"░".repeat(length - filledLength)}] ${(percentage * 100).toFixed(1)}%`;

      let color = 0xFFA500; 
      if (order.status === 'COMPLETED') color = UI_COLORS.SUCCESS;
      if (['EXPIRED', 'FAILED', 'CANCELLED'].includes(order.status)) color = UI_COLORS.DANGER;

      // 📊 TRANSACTION COST ANALYSIS (Implementation Shortfall)
      const avgFill = order.averageFillPrice || 0;
      let shortfallBps = 0;
      let tcaString = "Pending...";

      if (order.arrivalPrice && order.arrivalPrice > 0 && avgFill > 0) {
          shortfallBps = calculateImplementationShortfall(order.arrivalPrice, avgFill, order.side);
          const formattedBps = Math.abs(shortfallBps).toFixed(1);
          if (shortfallBps > 0) {
              tcaString = `+${formattedBps} bps (Slippage)`;
          } else {
              tcaString = `-${formattedBps} bps (Beating Arrival)`;
          }
      }

      const embed = new EmbedBuilder()
          .setTitle(`🧊 Dark Pool Execution: ${order.symbol} [${order.side}]`)
          .setColor(color)
          .setDescription(`Algorithmic slicing protocol. Market impact mitigated.\n\n\`\`\`\n${progressBar}\n\`\`\``)
          .addFields(
              { name: "📡 Live Mark", value: `\`\`\`diff\n${priceUp ? "+" : "-"} $${markPrice.toFixed(4)}\n\`\`\``, inline: true },
              { name: "🔮 Live Oracle", value: `\`\`\`diff\n${oracleUp ? "+" : "-"} $${oraclePrice.toFixed(4)}\n\`\`\``, inline: true },
              { name: "⚖️ Firewall Limit", value: `\`\`\`\n${order.limitPrice ? `$${order.limitPrice}` : "None"}\n\`\`\``, inline: true },
              
              { name: "📦 Target Volume", value: `\`${order.targetVolume} ${order.symbol}\``, inline: true },
              { name: "📈 Avg Fill (VWAP)", value: `\`$${avgFill.toFixed(4)}\``, inline: true },
              { name: "📊 TCA Impact", value: `\`${tcaString}\``, inline: true },
              
              { name: "🔪 Ghost Tranches", value: `\`${order.executionLedger?.length || 0}\``, inline: true },
              { name: "✅ Filled", value: `\`${order.filledVolume.toFixed(4)}\``, inline: true },
              { name: "🥷 Hidden Reserve", value: `\`${Math.max(order.targetVolume - order.filledVolume, 0).toFixed(4)}\``, inline: true },
              
              { name: "System Status", value: `**${order.status}**`, inline: false }
          )
          .setFooter({ text: `Zenith Iceberg Engine V2 | Arrival: $${order.arrivalPrice || "N/A"}` });

      if (order.errorMessage) {
          embed.addFields({ name: "⚠️ System Log", value: order.errorMessage });
      }

      const components = [];
      const actionRow = new ActionRowBuilder();
      
      // Allow cancellation if the engine is actively routing
      if (['INITIALIZING', 'ROUTING', 'PAUSED_FIREWALL', 'RUNNING'].includes(order.status)) {
          actionRow.addComponents(
              new ButtonBuilder()
                  .setCustomId(`cancel_iceberg_action_${order._id.toString()}`)
                  .setLabel("🛑 Emergency Abort")
                  .setStyle(ButtonStyle.Danger)
          );
      }

      actionRow.addComponents(
          new ButtonBuilder()
              .setCustomId("open_iceberg_history")
              .setLabel("⬅️ Back to Ledger")
              .setStyle(ButtonStyle.Secondary)
      );
      
      components.push(actionRow);
      return { embeds: [embed], components: components };
  };

  /**
   * 🚀 REAL-TIME EVENT BUS LISTENER FOR ICEBERGS
   * Intercepts broadcasts from the internal Node event emitter.
   * Allows the UI to update with 0-latency the millisecond a tranche fills.
   * Includes strict Discord Webhook Detachment Logic.
   */
  const liveUpdateHandler = async (algoData) => {
      // Zero-Latency UI Render: Only update if the user is actively viewing this specific Iceberg
      if (viewState === "iceberg_executing" && selectedIcebergTradeId === algoData._id.toString()) {
          try {
              await interaction.editReply(renderIcebergStatus(algoData));
          } catch (e) {
              // Discord Interaction Webhooks expire after exactly 15 minutes.
              // We detach the listener so the UI gracefully dies while backend logic continues.
              if (e.code === 50027 || e.code === 10062) {
                  console.log(`[UI Detach] Token expired for Iceberg ${algoData._id}. Detaching UI listener.`);
                  if (internalBus) internalBus.removeListener('ICEBERG_UPDATE', liveUpdateHandler);
              } else {
                  console.error("Failed to push real-time UI update:", e.message);
              }
          }
      }
  };

  // Bind the listener to the global hub to catch backend execution loops
  if (internalBus) {
      internalBus.on('ICEBERG_UPDATE', liveUpdateHandler);
  }

  /**
   * ============================================================================
   * STANDARD TRADING HISTORY (OPEN POSITIONS)
   * ============================================================================
   */
  const renderHistory = (allTrades) => {
    const embed = new EmbedBuilder().setTitle("📜 Trade History (Open Positions)").setColor(UI_COLORS.NEUTRAL);
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
    const color = isShort ? UI_COLORS.DANGER : UI_COLORS.SUCCESS;
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

  /**
   * ============================================================================
   * INSTITUTIONAL COPY TRADING METRICS & ENGINE
   * ============================================================================
   */
  const calculateStreamPerformance = async (streamId) => {
      try {
          const executions = await CopyExecution.find({ copyStreamId: streamId, "followerExecution.status": "SUCCESS" }).sort({ createdAt: -1 });
          let totalSessionVol = 0;
          let totalUnrealizedPnl = 0;
          
          const openPositions = {}; 

          executions.forEach(ex => {
              const sym = ex.symbol;
              const side = ex.side.toUpperCase();
              const amt = parseFloat(ex.followerExecution?.amount || 0);
              const price = parseFloat(ex.whaleExecution?.price || 0);

              totalSessionVol += (amt * price);

              if (!openPositions[sym]) {
                  openPositions[sym] = { amount: 0, avgEntry: 0, isShort: false };
              }

              if (side === "BUY") {
                  const newAmt = openPositions[sym].amount + amt;
                  openPositions[sym].avgEntry = ((openPositions[sym].amount * openPositions[sym].avgEntry) + (amt * price)) / newAmt;
                  openPositions[sym].amount = newAmt;
                  openPositions[sym].isShort = false;
              } else if (side === "SELL") {
                  openPositions[sym].amount = Math.max(0, openPositions[sym].amount - amt);
              }
          });

          for (const [sym, pos] of Object.entries(openPositions)) {
              if (pos.amount > 0) {
                  const liveData = pacificaWS.getPrice(sym);
                  if (liveData) {
                      const markPrice = parseFloat(liveData.mark);
                      if (pos.isShort) {
                          totalUnrealizedPnl += (pos.avgEntry - markPrice) * pos.amount;
                      } else {
                          totalUnrealizedPnl += (markPrice - pos.avgEntry) * pos.amount;
                      }
                  }
              }
          }

          return {
              sessionVolume: totalSessionVol,
              sessionPnl: totalUnrealizedPnl,
              tradeCount: executions.length
          };
      } catch (err) {
          console.error("[Stream Performance Error]:", err);
          return { sessionVolume: 0, sessionPnl: 0, tradeCount: 0 };
      }
  };

  const renderCopyMenu = () => {
    const embed = new EmbedBuilder()
      .setTitle("👥 Zenith Copy-Trading Engine")
      .setDescription("Welcome to the institutional copy-trading portal. Mirror the trades of top-tier whales completely on-chain with unified risk management.")
      .setColor(0x00A3FF)
      .addFields(
        { name: "Target Wallet", value: copyTargetWallet ? `\`${copyTargetWallet}\`` : "None Selected" },
        { name: "Risk Profile (1:1 Active)", value: `Max Trade: **$${copyRiskParams.maxTradeSizeUsd}**\nLeverage Cap: **${copyRiskParams.maxLeverageCap}x**\nSlippage: **${copyRiskParams.slippageTolerancePct}%**` }
      )
      .setFooter({ text: "Powered by Zenith Risk Engine | 1:1 Mirror Sizing" });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("set_copy_target").setLabel("🎯 Set Target").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("set_copy_risk").setLabel("⚙️ Adjust Risk Params").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("manage_active_copies").setLabel("🛠️ Manage Copies").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("confirm_copy_trade").setLabel("✅ Start").setStyle(ButtonStyle.Success).setDisabled(!copyTargetWallet || !copyTargetMetrics),
    );
    
    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("back").setLabel("⬅️ Back to Terminal").setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row, navRow] };
  };

  const renderCopyTargetPreview = (customMetrics = null) => {
    const stats = customMetrics || copyTargetMetrics || {};
    const lb = stats.leaderboard || {};
    const ov = stats.overview || {};
    const ts = stats.tradeStats || {};
    const rm = stats.riskMetrics || {};
    const rt = stats.ratios || {};
    const bh = stats.behavioral || {};
    const ps = stats.positionSizing || {};

    const rank = lb.rankTier || "Unranked";
    const tierColors = { "S": UI_COLORS.TIER_S, "A": UI_COLORS.TIER_A, "B": UI_COLORS.TIER_B, "C": UI_COLORS.TIER_C, "D": UI_COLORS.TIER_D, "Unranked": UI_COLORS.NEUTRAL };
    const color = tierColors[rank] || UI_COLORS.PRIMARY;

    const fmt = (val, suffix = "") => val !== null && val !== undefined ? `${Number(val).toFixed(2)}${suffix}` : "N/A";
    const fmtInt = (val, suffix = "") => val !== null && val !== undefined ? `${Math.round(val)}${suffix}` : "N/A";

    const embed = new EmbedBuilder()
      .setTitle("🔍 Target Wallet Analysis")
      .setDescription(`Deep-scan complete using Zenith Metrics Engine V2.`)
      .setColor(color)
      .addFields(
        { name: "🏆 Rank & Score", value: `Tier: **${rank}**\nScore: **${fmtInt(lb.zenithScore)}**`, inline: true },
        { name: "⏱️ Overview", value: `Active: **${fmtInt(ov.daysActive, "d")}**\nTrades: **${fmtInt(ov.totalTrades)}**`, inline: true },
        { name: "💰 Returns", value: `Net Return: **${fmt(ov.simpleReturnPct, "%")}**\nCAGR: **${fmt(ov.cagrPct, "%")}**`, inline: true },
        { name: "📊 Win / Loss", value: `Win Rate: **${fmt(ts.winRatePct, "%")}**\nProfit Factor: **${fmt(ts.profitFactor)}**`, inline: true },
        { name: "⚖️ Average Trade", value: `Avg Win: **$${fmt(ts.avgWinUsdc)}**\nAvg Loss: **$${fmt(ts.avgLossUsdc)}**`, inline: true },
        { name: "⚠️ Extremes", value: `Max Win: **$${fmt(ts.largestWinUsdc)}**\nMax Loss: **$${fmt(ts.largestLossUsdc)}**\nMax Streak: **${fmtInt(rm.maxLosingStreak)} L**`, inline: true },
        { name: "📉 Tail Risk", value: `Max Drawdown: **${fmt(rm.maxDrawdownPct, "%")}**\nCVaR (95%): **${fmt(rm.cvar95DailyPct, "%")}**`, inline: true },
        { name: "📈 Quant Ratios", value: `Sharpe: **${fmt(rt.sharpeAnnualized)}**\nSortino: **${fmt(rt.sortinoAnnualized)}**\nCalmar: **${fmt(rt.calmarRatio)}**`, inline: true },
        { name: "🧠 Behavioral & Kelly", value: `Opt-F: **${fmt(ps.optimalFPct, "%")}**\nRevenge: **${fmt(bh.revengeTradeRatePct, "%")}**\nOvertrade: **${fmtInt(bh.overtradingScore)}/100**`, inline: true }
      )
      .setFooter({ text: "Zenith Quant Analytics Engine V2" });

    if (customMetrics) {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("back_to_stream_details").setLabel("⬅️ Back to Details").setStyle(ButtonStyle.Secondary)
        );
        return { embeds: [embed], components: [row] };
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("set_copy_risk").setLabel("⚙️ Set Risk Params").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("confirm_copy_trade").setLabel("✅ Start Copying").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("open_copy_menu").setLabel("⬅️ Back").setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row] };
  };

  const fetchActiveStreams = async () => {
      if (!userRecord) return [];
      return await CopyTrading.find({ followerWallet: userRecord.walletAddress }).sort({ createdAt: -1 });
  };

  const renderCopyDashboard = async () => {
    copyDashActiveStreams = await fetchActiveStreams();

    const embed = new EmbedBuilder()
      .setTitle("🛠️ Institutional Copy Streams Dashboard")
      .setColor(0x0099ff)
      .setTimestamp();

    const itemsPerPage = 5;
    const start = copyDashPageIndex * itemsPerPage;
    const end = start + itemsPerPage;
    const pageItems = copyDashActiveStreams.slice(start, end);
    const totalPages = Math.ceil(copyDashActiveStreams.length / itemsPerPage) || 1;

    const components = [];
    const buttonRow = new ActionRowBuilder();

    if (pageItems.length === 0) {
        embed.setDescription("```\nYou are not currently mirroring any whales.\n```");
    } else {
        const descriptions = await Promise.all(pageItems.map(async (stream, i) => {
            const statusIcon = stream.isActive ? "🟢 ACTIVE" : "🔴 STOPPED";
            const performance = await calculateStreamPerformance(stream._id);
            const pnl = performance.sessionPnl;
            const colorCode = pnl >= 0 ? "diff\n+" : "diff\n-";
            const absoluteIndex = start + i + 1;
            
            buttonRow.addComponents(
                new ButtonBuilder().setCustomId(`select_stream_${stream._id}`).setLabel(`${absoluteIndex}`).setStyle(stream.isActive ? ButtonStyle.Success : ButtonStyle.Secondary)
            );
            
            return `**${absoluteIndex}. Whale:** \`${stream.targetWallet}\`\nStatus: \`${statusIcon}\` | Total Vol: \`$${performance.sessionVolume.toFixed(2)}\` | Trades: \`${performance.tradeCount}\`\nSession PnL: \`\`\`${colorCode} $${Math.abs(pnl).toFixed(2)}\n\`\`\``;
        }));
        
        embed.setDescription(`Select a stream number below to manage settings or view performance.\n\n${descriptions.join("\n\n")}`);
        embed.setFooter({ text: `Page ${copyDashPageIndex + 1} of ${totalPages}` });
        components.push(buttonRow);
    }

    const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("dash_page_prev").setLabel("⬅️ Prev").setStyle(ButtonStyle.Primary).setDisabled(copyDashPageIndex === 0),
        new ButtonBuilder().setCustomId("open_copy_menu").setLabel("🏠 Return to Menu").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("dash_page_next").setLabel("Next ➡️").setStyle(ButtonStyle.Primary).setDisabled(end >= copyDashActiveStreams.length)
    );
    components.push(navRow);

    return { embeds: [embed], components: components };
  };

  const renderCopyStreamDetails = async (streamId) => {
      const stream = await CopyTrading.findById(streamId);
      if (!stream) return renderCopyDashboard();

      selectedCopyStreamId = stream._id;
      const performance = await calculateStreamPerformance(stream._id);

      const blacklistStr = stream.assetBlacklist && stream.assetBlacklist.length > 0 
          ? stream.assetBlacklist.join(", ") 
          : "None";

      const embed = new EmbedBuilder()
        .setTitle(`⚙️ Stream Management Panel`)
        .setDescription(`Target Whale: \`${stream.targetWallet}\`\nStatus: **${stream.isActive ? "🟢 ACTIVE" : "🔴 STOPPED"}**`)
        .setColor(stream.isActive ? 0x00ff00 : 0x555555)
        .addFields(
            { name: "🛡️ Risk Parameters", value: `Max Trade: **$${stream.maxTradeSizeUsd}**\nLeverage Cap: **${stream.maxLeverageCap}x**\nSlippage: **${stream.slippageTolerancePct}%**`, inline: true },
            { name: "🚫 Blacklisted Assets", value: `\`\`\`\n${blacklistStr}\n\`\`\``, inline: true },
            { name: "📊 Session Activity", value: `Total Traded Vol: **$${performance.sessionVolume.toFixed(2)}**\nTrades Copied: **${performance.tradeCount}**\nSession PnL: **$${performance.sessionPnl.toFixed(2)}**\nStarted: <t:${Math.floor(new Date(stream.createdAt).getTime() / 1000)}:R>`, inline: false }
        )
        .setFooter({ text: "Use buttons below to update live parameters or view trade history." });

      const row1 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("edit_stream_risk").setLabel("⚙️ Edit Risk Params").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("edit_stream_blacklist").setLabel("🚫 Edit Blacklist").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("view_stream_report").setLabel("📈 View Zenith Report").setStyle(ButtonStyle.Success)
      );

      const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("view_copy_history").setLabel("📜 View Copied Trades").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("toggle_stream_status").setLabel(stream.isActive ? "🛑 Stop Copying" : "▶️ Resume Copying").setStyle(stream.isActive ? ButtonStyle.Danger : ButtonStyle.Success),
          new ButtonBuilder().setCustomId("manage_active_copies").setLabel("⬅️ Back to Dashboard").setStyle(ButtonStyle.Secondary)
      );

      return { embeds: [embed], components: [row1, row2] };
  };

  const renderCopyHistory = async () => {
      if (!selectedCopyStreamId) return renderCopyDashboard();
      
      const executions = await CopyExecution.find({ copyStreamId: selectedCopyStreamId }).sort({ createdAt: -1 });
      copyExecutionsList = executions;

      const embed = new EmbedBuilder().setTitle("📜 Copied Trade History").setColor(0x2b2d31);
      const itemsPerPage = 5;
      const start = copyExecPageIndex * itemsPerPage;
      const end = start + itemsPerPage;
      const pageItems = copyExecutionsList.slice(start, end);
      const canGoNext = copyExecutionsList.length > end;
      const canGoPrev = copyExecPageIndex > 0;
      const startIndex = start + 1;

      if (pageItems.length === 0) {
        embed.setDescription("```\nNo copied trades found for this stream.\n```");
      } else {
        const list = pageItems.map((t, i) => {
            const emoji = t.side.toUpperCase() === "BUY" ? "🟢" : "🔴";
            const globalIndex = startIndex + i;
            const statusStr = t.followerExecution?.status === "SUCCESS" ? "✅" : "❌";
            const price = t.whaleExecution?.price ? `$${t.whaleExecution.price.toFixed(4)}` : "MKT";
            return `**${globalIndex}.** ${statusStr} ${emoji} **${t.symbol}** | \`${t.followerExecution?.amount || 0}\` @ \`${price}\``;
          }).join("\n\n");
        embed.setDescription(`Select a trade number to view or manage it.\n\n${list}`);
        embed.setFooter({ text: `Page ${copyExecPageIndex + 1}/${Math.ceil(copyExecutionsList.length / itemsPerPage) || 1}` });
      }

      const components = [];
      const tradeRow = new ActionRowBuilder();
      
      if (pageItems.length > 0) {
        pageItems.forEach((_, idx) => {
          const absoluteIndex = start + idx;
          tradeRow.addComponents(new ButtonBuilder().setCustomId(`copy_trade_idx_${absoluteIndex}`).setLabel(`${startIndex + idx}`).setStyle(ButtonStyle.Secondary));
        });
        components.push(tradeRow);
      }
      
      const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("copy_history_prev").setLabel("⬅️ Prev").setStyle(ButtonStyle.Primary).setDisabled(!canGoPrev),
        new ButtonBuilder().setCustomId("back_to_stream_details").setLabel("⬅️ Stream Details").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("copy_history_next").setLabel("Next ➡️").setStyle(ButtonStyle.Primary).setDisabled(!canGoNext),
      );
      
      components.push(navRow);
      return { embeds: [embed], components: components };
  };

  const renderCopyTradeDetail = (execution) => {
      const isSuccess = execution.followerExecution?.status === "SUCCESS";
      const color = isSuccess ? (execution.side.toUpperCase() === "BUY" ? UI_COLORS.SUCCESS : UI_COLORS.DANGER) : UI_COLORS.NEUTRAL;
      
      const embed = new EmbedBuilder()
          .setTitle(`🔎 Copied Trade: ${execution.symbol}`)
          .setColor(color)
          .addFields(
              { name: "Direction", value: `\`\`\`diff\n${execution.side.toUpperCase() === "BUY" ? "+ LONG" : "- SHORT"}\n\`\`\``, inline: true },
              { name: "Status", value: `\`\`\`\n${execution.followerExecution?.status || "PENDING"}\n\`\`\``, inline: true },
              { name: "Amount Copied", value: `\`\`\`\n${execution.followerExecution?.amount || 0} ${execution.symbol}\n\`\`\``, inline: true },
              { name: "Whale Entry Price", value: `\`\`\`\n$${execution.whaleExecution?.price?.toFixed(4) || "UNKNOWN"}\n\`\`\``, inline: true },
              { name: "Order ID (Exchange)", value: `\`\`\`\n${execution.followerExecution?.orderId || "N/A"}\n\`\`\``, inline: true },
              { name: "Execution Latency", value: `\`\`\`\n${execution.followerExecution?.latencyMs || 0} ms\n\`\`\``, inline: true },
          )
          .setTimestamp(execution.createdAt);

      const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("close_copied_trade").setLabel("Emergency Close Position").setStyle(ButtonStyle.Danger).setDisabled(!isSuccess),
          new ButtonBuilder().setCustomId("view_copy_history").setLabel("⬅️ Back to List").setStyle(ButtonStyle.Secondary)
      );

      return { embeds: [embed], components: [row] };
  };

  /**
   * ============================================================================
   * POLLING, EVENT LISTENERS & COLLECTORS
   * ============================================================================
   */

  const message = await interaction.editReply(renderDashboard(data));

  const interval = setInterval(async () => {
    if (isBusy) return;
    try {
      // Prevent dashboard overwrite during specific static views
      if (
          viewState === "history" || 
          viewState === "success" || 
          viewState === "executing" || 
          viewState === "expired" || 
          viewState === "closed" || 
          viewState.startsWith("copy_") || 
          viewState === "iceberg_executing" || 
          viewState === "iceberg_history"
      ) return;

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
    time: 840_000, // 14 Minute Collector Timeout
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

      // ==========================================
      // 🧊 DARK POOL ICEBERG ENGINE INJECTION
      // ==========================================
      
      else if (i.customId === "init_iceberg") {
        // Automatically inherit direction from Strategy Setup
        const modal = new ModalBuilder().setCustomId("iceberg_modal").setTitle(`Deploy Dark Pool: ${symbol} ${pendingSide.toUpperCase()}`);
        
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("total_amt").setLabel(`Total Size (${symbol})`).setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("chunk_amt").setLabel(`Base Tranche Size (${symbol})`).setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("interval").setLabel("Base Interval (ms, min 500)").setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("limit_price").setLabel("Price Ceiling/Floor (Optional)").setStyle(TextInputStyle.Short).setRequired(false))
        );
        
        await i.showModal(modal);

        try {
            const sub = await i.awaitModalSubmit({ time: 60000, filter: (s) => s.user.id === i.user.id });
            
            const ibSide = pendingSide.toLowerCase(); 
            const totalAmt = parseFloat(sub.fields.getTextInputValue("total_amt"));
            const chunkAmt = parseFloat(sub.fields.getTextInputValue("chunk_amt"));
            const intervalMs = parseInt(sub.fields.getTextInputValue("interval"));
            const rawLimit = sub.fields.getTextInputValue("limit_price");
            const limitPrice = rawLimit ? parseFloat(rawLimit) : null;

            // Strict Validation checks
            if (isNaN(totalAmt) || isNaN(chunkAmt) || isNaN(intervalMs) || chunkAmt >= totalAmt || chunkAmt <= 0 || intervalMs < 500) {
                await sub.reply({ content: "❌ Invalid Dark Pool parameters. Ensure Chunk < Total and Interval >= 500ms.", ephemeral: true });
                return;
            }

            viewState = "iceberg_executing";
            await sub.deferUpdate();

            // Fire the asynchronous backend engine
            const response = await launchIceberg(
                userRecord.walletAddress, 
                symbol, 
                ibSide, 
                totalAmt, 
                chunkAmt, 
                intervalMs, 
                limitPrice, 
                orderParams.slippage, 
                userRecord.builderCode
            );
            
            if (!response.success) {
                viewState = "dashboard";
                await i.editReply({ content: `❌ Launch Failed: ${response.error}`, embeds: [], components: [] });
            } else {
                selectedIcebergTradeId = response.icebergId.toString(); 
                
                const initialOrderObj = {
                    _id: response.icebergId.toString(),
                    symbol: symbol,
                    side: ibSide.toUpperCase(),
                    targetVolume: totalAmt,
                    filledVolume: 0,
                    averageFillPrice: 0,
                    arrivalPrice: latest ? parseFloat(latest.mark) : 0,
                    executionLedger: [],
                    status: 'INITIALIZING',
                    limitPrice: limitPrice
                };
                
                await i.editReply(renderIcebergStatus(initialOrderObj));
            }
        } catch (e) {} // Ignore modal timeouts gracefully
      }

      // --- ICEBERG HISTORY & LEDGER ROUTES ---
      else if (i.customId === "open_iceberg_history") {
          await i.deferUpdate();
          if (!userRecord) return i.followUp({ content: "❌ Wallet not linked.", ephemeral: true });
          
          try {
              const hist = await IcebergPool.find({ walletAddress: userRecord.walletAddress }).sort({ createdAt: -1 });
              icebergHistoryData = hist;
              icebergPageIndex = 0;
              viewState = "iceberg_history";
              await i.editReply(renderIcebergHistory());
          } catch (err) {
              console.error(err);
              await i.followUp({ content: "❌ Failed to load Dark Pool Ledger.", ephemeral: true });
          }
      }

      else if (i.customId === "iceberg_history_prev" || i.customId === "iceberg_history_next") {
          await i.deferUpdate();
          if (i.customId === "iceberg_history_prev") icebergPageIndex = Math.max(0, icebergPageIndex - 1);
          else icebergPageIndex++;
          await i.editReply(renderIcebergHistory());
      }

      else if (i.customId.startsWith("iceberg_trade_idx_")) {
          await i.deferUpdate();
          const absoluteIndex = parseInt(i.customId.replace("iceberg_trade_idx_", ""));
          const algoObj = icebergHistoryData[absoluteIndex];
          if (algoObj) {
              selectedIcebergTradeId = algoObj._id.toString();
              // Lock into executing state so the WS updater will catch live updates if it's currently running
              viewState = "iceberg_executing"; 
              await i.editReply(renderIcebergStatus(algoObj));
          }
      }

      else if (i.customId.startsWith("cancel_iceberg_action_")) {
          await i.deferUpdate();
          const targetId = i.customId.replace("cancel_iceberg_action_", "");
          try {
              // Update the DB immediately. The backend engine will check this DB status before its next tranche!
              const algo = await IcebergPool.findById(targetId);
              if (algo && ['INITIALIZING', 'ROUTING', 'PAUSED_FIREWALL', 'RUNNING'].includes(algo.status)) {
                  algo.status = 'CANCELLED';
                  algo.errorMessage = "Forcefully aborted by user command.";
                  algo.completedAt = Date.now();
                  await algo.save();
                  
                  // Broadcast the kill so the UI updates instantly
                  if (internalBus) internalBus.emit('ICEBERG_UPDATE', algo);
                  
                  await i.editReply(renderIcebergStatus(algo));
                  await interaction.followUp({ content: "✅ Dark Pool routing sequence forcefully aborted.", ephemeral: true });
              }
          } catch (err) {
              await interaction.followUp({ content: `❌ Abort failed: ${err.message}`, ephemeral: true });
          }
      }

      // ==========================================
      // --- COPY TRADING UI ROUTING ---
      // ==========================================
      else if (i.customId === "open_copy_menu") {
        if (!userRecord) {
          await i.reply({ content: "❌ You must link your wallet before using the Copy Engine.", ephemeral: true });
        } else {
          viewState = "copy_menu";
          await i.update(renderCopyMenu());
        }
      } 
      
      else if (i.customId === "set_copy_target") {
        const modal = new ModalBuilder().setCustomId("copy_target_modal").setTitle("Set Target Wallet");
        const walletInput = new TextInputBuilder()
          .setCustomId("target_address")
          .setLabel("Whale Wallet Address")
          .setPlaceholder("e.g. 42trU9A5...")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(walletInput));
        await i.showModal(modal);

        try {
          const sub = await i.awaitModalSubmit({ time: 60000, filter: (s) => s.user.id === i.user.id });
          const enteredWallet = sub.fields.getTextInputValue("target_address").trim();
          
          viewState = "copy_fetching";
          await sub.update({ 
            embeds: [new EmbedBuilder()
              .setTitle("⏳ Analyzing Target Wallet...")
              .setDescription("Running Zenith Risk Engine. This may take up to 45 seconds for whales with massive trade history...")
              .setColor(0xFFA500)],
            components: []
          });

          try {
            const targetUser = await getCopyTradeWallet(enteredWallet);
            
            let metrics = targetUser?.quantMetrics;
            if (!metrics || !metrics.leaderboard) {
                throw new Error("Wallet scanned successfully, but metric calculation failed.");
            }

            copyTargetWallet = enteredWallet;
            copyTargetMetrics = metrics;
            viewState = "copy_preview";
            await sub.editReply(renderCopyTargetPreview());
          } catch (err) {
            viewState = "copy_menu";
            await sub.editReply({
               embeds: [new EmbedBuilder().setTitle("❌ Scan Failed").setDescription(err.message).setColor(0xff0000)],
               components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("open_copy_menu").setLabel("⬅️ Back").setStyle(ButtonStyle.Secondary))]
            });
          }
        } catch (e) { /* Modal timeout ignored */ }
      } 
      
      else if (i.customId === "set_copy_risk") {
        const modal = new ModalBuilder().setCustomId("copy_risk_modal").setTitle("Set 1:1 Risk Limits");
        
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("max_usd").setLabel("Max Trade Size ($ USD)").setValue(copyRiskParams.maxTradeSizeUsd.toString()).setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("lev_cap").setLabel("Max Leverage Cap (e.g. 5)").setValue(copyRiskParams.maxLeverageCap.toString()).setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("slip_pct").setLabel("Slippage Tolerance (%)").setValue(copyRiskParams.slippageTolerancePct.toString()).setStyle(TextInputStyle.Short).setRequired(true))
        );
        
        await i.showModal(modal);

        try {
          const sub = await i.awaitModalSubmit({ time: 60000, filter: (s) => s.user.id === i.user.id });
          
          const mUsd = parseFloat(sub.fields.getTextInputValue("max_usd"));
          const lCap = parseFloat(sub.fields.getTextInputValue("lev_cap"));
          const sPct = parseFloat(sub.fields.getTextInputValue("slip_pct"));

          if (isNaN(mUsd) || isNaN(sPct) || isNaN(lCap)) {
            await sub.reply({ content: "❌ Invalid risk parameters entered.", ephemeral: true });
          } else {
            copyRiskParams = { portfolioPct: 100, maxTradeSizeUsd: mUsd, slippageTolerancePct: sPct, maxLeverageCap: lCap };
            
            if (copyTargetWallet && copyTargetMetrics) {
                viewState = "copy_preview";
                await sub.update(renderCopyTargetPreview());
            } else {
                viewState = "copy_menu";
                await sub.update(renderCopyMenu());
            }
          }
        } catch (e) {}
      } 
      
      else if (i.customId === "confirm_copy_trade") {
        await i.deferUpdate();
        viewState = "copy_executing";
        
        const response = await copytrade(userRecord.walletAddress, copyTargetWallet, copyRiskParams);
        
        if (!response.success) {
           viewState = "copy_preview";
           await i.editReply({
              embeds: [new EmbedBuilder().setTitle("❌ Copy Failed").setDescription(response.error).setColor(0xff0000)],
              components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("open_copy_menu").setLabel("⬅️ Back").setStyle(ButtonStyle.Secondary))]
           });
        } else {
           viewState = "copy_success";
           let warnText = response.warnings && response.warnings.length > 0 ? `\n\n**Warnings:**\n${response.warnings.join("\n")}` : "";
           
           const successEmbed = new EmbedBuilder()
             .setTitle("🔗 1:1 Mirror Stream Active")
             .setDescription(`${response.message}${warnText}`)
             .setColor(0x00ff00)
             .addFields(
               { name: "Follower Wallet", value: `\`${userRecord.walletAddress}\`` },
               { name: "Target Whale", value: `\`${copyTargetWallet}\`` }
             )
             .setTimestamp();
             
           const row = new ActionRowBuilder().addComponents(
               new ButtonBuilder().setCustomId("manage_active_copies").setLabel("🛠️ View Active Streams").setStyle(ButtonStyle.Primary),
               new ButtonBuilder().setCustomId("back").setLabel("🏠 Terminal").setStyle(ButtonStyle.Secondary)
            );
           await i.editReply({ embeds: [successEmbed], components: [row] });
        }
      }

      // ==========================================
      // --- ADVANCED DASHBOARD HANDLERS ---
      // ==========================================
      else if (i.customId === "manage_active_copies") {
        await i.deferUpdate();
        viewState = "copy_dashboard";
        copyDashPageIndex = 0; 
        await i.editReply(await renderCopyDashboard());
      }
      
      else if (i.customId === "dash_page_prev" || i.customId === "dash_page_next") {
        await i.deferUpdate();
        if (i.customId === "dash_page_prev") copyDashPageIndex = Math.max(0, copyDashPageIndex - 1);
        else copyDashPageIndex++;
        await i.editReply(await renderCopyDashboard());
      }

      else if (i.customId.startsWith("select_stream_")) {
        await i.deferUpdate();
        const targetId = i.customId.replace("select_stream_", "");
        viewState = "copy_stream_details";
        await i.editReply(await renderCopyStreamDetails(targetId));
      }

      else if (i.customId === "back_to_stream_details") {
        await i.deferUpdate();
        viewState = "copy_stream_details";
        if (selectedCopyStreamId) {
            await i.editReply(await renderCopyStreamDetails(selectedCopyStreamId));
        } else {
            await i.editReply(await renderCopyDashboard());
        }
      }

      else if (i.customId === "toggle_stream_status") {
        await i.deferUpdate();
        if (selectedCopyStreamId) {
            const stream = await CopyTrading.findById(selectedCopyStreamId);
            if (stream) {
                stream.isActive = !stream.isActive;
                await stream.save();
                await i.editReply(await renderCopyStreamDetails(selectedCopyStreamId));
            }
        }
      }

      else if (i.customId === "view_stream_report") {
        await i.deferUpdate();
        if (selectedCopyStreamId) {
            const stream = await CopyTrading.findById(selectedCopyStreamId);
            if (stream && stream.targetMetricsSnapshot) {
                viewState = "copy_report";
                await i.editReply(renderCopyTargetPreview(stream.targetMetricsSnapshot));
            }
        }
      }

      else if (i.customId === "edit_stream_risk") {
        if (!selectedCopyStreamId) return;
        const stream = await CopyTrading.findById(selectedCopyStreamId);
        
        const modal = new ModalBuilder().setCustomId("edit_stream_risk_modal").setTitle("Update Live Risk Params");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("max_usd").setLabel("Max Trade Size ($ USD)").setValue(stream.maxTradeSizeUsd.toString()).setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("lev_cap").setLabel("Max Leverage Cap").setValue(stream.maxLeverageCap.toString()).setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("slip_pct").setLabel("Slippage Tolerance (%)").setValue(stream.slippageTolerancePct.toString()).setStyle(TextInputStyle.Short).setRequired(true))
        );
        
        await i.showModal(modal);

        try {
            const sub = await i.awaitModalSubmit({ time: 60000, filter: (s) => s.user.id === i.user.id });
            const mUsd = parseFloat(sub.fields.getTextInputValue("max_usd"));
            const lCap = parseFloat(sub.fields.getTextInputValue("lev_cap"));
            const sPct = parseFloat(sub.fields.getTextInputValue("slip_pct"));

            if (isNaN(mUsd) || isNaN(sPct) || isNaN(lCap)) {
                await sub.reply({ content: "❌ Invalid parameters.", ephemeral: true });
            } else {
                await CopyTrading.updateOne(
                    { _id: selectedCopyStreamId },
                    { $set: { maxTradeSizeUsd: mUsd, maxLeverageCap: lCap, slippageTolerancePct: sPct } }
                );
                await sub.update(await renderCopyStreamDetails(selectedCopyStreamId));
            }
        } catch (e) {}
      }

      else if (i.customId === "edit_stream_blacklist") {
        if (!selectedCopyStreamId) return;
        const stream = await CopyTrading.findById(selectedCopyStreamId);
        const currentList = stream.assetBlacklist && stream.assetBlacklist.length > 0 ? stream.assetBlacklist.join(", ") : "";

        const modal = new ModalBuilder().setCustomId("edit_blacklist_modal").setTitle("Update Asset Blacklist");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
              new TextInputBuilder()
              .setCustomId("blacklist_input")
              .setLabel("Excluded Symbols (comma separated)")
              .setPlaceholder("e.g. BTC, ETH, SOL")
              .setValue(currentList)
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
          )
        );
        
        await i.showModal(modal);

        try {
            const sub = await i.awaitModalSubmit({ time: 60000, filter: (s) => s.user.id === i.user.id });
            const rawInput = sub.fields.getTextInputValue("blacklist_input");
            
            const parsedArray = rawInput.split(',').map(s => s.trim().toUpperCase()).filter(s => s.length > 0);

            await CopyTrading.updateOne(
                { _id: selectedCopyStreamId },
                { $set: { assetBlacklist: parsedArray } }
            );
            await sub.update(await renderCopyStreamDetails(selectedCopyStreamId));
        } catch (e) {}
      }

      // --- COPY TRADE HISTORY HANDLERS ---
      else if (i.customId === "view_copy_history") {
          await i.deferUpdate();
          viewState = "copy_history";
          copyExecPageIndex = 0;
          await i.editReply(await renderCopyHistory());
      }

      else if (i.customId === "copy_history_prev" || i.customId === "copy_history_next") {
          await i.deferUpdate();
          if (i.customId === "copy_history_prev") copyExecPageIndex = Math.max(0, copyExecPageIndex - 1);
          else copyExecPageIndex++;
          await i.editReply(await renderCopyHistory());
      }

      else if (i.customId.startsWith("copy_trade_idx_")) {
          await i.deferUpdate();
          const absoluteIndex = parseInt(i.customId.replace("copy_trade_idx_", ""));
          selectedCopyExecution = copyExecutionsList[absoluteIndex];
          if (selectedCopyExecution) {
              viewState = "copy_trade_detail";
              await i.editReply(renderCopyTradeDetail(selectedCopyExecution));
          }
      }

      else if (i.customId === "close_copied_trade") {
          await i.deferUpdate();
          if (!selectedCopyExecution || !userRecord) return;

          try {
              const originalSide = selectedCopyExecution.side.toUpperCase();
              const closingSide = originalSide === "BUY" ? "ask" : "bid";
              const amt = parseFloat(selectedCopyExecution.followerExecution?.amount);
              const sym = selectedCopyExecution.symbol;

              const receipt = await marketOrder(userRecord.walletAddress, sym, amt, 0.5, closingSide, null, null, true);
              if (!receipt || receipt.success === false) throw new Error(receipt?.data?.error || "Failed to close copied position");

              const successEmbed = new EmbedBuilder().setTitle(`✅ Copied Position Closed`).setDescription(`Successfully emergency closed ${amt} ${sym}`).setColor(0x00ff00);
              const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("view_copy_history").setLabel("⬅️ Back to History").setStyle(ButtonStyle.Secondary));
              
              await i.editReply({ embeds: [successEmbed], components: [row] });
          } catch (err) {
              const failEmbed = new EmbedBuilder().setTitle("❌ Close Failed").setColor(0xff0000).setDescription(`**Error:** ${formatError(err)}`);
              const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("view_copy_history").setLabel("⬅️ Back to History").setStyle(ButtonStyle.Secondary));
              await i.editReply({ embeds: [failEmbed], components: [row] });
          }
      }

      // ==========================================
      // --- STANDARD MANUAL TRADING HANDLERS ---
      // ==========================================

      else if (i.customId === "view_account") {
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
          const modal = new ModalBuilder().setCustomId("trade_modal").setTitle(pendingSide === "long" ? `Long ${symbol}` : `Short ${symbol}`);
          let defaultAmt = orderParams.amount;
          if (defaultAmt <= 0) {
            const price = parseFloat(latest.mark);
            if (price > 0) {
              const rec = 12 / price;
              defaultAmt = roundStep(rec, marketConstraints.lot_size);
            }
          }

          const amt = new TextInputBuilder()
            .setCustomId("amt")
            .setLabel(`Amount (${symbol})`)
            .setPlaceholder("e.g. 0.5")
            .setValue(defaultAmt > 0 ? defaultAmt.toString() : "")
            .setStyle(TextInputStyle.Short)
            .setRequired(false);

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
            new ActionRowBuilder().addComponents(usdInput), 
            new ActionRowBuilder().addComponents(slip),
            new ActionRowBuilder().addComponents(tp),
            new ActionRowBuilder().addComponents(sl),
          );

          await i.showModal(modal);

          try {
            const sub = await i.awaitModalSubmit({ time: 60_000, filter: (s) => s.user.id === i.user.id });
            
            const rawAmt = sub.fields.getTextInputValue("amt").trim();
            const rawUsd = sub.fields.getTextInputValue("usd_amt").trim();

            if (rawAmt.length > 0 && rawUsd.length > 0) {
                 return sub.reply({ content: "⚠️ **Ambiguous Input:** Please fill EITHER the Token Amount OR the USD Amount, not both.", ephemeral: true });
            }
            if (rawAmt.length === 0 && rawUsd.length === 0) {
                 return sub.reply({ content: "❌ **Missing Input:** Please enter a trade size.", ephemeral: true });
            }

            let newAmt = 0;

            if (rawAmt.length > 0) {
                newAmt = parseFloat(rawAmt);
                orderParams.enteredType = 'token';
                orderParams.enteredValue = newAmt;
            } else {
                const usdValue = parseFloat(rawUsd);
                if (isNaN(usdValue) || usdValue <= 0) {
                     return sub.reply({ content: "❌ Invalid USD Amount.", ephemeral: true });
                }
                
                let currentMark = parseFloat(latest.mark);
                
                if (symbol.includes("BTC") || currentMark > 1000) {
                    currentMark = roundStep(currentMark, marketConstraints.tick_size);
                }

                if (currentMark > 0) {
                    newAmt = usdValue / currentMark;
                    orderParams.enteredType = 'usd';
                    orderParams.enteredValue = usdValue;
                } else {
                    return sub.reply({ content: "❌ Market data invalid (Price is 0).", ephemeral: true });
                }
            }

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
    
    // 🧹 MEMORY MANAGEMENT: Kill the listener when the terminal times out
    if (internalBus) {
        internalBus.removeListener('ICEBERG_UPDATE', liveUpdateHandler); 
    }

    if (reason === "time") {
      try {
        await interaction.editReply({ components: [] });
      } catch (e) {}
    }
  });
}

module.exports = fetchMarket;
