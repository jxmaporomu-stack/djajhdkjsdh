require('dotenv').config();
const fs = require('fs');
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits,
  EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');

const { TOKEN, CLIENT_ID, GUILD_ID } = process.env;
const DB_FILE = './db.json';
const EPH = MessageFlags.Ephemeral;

/* ───────────── 데이터 저장 (JSON) ───────────── */
const defaultDB = {
  nextId: 1,
  nextChargeId: 1,
  charges: {},  // id: { id, userId, amount, depositor, imageUrl, status, handledBy }
  products: {}, // id: { id, name, price, stock: [string] }
  users: {},    // uid: { balance, checkInAt, lastRewardDate, totalMinutes }
  settings: { globalDiscount: 0, roleDiscounts: {}, buyerRoleId: null, attendReward: 100, bank: null, chargeChannelId: null },
};
let db = defaultDB;
if (fs.existsSync(DB_FILE)) {
  db = { ...defaultDB, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  db.settings = { ...defaultDB.settings, ...db.settings };
}
db.sessions ??= {}; // channelId: { userId, amount, depositor, createdAt, busy }
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const getUser = (id) => (db.users[id] ??= { balance: 0, checkInAt: null, lastRewardDate: null, totalMinutes: 0 });
const kstDate = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const won = (n) => `${n.toLocaleString()}P`;

/* 할인율: 전체 할인과 보유 역할 할인 중 가장 큰 값 1개만 적용 (중복 적용 X) */
function getDiscount(member) {
  let pct = db.settings.globalDiscount;
  for (const [rid, p] of Object.entries(db.settings.roleDiscounts)) {
    if (member.roles.cache.has(rid) && p > pct) pct = p;
  }
  return pct;
}
const finalPrice = (price, pct) => Math.floor((price * (100 - pct)) / 100);

/* ───────────── 슬래시 명령어 정의 ───────────── */
const admin = PermissionFlagsBits.Administrator;
const productOpt = (o) => o.setName('상품').setDescription('상품').setAutocomplete(true).setRequired(true);
const commands = [
  new SlashCommandBuilder().setName('상품추가').setDescription('상품 등록 (관리자)')
    .addStringOption((o) => o.setName('이름').setDescription('상품 이름').setRequired(true))
    .addIntegerOption((o) => o.setName('가격').setDescription('가격(포인트)').setMinValue(0).setRequired(true))
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('상품삭제').setDescription('상품 삭제 (관리자)')
    .addStringOption(productOpt).setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('재고추가').setDescription('재고 추가 - 한 줄에 상품 1개 (관리자)')
    .addStringOption(productOpt).setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('상품목록').setDescription('상품/재고 현황 (관리자)')
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('자판기설치').setDescription('현재 채널에 자판기 메시지 설치 (관리자)')
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('전체할인').setDescription('전체 할인율 설정 (관리자)')
    .addIntegerOption((o) => o.setName('퍼센트').setDescription('0~100 (0이면 해제)').setMinValue(0).setMaxValue(100).setRequired(true))
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('역할할인').setDescription('특정 역할 할인율 설정 (관리자)')
    .addRoleOption((o) => o.setName('역할').setDescription('할인 받을 역할').setRequired(true))
    .addIntegerOption((o) => o.setName('퍼센트').setDescription('0~100 (0이면 해제)').setMinValue(0).setMaxValue(100).setRequired(true))
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('구매자역할').setDescription('구매 시 지급할 역할 설정 (관리자)')
    .addRoleOption((o) => o.setName('역할').setDescription('구매자 역할').setRequired(true))
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('잔액지급').setDescription('유저에게 포인트 지급/차감 (관리자)')
    .addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true))
    .addIntegerOption((o) => o.setName('금액').setDescription('음수면 차감').setRequired(true))
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('출근보상').setDescription('하루 첫 출근 보상 포인트 설정 (관리자)')
    .addIntegerOption((o) => o.setName('금액').setDescription('포인트').setMinValue(0).setRequired(true))
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('계좌설정').setDescription('충전용 입금 계좌 설정 (관리자)')
    .addStringOption((o) => o.setName('은행').setDescription('은행명').setRequired(true))
    .addStringOption((o) => o.setName('계좌번호').setDescription('계좌번호').setRequired(true))
    .addStringOption((o) => o.setName('예금주').setDescription('예금주').setRequired(true))
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('충전채널').setDescription('충전 요청이 올라올 관리자 채널 설정 (관리자)')
    .addChannelOption((o) => o.setName('채널').setDescription('관리자만 볼 수 있는 채널').setRequired(true))
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('충전안내').setDescription('입금 계좌 및 이중창 인증 방법 보기'),
  new SlashCommandBuilder().setName('충전패널').setDescription('현재 채널에 충전 신청 버튼 설치 (관리자)')
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('잔액').setDescription('내 포인트 확인'),
  new SlashCommandBuilder().setName('출근').setDescription('출근하기'),
  new SlashCommandBuilder().setName('퇴근').setDescription('퇴근하기'),
].map((c) => c.toJSON());

/* ───────────── 클라이언트 ───────────── */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once('clientReady', async () => {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log(`✅ ${client.user.tag} 로그인 / 명령어 등록 완료`);
});

function vendingPanel() {
  const products = Object.values(db.products).slice(0, 25);
  const embed = new EmbedBuilder().setTitle('🛒 자판기').setColor(0x5865f2)
    .setDescription(products.length
      ? products.map((p) => `**${p.name}** — ${won(p.price)} (재고 ${p.stock.length})`).join('\n')
      : '등록된 상품이 없습니다.')
    .setFooter({ text: '아래 메뉴에서 상품을 선택하세요. 할인은 구매 단계에서 자동 적용됩니다.' });
  const rows = [];
  if (products.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('vend_select').setPlaceholder('상품을 선택하세요')
        .addOptions(products.map((p) => ({
          label: p.name.slice(0, 100), description: `${won(p.price)} / 재고 ${p.stock.length}`, value: p.id,
        }))),
    ));
  }
  return { embeds: [embed], components: rows };
}

/* ───────────── 구매 처리 ───────────── */
async function purchase(interaction, productId) {
  const product = db.products[productId];
  if (!product) return interaction.editReply('존재하지 않는 상품입니다.');
  if (!product.stock.length) return interaction.editReply('❌ 품절된 상품입니다.');

  const user = getUser(interaction.user.id);
  const pct = getDiscount(interaction.member);
  const price = finalPrice(product.price, pct);
  if (user.balance < price) {
    return interaction.editReply(`❌ 포인트가 부족합니다. (필요 ${won(price)} / 보유 ${won(user.balance)})`);
  }

  // 결제 + 재고 차감 (여기까지 await 없음 → 동시 구매에도 안전)
  const item = product.stock.shift();
  user.balance -= price;
  save();

  // DM 발송, 실패 시 전액 환불 + 재고 복구
  try {
    await interaction.user.send({
      embeds: [new EmbedBuilder().setTitle('📦 구매 상품 도착').setColor(0x57f287)
        .addFields(
          { name: '상품', value: product.name },
          { name: '결제 금액', value: `${won(price)}${pct ? ` (${pct}% 할인)` : ''}` },
          { name: '내용', value: `\`\`\`\n${item}\n\`\`\`` },
        ).setTimestamp()],
    });
  } catch {
    product.stock.unshift(item);
    user.balance += price;
    save();
    return interaction.editReply('❌ DM 전송 실패! 서버 멤버의 DM 허용을 켠 뒤 다시 시도해주세요. (결제는 취소되었습니다)');
  }

  // 구매자 역할 지급
  let roleMsg = '';
  const roleId = db.settings.buyerRoleId;
  if (roleId) {
    try { await interaction.member.roles.add(roleId); roleMsg = '\n🏷️ 구매자 역할이 지급되었습니다.'; }
    catch { roleMsg = '\n⚠️ 역할 지급 실패 (봇 권한/역할 순서를 확인하세요).'; }
  }

  return interaction.editReply(
    `✅ **${product.name}** 구매 완료! DM을 확인하세요.\n결제 ${won(price)}${pct ? ` (${pct}% 할인)` : ''} / 남은 포인트 ${won(user.balance)}${roleMsg}`,
  );
}

/* ───────────── 인터랙션 ───────────── */
client.on('interactionCreate', async (i) => {
  try {
    // 상품 자동완성
    if (i.isAutocomplete()) {
      const q = i.options.getFocused().toLowerCase();
      return i.respond(Object.values(db.products)
        .filter((p) => p.name.toLowerCase().includes(q)).slice(0, 25)
        .map((p) => ({ name: `${p.name} (${won(p.price)})`, value: p.id })));
    }

    // 자판기 상품 선택 → 가격 안내 + 구매 버튼
    if (i.isStringSelectMenu() && i.customId === 'vend_select') {
      const p = db.products[i.values[0]];
      if (!p) return i.reply({ content: '존재하지 않는 상품입니다.', flags: EPH });
      const pct = getDiscount(i.member);
      const price = finalPrice(p.price, pct);
      return i.reply({
        flags: EPH,
        embeds: [new EmbedBuilder().setTitle(p.name).setColor(0xfee75c).addFields(
          { name: '정가', value: won(p.price), inline: true },
          { name: '할인', value: `${pct}%`, inline: true },
          { name: '결제 금액', value: won(price), inline: true },
          { name: '내 포인트', value: won(getUser(i.user.id).balance), inline: true },
          { name: '재고', value: `${p.stock.length}개`, inline: true },
        )],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`buy:${p.id}`).setLabel('구매하기').setStyle(ButtonStyle.Success))],
      });
    }

    // 충전 신청 버튼 → 금액/입금자명 입력창
    if (i.isButton() && i.customId === 'charge_open') {
      return i.showModal(new ModalBuilder().setCustomId('charge_form').setTitle('충전 신청').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('입금 금액(원, 최소 1000)')
          .setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('depositor').setLabel('입금자명')
          .setStyle(TextInputStyle.Short).setRequired(true))));
    }

    // 충전 신청 입력 제출 → 개인 채널 생성
    if (i.isModalSubmit() && i.customId === 'charge_form') {
      const st = db.settings;
      if (!st.bank || !st.chargeChannelId) return i.reply({ content: '충전 기능이 아직 설정되지 않았습니다.', flags: EPH });
      const amount = parseInt(i.fields.getTextInputValue('amount').replace(/[^0-9]/g, ''), 10);
      const depositor = i.fields.getTextInputValue('depositor').trim();
      if (!amount || amount < 1000) return i.reply({ content: '금액은 1,000원 이상 숫자로 입력해주세요.', flags: EPH });
      if (Object.values(db.sessions).some((x) => x.userId === i.user.id)) {
        return i.reply({ content: '이미 열려 있는 충전 채널이 있습니다.', flags: EPH });
      }
      const pend = Object.values(db.charges).filter((c) => c.userId === i.user.id && c.status === 'pending').length;
      if (pend >= 3) return i.reply({ content: '처리 대기 중인 충전 요청이 너무 많습니다.', flags: EPH });

      await i.deferReply({ flags: EPH });
      const P = PermissionFlagsBits;
      const ch = await i.guild.channels.create({
        name: `충전-${i.user.username}`.slice(0, 90),
        type: ChannelType.GuildText,
        parent: i.channel?.parentId ?? undefined,
        permissionOverwrites: [
          { id: i.guild.id, deny: [P.ViewChannel] },
          { id: i.user.id, allow: [P.ViewChannel, P.SendMessages, P.AttachFiles, P.ReadMessageHistory] },
          { id: client.user.id, allow: [P.ViewChannel, P.SendMessages, P.AttachFiles, P.EmbedLinks, P.ManageChannels, P.ReadMessageHistory] },
        ],
      }).catch(() => null);
      if (!ch) return i.editReply('❌ 채널 생성 실패. 봇에 채널 관리 권한이 있는지 확인해주세요.');
      db.sessions[ch.id] = { userId: i.user.id, amount, depositor, createdAt: Date.now(), busy: false };
      save();
      await ch.send({
        content: `${i.user}`,
        embeds: [new EmbedBuilder().setTitle('💳 충전 인증').setColor(0xfee75c).addFields(
          { name: '입금 계좌', value: `${st.bank.bank} ${st.bank.number} (예금주 ${st.bank.holder})` },
          { name: '신청 내용', value: `${amount.toLocaleString()}원 / 입금자명 ${depositor}` },
          { name: '이중창 인증 방법', value: '1. 위 계좌로 이체합니다.\n2. 폰 화면 분할로 **은행 이체 완료 화면 + 디스코드 화면**을 동시에 띄웁니다.\n3. 그 상태로 캡처해서 **이 채널 메시지창에 사진을 보내세요.**' },
          { name: '안내', value: '15분 안에 사진을 보내지 않으면 채널이 자동 삭제됩니다. 비밀번호 등 민감 정보는 가리고 보내주세요.' },
        )],
      });
      return i.editReply(`✅ ${ch} 채널이 열렸습니다. 이체 후 그곳에 이중창 캡처를 보내주세요.`);
    }

    // 충전 승인/거절 버튼 (관리자 전용)
    if (i.isButton() && /^charge_(ok|no):/.test(i.customId)) {
      if (!i.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return i.reply({ content: '관리자만 처리할 수 있습니다.', flags: EPH });
      }
      const [act, id] = i.customId.split(':');
      const c = db.charges[id];
      if (!c || c.status !== 'pending') return i.reply({ content: '이미 처리되었거나 없는 요청입니다.', flags: EPH });
      const ok = act === 'charge_ok';
      c.status = ok ? 'approved' : 'rejected';
      c.handledBy = i.user.id;
      if (ok) getUser(c.userId).balance += c.amount;
      save();
      const embed = EmbedBuilder.from(i.message.embeds[0]).setColor(ok ? 0x57f287 : 0xed4245)
        .setTitle(`${ok ? '✅ 승인' : '❌ 거절'} - 충전 요청 #${id}`)
        .setFooter({ text: `처리자: ${i.user.tag}` });
      await i.update({ embeds: [embed], components: [] });
      const target = await client.users.fetch(c.userId).catch(() => null);
      target?.send(ok
        ? `✅ ${won(c.amount)} 충전이 완료되었습니다! 현재 포인트: ${won(getUser(c.userId).balance)}`
        : '❌ 충전 요청이 거절되었습니다. 이체 화면과 디스코드 화면이 한 화면에 함께 보이는 이중창 캡처로 다시 신청해주세요.').catch(() => {});
      return;
    }

    // 구매 버튼
    if (i.isButton() && i.customId.startsWith('buy:')) {
      await i.deferReply({ flags: EPH });
      return purchase(i, i.customId.split(':')[1]);
    }

    // 재고 입력 모달 제출
    if (i.isModalSubmit() && i.customId.startsWith('stock:')) {
      const p = db.products[i.customId.split(':')[1]];
      if (!p) return i.reply({ content: '존재하지 않는 상품입니다.', flags: EPH });
      const lines = i.fields.getTextInputValue('items').split('\n').map((s) => s.trim()).filter(Boolean);
      p.stock.push(...lines);
      save();
      return i.reply({ content: `✅ **${p.name}** 재고 ${lines.length}개 추가 (현재 ${p.stock.length}개)`, flags: EPH });
    }

    if (!i.isChatInputCommand()) return;
    const n = i.commandName;

    if (n === '상품추가') {
      const id = String(db.nextId++);
      db.products[id] = { id, name: i.options.getString('이름'), price: i.options.getInteger('가격'), stock: [] };
      save();
      return i.reply({ content: `✅ 상품 등록: **${db.products[id].name}** (${won(db.products[id].price)})\n\`/재고추가\`로 재고를 넣어주세요.`, flags: EPH });
    }
    if (n === '상품삭제') {
      const p = db.products[i.options.getString('상품')];
      if (!p) return i.reply({ content: '존재하지 않는 상품입니다.', flags: EPH });
      delete db.products[p.id]; save();
      return i.reply({ content: `🗑️ **${p.name}** 삭제 완료`, flags: EPH });
    }
    if (n === '재고추가') {
      const p = db.products[i.options.getString('상품')];
      if (!p) return i.reply({ content: '존재하지 않는 상품입니다.', flags: EPH });
      return i.showModal(new ModalBuilder().setCustomId(`stock:${p.id}`).setTitle(`${p.name} 재고 추가`.slice(0, 45))
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('items').setLabel('한 줄에 상품 1개씩 입력')
            .setStyle(TextInputStyle.Paragraph).setRequired(true))));
    }
    if (n === '상품목록') {
      const list = Object.values(db.products).map((p) => `\`${p.id}\` **${p.name}** ${won(p.price)} / 재고 ${p.stock.length}`).join('\n') || '상품 없음';
      return i.reply({ content: list, flags: EPH });
    }
    if (n === '자판기설치') {
      await i.channel.send(vendingPanel());
      return i.reply({ content: '✅ 자판기를 설치했습니다. (상품/재고가 바뀌면 다시 설치하세요)', flags: EPH });
    }
    if (n === '전체할인') {
      db.settings.globalDiscount = i.options.getInteger('퍼센트'); save();
      return i.reply({ content: `🏷️ 전체 할인: **${db.settings.globalDiscount}%**`, flags: EPH });
    }
    if (n === '역할할인') {
      const role = i.options.getRole('역할'); const pct = i.options.getInteger('퍼센트');
      if (pct === 0) delete db.settings.roleDiscounts[role.id]; else db.settings.roleDiscounts[role.id] = pct;
      save();
      return i.reply({ content: pct ? `🏷️ ${role} 역할 할인 **${pct}%** 설정` : `🏷️ ${role} 역할 할인 해제`, flags: EPH });
    }
    if (n === '구매자역할') {
      const role = i.options.getRole('역할'); db.settings.buyerRoleId = role.id; save();
      return i.reply({ content: `✅ 구매 시 ${role} 역할이 지급됩니다. (봇 역할이 이 역할보다 위에 있어야 합니다)`, flags: EPH });
    }
    if (n === '잔액지급') {
      const u = i.options.getUser('유저'); const amt = i.options.getInteger('금액');
      const data = getUser(u.id); data.balance = Math.max(0, data.balance + amt); save();
      return i.reply({ content: `✅ ${u} 잔액: ${won(data.balance)} (${amt >= 0 ? '+' : ''}${amt})`, flags: EPH });
    }
    if (n === '출근보상') {
      db.settings.attendReward = i.options.getInteger('금액'); save();
      return i.reply({ content: `✅ 하루 첫 출근 보상: ${won(db.settings.attendReward)}`, flags: EPH });
    }
    if (n === '계좌설정') {
      db.settings.bank = { bank: i.options.getString('은행'), number: i.options.getString('계좌번호'), holder: i.options.getString('예금주') };
      save();
      return i.reply({ content: '✅ 입금 계좌 설정 완료', flags: EPH });
    }
    if (n === '충전채널') {
      const ch = i.options.getChannel('채널'); db.settings.chargeChannelId = ch.id; save();
      return i.reply({ content: `✅ 충전 요청이 ${ch} 에 올라옵니다. (관리자만 볼 수 있는 채널로 지정하세요)`, flags: EPH });
    }
    if (n === '충전안내') {
      const b = db.settings.bank;
      if (!b) return i.reply({ content: '충전 계좌가 아직 설정되지 않았습니다. 관리자에게 문의하세요.', flags: EPH });
      return i.reply({
        flags: EPH,
        embeds: [new EmbedBuilder().setTitle('💳 계좌 충전 안내').setColor(0x5865f2).addFields(
          { name: '입금 계좌', value: `${b.bank} ${b.number} (예금주 ${b.holder})` },
          { name: '충전 비율', value: '1원 = 1P (최소 1,000원)' },
          { name: '이중창 인증 방법', value: '1. 계좌로 입금(이체)합니다.\n2. 폰에서 화면 분할(멀티윈도우)로 **은행 이체 완료 화면**과 **디스코드 화면**을 한 화면에 같이 띄웁니다.\n3. 충전 패널의 **충전 신청** 버튼 → 금액/입금자명 입력 → 열린 채널에 캡처를 보냅니다.\n4. 관리자가 확인하면 포인트가 지급되고 DM으로 알려드립니다.' },
          { name: '주의', value: '입금자명/금액이 사진과 일치해야 합니다. 비밀번호·보안카드 번호 등 민감 정보는 가리고 올려주세요.' },
        )],
      });
    }
    if (n === '충전패널') {
      if (!db.settings.bank || !db.settings.chargeChannelId) {
        return i.reply({ content: '먼저 `/계좌설정`과 `/충전채널`을 설정해주세요.', flags: EPH });
      }
      await i.channel.send({
        embeds: [new EmbedBuilder().setTitle('💳 계좌 충전').setColor(0x5865f2)
          .setDescription('아래 버튼을 누르면 **나만 볼 수 있는 충전 채널**이 열립니다.\n그 채널에 이체 후 **이중창 인증 사진**을 보내면 관리자에게 전달됩니다.')],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('charge_open').setLabel('충전 신청').setStyle(ButtonStyle.Primary))],
      });
      return i.reply({ content: '✅ 충전 패널을 설치했습니다.', flags: EPH });
    }
    if (n === '잔액') {
      return i.reply({ content: `💰 보유 포인트: **${won(getUser(i.user.id).balance)}**`, flags: EPH });
    }
    if (n === '출근') {
      const u = getUser(i.user.id);
      if (u.checkInAt) return i.reply({ content: '이미 출근 상태입니다. `/퇴근`을 먼저 해주세요.', flags: EPH });
      u.checkInAt = Date.now();
      let msg = `🏢 출근 완료! (<t:${Math.floor(u.checkInAt / 1000)}:T>)`;
      const today = kstDate();
      if (u.lastRewardDate !== today && db.settings.attendReward > 0) {
        u.balance += db.settings.attendReward; u.lastRewardDate = today;
        msg += `\n🎁 오늘의 출근 보상 ${won(db.settings.attendReward)} 지급!`;
      }
      save();
      return i.reply(msg);
    }
    if (n === '퇴근') {
      const u = getUser(i.user.id);
      if (!u.checkInAt) return i.reply({ content: '출근 상태가 아닙니다. `/출근`을 먼저 해주세요.', flags: EPH });
      const mins = Math.floor((Date.now() - u.checkInAt) / 60000);
      u.totalMinutes += mins; u.checkInAt = null; save();
      return i.reply(`🏠 퇴근 완료! 오늘 근무 **${Math.floor(mins / 60)}시간 ${mins % 60}분** (누적 ${Math.floor(u.totalMinutes / 60)}시간 ${u.totalMinutes % 60}분)`);
    }
  } catch (e) {
    console.error(e);
    const msg = { content: '⚠️ 오류가 발생했습니다.', flags: EPH };
    if (i.deferred || i.replied) i.followUp(msg).catch(() => {}); else i.reply(msg).catch(() => {});
  }
});

/* ───────────── 충전 개인 채널: 사진 수신 → 관리자 채널 전달 ───────────── */
const SESSION_MS = 15 * 60 * 1000;

async function closeSession(channelId) {
  delete db.sessions[channelId];
  save();
  const ch = await client.channels.fetch(channelId).catch(() => null);
  await ch?.delete().catch(() => {});
}
setInterval(() => {
  for (const [cid, x] of Object.entries(db.sessions)) {
    if (Date.now() - x.createdAt > SESSION_MS) closeSession(cid);
  }
}, 60 * 1000);

client.on('messageCreate', async (m) => {
  if (m.author.bot) return;
  const sess = db.sessions[m.channelId];
  if (!sess || sess.userId !== m.author.id || sess.busy) return;

  const file = m.attachments.find((a) => a.contentType?.startsWith('image/'));
  if (!file) return void m.reply('📷 이중창 캡처 **이미지**를 첨부해서 보내주세요.').catch(() => {});

  sess.busy = true;
  const adminCh = await client.channels.fetch(db.settings.chargeChannelId).catch(() => null);
  if (!adminCh) {
    sess.busy = false;
    return void m.reply('❌ 관리자 확인 채널을 찾을 수 없습니다. 관리자에게 문의하세요.').catch(() => {});
  }
  const id = String(db.nextChargeId);
  const ext = file.contentType.split('/')[1].split(';')[0];
  const name = `proof.${ext}`;
  // 개인 채널이 삭제돼도 사진이 남도록 관리자 채널에 사진을 다시 업로드
  const sent = await adminCh.send({
    embeds: [new EmbedBuilder().setTitle(`💳 충전 요청 #${id}`).setColor(0xfee75c)
      .addFields(
        { name: '신청자', value: `${m.author} (${m.author.tag})`, inline: true },
        { name: '금액', value: `${sess.amount.toLocaleString()}원`, inline: true },
        { name: '입금자명', value: sess.depositor, inline: true },
      ).setImage(`attachment://${name}`).setTimestamp()],
    files: [new AttachmentBuilder(file.url, { name })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`charge_ok:${id}`).setLabel('승인').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`charge_no:${id}`).setLabel('거절').setStyle(ButtonStyle.Danger))],
  }).catch(() => null);
  if (!sent) {
    sess.busy = false;
    return void m.reply('❌ 관리자 채널에 요청을 보내지 못했습니다. 관리자에게 문의하세요.').catch(() => {});
  }
  db.charges[id] = { id, userId: m.author.id, amount: sess.amount, depositor: sess.depositor, imageUrl: file.url, status: 'pending', handledBy: null };
  db.nextChargeId++;
  save();
  await m.reply(`✅ 충전 요청 #${id} 접수 완료! 관리자 확인 후 DM으로 알려드립니다. 이 채널은 5초 뒤 삭제됩니다.`).catch(() => {});
  setTimeout(() => closeSession(m.channelId), 5000);
});

client.login(TOKEN);
