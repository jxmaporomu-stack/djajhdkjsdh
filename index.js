require('dotenv').config();
const crypto = require('crypto');
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  SlashCommandBuilder, MessageFlags,
} = require('discord.js');
const { db, q, buy, approveCharge, rejectCharge, redeemLicense } = require('./db');
const makeAdmin = require('./admin');

const { TOKEN, MASTER_ID, BOT_NAME = '자판기', LICENSE_PREFIX = 'VEND' } = process.env;
const FREE_GUILDS = (process.env.FREE_GUILD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const EPH = { flags: MessageFlags.Ephemeral };
const won = (n) => `${Number(n).toLocaleString()}원`;
const ts = (ms) => `<t:${Math.floor(ms / 1000)}:F>`;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/* ───────────── 슬래시 커맨드 정의 ───────────── */
const commands = [
  new SlashCommandBuilder().setName('패널').setDescription('자판기 패널을 이 채널에 올립니다 (서버 주인 전용)'),
  new SlashCommandBuilder().setName('설정').setDescription('계좌 안내 / 이용가이드 문구 설정 (서버 주인 전용)'),
  new SlashCommandBuilder().setName('상품추가').setDescription('상품 추가 (서버 주인 전용)')
    .addStringOption((o) => o.setName('카테고리').setDescription('예: 계정, 쿠폰').setRequired(true))
    .addStringOption((o) => o.setName('이름').setDescription('상품 이름').setRequired(true))
    .addIntegerOption((o) => o.setName('가격').setDescription('가격(원)').setMinValue(0).setRequired(true)),
  new SlashCommandBuilder().setName('재고추가').setDescription('상품 재고 추가 - 한 줄에 1개 (서버 주인 전용)')
    .addIntegerOption((o) => o.setName('상품번호').setDescription('/상품목록 에서 확인').setRequired(true)),
  new SlashCommandBuilder().setName('상품목록').setDescription('상품 번호/재고 확인 (서버 주인 전용)'),
  new SlashCommandBuilder().setName('상품삭제').setDescription('상품 삭제 (서버 주인 전용)')
    .addIntegerOption((o) => o.setName('상품번호').setDescription('삭제할 상품 번호').setRequired(true)),
  new SlashCommandBuilder().setName('잔액지급').setDescription('유저 잔액 지급/차감 (서버 주인 전용)')
    .addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true))
    .addIntegerOption((o) => o.setName('금액').setDescription('차감은 음수').setRequired(true)),
  new SlashCommandBuilder().setName('라이센스등록').setDescription('구매한 라이센스 키를 이 서버에 등록 (서버 주인 전용)')
    .addStringOption((o) => o.setName('키').setDescription('라이센스 키').setRequired(true)),
  new SlashCommandBuilder().setName('라이센스확인').setDescription('이 서버의 라이센스 만료일 확인'),
  new SlashCommandBuilder().setName('라이센스생성').setDescription('라이센스 키 생성 (봇 판매자 전용)')
    .addIntegerOption((o) => o.setName('기간').setDescription('이용 기간').setRequired(true)
      .addChoices({ name: '1개월 (30일)', value: 30 }, { name: '2개월 (60일)', value: 60 }, { name: '3개월 (90일)', value: 90 }))
    .addIntegerOption((o) => o.setName('개수').setDescription('생성 개수 (기본 1, 최대 20)').setMinValue(1).setMaxValue(20)),
  new SlashCommandBuilder().setName('라이센스목록').setDescription('미사용 라이센스 목록 (봇 판매자 전용)'),
  new SlashCommandBuilder().setName('출퇴근패널').setDescription('출퇴근 패널을 이 채널에 올립니다 (서버 주인 전용)'),
  new SlashCommandBuilder().setName('출퇴근기록').setDescription('내 출퇴근 기록 확인'),
  new SlashCommandBuilder().setName('관리').setDescription('자판기 관리 패널 열기 (서버 주인 전용)'),
].map((c) => c.toJSON());

client.once('ready', async () => {
  // 전역 명령어를 이 봇의 명령어로 통째로 교체 (예전에 등록된 전역 명령어 제거)
  await client.application.commands.set(commands);
  // 예전 코드가 서버(길드) 단위로 등록해 둔 명령어도 모두 제거 → 중복 표시 방지
  for (const guild of client.guilds.cache.values()) {
    await guild.commands.set([]).catch((e) => console.warn(`길드 명령어 정리 실패 (${guild.name}):`, e.message));
  }
  console.log(`✅ 로그인: ${client.user.tag}`);
});

/* ───────────── 유틸 ───────────── */
const isMaster = (id) => id === MASTER_ID;
const isOwner = (i) => i.user.id === i.guild.ownerId;
const isLicensed = (guildId) => FREE_GUILDS.includes(guildId) || q.getGuild(guildId).expires_at > Date.now();

function makeKey() {
  const part = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${LICENSE_PREFIX}-${part()}-${part()}-${part()}-${part()}`;
}

function panelPayload(guild) {
  const g = q.getGuild(guild.id);
  const embed = new EmbedBuilder()
    .setColor(g.panel_color ? parseInt(g.panel_color.slice(1), 16) : 0xff88cc)
    .setTitle(g.panel_title || '💎💜 24시간 무인 자판기 💜💎')
    .setDescription(
      [
        '━━━━━━━━━━━━━━━━━━━━━━',
        '💗 **상품스토어** – 카테고리별 편리한 쇼핑 & 즉시 자동 지급',
        '🤍 **잔액충전** – 계좌이체를 통한 간편 충전',
        '🖤 **내정보** – 잔액, 이용 기록 확인',
        '💗 **이용안내** – 자판기 이용 방법 및 가이드',
        '━━━━━━━━━━━━━━━━━━━━━━',
        '✨ 아래 버튼을 눌러 이용해 주세요. 모든 응답은 **나에게만** 안전하게 보여요 🔒',
      ].join('\n'),
    )
    .setFooter({ text: g.footer_text || `✦ ${BOT_NAME} ✦` })
    .setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('store').setLabel('제품스토어').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('charge').setLabel('잔액충전').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('myinfo').setLabel('내정보').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('guide').setLabel('이용가이드').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

const licenseText = (gid) => {
  if (FREE_GUILDS.includes(gid)) return '♾️ 무제한';
  const exp = q.getGuild(gid).expires_at;
  return exp > Date.now() ? `✅ ${ts(exp)} 까지` : '⛔ 만료 / 미등록';
};

const admin = makeAdmin({ won, ts, EPH, isOwner, panelPayload, clockPanelPayload, licenseText });

/* ───────────── 메인 핸들러 ───────────── */
client.on('interactionCreate', async (i) => {
  try {
    // 서버 주인 DM에서 누르는 충전 승인/거절 버튼 (DM이라 guild 없음)
    if (i.isButton() && /^chg_(ok|no):/.test(i.customId)) return await handleChargeDecision(i);

    if (!i.guild) return;

    // 라이센스 관련 명령은 라이센스 없어도 사용 가능
    if (i.isChatInputCommand() && ['라이센스등록', '라이센스확인', '라이센스생성', '라이센스목록'].includes(i.commandName)) {
      return await handleLicenseCmd(i);
    }

    // 라이센스 만료 시 전체 기능 잠금
    if (!isLicensed(i.guildId)) {
      return await i.reply({
        content: '⛔ 이 서버의 자판기 라이센스가 만료되었거나 등록되지 않았어요.\n서버 주인이 `/라이센스등록` 으로 키를 등록해 주세요.',
        ...EPH,
      });
    }

    if (admin.owns(i)) return await admin.handle(i);
    if (i.isChatInputCommand()) return await handleCommand(i);
    if (i.isButton()) return await handleButton(i);
    if (i.isStringSelectMenu()) return await handleSelect(i);
    if (i.isModalSubmit()) return await handleModal(i);
  } catch (e) {
    console.error(e);
    const msg = { content: '⚠️ 처리 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.', ...EPH };
    if (i.deferred || i.replied) i.followUp(msg).catch(() => {});
    else i.reply(msg).catch(() => {});
  }
});

/* ───────────── 슬래시 커맨드 (서버 주인용) ───────────── */
async function handleCommand(i) {
  if (i.commandName === '출퇴근기록') return myAttendance(i);
  if (!isOwner(i)) return i.reply({ content: '🚫 서버 주인만 사용할 수 있는 명령어예요.', ...EPH });
  const gid = i.guildId;

  switch (i.commandName) {
    case '패널': {
      await i.channel.send(panelPayload(i.guild));
      return i.reply({ content: '✅ 패널을 올렸어요.', ...EPH });
    }
    case '관리':
      return i.reply({ ...admin.home(gid), ...EPH });
    case '출퇴근패널': {
      await i.channel.send(clockPanelPayload(gid));
      return i.reply({ content: '✅ 출퇴근 패널을 올렸어요.', ...EPH });
    }
    case '설정': {
      const g = q.getGuild(gid);
      const modal = new ModalBuilder().setCustomId('settings').setTitle('자판기 설정').addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('bank').setLabel('입금 계좌 안내 (충전 신청 후 표시)')
            .setStyle(TextInputStyle.Paragraph).setValue(g.bank_info || '').setRequired(true)
            .setPlaceholder('예: 카카오뱅크 3333-00-0000000 홍길동'),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('guide').setLabel('이용가이드 문구')
            .setStyle(TextInputStyle.Paragraph).setValue(g.guide || '').setRequired(false),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('min').setLabel('최소 충전 금액(원)')
            .setStyle(TextInputStyle.Short).setValue(String(g.min_charge)).setRequired(true),
        ),
      );
      return i.showModal(modal);
    }
    case '상품추가': {
      const info = db.prepare('INSERT INTO products (guild_id, category, name, price) VALUES (?,?,?,?)')
        .run(gid, i.options.getString('카테고리').slice(0, 20), i.options.getString('이름').slice(0, 60), i.options.getInteger('가격'));
      return i.reply({ content: `✅ 상품 추가 완료 (번호 **${info.lastInsertRowid}**)\n\`/재고추가 ${info.lastInsertRowid}\` 로 재고를 넣어 주세요.`, ...EPH });
    }
    case '재고추가': {
      const pid = i.options.getInteger('상품번호');
      const p = db.prepare('SELECT * FROM products WHERE id = ? AND guild_id = ?').get(pid, gid);
      if (!p) return i.reply({ content: '❌ 없는 상품 번호예요.', ...EPH });
      const modal = new ModalBuilder().setCustomId(`stock:${pid}`).setTitle(`재고 추가 - ${p.name}`.slice(0, 45)).addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('lines').setLabel('한 줄에 재고 1개').setStyle(TextInputStyle.Paragraph).setRequired(true),
        ),
      );
      return i.showModal(modal);
    }
    case '상품목록': {
      const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM stock s WHERE s.product_id = p.id AND s.sold = 0) AS cnt
                               FROM products p WHERE guild_id = ? ORDER BY id`).all(gid);
      const text = rows.length
        ? rows.map((r) => `**#${r.id}** [${r.category}] ${r.name} — ${won(r.price)} (재고 ${r.cnt})`).join('\n')
        : '등록된 상품이 없어요. `/상품추가` 로 만들어 주세요.';
      return i.reply({ content: text.slice(0, 1900), ...EPH });
    }
    case '상품삭제': {
      const pid = i.options.getInteger('상품번호');
      const r = db.prepare('DELETE FROM products WHERE id = ? AND guild_id = ?').run(pid, gid);
      if (r.changes) db.prepare('DELETE FROM stock WHERE product_id = ?').run(pid);
      return i.reply({ content: r.changes ? '🗑️ 삭제했어요.' : '❌ 없는 상품 번호예요.', ...EPH });
    }
    case '잔액지급': {
      const user = i.options.getUser('유저');
      const amt = i.options.getInteger('금액');
      q.getUser(gid, user.id);
      db.prepare('UPDATE users SET balance = MAX(0, balance + ?) WHERE guild_id = ? AND user_id = ?').run(amt, gid, user.id);
      const u = q.getUser(gid, user.id);
      return i.reply({ content: `✅ ${user} 잔액: **${won(u.balance)}**`, ...EPH });
    }
  }
}

/* ───────────── 버튼 ───────────── */
async function handleButton(i) {
  const gid = i.guildId;

  if (i.customId === 'clock_in') return clockIn(i);
  if (i.customId === 'clock_out') return clockOut(i);

  if (i.customId === 'store') {
    const cats = db.prepare(`SELECT p.category, COUNT(*) AS n,
                               SUM((SELECT COUNT(*) FROM stock s WHERE s.product_id = p.id AND s.sold = 0)) AS cnt
                             FROM products p WHERE guild_id = ? GROUP BY p.category ORDER BY p.category LIMIT 25`).all(gid);
    if (!cats.length) return i.reply({ content: '😢 아직 등록된 상품이 없어요.', ...EPH });
    const menu = new StringSelectMenuBuilder().setCustomId('cat').setPlaceholder('카테고리를 선택하세요').addOptions(
      cats.map((c) => ({
        label: c.category.slice(0, 100),
        description: `상품 ${c.n}종 · 재고 ${c.cnt}개`,
        value: c.category,
      })),
    );
    return i.reply({ content: '🛒 **제품스토어** — 카테고리를 먼저 골라 주세요.', components: [new ActionRowBuilder().addComponents(menu)], ...EPH });
  }

  if (i.customId === 'charge') {
    const g = q.getGuild(gid);
    const modal = new ModalBuilder().setCustomId('charge_form').setTitle('잔액 충전 신청').addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('depositor').setLabel('입금자명').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('amount').setLabel(`충전 금액 (최소 ${g.min_charge}원)`).setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('숫자만 입력 예: 10000'),
      ),
    );
    return i.showModal(modal);
  }

  if (i.customId === 'myinfo') {
    const u = q.getUser(gid, i.user.id);
    const recent = db.prepare('SELECT * FROM purchases WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 5').all(gid, i.user.id);
    const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle('🖤 내정보')
      .addFields(
        { name: '보유 잔액', value: won(u.balance), inline: true },
        { name: '누적 사용', value: won(u.total_spent), inline: true },
        { name: '최근 구매 5건', value: recent.length ? recent.map((r) => `• ${r.product_name} — ${won(r.price)} (${ts(r.created_at)})`).join('\n') : '구매 내역이 없어요.' },
      );
    return i.reply({ embeds: [embed], ...EPH });
  }

  if (i.customId === 'guide') {
    const g = q.getGuild(gid);
    const text = g.guide || '1. **잔액충전** 으로 충전 신청\n2. 서버 주인이 입금 확인 후 승인\n3. **제품스토어** 에서 상품 선택 → 구매\n4. 상품은 즉시 자동 지급돼요.';
    return i.reply({ embeds: [new EmbedBuilder().setColor(0xff88cc).setTitle('💗 이용가이드').setDescription(text)], ...EPH });
  }

  // 구매 확정 버튼
  if (i.customId.startsWith('buy:')) {
    const res = buy(gid, i.user.id, Number(i.customId.split(':')[1]));
    if (res.err) return i.update({ content: `❌ ${res.err}`, components: [] });    await i.update({ content: `✅ **${res.product.name}** 구매 완료! 남은 잔액 ${won(res.balance)}\n\n지급 내용:\n\`\`\`\n${res.content}\n\`\`\``, components: [] });
    i.user.send(`🛒 [${i.guild.name}] **${res.product.name}** 구매 내역\n\`\`\`\n${res.content}\n\`\`\``).catch(() => {});
    await afterPurchase(i, res);
    return;
  }
  if (i.customId === 'buy_cancel') return i.update({ content: '구매를 취소했어요.', components: [] });
}

/* ───────────── 구매 후 처리 (역할 지급 / 구매 로그 / 후기 안내 DM) ───────────── */
async function afterPurchase(i, res) {
  const g = q.getGuild(i.guildId);

  // 1) 구매자 역할 지급
  let roleNote = '';
  if (g.buyer_role) {
    try {
      await i.member.roles.add(g.buyer_role, '자판기 구매 역할 지급');
      roleNote = `<@&${g.buyer_role}> 지급 완료 ✅`;
    } catch (e) {
      console.warn('역할 지급 실패:', e.message);
      roleNote = '❌ 역할 지급 실패 (봇 권한/역할 순서 확인)';
    }
  }

  // 2) 구매 로그 채널에 기록
  const line = '═'.repeat(28);
  const log = new EmbedBuilder().setColor(0x57f287)
    .setTitle('💎🩷🤍🖤📦 새로운 구매 발생')
    .setDescription([
      line,
      '═'.repeat(14),
      `• **구매자:** ${i.user} (\`${i.user.id}\`)`,
      `• **상품명:** ${res.product.name}`,
      `• **결제금액:** \`${won(res.product.price)}\``,
      ...(roleNote ? [`• **구매자 역할:** ${roleNote}`] : []),
    ].join('\n'))
    .setFooter({ text: g.footer_text || `✦ ${BOT_NAME} ✦` }).setTimestamp();
  admin.log(i.guild, log);

  // 3) 구매자 DM으로 후기 작성 안내
  if (g.review_channel) {
    const url = `https://discord.com/channels/${i.guildId}/${g.review_channel}`;
    const dm = new EmbedBuilder().setColor(0xff88cc).setTitle('💌 구매해 주셔서 감사해요!')
      .setDescription(`**${i.guild.name}** 에서 **${res.product.name}** 을(를) 구매하셨어요.\n구매 후기를 <#${g.review_channel}> 채널에 남겨 주시면 큰 힘이 돼요 🙏`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('후기 남기러 가기').setStyle(ButtonStyle.Link).setURL(url),
    );
    await i.user.send({ embeds: [dm], components: [row] }).catch(() => {});
  }
}

/* ───────────── 출퇴근 ───────────── */
const KST = 'Asia/Seoul';
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('en-GB', {
  timeZone: KST, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${d.toLocaleDateString('en-CA', { timeZone: KST })} (${d.toLocaleDateString('ko-KR', { timeZone: KST, weekday: 'short' })})`;
};
const fmtDur = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분 ${s % 60}초`;
};
const rel = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;
const SPARKLE = '⋆｡°✩ ─────────────── ✩°｡⋆';
const footerOf = (gid) => q.getGuild(gid).footer_text || BOT_NAME;

function clockPanelPayload(gid) {
  const embed = new EmbedBuilder().setColor(0xffa07a).setTitle('🕘 출퇴근 기록')
    .setDescription('아래 버튼으로 출근/퇴근을 기록해 주세요.\n근무 시간은 퇴근 시 자동으로 계산돼요. 💫')
    .setFooter({ text: `${footerOf(gid)} · 출퇴근 기록 💫` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('clock_in').setLabel('출근').setEmoji('🟢').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('clock_out').setLabel('퇴근').setEmoji('🔴').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

async function clockIn(i) {
  const gid = i.guildId;
  const open = db.prepare('SELECT * FROM attendance WHERE guild_id = ? AND user_id = ? AND clock_out IS NULL').get(gid, i.user.id);
  if (open) return i.reply({ content: `⚠️ 이미 출근 중이에요! (출근 ${rel(open.clock_in)})\n먼저 퇴근 버튼을 눌러 주세요.`, ...EPH });

  const now = Date.now();
  db.prepare('INSERT INTO attendance (guild_id, user_id, clock_in) VALUES (?,?,?)').run(gid, i.user.id, now);

  const embed = new EmbedBuilder().setColor(0x57f287).setThumbnail(i.user.displayAvatarURL())
    .setTitle('☀️💖 출 근 완 료 💖☀️')
    .setDescription(`${SPARKLE}\n🌷 ${i.user} 님이 출근했어요! 🌷\n☕ 오늘 하루도 힘내세요! 화이팅 💪\n${SPARKLE}`)
    .addFields(
      { name: '📅 날짜', value: `\`${fmtDate(now)}\`` },
      { name: '🟢 출근', value: `\`${fmtTime(now)}\``, inline: true },
      { name: '🎉 상태', value: `🟢 **근무 중** · ${rel(now)} 출근 💼` },
    )
    .setFooter({ text: `${footerOf(i.guildId)} · 출퇴근 기록 💫` }).setTimestamp();
  return i.reply({ embeds: [embed] });
}

async function clockOut(i) {
  const gid = i.guildId;
  const open = db.prepare('SELECT * FROM attendance WHERE guild_id = ? AND user_id = ? AND clock_out IS NULL ORDER BY id DESC').get(gid, i.user.id);
  if (!open) return i.reply({ content: '⚠️ 출근 기록이 없어요. 먼저 출근 버튼을 눌러 주세요.', ...EPH });

  const now = Date.now();
  db.prepare('UPDATE attendance SET clock_out = ? WHERE id = ?').run(now, open.id);

  const embed = new EmbedBuilder().setColor(0xffa07a).setThumbnail(i.user.displayAvatarURL())
    .setTitle('🌙💖 퇴 근 완 료 💖🌙')
    .setDescription(`${SPARKLE}\n🌷 ${i.user} 님이 퇴근했어요! 🌷\n🛁 오늘 하루도 정말 수고 많으셨어요! 푹 쉬세요 😴\n${SPARKLE}`)
    .addFields(
      { name: '📅 날짜', value: `\`${fmtDate(open.clock_in)}\`` },
      { name: '🟢 출근', value: `\`${fmtTime(open.clock_in)}\``, inline: true },
      { name: '🔴 퇴근', value: `\`${fmtTime(now)}\``, inline: true },
      { name: '🕒 총 근무시간', value: `\`${fmtDur(now - open.clock_in)}\`` },
      { name: '🎉 상태', value: `🔴 **퇴근 완료** · ${rel(now)} 퇴근 🏡` },
    )
    .setFooter({ text: `${footerOf(i.guildId)} · 출퇴근 기록 💫` }).setTimestamp();
  return i.reply({ embeds: [embed] });
}

async function myAttendance(i) {
  const gid = i.guildId;
  const rows = db.prepare('SELECT * FROM attendance WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 7').all(gid, i.user.id);
  const sum = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(clock_out - clock_in), 0) AS t FROM attendance WHERE guild_id = ? AND user_id = ? AND clock_out IS NOT NULL').get(gid, i.user.id);
  if (!rows.length) return i.reply({ content: '아직 출퇴근 기록이 없어요.', ...EPH });
  const lines = rows.map((r) => `\`${fmtDate(r.clock_in)}\` ${fmtTime(r.clock_in)} ~ ${r.clock_out ? `${fmtTime(r.clock_out)} (${fmtDur(r.clock_out - r.clock_in)})` : '**근무 중** 🟢'}`);
  const embed = new EmbedBuilder().setColor(0xffa07a).setTitle('📋 내 출퇴근 기록')
    .setDescription(lines.join('\n'))
    .addFields({ name: '누적', value: `${sum.n}회 · ${fmtDur(sum.t)}` });
  return i.reply({ embeds: [embed], ...EPH });
}

/* ───────────── 셀렉트 메뉴 ───────────── */
async function handleSelect(i) {
  // 1단계: 카테고리 선택 → 해당 카테고리 상품 목록
  if (i.customId === 'cat') {
    const category = i.values[0];
    const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM stock s WHERE s.product_id = p.id AND s.sold = 0) AS cnt
                             FROM products p WHERE guild_id = ? AND category = ? ORDER BY id LIMIT 25`).all(i.guildId, category);
    if (!rows.length) return i.update({ content: '😢 이 카테고리에 상품이 없어요.', components: [] });
    const menu = new StringSelectMenuBuilder().setCustomId('pick').setPlaceholder('구매할 상품을 선택하세요').addOptions(
      rows.map((r) => ({
        label: r.name.slice(0, 100),
        description: `${won(r.price)} · ${r.cnt > 0 ? `재고 ${r.cnt}개` : '품절'}`,
        value: String(r.id),
      })),
    );
    return i.update({ content: `🛒 **${category}** — 상품을 선택해 주세요.`, components: [new ActionRowBuilder().addComponents(menu)] });
  }

  // 2단계: 상품 선택 → 구매 확인
  if (i.customId !== 'pick') return;
  const p = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM stock s WHERE s.product_id = p.id AND s.sold = 0) AS cnt
                        FROM products p WHERE id = ? AND guild_id = ?`).get(Number(i.values[0]), i.guildId);
  if (!p) return i.update({ content: '❌ 없는 상품이에요.', components: [] });
  const u = q.getUser(i.guildId, i.user.id);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`buy:${p.id}`).setLabel('구매하기').setStyle(ButtonStyle.Success).setDisabled(p.cnt === 0),
    new ButtonBuilder().setCustomId('buy_cancel').setLabel('취소').setStyle(ButtonStyle.Secondary),
  );
  return i.update({
    content: `**${p.name}** [${p.category}]\n가격: ${won(p.price)} · 재고: ${p.cnt > 0 ? `${p.cnt}개` : '품절'}\n내 잔액: ${won(u.balance)}`,
    components: [row],
  });
}

/* ───────────── 모달 ───────────── */
async function handleModal(i) {
  const gid = i.guildId;

  if (i.customId === 'settings') {
    if (!isOwner(i)) return i.reply({ content: '🚫 서버 주인 전용이에요.', ...EPH });
    const min = Math.max(0, parseInt(i.fields.getTextInputValue('min').replace(/\D/g, ''), 10) || 1000);
    q.getGuild(gid);
    db.prepare('UPDATE guilds SET bank_info = ?, guide = ?, min_charge = ? WHERE guild_id = ?')
      .run(i.fields.getTextInputValue('bank'), i.fields.getTextInputValue('guide'), min, gid);
    return i.reply({ content: '✅ 설정을 저장했어요.', ...EPH });
  }

  if (i.customId.startsWith('stock:')) {
    if (!isOwner(i)) return i.reply({ content: '🚫 서버 주인 전용이에요.', ...EPH });
    const pid = Number(i.customId.split(':')[1]);
    const lines = i.fields.getTextInputValue('lines').split('\n').map((s) => s.trim()).filter(Boolean);
    const ins = db.prepare('INSERT INTO stock (product_id, content) VALUES (?, ?)');
    db.transaction(() => lines.forEach((l) => ins.run(pid, l)))();
    return i.reply({ content: `✅ 재고 **${lines.length}개** 추가했어요.`, ...EPH });
  }

  if (i.customId === 'charge_form') {
    const g = q.getGuild(gid);
    const amount = parseInt(i.fields.getTextInputValue('amount').replace(/\D/g, ''), 10);
    const depositor = i.fields.getTextInputValue('depositor').trim();
    if (!amount || amount < g.min_charge) return i.reply({ content: `❌ 최소 충전 금액은 ${won(g.min_charge)} 이에요.`, ...EPH });

    const pending = db.prepare("SELECT COUNT(*) AS c FROM charges WHERE guild_id = ? AND user_id = ? AND status = 'pending'").get(gid, i.user.id).c;
    if (pending >= 3) return i.reply({ content: '❌ 처리 대기 중인 충전 신청이 너무 많아요. 승인 후 다시 신청해 주세요.', ...EPH });

    const info = db.prepare('INSERT INTO charges (guild_id, user_id, amount, depositor, created_at) VALUES (?,?,?,?,?)')
      .run(gid, i.user.id, amount, depositor, Date.now());
    const chargeId = Number(info.lastInsertRowid);

    // 충전 신청은 "서버 주인" 에게만 DM 전송
    const embed = new EmbedBuilder().setColor(0xffcc4d).setTitle('💰 충전 신청이 도착했어요')
      .addFields(
        { name: '서버', value: i.guild.name, inline: true },
        { name: '신청자', value: `${i.user} (${i.user.tag})`, inline: true },
        { name: '입금자명', value: depositor, inline: true },
        { name: '금액', value: won(amount), inline: true },
        { name: '신청번호', value: `#${chargeId}`, inline: true },
      ).setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`chg_ok:${chargeId}`).setLabel('승인').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`chg_no:${chargeId}`).setLabel('거절').setStyle(ButtonStyle.Danger),
    );
    try {
      const owner = await i.guild.fetchOwner();
      await owner.send({ embeds: [embed], components: [row] });
    } catch {
      db.prepare('DELETE FROM charges WHERE id = ?').run(chargeId);
      return i.reply({ content: '❌ 서버 주인에게 알림을 보내지 못했어요. (주인의 DM 수신이 꺼져 있을 수 있어요)', ...EPH });
    }

    return i.reply({
      content: `✅ 충전 신청 완료! (#${chargeId})\n\n**입금 계좌**\n${g.bank_info || '서버 주인에게 문의해 주세요.'}\n\n입금자명 **${depositor}** / 금액 **${won(amount)}** 로 입금해 주세요.\n서버 주인이 확인하면 잔액이 자동 반영돼요.`,
      ...EPH,
    });
  }
}

/* ───────────── 충전 승인/거절 (서버 주인 DM) ───────────── */
async function handleChargeDecision(i) {
  const [action, idStr] = i.customId.split(':');
  const chargeId = Number(idStr);
  const c = db.prepare('SELECT * FROM charges WHERE id = ?').get(chargeId);
  if (!c) return i.reply({ content: '❌ 신청 내역을 찾을 수 없어요.', ...EPH });

  const guild = await client.guilds.fetch(c.guild_id).catch(() => null);
  if (!guild || guild.ownerId !== i.user.id) return i.reply({ content: '🚫 서버 주인만 처리할 수 있어요.', ...EPH });
  if (c.status !== 'pending') return i.reply({ content: '이미 처리된 신청이에요.', ...EPH });

  const approve = action === 'chg_ok';
  const done = approve ? approveCharge(chargeId) : rejectCharge(chargeId);
  if (!done) return i.reply({ content: '이미 처리된 신청이에요.', ...EPH });

  const base = EmbedBuilder.from(i.message.embeds[0]).setColor(approve ? 0x57f287 : 0xed4245)
    .addFields({ name: '처리 결과', value: approve ? '✅ 승인됨' : '❌ 거절됨' });
  await i.update({ embeds: [base], components: [] });
  admin.log(guild, base, 'charge_log_channel');

  const bal = q.getUser(c.guild_id, c.user_id).balance;
  client.users.send(c.user_id, approve
    ? `✅ [${guild.name}] 충전 **${won(c.amount)}** 이 승인됐어요! 현재 잔액 ${won(bal)}`
    : `❌ [${guild.name}] 충전 신청(#${c.id}, ${won(c.amount)})이 거절됐어요. 문의는 서버 주인에게 해주세요.`).catch(() => {});
}

/* ───────────── 라이센스 ───────────── */
async function handleLicenseCmd(i) {
  switch (i.commandName) {
    case '라이센스생성': {
      if (!isMaster(i.user.id)) return i.reply({ content: '🚫 봇 판매자만 사용할 수 있어요.', ...EPH });
      const days = i.options.getInteger('기간');
      const n = i.options.getInteger('개수') || 1;
      const ins = db.prepare('INSERT INTO licenses (key, days, created_at) VALUES (?,?,?)');
      const keys = [];
      db.transaction(() => { for (let k = 0; k < n; k++) { const key = makeKey(); ins.run(key, days, Date.now()); keys.push(key); } })();
      return i.reply({ content: `🔑 **${days}일** 라이센스 ${n}개 생성\n\`\`\`\n${keys.join('\n')}\n\`\`\``, ...EPH });
    }
    case '라이센스목록': {
      if (!isMaster(i.user.id)) return i.reply({ content: '🚫 봇 판매자만 사용할 수 있어요.', ...EPH });
      const rows = db.prepare('SELECT * FROM licenses WHERE used_guild IS NULL ORDER BY created_at DESC LIMIT 30').all();
      return i.reply({ content: rows.length ? `미사용 라이센스 (최근 30개)\n\`\`\`\n${rows.map((r) => `${r.key}  ${r.days}일`).join('\n')}\n\`\`\`` : '미사용 라이센스가 없어요.', ...EPH });
    }
    case '라이센스등록': {
      if (!isOwner(i)) return i.reply({ content: '🚫 서버 주인만 등록할 수 있어요.', ...EPH });
      const res = redeemLicense(i.options.getString('키').trim().toUpperCase(), i.guildId);
      if (res.err) return i.reply({ content: `❌ ${res.err}`, ...EPH });
      return i.reply({ content: `✅ **${res.days}일** 라이센스 등록 완료!\n만료일: ${ts(res.expires)}`, ...EPH });
    }
    case '라이센스확인': {
      if (FREE_GUILDS.includes(i.guildId)) return i.reply({ content: '♾️ 이 서버는 무제한 이용 서버예요.', ...EPH });
      const g = q.getGuild(i.guildId);
      return i.reply({ content: g.expires_at > Date.now() ? `✅ 이용 가능 — 만료일 ${ts(g.expires_at)}` : '⛔ 라이센스가 없거나 만료되었어요.', ...EPH });
    }
  }
}

client.login(TOKEN);
