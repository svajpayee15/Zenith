require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const connectDB = require("../../database/db.js");
const approvals = require("../../database/models/approvals.Schema.js");
const { checkRateLimit } = require("../../utility/rateLimiter.js"); 

const register = require("./commands/register.command.js");
const revoke = require("./commands/revoke.command.js");
const markets = require("./commands/services/markets.integration.js");

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

connectDB();

const TOKEN = process.env.TOKEN;

const commands = [
  new SlashCommandBuilder()
    .setName("register")
    .setDescription("Link your wallet to the bot"),
  new SlashCommandBuilder()
    .setName("revoke")
    .setDescription("Revoke the builder code"),
  new SlashCommandBuilder()
    .setName('trade')
    .setDescription('Open Trading Dashboard')
    .addStringOption(option =>
        option
            .setName('symbol')
            .setDescription('Select a market')
            .setRequired(true)
    )
];

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });
    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error(error);
  }
});

client.on("interactionCreate", async (interaction) => {
  let actionType = 'global';
  
  if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.includes('trade') || id.includes('long') || id.includes('short') || id === 'confirm_trade' || id === 'close_trade_action') {
          actionType = 'trade';
      } else if (id.startsWith('tf_') || id === 'switch_market' || id === 'open_history') {
          actionType = 'view';
      }
  } else if (interaction.isChatInputCommand() && interaction.commandName === 'trade') {
      actionType = 'view';
  }

  const isAllowed = checkRateLimit(interaction.user.id, actionType);

  if (!isAllowed) {
      const msg = { 
          content: "🔥 **Slow down!** You are interacting too fast. Please wait a moment.", 
          ephemeral: true 
      };
      
      if (interaction.deferred || interaction.replied) {
          return interaction.followUp(msg).catch(() => {});
      } else {
          return interaction.reply(msg).catch(() => {});
      }
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "register") {
    register(
      approvals,
      EmbedBuilder,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      interaction
    );
  }

  else if(interaction.commandName === "revoke"){
     revoke(
      approvals,
      EmbedBuilder,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      interaction
    );
  } 
  else if(interaction.commandName === "trade"){
    markets(
      approvals, 
      interaction
    )
  }
});

client.login(TOKEN);