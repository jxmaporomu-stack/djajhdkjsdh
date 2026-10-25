const Database = require('better-sqlite3');

// Railway 등 배포 환경에서는 볼륨 경로(예: /data/data.db)를 DB_PATH 로 지정
const db = new Database(process.env.DB_PATH || 'data.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS guilds (
  guild_id   TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL DEFAULT 0,
  bank_info  TEXT NOT NULL DEFAULT '',
  guide      TEXT NOT NULL DEFAULT '',
  min_charge INTEGER NOT NULL DEFAULT 1000
);

CREATE TABLE IF NOT EXISTS licenses (
  key        TEXT PRIMARY KEY,
  days       INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used_guild TEXT,
  used_at    INTEGER
);

CREATE TABLE IF NOT EXISTS users (
  guild_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  balance     INTEGER NOT NULL DEFAULT 0,
  total_spent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS products (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  category TEXT NOT NULL,
  name     TEXT NOT NULL,
  price    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stock (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  content    TEXT NOT NULL,
  sold       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  product_name TEXT NOT NULL,
  price        INTEGER NOT NULL,
  content      TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS charges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  depositor  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id  TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  clock_in  INTEGER NOT NULL,
  clock_out INTEGER
);
`);

// 기존 DB에 새 설정 컬럼 추가 (이미 있으면 건너뜀)
const guildCols = db.prepare('PRAGMA table_info(guilds)').all().map((c) => c.name);
for (const col of ['log_channel', 'panel_title', 'panel_color', 'footer_text', 'buyer_role', 'review_channel', 'charge_log_channel']) {
  if (!guildCols.includes(col)) db.exec(`ALTER TABLE guilds ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
}

const q = {
  getGuild(guildId) {
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)').run(guildId);
    return db.prepare('SELECT * FROM guilds WHERE guild_id = ?').get(guildId);
  },
  getUser(guildId, userId) {
    db.prepare('INSERT OR IGNORE INTO users (guild_id, user_id) VALUES (?, ?)').run(guildId, userId);
    return db.prepare('SELECT * FROM users WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  },
};

// 구매: 잔액 차감 + 재고 1개 소진을 한 트랜잭션으로 (동시 구매에도 중복 지급 없음)
const buy = db.transaction((guildId, userId, productId) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ? AND guild_id = ?').get(productId, guildId);
  if (!p) return { err: '존재하지 않는 상품이에요.' };
  const u = q.getUser(guildId, userId);
  if (u.balance < p.price) return { err: `잔액이 부족해요. (필요 ${p.price.toLocaleString()}원 / 보유 ${u.balance.toLocaleString()}원)` };
  const s = db.prepare('SELECT * FROM stock WHERE product_id = ? AND sold = 0 ORDER BY id LIMIT 1').get(productId);
  if (!s) return { err: '품절된 상품이에요.' };

  db.prepare('UPDATE stock SET sold = 1 WHERE id = ?').run(s.id);
  db.prepare('UPDATE users SET balance = balance - ?, total_spent = total_spent + ? WHERE guild_id = ? AND user_id = ?')
    .run(p.price, p.price, guildId, userId);
  db.prepare('INSERT INTO purchases (guild_id, user_id, product_name, price, content, created_at) VALUES (?,?,?,?,?,?)')
    .run(guildId, userId, p.name, p.price, s.content, Date.now());
  return { product: p, content: s.content, balance: u.balance - p.price };
});

// 충전 승인: pending 상태일 때만 1번 처리
const approveCharge = db.transaction((chargeId) => {
  const c = db.prepare('SELECT * FROM charges WHERE id = ?').get(chargeId);
  if (!c || c.status !== 'pending') return null;
  db.prepare("UPDATE charges SET status = 'approved' WHERE id = ?").run(chargeId);
  q.getUser(c.guild_id, c.user_id);
  db.prepare('UPDATE users SET balance = balance + ? WHERE guild_id = ? AND user_id = ?')
    .run(c.amount, c.guild_id, c.user_id);
  return c;
});

const rejectCharge = db.transaction((chargeId) => {
  const c = db.prepare('SELECT * FROM charges WHERE id = ?').get(chargeId);
  if (!c || c.status !== 'pending') return null;
  db.prepare("UPDATE charges SET status = 'rejected' WHERE id = ?").run(chargeId);
  return c;
});

// 라이센스 등록: 이미 사용 중이면 남은 기간 뒤에 이어서 연장
const redeemLicense = db.transaction((key, guildId) => {
  const l = db.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
  if (!l) return { err: '존재하지 않는 라이센스 키예요.' };
  if (l.used_guild) return { err: '이미 사용된 라이센스 키예요.' };
  const g = q.getGuild(guildId);
  const base = Math.max(Date.now(), g.expires_at);
  const expires = base + l.days * 86400000;
  db.prepare('UPDATE licenses SET used_guild = ?, used_at = ? WHERE key = ?').run(guildId, Date.now(), key);
  db.prepare('UPDATE guilds SET expires_at = ? WHERE guild_id = ?').run(expires, guildId);
  return { days: l.days, expires };
});

module.exports = { db, q, buy, approveCharge, rejectCharge, redeemLicense };
