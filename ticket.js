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
    CREATE TABLE IF NOT EXISTS ticket_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL,
      name TEXT NOT NULL, questions TEXT NOT NULL DEFAULT '[]',
      require_purchase INTEGER NOT NULL DEFAULT 0
    );
  `);
  const ticketCols = db.prepare('PRAGMA table_info(tickets)').all().map(x => x.name);
  if (!ticketCols.includes('type_name')) db.exec('ALTER TABLE tickets ADD COLUMN type_name TEXT');
  if (!ticketCols.includes('purchase_id')) db.exec('ALTER TABLE tickets ADD COLUMN purchase_id INTEGER');
  const typeCols = db.prepare('PRAGMA table_info(ticket_types)').all().map(x => x.name);
  if (!typeCols.includes('use_form')) db.exec('ALTER TABLE ticket_types ADD COLUMN use_form INTEGER NOT NULL DEFAULT 1');
  const EPH = { flags: MessageFlags.Ephemeral };
  const commands = [
    new SlashCommandBuilder().setName('티켓설정').setDescription('티켓 카테고리/담당 역할/로그 채널 설정 (관리자)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addChannelOption(o => o.setName('카테고리').setDescription('티켓이 생성될 카테고리').addChannelTypes(ChannelType.GuildCategory).setRequired(true))
      .addRoleOption(o => o.setName('담당역할').setDescription('티켓을 볼 수 있는 스태프 역할').setRequired(false))
      .addChannelOption(o => o.setName('로그채널').setDescription('티켓 개설/종료 알림').addChannelTypes(ChannelType.GuildText).setRequired(false)),
    new SlashCommandBuilder().setName('티켓패널').setDescription('이 채널에 티켓 열기 패널 게시 (관리자)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(o => o.setName('제목').setDescription('패널 제목 (선택)'))
      .addStringOption(o => o.setName('안내').setDescription('패널 안내 문구 (선택)'))
      .addBooleanOption(o => o.setName('드롭다운').setDescription('켜기: 선택 메뉴 / 끄기: 버튼 (기본 켜기)')),
    new SlashCommandBuilder().setName('티켓종류추가').setDescription('서버 주인: 티켓 종류와 입력 서식 추가')
      .addStringOption(o => o.setName('이름').setDescription('드롭다운에 표시될 종류 이름').setRequired(true).setMaxLength(80))
      .addBooleanOption(o => o.setName('폼').setDescription('문의 제목/내용 입력 폼 표시 (기본 켜기)'))
      .addBooleanOption(o => o.setName('인보이스입력').setDescription('구매번호 입력칸 표시 및 구매 정보 연동'))
      .addStringOption(o => o.setName('질문').setDescription('추가 입력 항목 이름을 | 로 구분 (최대 3개)')),
    new SlashCommandBuilder().setName('티켓종류수정').setDescription('서버 주인: 기존 티켓 종류 옵션 수정')
      .addIntegerOption(o => o.setName('번호').setDescription('티켓종류목록에서 확인').setRequired(true))
      .addBooleanOption(o => o.setName('폼').setDescription('문의 입력 폼 켜기/끄기'))
      .addBooleanOption(o => o.setName('인보이스입력').setDescription('구매번호 입력칸 켜기/끄기'))
      .addStringOption(o => o.setName('질문').setDescription('질문을 | 로 구분, 없음으로 모두 삭제')),
    new SlashCommandBuilder().setName('티켓종류삭제').setDescription('서버 주인: 티켓 종류 삭제')
      .addIntegerOption(o => o.setName('번호').setDescription('티켓종류목록에서 확인').setRequired(true)),
    new SlashCommandBuilder().setName('티켓종류목록').setDescription('서버 주인: 등록된 티켓 종류 확인'),
    new SlashCommandBuilder().setName('티켓관리').setDescription('서버 주인: 버튼과 입력창으로 티켓 서식 설정'),
    new SlashCommandBuilder().setName('티켓닫기').setDescription('현재 티켓을 닫습니다'),
    new SlashCommandBuilder().setName('티켓열기').setDescription('닫힌 티켓을 다시 엽니다 (관리자)'),
    new SlashCommandBuilder().setName('티켓삭제').setDescription('닫힌 티켓 채널을 삭제합니다 (관리자)'),
  ].map(c => c.toJSON());
  const row = (...buttons) => new ActionRowBuilder().addComponents(...buttons);
  const button = (id, label, style) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  const isStaff = i => i.memberPermissions?.has(PermissionFlagsBits.ManageChannels) || i.user.id === i.guild.ownerId ||
    (getSettings(i.guildId)?.staff_role_id && i.member?.roles?.cache?.has(getSettings(i.guildId).staff_role_id));
  const getSettings = gid => db.prepare('SELECT * FROM ticket_settings WHERE guild_id=?').get(gid);
  const getTicket = i => db.prepare('SELECT * FROM tickets WHERE guild_id=? AND channel_id=?').get(i.guildId, i.channelId);
  const getTypes = gid => db.prepare('SELECT * FROM ticket_types WHERE guild_id=? ORDER BY id LIMIT 25').all(gid);
  const error = (i, message) => i.reply({ content: message, ...EPH });
  const adminOnly = i => i.user.id === i.guild.ownerId;
  const adminHome = gid => {
    const types = getTypes(gid);
    return {
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('⚙️ 티켓 서식 관리')
        .setDescription('아래 버튼으로 티켓 종류를 만들고, 종류별 **폼 / 인보이스 입력 / 질문**을 수정하세요.\n패널 게시 버튼에서 드롭다운 또는 버튼형을 선택할 수 있어요.')
        .addFields({ name: `등록된 티켓 종류 (${types.length}/25)`, value: types.length
          ? types.map(t => `• **#${t.id} ${t.name}** — 폼 ${t.use_form ? 'ON' : 'OFF'}, 인보이스 ${t.require_purchase ? 'ON' : 'OFF'}`).join('\n').slice(0, 1024)
          : '아직 등록되지 않았어요.' })],
      components: [row(button('ticket:admin:new', '➕ 종류 추가', ButtonStyle.Success), button('ticket:admin:pick', '✏️ 종류 수정/삭제', ButtonStyle.Primary)),
        row(button('ticket:admin:panel', '📩 티켓 패널 게시', ButtonStyle.Secondary))],
    };
  };
  const adminModal = (id, title, entries) => new ModalBuilder().setCustomId(id).setTitle(title)
    .addComponents(entries.map(([key, label, value, required = false]) => {
      const input = new TextInputBuilder().setCustomId(key).setLabel(label)
        .setStyle(TextInputStyle.Short).setMaxLength(key === 'questions' ? 300 : 100).setRequired(required);
      if (value) input.setValue(value);
      return row(input);
    }));
  const typeEditor = type => ({
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`✏️ ${type.name}`)
      .setDescription(`폼: **${type.use_form ? 'ON' : 'OFF'}**\n인보이스 입력: **${type.require_purchase ? 'ON' : 'OFF'}**\n질문: ${JSON.parse(type.questions).join(' / ') || '없음'}\n\n폼 OFF + 인보이스 ON이면 구매번호만 묻고, 모두 OFF면 즉시 티켓이 열립니다.`)],
    components: [row(button(`ticket:admin:form:${type.id}`, '폼 ON/OFF', ButtonStyle.Primary),
      button(`ticket:admin:invoice:${type.id}`, '인보이스 ON/OFF', ButtonStyle.Primary)),
      row(button(`ticket:admin:questions:${type.id}`, '📝 질문 수정', ButtonStyle.Secondary),
        button(`ticket:admin:delete:${type.id}`, '🗑️ 종류 삭제', ButtonStyle.Danger)),
      row(button('ticket:admin:home', '↩ 관리 홈', ButtonStyle.Secondary))],
  });
  async function publishPanel(i, title, description, dropdown) {
    if (!getSettings(i.guildId)) return error(i, '먼저 `/티켓설정`을 실행해 주세요.');
    const types = getTypes(i.guildId);
    if (!types.length) return error(i, '먼저 티켓 종류를 추가해 주세요.');
    const components = dropdown
      ? [row(new StringSelectMenuBuilder().setCustomId('ticket:type').setPlaceholder('문의 종류를 선택하세요')
        .addOptions(types.map(t => ({ label: t.name.slice(0, 100), value: String(t.id), description: t.require_purchase ? '인보이스 정보 입력' : '문의 접수' }))))]
      : Array.from({ length: Math.ceil(types.length / 5) }, (_, n) => row(...types.slice(n * 5, n * 5 + 5)
        .map(t => button(`ticket:create:${t.id}`, t.name.slice(0, 80), ButtonStyle.Primary))));
    await i.channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(title || '📩 고객지원 티켓')
      .setDescription(description || `아래 ${dropdown ? '메뉴' : '버튼'}에서 문의 종류를 선택해 주세요. 비공개 티켓이 생성됩니다.`)], components });
    return error(i, '✅ 이 채널에 티켓 패널을 게시했어요.');
  }

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
    const typeId = Number(i.isStringSelectMenu() ? i.values[0] : i.customId.split(':')[2]);
    const type = db.prepare('SELECT * FROM ticket_types WHERE id=? AND guild_id=?').get(typeId, i.guildId);
    if (!type) return error(i, '삭제되었거나 존재하지 않는 티켓 종류예요.');
    if (!type.use_form && !type.require_purchase) return submit(i, { subject: type.name, detail: '', answers: [] });
    const questions = type.use_form ? JSON.parse(type.questions) : [];
    const inputs = type.use_form ? [row(new TextInputBuilder().setCustomId('subject').setLabel('문의 제목').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true)),
      row(new TextInputBuilder().setCustomId('detail').setLabel('문의 내용').setStyle(TextInputStyle.Paragraph).setMaxLength(1500).setRequired(true))] : [];
    if (type.require_purchase) inputs.push(row(new TextInputBuilder().setCustomId('purchase').setLabel('구매번호 (내정보에서 확인)').setStyle(TextInputStyle.Short).setMaxLength(12).setRequired(true)));
    for (let n = 0; n < questions.length; n++) inputs.push(row(new TextInputBuilder().setCustomId(`q${n}`).setLabel(questions[n]).setStyle(TextInputStyle.Short).setMaxLength(300).setRequired(true)));
    return i.showModal(new ModalBuilder().setCustomId(`ticket:submit:${type.id}`).setTitle(`${type.name} 티켓`.slice(0, 45)).addComponents(inputs));
  }
  async function submit(i, direct = null) {
    await i.deferReply(EPH);
    const settings = getSettings(i.guildId);
    if (!settings) return i.editReply('⚠️ 티켓 설정이 없어요.');
    // Synchronously reserve one open ticket per user to protect against double submission.
    const typeId = direct ? Number(i.isStringSelectMenu() ? i.values[0] : i.customId.split(':')[2]) : Number(i.customId.split(':')[2]);
    const type = db.prepare('SELECT * FROM ticket_types WHERE id=? AND guild_id=?').get(typeId, i.guildId);
    if (!type) return i.editReply('티켓 종류가 삭제되었어요.');
    const purchaseId = type.require_purchase ? Number(i.fields.getTextInputValue('purchase')) : null;
    const purchase = type.require_purchase && Number.isSafeInteger(purchaseId)
      ? db.prepare('SELECT id,product_name,price,created_at FROM purchases WHERE id=? AND guild_id=? AND user_id=?').get(purchaseId, i.guildId, i.user.id) : null;
    if (type.require_purchase && !purchase) return i.editReply('❌ 본인의 유효한 구매번호를 입력해 주세요. `/내정보`가 아닌 자판기 **내정보** 버튼에서 구매번호를 확인할 수 있어요.');
    const subject = direct ? direct.subject : type.use_form ? i.fields.getTextInputValue('subject') : type.name;
    const detail = direct ? direct.detail : type.use_form ? i.fields.getTextInputValue('detail') : '';
    const questions = type.use_form ? JSON.parse(type.questions) : [];
    const answers = direct ? direct.answers : questions.map((q, n) => ({ name: q, value: i.fields.getTextInputValue(`q${n}`).slice(0, 300) }));
    const reserved = db.transaction(() => {
      const old = db.prepare("SELECT channel_id FROM tickets WHERE guild_id=? AND user_id=? AND status IN ('open','creating')").get(i.guildId, i.user.id);
      if (old) return { old };
      const r = db.prepare('INSERT INTO tickets (guild_id,user_id,subject,status,created_at,type_name,purchase_id) VALUES (?,?,?,?,?,?,?)')
        .run(i.guildId, i.user.id, subject, 'creating', Date.now(), type.name, purchase?.id || null);
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
        embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`📩 ${type.name} · 티켓 #${id}`)
          .addFields({ name: '문의자', value: `<@${i.user.id}>` },
            { name: '제목', value: subject.slice(0, 100) },
            ...(detail ? [{ name: '문의 내용', value: detail.slice(0, 1024) }] : []),
            ...(purchase ? [{ name: '🧾 구매 정보', value: `주문 #${purchase.id}\n상품: ${purchase.product_name}\n가격: ${purchase.price.toLocaleString()}원\n구매일: <t:${Math.floor(purchase.created_at / 1000)}:F>` }] : []),
            ...answers)
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
  async function handleAdmin(i) {
    if (!adminOnly(i)) return error(i, '🚫 서버 주인만 티켓 서식을 관리할 수 있어요.');
    if (i.isModalSubmit()) {
      if (i.customId === 'ticket:admin:new:save') {
        if (getTypes(i.guildId).length >= 25) return error(i, '티켓 종류는 최대 25개예요.');
        const name = i.fields.getTextInputValue('name').trim();
        const questions = i.fields.getTextInputValue('questions').split('|').map(s => s.trim()).filter(Boolean);
        if (!name || questions.length > 3 || questions.some(q => q.length > 45)) return error(i, '이름은 필수이고 질문은 최대 3개(각 45자 이내)까지 가능해요.');
        const result = db.prepare('INSERT INTO ticket_types(guild_id,name,questions,require_purchase,use_form) VALUES (?,?,?,0,1)')
          .run(i.guildId, name, JSON.stringify(questions));
        return i.reply({ content: `✅ **${name}** 추가 완료! 아래에서 폼/인보이스 입력을 켜거나 끌 수 있어요.`, ...typeEditor(db.prepare('SELECT * FROM ticket_types WHERE id=?').get(result.lastInsertRowid)), ...EPH });
      }
      if (i.customId.startsWith('ticket:admin:questions:save:')) {
        const id = Number(i.customId.split(':')[4]);
        const type = db.prepare('SELECT * FROM ticket_types WHERE id=? AND guild_id=?').get(id, i.guildId);
        if (!type) return error(i, '티켓 종류를 찾지 못했어요.');
        const questions = i.fields.getTextInputValue('questions').split('|').map(s => s.trim()).filter(Boolean);
        if (questions.length > (type.require_purchase ? 2 : 3) || questions.some(q => q.length > 45)) return error(i, `질문은 ${type.require_purchase ? 2 : 3}개 이하, 각 45자 이내로 적어 주세요.`);
        db.prepare('UPDATE ticket_types SET questions=? WHERE id=? AND guild_id=?').run(JSON.stringify(questions), id, i.guildId);
        return i.reply({ ...typeEditor({ ...type, questions: JSON.stringify(questions) }), ...EPH });
      }
      if (i.customId === 'ticket:admin:panel:save') {
        const mode = i.fields.getTextInputValue('mode').trim().toLowerCase();
        if (!['드롭다운','버튼','dropdown','button'].includes(mode)) return error(i, '표시방식은 `드롭다운` 또는 `버튼`으로 적어 주세요.');
        return publishPanel(i, i.fields.getTextInputValue('title').slice(0, 100), i.fields.getTextInputValue('description').slice(0, 2000), ['드롭다운','dropdown'].includes(mode));
      }
    }
    if (i.isStringSelectMenu() && i.customId === 'ticket:admin:select') {
      const type = db.prepare('SELECT * FROM ticket_types WHERE id=? AND guild_id=?').get(Number(i.values[0]), i.guildId);
      return i.update(type ? typeEditor(type) : { content: '종류를 찾지 못했어요.', components: [] });
    }
    if (!i.isButton()) return;
    const parts = i.customId.split(':');
    const action = parts[2];
    if (action === 'home') return i.update(adminHome(i.guildId));
    if (action === 'new') return i.showModal(adminModal('ticket:admin:new:save', '티켓 종류 추가', [
      ['name', '티켓 종류 이름', '', true], ['questions', '입력 질문 (| 구분, 선택)', '']]));
    if (action === 'panel') return i.showModal(adminModal('ticket:admin:panel:save', '티켓 패널 게시', [
      ['title', '패널 제목', '📩 고객지원 티켓'], ['description', '안내 문구', '문의 종류를 선택해 주세요.'],
      ['mode', '표시방식: 드롭다운 또는 버튼', '드롭다운', true]]));
    if (action === 'pick') {
      const types = getTypes(i.guildId);
      if (!types.length) return i.update({ content: '등록된 종류가 없어요. 종류를 먼저 추가하세요.', components: [row(button('ticket:admin:home','↩ 관리 홈',ButtonStyle.Secondary))], embeds: [] });
      return i.update({ content: '수정할 티켓 종류를 선택하세요.', embeds: [], components: [row(new StringSelectMenuBuilder()
        .setCustomId('ticket:admin:select').setPlaceholder('티켓 종류 선택').addOptions(types.map(t => ({ label: t.name, value: String(t.id) })))),
        row(button('ticket:admin:home','↩ 관리 홈',ButtonStyle.Secondary))] });
    }
    const id = Number(parts[3]);
    const type = db.prepare('SELECT * FROM ticket_types WHERE id=? AND guild_id=?').get(id, i.guildId);
    if (!type) return error(i, '티켓 종류를 찾지 못했어요.');
    if (action === 'questions') return i.showModal(adminModal(`ticket:admin:questions:save:${id}`, '입력 질문 수정', [
      ['questions', '질문을 | 로 구분 (비우면 삭제)', JSON.parse(type.questions).join('|')]]));
    if (action === 'delete') return i.update({ content: `⚠️ **${type.name}** 종류를 삭제할까요?`, embeds: [], components: [row(
      button(`ticket:admin:confirm:${id}`, '삭제 확정', ButtonStyle.Danger), button('ticket:admin:home', '취소', ButtonStyle.Secondary))] });
    if (action === 'confirm') {
      db.prepare('DELETE FROM ticket_types WHERE id=? AND guild_id=?').run(id, i.guildId);
      return i.update(adminHome(i.guildId));
    }
    if (action === 'form' || action === 'invoice') {
      const nextForm = action === 'form' ? Number(!type.use_form) : type.use_form;
      const nextInvoice = action === 'invoice' ? Number(!type.require_purchase) : type.require_purchase;
      if (nextForm && JSON.parse(type.questions).length > (nextInvoice ? 2 : 3)) return error(i, '인보이스 입력 ON일 때 질문은 최대 2개예요. 질문을 먼저 줄여 주세요.');
      db.prepare('UPDATE ticket_types SET use_form=?,require_purchase=? WHERE id=? AND guild_id=?').run(nextForm,nextInvoice,id,i.guildId);
      return i.update(typeEditor({ ...type, use_form: nextForm, require_purchase: nextInvoice }));
    }
  }
  async function handle(i) {
    if (!i.guild) return;
    if (!isLicensed(i.guildId)) return error(i, '⛔ 일반 또는 프리미엄 라이센스가 필요합니다. `/라이센스등록`으로 등록해 주세요.');
    if (i.isChatInputCommand() && i.commandName === '티켓관리') return adminOnly(i)
      ? i.reply({ ...adminHome(i.guildId), ...EPH }) : error(i, '서버 주인 전용이에요.');
    if ((i.isButton() || i.isModalSubmit() || i.isStringSelectMenu()) && i.customId.startsWith('ticket:admin:')) return handleAdmin(i);
    if (i.isStringSelectMenu() && i.customId === 'ticket:type') return create(i);
    if (i.isButton() && (i.customId === 'ticket:create' || i.customId.startsWith('ticket:create:'))) return create(i);
    if (i.isModalSubmit() && i.customId.startsWith('ticket:submit:')) return submit(i);
    if ((i.isButton() && i.customId === 'ticket:close') || (i.isChatInputCommand() && i.commandName === '티켓닫기')) return close(i);
    if (!i.isChatInputCommand()) return;
    if (i.commandName === '티켓열기') return reopen(i);
    if (i.commandName === '티켓삭제') return remove(i);
    if (['티켓종류추가','티켓종류수정','티켓종류삭제','티켓종류목록'].includes(i.commandName)) {
      if (i.user.id !== i.guild.ownerId) return error(i, '서버 주인만 티켓 서식을 설정할 수 있어요.');
      if (i.commandName === '티켓종류목록') {
        const types = getTypes(i.guildId);
        return error(i, types.length ? types.map(t => `#${t.id} **${t.name}** · 폼 ${t.use_form ? 'ON' : 'OFF'} · 인보이스 입력 ${t.require_purchase ? 'ON' : 'OFF'} · 질문: ${JSON.parse(t.questions).join(', ') || '없음'}`).join('\n').slice(0, 1900) : '등록된 종류가 없어요. `/티켓종류추가`를 사용하세요.');
      }
      if (i.commandName === '티켓종류삭제') {
        const r = db.prepare('DELETE FROM ticket_types WHERE id=? AND guild_id=?').run(i.options.getInteger('번호'), i.guildId);
        return error(i, r.changes ? '✅ 삭제했어요. 기존 게시 패널은 다시 게시해 주세요.' : '해당 번호가 없어요.');
      }
      const editing = i.commandName === '티켓종류수정';
      const old = editing ? db.prepare('SELECT * FROM ticket_types WHERE id=? AND guild_id=?').get(i.options.getInteger('번호'), i.guildId) : null;
      if (editing && !old) return error(i, '해당 번호의 티켓 종류가 없어요.');
      if (!editing && getTypes(i.guildId).length >= 25) return error(i, '티켓 종류는 최대 25개까지 만들 수 있어요.');
      const name = editing ? old.name : i.options.getString('이름').trim();
      const useForm = i.options.getBoolean('폼') === null ? (editing ? old.use_form : 1) : Number(i.options.getBoolean('폼'));
      const invoice = i.options.getBoolean('인보이스입력');
      const requirePurchase = invoice === null ? (editing ? old.require_purchase : 0) : Number(invoice);
      const questionOption = i.options.getString('질문');
      const questions = questionOption === null && editing ? JSON.parse(old.questions) : (questionOption || '').trim() === '없음' ? [] : (questionOption || '').split('|').map(s => s.trim()).filter(Boolean);
      if (!name || (useForm && questions.length > (requirePurchase ? 2 : 3)) || questions.some(q => q.length > 45)) return error(i, `❌ 질문은 ${requirePurchase ? '2' : '3'}개 이하, 각 45자 이내로 입력해 주세요.`);
      if (editing) db.prepare('UPDATE ticket_types SET questions=?,require_purchase=?,use_form=? WHERE id=? AND guild_id=?')
        .run(JSON.stringify(questions), requirePurchase, useForm, old.id, i.guildId);
      else db.prepare('INSERT INTO ticket_types(guild_id,name,questions,require_purchase,use_form) VALUES (?,?,?,?,?)')
        .run(i.guildId,name,JSON.stringify(questions),requirePurchase,useForm);
      return error(i, `✅ **${name}** 티켓 설정 ${editing ? '수정' : '추가'} 완료! 폼 ${useForm ? 'ON' : 'OFF'}, 인보이스 입력 ${requirePurchase ? 'ON' : 'OFF'}\n변경된 종류/드롭다운 설정을 반영하려면 `/티켓패널`로 새 패널을 게시해 주세요.`);
    }
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
      const types = getTypes(i.guildId);
      if (!types.length) return error(i, '먼저 `/티켓종류추가`로 티켓 종류를 등록해 주세요.');
      const dropdown = i.options.getBoolean('드롭다운') !== false;
      const components = dropdown
        ? [row(new StringSelectMenuBuilder().setCustomId('ticket:type').setPlaceholder('문의 종류를 선택하세요')
          .addOptions(types.map(t => ({ label: t.name.slice(0, 100), value: String(t.id), description: t.require_purchase ? '인보이스 정보 입력' : '문의 접수' }))))]
        : Array.from({ length: Math.ceil(types.length / 5) }, (_, n) => row(...types.slice(n * 5, n * 5 + 5)
          .map(t => button(`ticket:create:${t.id}`, t.name.slice(0, 80), ButtonStyle.Primary))));
      await i.channel.send({
        embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(i.options.getString('제목')?.slice(0, 100) || '📩 고객지원 티켓')
          .setDescription(i.options.getString('안내')?.slice(0, 2000) || `아래 ${dropdown ? '메뉴' : '버튼'}에서 문의 종류를 선택해 주세요. 담당자만 볼 수 있는 비공개 티켓이 생성됩니다.`)],
        components,
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
