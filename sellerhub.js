const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits: P,
  EmbedBuilder,
} = require('discord.js');

const data = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Create the SELLER HUB global network server structure');

const ROLE_DEFS = [
  ['Global Owner', 0xF1C40F],
  ['Co-Owner', 0xE5C07B],
  ['Network Admin', 0x9B59B6],
  ['Asia Director', 0x3498DB],
  ['Americas Director', 0xE74C3C],
  ['Europe Director', 0x2ECC71],
  ['Cell Server Owner', 0xF39C12],
  ['Regional Admin', 0x1ABC9C],
  ['Regional Moderator', 0x5865F2],
  ['Support', 0x95A5A6],
  ['Verified Trader', 0x2ECC71],
  ['Member', 0x5865F2],
  ['Muted', 0x7F8C8D],
];

// Every channel is created under its category. Regional directors can post only
// in their own region's announcement channels; network leadership can post globally.
const SECTIONS = [
  {
    name: '📥 WELCOME CENTER',
    type: 'welcome',
    channels: [
      ['welcome', 'Welcome to SELLER HUB — start here.'],
      ['join', 'Automatic new member join notices.'],
      ['leave', 'Automatic member departure notices.'],
      ['server-info', 'Official information about SELLER HUB.'],
      ['rules', 'Community rules and safety guidelines.'],
    ],
  },
  {
    name: '📢 ANNOUNCEMENTS',
    type: 'global-announcements',
    channels: [
      ['announcements', 'Official announcements from SELLER HUB HQ.'],
      ['global-updates', 'Global network news and updates.'],
      ['important-notices', 'Important community and security notices.'],
    ],
  },
  {
    name: '🌐 GLOBAL NETWORK',
    type: 'global-network',
    channels: [
      ['network-announcements', 'Official global network announcements.'],
      ['new-cell-server-launches', 'New regional cell server launch announcements.'],
      ['network-partnerships', 'Official network partnerships and collaborations.'],
      ['global-server-directory', 'Directory of official SELLER HUB cell servers.'],
      ['cell-server-applications', 'Applications to establish a new cell server.'],
    ],
  },
  {
    name: '🌏 ASIA NETWORK',
    type: 'asia',
    channels: [
      ['asia-announcements', 'Official Asia regional announcements.'],
      ['asia-server-launches', 'New Asia cell server launch announcements.'],
      ['asia-server-directory', 'Directory of official Asia cell servers.'],
      ['asia-recruitment', 'Asia regional team recruitment.'],
    ],
  },
  {
    name: '🌎 AMERICAS NETWORK',
    type: 'americas',
    channels: [
      ['americas-announcements', 'Official Americas regional announcements.'],
      ['americas-server-launches', 'New Americas cell server launch announcements.'],
      ['americas-server-directory', 'Directory of official Americas cell servers.'],
      ['americas-recruitment', 'Americas regional team recruitment.'],
    ],
  },
  {
    name: '🌍 EUROPE NETWORK',
    type: 'europe',
    channels: [
      ['europe-announcements', 'Official Europe regional announcements.'],
      ['europe-server-launches', 'New Europe cell server launch announcements.'],
      ['europe-server-directory', 'Directory of official Europe cell servers.'],
      ['europe-recruitment', 'Europe regional team recruitment.'],
    ],
  },
  {
    name: '🌍 GLOBAL COMMUNITY',
    type: 'chat',
    channels: [
      ['global-chat', 'Chat with traders and members worldwide.'],
      ['introductions', 'Introduce yourself to the global community.'],
      ['international-chat', 'International conversations and networking.'],
      ['general-discussion', 'General community discussions.'],
    ],
  },
  {
    name: '🤝 MIDDLEMAN CENTER',
    type: 'chat',
    channels: [
      ['mm-request', 'Request information about middleman-assisted deals.'],
      ['mm-information', 'Middleman service information and safety guidance.'],
      ['mm-vouches', 'Share verifiable middleman feedback and references.'],
      ['mm-discussion', 'Middleman service discussions.'],
    ],
  },
  {
    name: '🛡️ TRUST CENTER',
    type: 'chat',
    channels: [
      ['trusted-sellers', 'Seller reputation information and references.'],
      ['trusted-buyers', 'Buyer reputation information and references.'],
      ['seller-reviews', 'Post fair, evidence-based seller reviews.'],
      ['verification', 'Community verification information.'],
    ],
  },
  {
    name: '🚨 SCAM ALERT CENTER',
    type: 'chat',
    channels: [
      ['scammer-reports', 'Report suspected scams with supporting evidence.'],
      ['scammer-database', 'Documented scam warnings and report outcomes.'],
      ['suspicious-activity', 'Discuss suspicious trading activity.'],
      ['report-evidence', 'Submit evidence for moderator review.'],
    ],
  },
  {
    name: '💱 MARKETPLACE',
    type: 'chat',
    channels: [
      ['buying', 'Post items or services you are looking to buy.'],
      ['selling', 'Post items or services you are offering.'],
      ['trading-chat', 'Discuss trades and potential deals.'],
      ['deal-discussion', 'Discuss deal terms and transaction safety.'],
    ],
  },
  {
    name: '🎫 SUPPORT CENTER',
    type: 'support',
    channels: [
      ['open-a-ticket', 'Find out how to contact the support team.'],
      ['help-support', 'Ask for community and server assistance.'],
      ['staff-contact', 'Contact the appropriate server staff.'],
    ],
  },
  {
    name: '🔒 STAFF ONLY',
    type: 'staff',
    channels: [
      ['staff-chat', 'Private staff communication.'],
      ['mod-logs', 'Moderation activity logs.'],
      ['report-review', 'Review scam and community reports.'],
      ['bot-logs', 'Bot activity and system logs.'],
    ],
  },
];

function roleByName(guild, name) {
  return guild.roles.cache.find(r => r.name === name) || null;
}

async function ensureRoles(guild) {
  const map = {};
  for (const [name, color] of ROLE_DEFS) {
    let role = roleByName(guild, name);
    if (!role) {
      role = await guild.roles.create({
        name,
        color,
        permissions: [],
        mentionable: false,
        reason: 'SELLER HUB one-time server setup',
      });
    }
    map[name] = role;
  }
  return map;
}

function canPostRoles(section, roles) {
  const names = ['Global Owner', 'Co-Owner', 'Network Admin'];
  if (section.type === 'asia') names.push('Asia Director');
  if (section.type === 'americas') names.push('Americas Director');
  if (section.type === 'europe') names.push('Europe Director');
  if (section.type === 'global-announcements' || section.type === 'global-network') {
    names.push('Asia Director', 'Americas Director', 'Europe Director');
  }
  if (section.type === 'welcome') names.push('Network Admin');
  return [...new Set(names)].map(n => roles[n]).filter(Boolean);
}

function buildOverwrites(guild, botUserId, section, roles) {
  const overwrites = [];
  const readonly = ['welcome', 'global-announcements', 'global-network', 'asia', 'americas', 'europe'].includes(section.type);

  if (section.type === 'staff') {
    overwrites.push({
      id: guild.roles.everyone.id,
      deny: [P.ViewChannel],
    });
    for (const name of ['Global Owner', 'Co-Owner', 'Network Admin', 'Asia Director',
      'Americas Director', 'Europe Director', 'Regional Admin', 'Regional Moderator', 'Support']) {
      const role = roles[name];
      if (role) overwrites.push({
        id: role.id,
        allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessages],
      });
    }
    overwrites.push({
      id: botUserId,
      allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.ManageMessages],
    });
    return overwrites;
  }

  overwrites.push({
    id: guild.roles.everyone.id,
    allow: [P.ViewChannel, P.ReadMessageHistory],
    ...(readonly ? { deny: [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads] } : {
      allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.AddReactions, P.EmbedLinks, P.AttachFiles],
    }),
  });

  if (readonly) {
    for (const role of canPostRoles(section, roles)) {
      overwrites.push({
        id: role.id,
        allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.EmbedLinks, P.AttachFiles],
      });
    }
    // Bot can post automated join/leave messages and maintain notices.
    overwrites.push({
      id: botUserId,
      allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.EmbedLinks, P.AttachFiles],
    });
  }

  if (section.type === 'support') {
    for (const name of ['Support', 'Regional Admin', 'Network Admin']) {
      const role = roles[name];
      if (role) overwrites.push({
        id: role.id,
        allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.ManageMessages],
      });
    }
  }
  return overwrites;
}

async function ensureCategory(guild, section, roles, botUserId, position) {
  let category = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name === section.name
  );
  const overwrites = buildOverwrites(guild, botUserId, section, roles);

  if (!category) {
    category = await guild.channels.create({
      name: section.name,
      type: ChannelType.GuildCategory,
      permissionOverwrites: overwrites,
      reason: 'SELLER HUB one-time server setup',
    });
  } else {
    await category.permissionOverwrites.set(overwrites, 'SELLER HUB permission configuration');
  }

  await category.setPosition(position);

  for (const [name, topic] of section.channels) {
    let channel = guild.channels.cache.find(
      c => c.type === ChannelType.GuildText && c.parentId === category.id && c.name === name
    );
    if (!channel) {
      await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: category.id,
        topic,
        permissionOverwrites: overwrites,
        reason: 'SELLER HUB one-time server setup',
      });
    } else {
      await channel.setTopic(topic);
      await channel.lockPermissions();
    }
  }
}

async function execute(interaction) {
  if (!interaction.inGuild()) return;

  const memberPermissions = interaction.memberPermissions;
  if (!memberPermissions?.has(P.ManageGuild) && interaction.user.id !== interaction.guild.ownerId) {
    return interaction.reply({
      content: '⛔ You need **Manage Server** permission to run this setup.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const guild = interaction.guild;
    const me = await guild.members.fetchMe();

    if (!me.permissions.has(P.ManageChannels) || !me.permissions.has(P.ManageRoles)) {
      return interaction.editReply(
        '❌ The bot needs **Manage Channels** and **Manage Roles** permissions.'
      );
    }

    const roles = await ensureRoles(guild);
    for (let i = 0; i < SECTIONS.length; i++) {
      await ensureCategory(guild, SECTIONS[i], roles, interaction.client.user.id, i);
    }

    const summary = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle('🌐 SELLER HUB SETUP COMPLETE')
      .setDescription('The global headquarters and regional network structure has been created.')
      .addFields(
        { name: '📁 Categories', value: `${SECTIONS.length}`, inline: true },
        { name: '📝 Text Channels', value: `${SECTIONS.reduce((n, s) => n + s.channels.length, 0)}`, inline: true },
        { name: '🎭 Roles', value: `${ROLE_DEFS.length}`, inline: true },
        { name: '🌏 Regions', value: 'Asia • Americas • Europe', inline: false },
        { name: '🔐 Permissions', value: 'Announcements are read-only for members. Regional Directors can post in their own region. Staff channels are private.', inline: false },
      )
      .setFooter({ text: 'SELLER HUB • Global Network' })
      .setTimestamp();

    await interaction.editReply({ embeds: [summary] });
  } catch (error) {
    console.error('[SELLER HUB setup error]', error);
    await interaction.editReply(
      `❌ Setup failed: ${String(error.message || error).slice(0, 800)}\nCheck the bot permissions and role hierarchy.`
    );
  }
}

function installEvents(client) {
  client.on('guildMemberAdd', async member => {
    try {
      const channel = member.guild.channels.cache.find(
        c => c.type === ChannelType.GuildText && c.name === 'join'
      );
      if (!channel) return;
      const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('🌍 NEW MEMBER JOINED')
        .setDescription(`Welcome ${member} to **SELLER HUB**!\nYou are now part of our global community.`)
        .setThumbnail(member.user.displayAvatarURL())
        .setFooter({ text: 'SELLER HUB • Global Community' })
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    } catch (error) {
      console.error('[SELLER HUB join notice]', error);
    }
  });

  client.on('guildMemberRemove', async member => {
    try {
      const channel = member.guild.channels.cache.find(
        c => c.type === ChannelType.GuildText && c.name === 'leave'
      );
      if (!channel) return;
      const embed = new EmbedBuilder()
        .setColor(0xE74C3C)
        .setTitle('👋 MEMBER LEFT')
        .setDescription(`**${member.user.tag}** has left SELLER HUB.`)
        .setThumbnail(member.user.displayAvatarURL())
        .setFooter({ text: 'SELLER HUB • Global Community' })
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    } catch (error) {
      console.error('[SELLER HUB leave notice]', error);
    }
  });
}

module.exports = { data, execute, installEvents };
