const crypto = require("crypto");

async function register(
  approvals,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  interaction
) {
  const userApproval = await approvals.findOne({
    userId: interaction.user.id,
  });

  if (userApproval) {
    if (userApproval.signature && userApproval.approved) {
      return interaction.reply({
        content: "✅ You are already a verified user.",
        ephemeral: true,
      });
    }

    await approvals.deleteOne({ userId: interaction.user.id });
  }

  const nonce = crypto.randomBytes(16).toString("hex");

  const newApprovalInitiated = await approvals.create({
    nonce: nonce,
    userId: interaction.user.id,
    expireAt: new Date(Date.now() + 60 * 1000),
  });

  const embed = new EmbedBuilder()
    .setColor(0x0099ff)
    .setTitle("🔐 Authorization Required")
    .setDescription(
      "To enable trading features, you need to link your wallet and approve the **Pacifica Builder Code**."
    )
    .addFields(
      {
        name: "One-Time Setup",
        value:
          "This signature grants the bot permission to place orders on your behalf.",
      },
      {
        name: "Security",
        value: "This link is unique to you and expires in **1 minute**.",
      }
    )
    .setFooter({ text: "Pacifica Trading Bot" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Connect Wallet")
      .setStyle(ButtonStyle.Link)
      .setURL(
        `https://zenith-e0xa.onrender.com/auth/approve?userId=${newApprovalInitiated.userId}&nonce=${newApprovalInitiated.nonce}`
      )
      .setEmoji("🔗")
  );

  await interaction.reply({
    embeds: [embed],
    components: [row],
    ephemeral: true,
  });

  setTimeout(async () => {
    try {
      await interaction.editReply({
        content: "⚠️ **This link has expired.** Please run `/register` again.",
        embeds: [],
        components: [],
      });

      setTimeout(async () => {
        try {
          await interaction.editReply({
            content:
              "⚠️ **This link has expired.** Please run `/register` again.",
            embeds: [],
            components: [],
          });
        } catch (err) {}
      });
    } catch (error) {}
  }, 60_000);
}

module.exports = register;
