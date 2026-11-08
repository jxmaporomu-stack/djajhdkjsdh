const { EmbedBuilder } = require('discord.js');
const { q } = require('./db');
const won = n => `${Number(n).toLocaleString('ko-KR')}원`;
const defaults = {
  title: '📥 자판기 재고 추가 로그',
  message: '상품: {상품}\n상품 가격: {가격}\n추가 수량: +{추가수량}개\n추가 후 재고: {현재재고}개\n추가 관리자: {관리자}\n추가 시간: {시간}'
};
function render(template, product, actorId, result) {
  const fields = {
    '{상품}': `#${product.id} ${product.name}`,
    '{가격}': won(product.price),
    '{추가수량}': String(result.quantity),
    '{현재재고}': String(result.after),
    '{관리자}': `<@${actorId}>`,
    '{시간}': `<t:${Math.floor(Date.now()/1000)}:F>`
  };
  return String(template || '').replace(/\{상품\}|\{가격\}|\{추가수량\}|\{현재재고\}|\{관리자\}|\{시간\}/g, match => fields[match]);
}
async function sendStockLog(guild, actorId, result) {
  const settings = q.getGuild(guild.id);
  if (!settings.stock_log_channel) return;
  try {
    const channel = await guild.channels.fetch(settings.stock_log_channel);
    if (!channel?.isTextBased()) return;
    const title = render(settings.stock_log_title || defaults.title, result.product, actorId, result).slice(0, 256);
    const message = render(settings.stock_log_message || defaults.message, result.product, actorId, result).slice(0, 4000);
    await channel.send({
      embeds: [new EmbedBuilder().setColor(0x57f287).setTitle(title).setDescription(message).setTimestamp()],
      allowedMentions: { parse: [] }
    });
  } catch (error) { console.warn('[재고로그] 전송 실패:', error.message); }
}
module.exports = { sendStockLog, defaults };
