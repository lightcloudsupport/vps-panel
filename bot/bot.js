// Env: DISCORD_TOKEN, CLIENT_ID, PANEL_URL (e.g. http://localhost:3000), BOT_API_KEY, ADMIN_IDS (comma-separated Discord IDs)
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { DISCORD_TOKEN, CLIENT_ID, PANEL_URL, BOT_API_KEY, ADMIN_IDS = '' } = process.env;
const admins = ADMIN_IDS.split(',');

const commands = [
  new SlashCommandBuilder().setName('deploy').setDescription('Create a VPS and send the login to the user by DM')
    .addUserOption(o => o.setName('user').setDescription('Who gets the VPS').setRequired(true))
    .addIntegerOption(o => o.setName('plan').setDescription('Plan ID from the panel Shop').setRequired(true)),
].map(c => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', async () => {
  await new REST({ version: '10' }).setToken(DISCORD_TOKEN).put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Bot ready as', client.user.tag);
});

client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand() || i.commandName !== 'deploy') return;
  if (!admins.includes(i.user.id)) return i.reply({ content: 'Only admins can use this command.', ephemeral: true });
  await i.deferReply({ ephemeral: true });
  const target = i.options.getUser('user');
  try {
    const r = await fetch(PANEL_URL + '/api/bot/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': BOT_API_KEY },
      body: JSON.stringify({ discordId: target.id, planId: i.options.getInteger('plan') }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    const embed = new EmbedBuilder().setTitle('Your LightCloud VPS is ready').setColor(0x3b82f6).addFields(
      { name: 'Plan', value: d.plan },
      { name: 'SSH', value: `\`ssh ${d.sshUser}@${d.host} -p ${d.sshPort}\`` },
      { name: 'SSH password', value: `||${d.sshPassword}||` },
      ...(d.panelPassword ? [{ name: 'Panel login', value: `${PANEL_URL}\nUser: \`${d.panelUser}\`\nPassword: ||${d.panelPassword}||` }] : []),
    );
    try { await target.send({ embeds: [embed] }); await i.editReply(`VPS created. Login details sent to ${target.tag} by DM.`); }
    catch { await i.editReply(`VPS created, but ${target.tag} has DMs closed. Ask them to open DMs, then reset the password from the panel.`); }
  } catch (e) { await i.editReply('Could not create the VPS: ' + e.message); }
});
client.login(DISCORD_TOKEN);
