require("dotenv").config();
const fs = require("fs");
const path = require("path");
const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder, MessageFlags
} = require("discord.js");
const { db } = require("./db");

module.exports = function attachSlotBot(client, { isPremium }) {
const CONFIG_PATH = path.join(__dirname, "config.json");
if (!fs.existsSync(CONFIG_PATH)) {
  throw new Error("슬롯 기능 활성화 시 config.example.json을 config.json으로 복사하여 설정해야 합니다.");
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const token = process.env.TOKEN || process.env.DISCORD_TOKEN;
if (!token) throw new Error("슬롯 기능에는 TOKEN이 필요합니다.");
// 자판기와 슬롯은 동일한 SQLite DB_PATH 파일을 공유합니다.
// 시간은 모두 UTC ISO-8601 문자열로 보관합니다.
const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const iso = (value) => value instanceof Date ? value.toISOString() : value;
function query(statement, params = []) {
  // PostgreSQL의 $1...$n 플레이스홀더를 SQLite ?로 바꾸며 같은 번호의 반복도 지원합니다.
  const reordered = [];
  const sql = statement.replace(/\$(\d+)/g, (_, n) => {
    reordered.push(iso(params[Number(n)-1]));
    return '?';
  });
  const st = db.prepare(sql);
  const rows = st.reader ? st.all(...reordered) : (st.run(...reordered), []);
  return { rows, rowCount: rows.length };
}
const moneyToSats = (ltc) => {
  const n = Number(ltc);
  if (!Number.isFinite(n) || n <= 0) throw new Error("가격은 0보다 큰 LTC 금액이어야 합니다.");
  return BigInt(Math.round(n * 1e8));
};
const satsToLtc = (sats) => (Number(sats) / 1e8).toFixed(8);

// USD 고정 판매가를 주문 생성 시 LTC로 환산합니다. 시세 조회에 실패하면 주문을 생성하지 않습니다.
let cachedLtcUsd = null;
let lastRateAt = 0;
async function fetchLtcUsd() {
  if (cachedLtcUsd && Date.now() - lastRateAt < 60000) return cachedLtcUsd;
  const providers = [
    async () => {
      const r = await fetch('https://api.coinbase.com/v2/prices/LTC-USD/spot', { signal: AbortSignal.timeout(7000) });
      if (!r.ok) throw new Error(`Coinbase ${r.status}`);
      const j = await r.json();
      return Number(j?.data?.amount);
    },
    async () => {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd', { signal: AbortSignal.timeout(7000) });
      if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
      const j = await r.json();
      return Number(j?.litecoin?.usd);
    }
  ];
  for (const provider of providers) {
    try {
      const rate = await provider();
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('유효하지 않은 시세');
      cachedLtcUsd = rate;
      lastRateAt = Date.now();
      return rate;
    } catch (error) { console.warn('LTC/USD 시세 조회 실패:', error.message); }
  }
  throw new Error('현재 LTC 시세를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.');
}
async function categoryQuote(category) {
  const usd = Number(category.priceUsd);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error('슬롯 USD 가격 설정이 올바르지 않습니다.');
  const rate = await fetchLtcUsd();
  // 실제 청구 LTC를 소수점 8자리(1 satoshi)까지 반올림합니다.
  const sats = BigInt(Math.max(1, Math.round(usd / rate * 1e8)));
  return { usd, rate, sats };
}

const safeName = (s) => s.toLowerCase().replace(/[^a-z0-9가-힣_-]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "slot";
const isAdmin = (member) => {
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  return (config.adminRoleIds || []).some(id => member.roles?.cache?.has(id));
};
const getCategory = (key) => config.categories.find(c => c.key === key);

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS slot_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      category_key TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      expected_sats TEXT NOT NULL,
      duration_days INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      txid TEXT UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      paid_at TEXT,
      channel_id TEXT,
      slot_expires_at TEXT,
      target_channel_id TEXT
    );
    CREATE TABLE IF NOT EXISTS slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      category_key TEXT NOT NULL,
      channel_id TEXT NOT NULL UNIQUE,
      channel_name TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS ping_usage (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, usage_date)
    );
    CREATE TABLE IF NOT EXISTS used_outputs (
      txid TEXT NOT NULL,
      vout INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      PRIMARY KEY (txid, vout)
    );
    CREATE INDEX IF NOT EXISTS idx_slot_orders_pending ON slot_orders(guild_id,user_id,status,expires_at);
    CREATE INDEX IF NOT EXISTS idx_slots_expiry ON slots(expires_at);
  `);
  const cols = db.prepare('PRAGMA table_info(slot_orders)').all().map(x => x.name);
  if (!cols.includes('target_channel_id')) db.exec('ALTER TABLE slot_orders ADD COLUMN target_channel_id TEXT');
}
async function verifyLitecoinTx(txid, expectedSats) {
  if (!/^[a-fA-F0-9]{64}$/.test(txid)) throw new Error("TXID 형식이 올바르지 않습니다.");
  const api = (config.blockExplorerApi || "https://litecoinspace.org/api").replace(/\/$/, "");
  const response = await fetch(`${api}/tx/${txid.toLowerCase()}`, { headers: { "accept": "application/json" } });
  if (!response.ok) {
    if (response.status === 404) throw new Error("해당 TXID를 블록체인에서 찾을 수 없습니다.");
    throw new Error(`블록체인 조회 실패 (HTTP ${response.status}). 잠시 후 다시 시도하세요.`);
  }
  const tx = await response.json();
  const status = tx.status || {};
  const confirmed = Boolean(status.confirmed);
  let confirmations = 0;
  if (confirmed && Number.isInteger(status.block_height)) {
    const tipRes = await fetch(`${api}/blocks/tip/height`);
    if (tipRes.ok) {
      const tip = Number(await tipRes.text());
      confirmations = Math.max(0, tip - status.block_height + 1);
    }
  }
  const minimum = Number(config.minConfirmations || 1);
  if (!confirmed || confirmations < minimum) {
    throw new Error(`아직 입금 컨펌이 부족합니다. 현재 ${confirmations}/${minimum} 컨펌입니다.`);
  }

  const outputs = tx.vout || [];
  const matching = [];
  for (let i = 0; i < outputs.length; i++) {
    const out = outputs[i];
    const address = out.scriptpubkey_address;
    const value = BigInt(out.value || 0);
    if (address === config.ltcAddress && value >= BigInt(expectedSats)) {
      matching.push({ vout: i, value });
    }
  }
  if (!matching.length) throw new Error("내 LTC 수신 주소로 결제 금액 이상이 입금된 출력이 없습니다.");
  return matching[0];
}

async function createSlotChannel(guild, order) {
  const category = getCategory(order.category_key);
  if (!category) throw new Error("설정된 카테고리를 찾을 수 없습니다.");
  const base = await guild.channels.fetch(category.baseCategoryId).catch(() => null);
  if (!base || base.type !== ChannelType.GuildCategory) {
    throw new Error(`카테고리 ${category.label}의 baseCategoryId가 올바르지 않습니다.`);
  }

  // 같은 기준 카테고리에서 자동 생성된 후속 카테고리를 찾고, 50개가 차면 새 카테고리를 생성합니다.
  const siblings = guild.channels.cache
    .filter(ch => ch.type === ChannelType.GuildCategory &&
      (ch.id === base.id || ch.name === base.name || ch.name.startsWith(`${base.name} `)))
    .sort((a, b) => a.position - b.position);
  let targetCategory = null;
  const limit = Math.min(Number(category.maxChannels || 50), 50);
  for (const cat of siblings.values()) {
    const children = guild.channels.cache.filter(ch => ch.parentId === cat.id);
    if (children.size < limit) { targetCategory = cat; break; }
  }
  if (!targetCategory) {
    const nextNo = siblings.size + 1;
    targetCategory = await guild.channels.create({
      name: `${base.name} ${nextNo}`,
      type: ChannelType.GuildCategory,
      reason: "슬롯 카테고리 자동 확장"
    });
  }

  const member = await guild.members.fetch(order.user_id);
  const channelName = `${category.prefix || ""}${safeName(order.channel_name)}`.slice(0, 100);
  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: targetCategory.id,
    topic: `슬롯 소유자: ${order.user_id} | 주문번호: ${order.id}`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MentionEveryone] }
    ],
    reason: `LTC 결제 완료 슬롯 주문 #${order.id}`
  });
  const expiresAt = new Date(Date.now() + Number(order.duration_days) * 86400000);
  query(
    `INSERT INTO slots (guild_id,user_id,category_key,channel_id,channel_name,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [guild.id, order.user_id, order.category_key, channel.id, channel.name, expiresAt]
  );
  query(
    `UPDATE slot_orders SET status='paid', paid_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), channel_id=$1, slot_expires_at=$2 WHERE id=$3`,
    [channel.id, expiresAt, order.id]
  );
  await channel.send({
    content: `<@${order.user_id}> 슬롯 채널이 생성되었습니다!\n만료 예정: <t:${Math.floor(expiresAt.getTime()/1000)}:F>\nHERE 핑은 \`/슬롯핑\`으로 하루 3회 사용할 수 있습니다.`,
    allowedMentions: { users: [order.user_id] }
  });
  return channel;
}

const commands = [
  new SlashCommandBuilder().setName("슬롯상점").setDescription("구매 가능한 기간제 슬롯을 확인합니다."),
  new SlashCommandBuilder().setName("슬롯구매").setDescription("슬롯 구매를 시작합니다.")
    .addStringOption(o => o.setName("카테고리").setDescription("구매할 슬롯 카테고리").setRequired(true)
      .addChoices(...config.categories.map(c => ({ name: c.label, value: c.key })).slice(0, 25))),
  new SlashCommandBuilder().setName("txid").setDescription("결제한 라이트코인 TXID를 제출합니다.")
    .addStringOption(o => o.setName("txid").setDescription("64자리 트랜잭션 ID").setRequired(true)),
  new SlashCommandBuilder().setName("슬롯핑").setDescription("내 슬롯 채널에서 @here 핑을 사용합니다."),
  new SlashCommandBuilder().setName("슬롯정보").setDescription("내 슬롯 남은 기간과 핑 사용량을 확인합니다."),
  new SlashCommandBuilder().setName("슬롯연장").setDescription("내 슬롯 연장 결제를 시작합니다.")
    .addStringOption(o => o.setName("카테고리").setDescription("연장할 슬롯 카테고리").setRequired(true)
      .addChoices(...config.categories.map(c => ({ name: c.label, value: c.key })).slice(0, 25))),
  new SlashCommandBuilder().setName("슬롯카테고리설정").setDescription("관리자: 카테고리 상품 설정을 추가/수정합니다.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("키").setDescription("영문 고유 키 (예: vip)").setRequired(true))
    .addStringOption(o => o.setName("이름").setDescription("상점에 표시할 이름").setRequired(true))
    .addStringOption(o => o.setName("접두사").setDescription("채널명 앞부분 (예: 💎・)").setRequired(true))
    .addNumberOption(o => o.setName("가격usd").setDescription("USD 가격 (예: 2 또는 4)").setMinValue(0.01).setRequired(true))
    .addIntegerOption(o => o.setName("기간일").setDescription("이용 기간(일)").setRequired(true).setMinValue(1))
    .addStringOption(o => o.setName("기준카테고리id").setDescription("Discord 카테고리 ID").setRequired(true)),
  new SlashCommandBuilder().setName("슬롯삭제").setDescription("관리자: 슬롯 채널을 삭제하고 권한을 회수합니다.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("채널id").setDescription("삭제할 슬롯 채널 ID").setRequired(true))
];

async function startOrder(interaction, categoryKey, channelName, targetChannelId = null) {
  const category = getCategory(categoryKey);
  if (!category) return interaction.reply({ content: "해당 상품을 찾을 수 없습니다.", flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { usd, rate, sats } = await categoryQuote(category);
  const expiry = new Date(Date.now() + Number(config.paymentExpiryMinutes || 30) * 60000);
  const result = query(
    `INSERT INTO slot_orders (guild_id,user_id,category_key,channel_name,expected_sats,duration_days,expires_at,target_channel_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [interaction.guildId, interaction.user.id, categoryKey, channelName, sats.toString(), category.durationDays, expiry, targetChannelId]
  );
  const id = result.rows[0].id;
  const embed = new EmbedBuilder().setTitle("라이트코인 결제 안내")
    .setDescription(`**상품:** ${category.label}\n**채널명:** ${category.prefix || ""}${safeName(channelName)}\n**기간:** ${category.durationDays}일\n**판매 가격:** **$${usd.toFixed(2)} USD**\n**결제 금액:** \`${satsToLtc(sats)} LTC\`\n**수신 주소:**\n\`${config.ltcAddress}\`\n\n결제 후 \`/txid\` 명령어로 TXID를 제출하세요.\n주문 유효시간: <t:${Math.floor(expiry.getTime()/1000)}:R>`)
    .setFooter({ text: `주문번호 #${id} | 결제는 지정 주소로 정확한 금액 이상 보내세요.${targetChannelId ? " 기존 슬롯 연장 주문입니다." : ""}` });
  await interaction.editReply({ embeds: [embed] });
}

async function ready() {
  initDb();
  const guild = await client.guilds.fetch(config.guildId);
  await guild.commands.set(commands.map(c => c.toJSON()));
  console.log("✅ 슬롯 명령어 등록 완료");
  setInterval(() => expireSlots().catch(console.error), 60 * 1000);
  setInterval(() => expireOrders().catch(console.error), 60 * 1000);
  await expireOrders();
  await expireSlots();
}
async function expireOrders() {
  query("UPDATE slot_orders SET status='expired' WHERE status='pending' AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
}
async function expireSlots() {
  const { rows } = query("SELECT * FROM slots WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  for (const slot of rows) {
    try {
      const guild = await client.guilds.fetch(slot.guild_id);
      const channel = await guild.channels.fetch(slot.channel_id).catch(() => null);
      if (channel) await channel.delete("슬롯 이용 기간 만료");
      query("DELETE FROM slots WHERE id=$1", [slot.id]);
    } catch (e) {
      console.error("만료 채널 삭제 실패 (다음 검사 때 재시도):", e.message);
    }
  }
}

client.on("interactionCreate", async interaction => {
  if (interaction.guildId !== config.guildId) return;
  if (interaction.isChatInputCommand() && !commands.some(c => c.name === interaction.commandName)) return;
  if (interaction.isModalSubmit() && !interaction.customId.startsWith("slotname:")) return;
  if (!interaction.isChatInputCommand() && !interaction.isModalSubmit()) return;
  try {
    if (!isPremium(interaction.guildId)) {
      return interaction.reply({ content: '👑 슬롯 기능은 프리미엄 라이센스 전용입니다. 서버 주인이 프리미엄 라이센스를 구매한 뒤 `/라이센스등록`으로 등록해야 이용할 수 있습니다.', flags: MessageFlags.Ephemeral });
    }
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "슬롯상점") {
        const embed = new EmbedBuilder().setTitle("🛒 슬롯 상점").setDescription(
          config.categories.map(c => `**${c.emoji || "🛒"} ${c.label}**\n가격: **$${Number(c.priceUsd).toFixed(2)} USD** · 기간: ${c.durationDays}일\n(LTC 환산액은 주문 시 확인)`).join("\n\n")
        );
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
      if (interaction.commandName === "슬롯구매" || interaction.commandName === "슬롯연장") {
        const key = interaction.options.getString("카테고리");
        const category = getCategory(key);
        if (!category) return interaction.reply({ content: "상품을 찾을 수 없습니다.", flags: MessageFlags.Ephemeral });
        if (interaction.commandName === "슬롯연장") {
          const { rows } = query(
            "SELECT * FROM slots WHERE guild_id=$1 AND user_id=$2 AND category_key=$3 AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ORDER BY expires_at DESC LIMIT 1",
            [interaction.guildId, interaction.user.id, key]
          );
          if (!rows.length) return interaction.reply({ content: "해당 카테고리에 연장할 활성 슬롯이 없습니다.", flags: MessageFlags.Ephemeral });
          return startOrder(interaction, key, rows[0].channel_name, rows[0].channel_id);
        }
        const modal = new ModalBuilder().setCustomId(`slotname:${key}`).setTitle("슬롯 채널 이름");
        const input = new TextInputBuilder().setCustomId("channel_name").setLabel("원하는 채널명").setStyle(TextInputStyle.Short).setMinLength(2).setMaxLength(40).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }
      if (interaction.commandName === "txid") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const txid = interaction.options.getString("txid").trim().toLowerCase();
        const { rows } = query(
          `SELECT * FROM slot_orders WHERE guild_id=$1 AND user_id=$2 AND status='pending' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ORDER BY created_at DESC LIMIT 1`,
          [interaction.guildId, interaction.user.id]
        );
        if (!rows.length) return interaction.editReply("유효한 대기 주문이 없습니다. 먼저 /슬롯구매로 주문하세요.");
        const order = rows[0];
        const payment = await verifyLitecoinTx(txid, order.expected_sats);
        // SQLite 즉시 트랜잭션: 동일 출력을 두 주문에 사용하는 것을 원자적으로 차단합니다.
        db.transaction(() => {
          const used = db.prepare('SELECT order_id FROM used_outputs WHERE txid=? AND vout=?').get(txid, payment.vout);
          if (used && used.order_id !== order.id) throw new Error('이미 다른 주문에 사용된 TXID 출력입니다.');
          if (!used) db.prepare('INSERT INTO used_outputs (txid,vout,order_id) VALUES (?,?,?)').run(txid, payment.vout, order.id);
          db.prepare('UPDATE slot_orders SET txid=? WHERE id=?').run(txid, order.id);
        }).immediate();
        if (order.target_channel_id) {
          const { rows: existing } = query(
            "SELECT * FROM slots WHERE channel_id=$1 AND guild_id=$2 AND user_id=$3",
            [order.target_channel_id, interaction.guildId, interaction.user.id]
          );
          if (!existing.length) throw new Error("연장할 기존 슬롯을 찾을 수 없습니다. 관리자에게 문의하세요.");
          const oldExpiry = new Date(existing[0].expires_at);
          const newExpiry = new Date(Math.max(Date.now(), oldExpiry.getTime()) + Number(order.duration_days) * 86400000);
          query("UPDATE slots SET expires_at=$1 WHERE channel_id=$2", [newExpiry, order.target_channel_id]);
          query("UPDATE slot_orders SET status='paid',paid_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),channel_id=$1,slot_expires_at=$2 WHERE id=$3", [order.target_channel_id, newExpiry, order.id]);
          const ch = await interaction.guild.channels.fetch(order.target_channel_id);
          await ch.send(`<@${interaction.user.id}> 슬롯 기간이 연장되었습니다. 새 만료일: <t:${Math.floor(newExpiry.getTime()/1000)}:F>`);
          return interaction.editReply(`연장 결제 확인 완료! 기존 채널 ${ch}의 만료일이 연장되었습니다.`);
        }
        const channel = await createSlotChannel(interaction.guild, order);
        return interaction.editReply(`결제 확인 완료! 슬롯 채널 ${channel}을 생성했습니다.`);
      }
      if (interaction.commandName === "슬롯핑") {
        const { rows: slots } = query("SELECT * FROM slots WHERE guild_id=$1 AND user_id=$2 AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [interaction.guildId, interaction.user.id]);
        const current = slots.find(s => s.channel_id === interaction.channelId);
        if (!current) return interaction.reply({ content: "본인 슬롯 채널에서만 사용할 수 있습니다.", flags: MessageFlags.Ephemeral });
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone || "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
        const { rows } = query(
          `INSERT INTO ping_usage (guild_id,user_id,usage_date,count) VALUES ($1,$2,$3,1)
           ON CONFLICT (guild_id,user_id,usage_date) DO UPDATE SET count=count+1
           WHERE ping_usage.count < $4 RETURNING count`,
          [interaction.guildId, interaction.user.id, today, Number(config.dailyPingLimit || 3)]
        );
        if (!rows.length) return interaction.reply({ content: "오늘 사용할 수 있는 @here 핑을 모두 사용했습니다.", flags: MessageFlags.Ephemeral });
        const count = rows[0].count;
        await interaction.reply({ content: `@here\n핑 사용량: ${count}/${Number(config.dailyPingLimit || 3)}`, allowedMentions: { parse: ["everyone"] } });
        return;
      }
      if (interaction.commandName === "슬롯정보") {
        const { rows } = query("SELECT * FROM slots WHERE guild_id=$1 AND user_id=$2 AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [interaction.guildId, interaction.user.id]);
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone || "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
        const ping = query("SELECT count FROM ping_usage WHERE guild_id=$1 AND user_id=$2 AND usage_date=$3", [interaction.guildId, interaction.user.id, today]);
        if (!rows.length) return interaction.reply({ content: "이용 중인 슬롯이 없습니다.", flags: MessageFlags.Ephemeral });
        return interaction.reply({ content: rows.map(s => `<#${s.channel_id}> · 만료 <t:${Math.floor(new Date(s.expires_at).getTime()/1000)}:R>`).join("\n") + `\n오늘 핑: ${ping.rows[0]?.count || 0}/${Number(config.dailyPingLimit || 3)}`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.commandName === "슬롯카테고리설정") {
        if (!isAdmin(interaction.member)) return interaction.reply({ content: "관리자만 사용할 수 있습니다.", flags: MessageFlags.Ephemeral });
        const key = interaction.options.getString("키");
        const old = getCategory(key);
        const next = {
          key, label: interaction.options.getString("이름"),
          prefix: interaction.options.getString("접두사"),
          priceUsd: interaction.options.getNumber("가격usd"),
          durationDays: interaction.options.getInteger("기간일"),
          baseCategoryId: interaction.options.getString("기준카테고리id"),
          maxChannels: 50, emoji: old?.emoji || "🛒"
        };
        if (!Number.isFinite(next.priceUsd) || next.priceUsd <= 0) throw new Error("USD 가격이 올바르지 않습니다.");
        const index = config.categories.findIndex(c => c.key === key);
        if (index >= 0) config.categories[index] = next; else config.categories.push(next);
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
        return interaction.reply({ content: `카테고리 **${next.label}** 설정을 저장했습니다. 봇 재시작 후 상품 목록과 명령어 선택지에 반영됩니다.`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.commandName === "슬롯삭제") {
        if (!isAdmin(interaction.member)) return interaction.reply({ content: "관리자만 사용할 수 있습니다.", flags: MessageFlags.Ephemeral });
        const id = interaction.options.getString("채널id");
        const { rows } = query("DELETE FROM slots WHERE channel_id=$1 RETURNING *", [id]);
        if (!rows.length) return interaction.reply({ content: "해당 슬롯을 찾을 수 없습니다.", flags: MessageFlags.Ephemeral });
        const ch = await interaction.guild.channels.fetch(id).catch(() => null);
        if (ch) await ch.delete("관리자에 의한 슬롯 회수");
        return interaction.reply({ content: "슬롯 채널을 삭제하고 이용 권한을 회수했습니다.", flags: MessageFlags.Ephemeral });
      }
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("slotname:")) {
      const key = interaction.customId.split(":")[1];
      const channelName = interaction.fields.getTextInputValue("channel_name").trim();
      if (!/^[\p{L}\p{N} _-]{2,40}$/u.test(channelName)) {
        return interaction.reply({ content: "채널명은 한글/영문/숫자/공백/-/_만 사용할 수 있습니다.", flags: MessageFlags.Ephemeral });
      }
      return startOrder(interaction, key, channelName);
    }
  } catch (error) {
    console.error(error);
    const message = `처리 중 오류: ${error.message}`;
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ content: message }).catch(() => {});
    } else if (interaction.replied) {
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

return { ready, guildId: config.guildId, commandNames: commands.map(c => c.name) };
};
