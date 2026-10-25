// 서버 주인용 관리 패널 (/관리) — 버튼/선택메뉴/모달로 설정 전부 처리
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  UserSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType,
  PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { db, q, redeemLicense } = require('./db');

module.exports = function makeAdmin({ won, ts, EPH, isOwner, panelPayload, clockPanelPayload, licenseText }) {
  const row = (...c) => new ActionRowBuilder().addComponents(...c);
  const btn = (id, label, emoji, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);
  const ti = (id, label, style, o = {}) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(o.required !== false);
    if (o.max) t.setMaxLength(o.max);
    if (o.value) t.setValue(String(o.value).slice(0, o.max || 4000));
    if (o.placeholder) t.setPlaceholder(o.placeholder);
    return row(t);
  };
  const modal = (id, title, ...inputs) => new ModalBuilder().setCustomId(id).setTitle(title).addComponents(...inputs);

  const owns = (i) =>
    (i.isButton() || i.isAnySelectMenu() || i.isModalSubmit()) && i.customId.startsWith('adm_');

  /* ───── 메인 화면 ───── */
  function home(gid) {
    const g = q.getGuild(gid);
    const st = db.prepare(`SELECT
        (SELECT COUNT(*) FROM products WHERE guild_id = @g) AS prods,
        (SELECT COUNT(*) FROM stock s JOIN products p ON p.id = s.product_id WHERE p.guild_id = @g AND s.sold = 0) AS stock,
        (SELECT COUNT(*) FROM charges WHERE guild_id = @g AND status = 'pending') AS pend`).get({ g: gid });

    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('⚙️ 자판기 관리 패널')
      .setDescription('버튼을 눌러 설정하세요. 이 창은 나에게만 보여요 🔒')
      .addFields(
        { name: '🔑 라이센스', value: licenseText(gid), inline: true },
        { name: '📦 상품', value: `${st.prods}종 · 재고 ${st.stock}개`, inline: true },
        { name: '💳 대기 중 충전', value: `${st.pend}건`, inline: true },
        { name: '💰 최소 충전', value: won(g.min_charge), inline: true },
        { name: '📢 구매 로그 채널', value: g.log_channel ? `<#${g.log_channel}>` : '미설정', inline: true },
        { name: '💳 충전 로그 채널', value: g.charge_log_channel ? `<#${g.charge_log_channel}>` : '미설정', inline: true },
        { name: '🏦 계좌 안내', value: g.bank_info ? '설정됨 ✅' : '미설정 ❌', inline: true },
        { name: '🏷️ 구매자 역할', value: g.buyer_role ? `<@&${g.buyer_role}>` : '미설정', inline: true },
        { name: '✍️ 후기 채널', value: g.review_channel ? `<#${g.review_channel}>` : '미설정', inline: true },
      );
    return {
      embeds: [embed],
      components: [
        row(
          btn('adm_addprod', '상품 등록', '📦', ButtonStyle.Primary),
          btn('adm_addstock', '재고 추가', '📥', ButtonStyle.Primary),
          btn('adm_delprod', '상품 삭제', '🗑️', ButtonStyle.Danger),
          btn('adm_list', '상품 목록', '📋'),
        ),
        row(
          btn('adm_settings', '계좌·가이드', '💳'),
          btn('adm_brand', '패널 꾸미기', '🎨'),
          btn('adm_logch', '구매 로그 채널', '📢'),
          btn('adm_balance', '잔액 지급', '💰'),
        ),
        row(
          btn('adm_post_vend', '자판기 패널 게시', '🛒', ButtonStyle.Success),
          btn('adm_post_clock', '출퇴근 패널 게시', '🕘', ButtonStyle.Success),
          btn('adm_stats', '통계', '📊'),
          btn('adm_lic', '라이센스 등록', '🔑'),
          btn('adm_home', '새로고침', '🔄'),
        ),
        row(
          btn('adm_role', '구매자 역할', '🏷️'),
          btn('adm_review', '후기 채널(DM 안내)', '✍️'),
          btn('adm_chglog', '충전 로그 채널', '💳'),
        ),
      ],
    };
  }

  function productMenu(gid, customId, placeholder) {
    const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM stock s WHERE s.product_id = p.id AND s.sold = 0) AS cnt
                             FROM products p WHERE guild_id = ? ORDER BY category, id LIMIT 25`).all(gid);
    if (!rows.length) return null;
    return row(
      new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(
        rows.map((r) => ({
          label: `#${r.id} [${r.category}] ${r.name}`.slice(0, 100),
          description: `${won(r.price)} · 재고 ${r.cnt}개`,
          value: String(r.id),
        })),
      ),
    );
  }
  const getProduct = (gid, id) => db.prepare('SELECT * FROM products WHERE id = ? AND guild_id = ?').get(Number(id), gid);

  /* ───── 로그 채널로 알림 ───── */
  // key: 'log_channel'(구매 로그) | 'charge_log_channel'(충전 로그) — 서로 다른 채널로 분리
  async function log(guild, embed, key = 'log_channel') {
    try {
      const g = q.getGuild(guild.id);
      if (!g[key]) return;
      const ch = await guild.channels.fetch(g[key]).catch(() => null);
      if (ch && ch.isTextBased()) await ch.send({ embeds: [embed] });
    } catch { /* 로그 실패는 무시 */ }
  }

  /* ───── 핸들러 ───── */
  async function handle(i) {
    if (!isOwner(i)) return i.reply({ content: '🚫 서버 주인만 사용할 수 있어요.', ...EPH });
    const gid = i.guildId;
    const id = i.customId;

    /* 버튼 */
    if (i.isButton()) {
      switch (id) {
        case 'adm_home':
          return i.update(home(gid));

        case 'adm_addprod':
          return i.showModal(modal('adm_m_addprod', '상품 등록',
            ti('cat', '카테고리', TextInputStyle.Short, { max: 20, placeholder: '예: 계정, 쿠폰' }),
            ti('name', '상품 이름', TextInputStyle.Short, { max: 60 }),
            ti('price', '가격(원)', TextInputStyle.Short, { max: 10, placeholder: '숫자만 입력 예: 5000' }),
          ));

        case 'adm_addstock': {
          const menu = productMenu(gid, 'adm_s_stock', '재고를 넣을 상품 선택');
          if (!menu) return i.reply({ content: '😢 먼저 📦 상품 등록을 해주세요.', ...EPH });
          return i.reply({ content: '📥 재고를 추가할 상품을 골라 주세요.', components: [menu], ...EPH });
        }

        case 'adm_delprod': {
          const menu = productMenu(gid, 'adm_s_del', '삭제할 상품 선택');
          if (!menu) return i.reply({ content: '😢 등록된 상품이 없어요.', ...EPH });
          return i.reply({ content: '🗑️ 삭제할 상품을 골라 주세요.', components: [menu], ...EPH });
        }

        case 'adm_list': {
          const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM stock s WHERE s.product_id = p.id AND s.sold = 0) AS cnt
                                   FROM products p WHERE guild_id = ? ORDER BY category, id`).all(gid);
          const text = rows.length
            ? rows.map((r) => `**#${r.id}** [${r.category}] ${r.name} — ${won(r.price)} (재고 ${r.cnt})`).join('\n')
            : '등록된 상품이 없어요.';
          return i.reply({ content: text.slice(0, 1900), ...EPH });
        }

        case 'adm_settings': {
          const g = q.getGuild(gid);
          return i.showModal(modal('settings', '자판기 설정',
            ti('bank', '입금 계좌 안내 (충전 신청 후 표시)', TextInputStyle.Paragraph, { value: g.bank_info, placeholder: '예: 카카오뱅크 3333-00-0000000 홍길동' }),
            ti('guide', '이용가이드 문구', TextInputStyle.Paragraph, { value: g.guide, required: false }),
            ti('min', '최소 충전 금액(원)', TextInputStyle.Short, { value: String(g.min_charge), max: 10 }),
          ));
        }

        case 'adm_brand': {
          const g = q.getGuild(gid);
          return i.showModal(modal('adm_m_brand', '패널 꾸미기 (비우면 기본값)',
            ti('title', '자판기 패널 제목', TextInputStyle.Short, { value: g.panel_title, required: false, max: 100, placeholder: '💎💜 24시간 무인 자판기 💜💎' }),
            ti('color', '패널 색상 (HEX)', TextInputStyle.Short, { value: g.panel_color, required: false, max: 7, placeholder: '#FF88CC' }),
            ti('footer', '푸터 문구 (패널 하단 이름)', TextInputStyle.Short, { value: g.footer_text, required: false, max: 60, placeholder: '✦ 내 자판기 ✦' }),
          ));
        }

        case 'adm_logch':
          return i.reply({
            content: '📢 **구매 로그**를 받을 채널을 골라 주세요. (충전 로그는 별도 채널이에요)',
            components: [
              row(new ChannelSelectMenuBuilder().setCustomId('adm_s_logch').setPlaceholder('채널 선택')
                .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
              row(btn('adm_logclear', '로그 끄기', '🔕')),
            ],
            ...EPH,
          });

        case 'adm_logclear':
          db.prepare("UPDATE guilds SET log_channel = '' WHERE guild_id = ?").run(gid);
          return i.update({ content: '🔕 로그 채널을 해제했어요.', components: [] });

        case 'adm_role':
          return i.reply({
            content: '🏷️ 구매 시 자동으로 지급할 역할을 골라 주세요.\n(봇에게 **역할 관리** 권한이 있고, 봇 역할이 이 역할보다 위에 있어야 해요)',
            components: [
              row(new RoleSelectMenuBuilder().setCustomId('adm_s_role').setPlaceholder('역할 선택')),
              row(btn('adm_roleclear', '역할 지급 끄기', '🚫')),
            ],
            ...EPH,
          });

        case 'adm_roleclear':
          db.prepare("UPDATE guilds SET buyer_role = '' WHERE guild_id = ?").run(gid);
          return i.update({ content: '🚫 구매자 역할 지급을 껐어요.', components: [] });

        case 'adm_review':
          return i.reply({
            content: '✍️ 구매 후 구매자 DM으로 안내할 **후기 채널**을 골라 주세요.',
            components: [
              row(new ChannelSelectMenuBuilder().setCustomId('adm_s_review').setPlaceholder('채널 선택')
                .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum)),
              row(btn('adm_reviewclear', '후기 DM 끄기', '🔕')),
            ],
            ...EPH,
          });

        case 'adm_reviewclear':
          db.prepare("UPDATE guilds SET review_channel = '' WHERE guild_id = ?").run(gid);
          return i.update({ content: '🔕 후기 안내 DM을 껐어요.', components: [] });

        case 'adm_chglog':
          return i.reply({
            content: '💳 **충전 로그**(충전 승인/거절, 잔액 수동 조정)를 받을 채널을 골라 주세요. 구매 로그와 별도예요.',
            components: [
              row(new ChannelSelectMenuBuilder().setCustomId('adm_s_chglog').setPlaceholder('채널 선택')
                .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
              row(btn('adm_chglogclear', '충전 로그 끄기', '🔕')),
            ],
            ...EPH,
          });

        case 'adm_chglogclear':
          db.prepare("UPDATE guilds SET charge_log_channel = '' WHERE guild_id = ?").run(gid);
          return i.update({ content: '🔕 충전 로그를 껐어요.', components: [] });

        case 'adm_balance':
          return i.reply({
            content: '💰 잔액을 지급/차감할 유저를 골라 주세요.',
            components: [row(new UserSelectMenuBuilder().setCustomId('adm_s_user').setPlaceholder('유저 선택'))],
            ...EPH,
          });

        case 'adm_post_vend':
          await i.channel.send(panelPayload(i.guild));
          return i.reply({ content: '✅ 자판기 패널을 이 채널에 올렸어요.', ...EPH });

        case 'adm_post_clock':
          await i.channel.send(clockPanelPayload(gid));
          return i.reply({ content: '✅ 출퇴근 패널을 이 채널에 올렸어요.', ...EPH });

        case 'adm_stats': {
          const kstStart = Math.floor((Date.now() + 9 * 3600000) / 86400000) * 86400000 - 9 * 3600000;
          const all = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(price), 0) AS sum FROM purchases WHERE guild_id = ?').get(gid);
          const today = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(price), 0) AS sum FROM purchases WHERE guild_id = ? AND created_at >= ?').get(gid, kstStart);
          const users = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(balance), 0) AS bal FROM users WHERE guild_id = ?').get(gid);
          const charged = db.prepare("SELECT COALESCE(SUM(amount), 0) AS sum FROM charges WHERE guild_id = ? AND status = 'approved'").get(gid);
          const working = db.prepare('SELECT COUNT(*) AS n FROM attendance WHERE guild_id = ? AND clock_out IS NULL').get(gid);
          const embed = new EmbedBuilder().setColor(0x57f287).setTitle('📊 통계')
            .addFields(
              { name: '오늘 매출', value: `${won(today.sum)} (${today.n}건)`, inline: true },
              { name: '전체 매출', value: `${won(all.sum)} (${all.n}건)`, inline: true },
              { name: '누적 충전', value: won(charged.sum), inline: true },
              { name: '이용 유저', value: `${users.n}명`, inline: true },
              { name: '유저 보유 잔액 합계', value: won(users.bal), inline: true },
              { name: '현재 출근 중', value: `${working.n}명`, inline: true },
            );
          return i.reply({ embeds: [embed], ...EPH });
        }

        case 'adm_lic':
          return i.showModal(modal('adm_m_lic', '라이센스 등록',
            ti('key', '라이센스 키', TextInputStyle.Short, { max: 60, placeholder: 'XSHOP-XXXX-XXXX-XXXX-XXXX' }),
          ));

        case 'adm_cancel':
          return i.update({ content: '취소했어요.', components: [] });
      }

      if (id.startsWith('adm_delok:')) {
        const p = getProduct(gid, id.split(':')[1]);
        if (!p) return i.update({ content: '❌ 이미 없는 상품이에요.', components: [] });
        db.transaction(() => {
          db.prepare('DELETE FROM stock WHERE product_id = ?').run(p.id);
          db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
        })();
        return i.update({ content: `🗑️ **${p.name}** 삭제 완료`, components: [] });
      }
      return;
    }

    /* 선택 메뉴 */
    if (i.isAnySelectMenu()) {
      if (id === 'adm_s_stock') {
        const p = getProduct(gid, i.values[0]);
        if (!p) return i.update({ content: '❌ 없는 상품이에요.', components: [] });
        return i.showModal(modal(`adm_m_stock:${p.id}`, `재고 추가 - ${p.name}`.slice(0, 45),
          ti('lines', '한 줄에 재고 1개', TextInputStyle.Paragraph),
        ));
      }
      if (id === 'adm_s_del') {
        const p = getProduct(gid, i.values[0]);
        if (!p) return i.update({ content: '❌ 없는 상품이에요.', components: [] });
        return i.update({
          content: `⚠️ **#${p.id} ${p.name}** 상품과 남은 재고를 모두 삭제할까요?`,
          components: [row(btn(`adm_delok:${p.id}`, '삭제', '🗑️', ButtonStyle.Danger), btn('adm_cancel', '취소', '✖️'))],
        });
      }
      if (id === 'adm_s_user') {
        const uid = i.values[0];
        return i.showModal(modal(`adm_m_bal:${uid}`, '잔액 지급 / 차감',
          ti('amount', '금액 (차감은 앞에 - 붙이기)', TextInputStyle.Short, { max: 12, placeholder: '예: 5000 또는 -3000' }),
        ));
      }
      if (id === 'adm_s_role') {
        const role = i.roles.first();
        const me = i.guild.members.me;
        if (role.id === gid || role.managed) {
          return i.update({ content: '❌ 이 역할은 지급할 수 없어요. (@everyone 또는 봇/연동 전용 역할)', components: [] });
        }
        if (!me || !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
          return i.update({ content: '❌ 봇에게 **역할 관리** 권한이 없어요. 서버 설정에서 봇 권한을 켜 주세요.', components: [] });
        }
        if (role.position >= me.roles.highest.position) {
          return i.update({ content: `❌ 봇 역할이 ${role} 보다 위에 있어야 해요. 서버 설정 → 역할에서 봇 역할을 위로 올려 주세요.`, components: [] });
        }
        db.prepare('UPDATE guilds SET buyer_role = ? WHERE guild_id = ?').run(role.id, gid);
        return i.update({ content: `✅ 구매자에게 ${role} 역할을 자동 지급해요.`, components: [] });
      }
      if (id === 'adm_s_review') {
        const ch = i.channels.first();
        db.prepare('UPDATE guilds SET review_channel = ? WHERE guild_id = ?').run(ch.id, gid);
        return i.update({ content: `✅ 후기 채널: <#${ch.id}>\n구매 후 구매자 DM으로 이 채널 안내가 가요.`, components: [] });
      }
      if (id === 'adm_s_chglog') {
        const ch = i.channels.first();
        try {
          await ch.send({ content: '✅ 이 채널이 자판기 **충전 로그** 채널로 설정되었어요.' });
        } catch {
          return i.update({ content: '❌ 그 채널에 메시지를 보낼 권한이 없어요. 봇 권한을 확인해 주세요.', components: [] });
        }
        db.prepare('UPDATE guilds SET charge_log_channel = ? WHERE guild_id = ?').run(ch.id, gid);
        return i.update({ content: `✅ 충전 로그 채널: <#${ch.id}>`, components: [] });
      }
      if (id === 'adm_s_logch') {
        const ch = i.channels.first();
        try {
          await ch.send({ content: '✅ 이 채널이 자판기 **구매 로그** 채널로 설정되었어요.' });
        } catch {
          return i.update({ content: '❌ 그 채널에 메시지를 보낼 권한이 없어요. 봇 권한을 확인해 주세요.', components: [] });
        }
        db.prepare('UPDATE guilds SET log_channel = ? WHERE guild_id = ?').run(ch.id, gid);
        return i.update({ content: `✅ 구매 로그 채널: <#${ch.id}>`, components: [] });
      }
      return;
    }

    /* 모달 */
    if (i.isModalSubmit()) {
      if (id === 'adm_m_addprod') {
        const price = parseInt(i.fields.getTextInputValue('price').replace(/\D/g, ''), 10);
        if (Number.isNaN(price)) return i.reply({ content: '❌ 가격은 숫자로 입력해 주세요.', ...EPH });
        const info = db.prepare('INSERT INTO products (guild_id, category, name, price) VALUES (?,?,?,?)')
          .run(gid, i.fields.getTextInputValue('cat').trim(), i.fields.getTextInputValue('name').trim(), price);
        return i.reply({ content: `✅ 상품 등록 완료 (번호 **${info.lastInsertRowid}**)\n이제 관리 패널의 📥 **재고 추가**로 재고를 넣어 주세요.`, ...EPH });
      }

      if (id.startsWith('adm_m_stock:')) {
        const p = getProduct(gid, id.split(':')[1]);
        if (!p) return i.reply({ content: '❌ 없는 상품이에요.', ...EPH });
        const lines = i.fields.getTextInputValue('lines').split('\n').map((s) => s.trim()).filter(Boolean);
        const ins = db.prepare('INSERT INTO stock (product_id, content) VALUES (?, ?)');
        db.transaction(() => lines.forEach((l) => ins.run(p.id, l)))();
        return i.reply({ content: `✅ **${p.name}** 재고 **${lines.length}개** 추가했어요.`, ...EPH });
      }

      if (id.startsWith('adm_m_bal:')) {
        const uid = id.split(':')[1];
        const amt = parseInt(i.fields.getTextInputValue('amount').replace(/[^\d-]/g, ''), 10);
        if (Number.isNaN(amt)) return i.reply({ content: '❌ 금액을 숫자로 입력해 주세요.', ...EPH });
        q.getUser(gid, uid);
        db.prepare('UPDATE users SET balance = MAX(0, balance + ?) WHERE guild_id = ? AND user_id = ?').run(amt, gid, uid);
        const u = q.getUser(gid, uid);
        log(i.guild, new EmbedBuilder().setColor(0x5865f2).setTitle('💰 잔액 수동 조정')
          .addFields(
            { name: '대상', value: `<@${uid}>`, inline: true },
            { name: '변동', value: `${amt >= 0 ? '+' : ''}${won(amt)}`, inline: true },
            { name: '잔액', value: won(u.balance), inline: true },
          ).setTimestamp(), 'charge_log_channel');
        return i.reply({ content: `✅ <@${uid}> 잔액: **${won(u.balance)}**`, ...EPH });
      }

      if (id === 'adm_m_brand') {
        const title = i.fields.getTextInputValue('title').trim();
        let color = i.fields.getTextInputValue('color').trim();
        const footer = i.fields.getTextInputValue('footer').trim();
        if (color && !/^#?[0-9a-fA-F]{6}$/.test(color)) {
          return i.reply({ content: '❌ 색상은 `#FF88CC` 같은 HEX 6자리로 입력해 주세요.', ...EPH });
        }
        if (color && !color.startsWith('#')) color = `#${color}`;
        db.prepare('UPDATE guilds SET panel_title = ?, panel_color = ?, footer_text = ? WHERE guild_id = ?')
          .run(title, color.toUpperCase(), footer, gid);
        return i.reply({
          content: '✅ 저장했어요! 아래는 미리보기예요. (이미 올린 패널은 🛒 자판기 패널 게시로 다시 올려야 반영돼요)',
          embeds: panelPayload(i.guild).embeds,
          ...EPH,
        });
      }

      if (id === 'adm_m_lic') {
        const res = redeemLicense(i.fields.getTextInputValue('key').trim().toUpperCase(), gid);
        if (res.err) return i.reply({ content: `❌ ${res.err}`, ...EPH });
        return i.reply({ content: `✅ **${res.days}일** 라이센스 등록 완료!\n만료일: ${ts(res.expires)}`, ...EPH });
      }
    }
  }

  return { owns, handle, home, log };
};
