const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, MessageFlags, StringSelectMenuBuilder,
} = require('discord.js');
const { db } = require('./db');

// Tickets work on any guild with a valid standard OR premium license.
module.exports = function makeTickets({ isLicensed }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_settings (
      guild_id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL,
      staff_role_id TEXT,
      log_channel_id TEXT
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel_id TEXT UNIQUE,
      subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'creating',
      created_at INTEGER NOT NULL,
      closed_at INTEGER,
      closed_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(guild_id,user_id,status);
  `);
  // 테마는 실제 이미지 생성이 아닌 Discord 임베드 디자인입니다.
  const THEMES = {
    purple: { label: '💜 보라색 프리미엄', color: 0x9b59ff, title: '💜 프리미엄 고객지원', button: ButtonStyle.Primary, icon: '💜' },
    dark: { label: '🖤 검정색 모던', color: 0x2b2d31, title: '🖤 고객지원 센터', button: ButtonStyle.Secondary, icon: '🖤' },
    blue: { label: '💙 파란색 고객센터', color: 0x3498db, title: '💙 고객센터', button: ButtonStyle.Primary, icon: '💙' },
  };
  const validTheme = key => Object.hasOwn(THEMES, key) ? key : 'purple';
  const EPH = { flags: MessageFlags.Ephemeral };
  const commands = [
    new SlashCommandBuilder().setName('티켓설정').setDescription('티켓 카테고리/담당 역할/로그 채널 설정 (관리자)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addChannelOption(o => o.setName('카테고리').setDescription('티켓이 생성될 카테고리').addChannelTypes(ChannelType.GuildCategory).setRequired(true))
      .addRoleOption(o => o.setName('담당역할').setDescription('티켓을 볼 수 있는 스태프 역할').setRequired(false))
      .addChannelOption(o => o.setName('로그채널').setDescription('티켓 개설/종료 알림').addChannelTypes(ChannelType.GuildText).setRequired(false)),
    new SlashCommandBuilder().setName('티켓패널').setDescription('이 채널에 티켓 열기 패널 게시 (관리자)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(o => o.setName('스타일').setDescription('패널 기본 디자인 (미선택 시 보라색)')
        .addChoices({ name: '💜 보라색 프리미엄', value: 'purple' }, { name: '🖤 검정색 모던', value: 'dark' }, { name: '💙 파란색 고객센터', value: 'blue' })),
    new SlashCommandBuilder().setName('티켓닫기').setDescription('현재 티켓을 닫습니다'),
    new SlashCommandBuilder().setName('티켓열기').setDescription('닫힌 티켓을 다시 엽니다 (관리자)'),
    new SlashCommandBuilder().setName('티켓삭제').setDescription('닫힌 티켓 채널을 삭제합니다 (관리자)'),
  ].map(c => c.toJSON());
  const row = (...buttons) => new ActionRowBuilder().addComponents(...buttons);
  const button = (id, label, style) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  function themeEmbed(theme, personalized = false) {
    const t = THEMES[validTheme(theme)];
    return new EmbedBuilder().setColor(t.color).setTitle(t.title)
      .setDescription(personalized
        ? `${t.icon} **${t.label}** 스타일이 선택됐어요!\n아래 버튼을 눌러 문의를 접수하세요. 선택한 스타일은 티켓에도 적용됩니다.`
        : '문의할 내용이 있나요? 아래에서 원하는 디자인을 직접 선택하거나 바로 티켓을 열어 주세요.\n🔒 담당자와 나만 볼 수 있는 비공개 채널이 만들어집니다.\n*한 번에 하나의 티켓만 열 수 있어요.*');
  }
  function themeMenu() {
    return row(new StringSelectMenuBuilder().setCustomId('ticket:theme')
      .setPlaceholder('🎨 티켓 스타일 직접 선택')
      .addOptions(Object.entries(THEMES).map(([value, t]) => ({ label: t.label, value }))));
  }
  function styledCreateButton(theme) {
    const t = THEMES[validTheme(theme)];
    return row(button(`ticket:create:${validTheme(theme)}`, `${t.icon} 이 스타일로 티켓 열기`, t.button));
  }
  const isStaff = i => i.memberPermissions?.has(PermissionFlagsBits.ManageChannels) || i.user.id === i.guild.ownerId ||
    (getSettings(i.guildId)?.staff_role_id && i.member?.roles?.cache?.has(getSettings(i.guildId).staff_role_id));
  const getSettings = gid => db.prepare('SELECT * FROM ticket_settings WHERE guild_id=?').get(gid);
  const getTicket = i => db.prepare('SELECT * FROM tickets WHERE guild_id=? AND channel_id=?').get(i.guildId, i.channelId);
  const error = (i, message) => i.reply({ content: message, ...EPH });

  async function log(guild, text) {
    const id = getSettings(guild.id)?.log_channel_id;
    if (!id) return;
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (ch?.isTextBased()) await ch.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
  }
  async function create(i) {
    const settings = getSettings(i.guildId);
    if (!settings) return error(i, '⚠️ 관리자가 먼저 `/티켓설정`을 완료해야 해요.');
    const existing = db.prepare("SELECT channel_id FROM tickets WHERE guild_id=? AND user_id=? AND status IN ('open','creating') LIMIT 1").get(i.guildId, i.user.id);
    if (existing) return error(i, existing.channel_id ? `📩 이미 열린 티켓이 있어요: <#${existing.channel_id}>` : '📩 티켓을 생성 중이에요.');
    return i.showModal(new ModalBuilder().setCustomId(`ticket:create:${validTheme(i.customId.split(':')[2])}`).setTitle('📩 문의 티켓 열기').addComponents(
      row(new TextInputBuilder().setCustomId('subject').setLabel('문의 제목').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true)),
      row(new TextInputBuilder().setCustomId('detail').setLabel('문의 내용').setStyle(TextInputStyle.Paragraph).setMaxLength(1500).setRequired(true))));
  }
  async function submit(i) {
    await i.deferReply(EPH);
    const settings = getSettings(i.guildId);
    if (!settings) return i.editReply('⚠️ 티켓 설정이 없어요.');
    // Synchronously reserve one open ticket per user to protect against double submission.
    const theme = validTheme(i.customId.split(':')[2]);
    const reserved = db.transaction(() => {
      const old = db.prepare("SELECT channel_id FROM tickets WHERE guild_id=? AND user_id=? AND status IN ('open','creating')").get(i.guildId, i.user.id);
      if (old) return { old };
      const r = db.prepare('INSERT INTO tickets (guild_id,user_id,subject,status,created_at) VALUES (?,?,?,?,?)')
        .run(i.guildId, i.user.id, i.fields.getTextInputValue('subject'), 'creating', Date.now());
      return { id: Number(r.lastInsertRowid) };
    })();
    if (reserved.old) return i.editReply(reserved.old.channel_id ? `이미 열린 티켓: <#${reserved.old.channel_id}>` : '티켓을 생성 중이에요.');
    const id = reserved.id;
    let channel;
    try {
      const category = await i.guild.channels.fetch(settings.category_id);
      if (!category || category.type !== ChannelType.GuildCategory) throw Error('설정한 카테고리를 찾을 수 없습니다.');
      const overwrites = [
        { id: i.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
        { id: i.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
      ];
      if (settings.staff_role_id && !overwrites.some(p => p.id === settings.staff_role_id)) overwrites.push({
        id: settings.staff_role_id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      });
      channel = await i.guild.channels.create({
        name: `ticket-${String(id).padStart(4, '0')}`, type: ChannelType.GuildText,
        parent: category.id, permissionOverwrites: overwrites,
        topic: `티켓 #${id} | 신청자 ${i.user.id}`,
        reason: `Ticket #${id} by ${i.user.id}`,
      });
      db.prepare("UPDATE tickets SET channel_id=?,status='open' WHERE id=?").run(channel.id, id);
      const staff = settings.staff_role_id ? `<@&${settings.staff_role_id}>` : '관리자';
      await channel.send({
        content: `<@${i.user.id}> ${staff}`,
        allowedMentions: { users: [i.user.id], roles: settings.staff_role_id ? [settings.staff_role_id] : [] },
        embeds: [new EmbedBuilder().setColor(THEMES[theme].color).setTitle(`${THEMES[theme].icon} 문의 티켓 #${id}`)
          .addFields({ name: '문의자', value: `<@${i.user.id}>` },
            { name: '제목', value: i.fields.getTextInputValue('subject').slice(0, 100) },
            { name: '문의 내용', value: i.fields.getTextInputValue('detail').slice(0, 1024) })
          .setTimestamp()],
        components: [row(button('ticket:close', '🔒 티켓 닫기', ButtonStyle.Danger))],
      });
      await log(i.guild, `📩 티켓 #${id} 개설: <#${channel.id}> / 신청자 <@${i.user.id}>`);
      return i.editReply(`✅ 티켓이 생성되었어요: <#${channel.id}>`);
    } catch (e) {
      console.error('[티켓 생성 실패]', e);
      if (channel) await channel.delete().catch(() => {});
      db.prepare('DELETE FROM tickets WHERE id=?').run(id);
      return i.editReply('❌ 티켓 생성에 실패했어요. 봇의 채널 관리 권한과 카테고리 설정을 확인해 주세요.');
    }
  }
  async function close(i) {
    const t = getTicket(i);
    if (!t) return error(i, '이 채널은 티켓 채널이 아니에요.');
    if (t.status !== 'open') return error(i, '이미 닫힌 티켓이에요.');
    if (i.user.id !== t.user_id && !isStaff(i)) return error(i, '티켓 작성자 또는 담당자만 닫을 수 있어요.');
    await i.deferReply(EPH);
    await i.channel.permissionOverwrites.edit(t.user_id, { SendMessages: false });
    db.prepare("UPDATE tickets SET status='closed',closed_at=?,closed_by=? WHERE id=? AND status='open'").run(Date.now(), i.user.id, t.id);
    await i.channel.send({ content: `🔒 티켓 #${t.id} 종료 · 담당자: <@${i.user.id}>\n관리자는 \`/티켓열기\` 또는 \`/티켓삭제\`를 사용할 수 있어요.`, allowedMentions: { parse: [] } });
    await log(i.guild, `🔒 티켓 #${t.id} 종료: <#${i.channelId}> / 처리자 <@${i.user.id}>`);
    return i.editReply('✅ 티켓을 닫았어요.');
  }
  async function reopen(i) {
    const t = getTicket(i);
    if (!t || t.status !== 'closed') return error(i, '닫힌 티켓 채널에서만 사용할 수 있어요.');
    if (!isStaff(i)) return error(i, '담당자만 티켓을 다시 열 수 있어요.');
    await i.deferReply(EPH);
    await i.channel.permissionOverwrites.edit(t.user_id, { ViewChannel: true, SendMessages: true });
    db.prepare("UPDATE tickets SET status='open',closed_at=NULL,closed_by=NULL WHERE id=?").run(t.id);
    await i.channel.send({ content: `🔓 티켓 #${t.id} 다시 열림`, components: [row(button('ticket:close', '🔒 티켓 닫기', ButtonStyle.Danger))] });
    return i.editReply('✅ 티켓을 다시 열었어요.');
  }
  async function remove(i) {
    const t = getTicket(i);
    if (!t || t.status !== 'closed') return error(i, '닫힌 티켓만 삭제할 수 있어요.');
    if (!isStaff(i)) return error(i, '담당자만 삭제할 수 있어요.');
    await i.reply({ content: '🗑️ 티켓을 삭제합니다.', ...EPH });
    await i.channel.delete(`티켓 #${t.id} 삭제 by ${i.user.id}`);
    db.prepare("UPDATE tickets SET status='deleted' WHERE id=?").run(t.id);
    await log(i.guild, `🗑️ 티켓 #${t.id} 삭제 / 처리자 <@${i.user.id}>`);
  }
  async function handle(i) {
    if (!i.guild) return;
    if (!isLicensed(i.guildId)) return error(i, '⛔ 일반 또는 프리미엄 라이센스가 필요합니다. `/라이센스등록`으로 등록해 주세요.');
    if (i.isStringSelectMenu() && i.customId === 'ticket:theme') {
      const theme = validTheme(i.values[0]);
      return i.reply({ embeds: [themeEmbed(theme, true)], components: [styledCreateButton(theme)], ...EPH });
    }
    if (i.isButton() && (i.customId === 'ticket:create' || i.customId.startsWith('ticket:create:'))) return create(i);
    if (i.isModalSubmit() && (i.customId === 'ticket:create' || i.customId.startsWith('ticket:create:'))) return submit(i);
    if ((i.isButton() && i.customId === 'ticket:close') || (i.isChatInputCommand() && i.commandName === '티켓닫기')) return close(i);
    if (!i.isChatInputCommand()) return;
    if (i.commandName === '티켓열기') return reopen(i);
    if (i.commandName === '티켓삭제') return remove(i);
    if (i.commandName === '티켓설정') {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return error(i, '서버 관리 권한이 필요해요.');
      const category = i.options.getChannel('카테고리');
      const role = i.options.getRole('담당역할');
      const logChannel = i.options.getChannel('로그채널');
      db.prepare(`INSERT INTO ticket_settings(guild_id,category_id,staff_role_id,log_channel_id)
        VALUES (?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET category_id=excluded.category_id,
        staff_role_id=excluded.staff_role_id,log_channel_id=excluded.log_channel_id`)
        .run(i.guildId, category.id, role?.id || null, logChannel?.id || null);
      return error(i, `✅ 티켓 설정 완료!\n카테고리: ${category.name}\n담당 역할: ${role || '미설정 (채널 관리 권한 보유자)'}\n로그 채널: ${logChannel || '미설정'}`);
    }
    if (i.commandName === '티켓패널') {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return error(i, '서버 관리 권한이 필요해요.');
      if (!getSettings(i.guildId)) return error(i, '먼저 `/티켓설정`을 실행해 주세요.');
      const theme = validTheme(i.options.getString('스타일'));
      await i.channel.send({
        embeds: [themeEmbed(theme)],
        components: [themeMenu(), styledCreateButton(theme)],
      });
      return error(i, '✅ 티켓 패널을 게시했어요.');
    }
  }
  function owns(i) {
    return (i.isChatInputCommand() && commands.some(c => c.name === i.commandName)) ||
      ((i.isButton() || i.isModalSubmit() || i.isStringSelectMenu()) && i.customId.startsWith('ticket:'));
  }
  return { commands, owns, handle };
};
