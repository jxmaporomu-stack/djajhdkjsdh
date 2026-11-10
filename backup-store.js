const { DatabaseSync } = require('node:sqlite');
const { createHash, randomBytes } = require('node:crypto');
const hash = code => createHash('sha256').update(code.trim()).digest('hex');

function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS members(uid TEXT PRIMARY KEY, secret TEXT NOT NULL, verified INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS licenses(id INTEGER PRIMARY KEY, digest TEXT UNIQUE, cap INTEGER NOT NULL, used INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS tasks(job INTEGER, uid TEXT, status TEXT DEFAULT '대기', PRIMARY KEY(job,uid));
    CREATE TABLE IF NOT EXISTS settings(name TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  function issue(cap) {
    if (!Number.isInteger(cap) || cap < 50 || cap > 100000 || cap % 50 !== 0) {
      throw new RangeError('인원은 50명부터 100,000명까지 50명 단위로 입력해 줘. 예: 50, 100, 150');
    }
    const code = randomBytes(20).toString('hex');
    db.prepare('INSERT INTO licenses(digest,cap) VALUES(?,?)').run(hash(code),cap);
    return code;
  }
  function claim(code) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT * FROM licenses WHERE digest=? AND used=0').get(hash(code));
      if (!row) throw Error('유효하지 않거나 이미 사용한 코드야.');
      const {changes} = db.prepare(`INSERT INTO tasks(job,uid) SELECT ?,uid FROM members m
        WHERE NOT EXISTS(SELECT 1 FROM tasks t WHERE t.uid=m.uid AND t.status IN ('대기','완료','심사대기','동의만료'))
        ORDER BY verified,uid LIMIT ?`).run(row.id,row.cap);
      if (!changes) throw Error('새 복구 대상이 없어. 코드는 아직 사용할 수 있어.');
      db.prepare('UPDATE licenses SET used=1 WHERE id=?').run(row.id);
      db.exec('COMMIT');
      return {id:row.id, count:changes};
    } catch(e) { db.exec('ROLLBACK'); throw e; }
  }
  return {db,issue,claim};
}
module.exports = {openStore};
