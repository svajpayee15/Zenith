const crypto = require("crypto");

async function revoke(
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
      const nonce = crypto.randomBytes(16).toString("hex");

      await approvals.updateOne(
        {
          userId: interaction.user.id,
        },
        {
          nonce: nonce,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        }
      )
      .then((value)=>{
        console.log(value)
      })
      .catch((err)=>{
        console.log(err)
      })

      const embed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle("🔐 Authorization Required")
        .setDescription(
          "To diaable trading features, you need to link your wallet and sign the request to revoke the **Pacifica Builder Code**."
        )
        .addFields(
          {
            name: "One-Time Setup",
            value:
              "This signature revokes the bot permission to place orders on your behalf.",
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
            `http://localhost:3000/auth/revoke?userId=${interaction.user.id}&nonce=${nonce}`
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
            content:
              "⚠️ **This link has expired.** Please run `/register` again.",
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
  }
  else{
    await interaction.reply({
    content:"User not found.",
    ephemeral: true,
  });
  }
}

module.exports = revoke;
