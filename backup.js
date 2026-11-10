const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const {Client, GatewayIntentBits, Events, PermissionFlagsBits, Routes, ButtonBuilder, ButtonStyle, ActionRowBuilder, MessageFlags} = require('discord.js');
const {openStore} = require('./backup-store');
if (fs.existsSync('.env')) process.loadEnvFile('.env');
module.exports = function attachBackup(bot) {
const cfg = {...process.env, DISCORD_TOKEN: process.env.TOKEN, DB_PATH: process.env.BACKUP_DB_PATH || './data/backup.sqlite'};
for (const name of ['DISCORD_TOKEN','CLIENT_ID','CLIENT_SECRET','SOURCE_GUILD','BACKUP_GUILD','SOURCE_ROLE','BACKUP_ROLE','REDIRECT_URI','DATA_KEY']) {
  if (!cfg[name]) throw Error('설정 누락: '+name);
}
if (cfg.SOURCE_GUILD === cfg.BACKUP_GUILD) throw Error('원본 서버와 백업 서버를 구분해 주세요.');
const redirect = new URL(cfg.REDIRECT_URI);
if (redirect.protocol !== 'https:' || redirect.search || redirect.hash) throw Error('HTTPS 콜백 주소를 확인해 주세요.');
const key = Buffer.from(cfg.DATA_KEY,'base64');
if (key.length !== 32) throw Error('DATA_KEY는 32바이트 base64 키여야 합니다.');
function seal(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm',key,iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data)),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');
}
function unseal(value) {
  const b = Buffer.from(value,'base64');
  const d = crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));
  d.setAuthTag(b.subarray(12,28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]));
}
const file = cfg.DB_PATH || './data/backup.sqlite';
fs.mkdirSync(path.dirname(file),{recursive:true});
const {db,issue,claim} = openStore(file);
const binding = [cfg.CLIENT_ID,cfg.SOURCE_GUILD,cfg.BACKUP_GUILD,crypto.createHash('sha256').update(key).digest('hex')].join('/');
db.prepare("INSERT OR IGNORE INTO settings VALUES('binding',?)").run(binding);
if (db.prepare("SELECT value FROM settings WHERE name='binding'").get().value !== binding) throw Error('DB의 앱, 서버 또는 암호화 키 설정이 다릅니다.');

const source = cfg.SOURCE_GUILD, target = cfg.BACKUP_GUILD;
const admin = PermissionFlagsBits.Administrator;
const quiet = {flags:MessageFlags.Ephemeral};
const states = new Map();
const locks = new Map();
async function forUser(uid, fn) {
  const task = (locks.get(uid) || Promise.resolve()).catch(()=>{}).then(fn);
  locks.set(uid,task);
  try {return await task;} finally {if(locks.get(uid)===task) locks.delete(uid);}
}
function link(label,url) {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url));
}
async function token(fields) {
  const res = await fetch('https://discord.com/api/v10/oauth2/token',{method:'POST',signal:AbortSignal.timeout(15000),
    body:new URLSearchParams({client_id:cfg.CLIENT_ID,client_secret:cfg.CLIENT_SECRET,...fields})});
  const data = await res.json();
  if (!res.ok) throw Object.assign(Error('OAuth'),{invalid:data.error==='invalid_grant'});
  return {access:data.access_token,refresh:data.refresh_token,expires:Date.now()+data.expires_in*1000,scope:data.scope};
}
const getMember = uid => db.prepare('SELECT * FROM members WHERE uid=?').get(uid);
async function authorize(code,uid) {
  const t = await token({grant_type:'authorization_code',code,redirect_uri:cfg.REDIRECT_URI});
  if (!['identify','guilds.join'].every(s=>t.scope?.split(' ').includes(s))) throw Error('scope');
  const res = await fetch('https://discord.com/api/v10/users/@me',{headers:{Authorization:'Bearer '+t.access},signal:AbortSignal.timeout(15000)});
  if (!res.ok || (await res.json()).id!==uid) throw Error('identity');
  await bot.rest.put(Routes.guildMemberRole(source,uid,cfg.SOURCE_ROLE));
  db.prepare('INSERT INTO members VALUES(?,?,?) ON CONFLICT(uid) DO UPDATE SET secret=excluded.secret').run(uid,seal(t),Date.now());
  db.prepare("UPDATE tasks SET status='재인증됨' WHERE uid=? AND status='동의만료'").run(uid);
}
const server = http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','text/plain; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  try {
    const u = new URL(req.url,'http://localhost');
    if(req.method!=='GET' || u.pathname!==redirect.pathname){res.writeHead(404);return res.end();}
    const state=u.searchParams.get('state'), entry=states.get(state);
    states.delete(state);
    if(!entry || entry.until<Date.now() || !u.searchParams.get('code')) throw Error('state');
    await forUser(entry.uid,()=>authorize(u.searchParams.get('code'),entry.uid));
    res.end('인증 완료! 디스코드에서 인증 역할을 확인해 주세요.');
  } catch {res.writeHead(400);res.end('인증을 완료하지 못했어요. 같은 계정으로 인증 버튼부터 다시 시작해 주세요. 반복되면 관리자에게 역할 설정을 확인해 달라고 해 주세요.');}
});
const baseCommands = [
  {name:'인증패널',description:'이 채널에 인증 버튼 게시'},
  {name:'라이선스발급',description:'인원 한도를 정해 일회용 복구 코드 발급',options:[{name:'인원',description:'복구 대상 인원 (50명 단위: 50, 100, 150…)',type:4,required:true,min_value:50,max_value:100000}]},
  {name:'복구',description:'이 백업 서버에서 코드 사용',options:[{name:'코드',description:'일회용 코드',type:3,required:true,max_length:64}]},
  {name:'복구상태',description:'작업별 처리 현황',options:[{name:'번호',description:'복구 작업 번호',type:4,required:true,min_value:1}]}
].map(c=>({...c,default_member_permissions:String(admin)}));
const forget={name:'인증삭제',description:'내 인증 기록과 저장된 가입 동의 토큰 삭제'};
const nameOf=id=>bot.guilds.cache.get(id)?.name || id;
bot.once(Events.ClientReady,async()=>{
  try {

    server.listen(Number(cfg.PORT||3000),'0.0.0.0');
    setInterval(()=>{for(const [s,e] of states) if(e.until<Date.now()) states.delete(s);},60000);
    // Recheck screening after downtime or a missed gateway event.
    const recheck=()=>db.prepare("UPDATE tasks SET status='대기' WHERE status='심사대기'").run();
    recheck();
    setInterval(recheck, 15*60000);
    work();
    console.log('인증봇 준비 완료');
  } catch {console.error('명령어 등록 실패. 두 서버에 봇이 설치되었는지 확인하세요.');process.exit(1);}
});
bot.on(Events.GuildMemberAdd,async m=>{
  if(m.guild.id!==source || !getMember(m.id)) return;
  try {await m.roles.add(cfg.SOURCE_ROLE);} catch {console.error('재입장 역할 지급 실패. 역할 권한과 순서를 확인하세요.');}
});
bot.on(Events.InteractionCreate,async i=>{
  if(![source,target].includes(i.guildId)) return;
  try {
    if(i.isButton() && i.customId==='verify' && i.guildId===source){
      const state=crypto.randomBytes(32).toString('hex');
      states.set(state,{uid:i.user.id,until:Date.now()+600000});
      const url=new URL('https://discord.com/oauth2/authorize');
      url.search=new URLSearchParams({client_id:cfg.CLIENT_ID,response_type:'code',redirect_uri:cfg.REDIRECT_URI,scope:'identify guilds.join',state,prompt:'consent'}).toString();
      return await i.reply({...quiet,content:'인증하면 역할을 받고, 관리자가 백업 서버 **'+nameOf(target)+'** (ID '+target+')에 나를 가입시킬 수 있어. 동의하면 아래 버튼을 눌러줘. 링크는 10분간 유효해.',components:[link('동의하고 Discord 인증',url.href)]});
    }
    if(!i.isChatInputCommand()) return;
    if(i.commandName==='인증삭제'){
      await i.deferReply(quiet);
      await forUser(i.user.id,async()=>{
        db.prepare('DELETE FROM members WHERE uid=?').run(i.user.id);
        db.prepare('DELETE FROM tasks WHERE uid=?').run(i.user.id);
        for(const [s,e] of states) if(e.uid===i.user.id) states.delete(s);
      });
      return await i.editReply('내 인증 기록과 저장된 토큰을 삭제했어. 디스코드 사용자 설정 → 승인한 앱에서도 승인을 해제할 수 있어.');
    }
    if(!i.memberPermissions?.has(admin)) return await i.reply({...quiet,content:'서버 관리자만 사용할 수 있어.'});
    if(i.guildId===source && i.commandName==='인증패널'){
      const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel('인증하기').setCustomId('verify'));
      return await i.reply({content:'**서버 인증**\n버튼을 눌러 인증 역할을 받아줘. 인증 기록은 재입장 시 역할 복원과 지정 백업 서버 가입에 사용돼. 내 기록은 /인증삭제 로 삭제할 수 있어.',components:[row]});
    }
    if(i.guildId===source && i.commandName==='라이선스발급'){
      const cap=i.options.getInteger('인원',true);
      let code;
      try { code=issue(cap); } catch(e) {
        if(e instanceof RangeError) return await i.reply({...quiet,content:e.message});
        throw e;
      }
      return await i.reply({...quiet,content:'최대 '+cap+'명 · 1회용 코드\n`'+code+'`'});
    }
    if(i.guildId===target && i.commandName==='복구'){
      let result;
      try {result=claim(i.options.getString('코드',true));} catch(e){if(!e.code)return await i.reply({...quiet,content:e.message});throw e;}
      return await i.reply({...quiet,content:'작업 '+result.id+'번에 '+result.count+'명을 등록했어. /복구상태 로 확인해줘.'});
    }
    if(i.guildId===target && i.commandName==='복구상태'){
      const rows=db.prepare('SELECT status,COUNT(*) AS n FROM tasks WHERE job=? GROUP BY status').all(i.options.getInteger('번호',true));
      return await i.reply({...quiet,content:rows.map(r=>r.status+' '+r.n+'명').join('\n') || '표시할 대상이 없어.'});
    }
  } catch { console.error('명령 처리 실패');try {if(!i.replied) await (i.deferred?i.editReply('처리 실패'):i.reply({...quiet,content:'처리 실패'}));}catch{} }
});
async function restore(uid) {
  const m=getMember(uid);
  if(!m) return '동의삭제';
  let t=unseal(m.secret);
  if(t.expires<Date.now()+60000){
    try {t=await token({grant_type:'refresh_token',refresh_token:t.refresh});}
    catch(e){if(e.invalid)return '동의만료';throw e;}
    db.prepare('UPDATE members SET secret=? WHERE uid=?').run(seal(t),uid);
  }
  try {
    await bot.rest.put(Routes.guildMember(target,uid),{body:{access_token:t.access}});
    const member=await bot.rest.get(Routes.guildMember(target,uid));
    if(member.pending) return '심사대기';
    await bot.rest.put(Routes.guildMemberRole(target,uid,cfg.BACKUP_ROLE));
    return '완료';
  } catch(e){
    if(e.code===50025) return '동의만료';
    if(e.code===40007 || e.code===30001) return '가입불가';
    throw e;
  }
}
bot.on(Events.GuildMemberUpdate,async (old,m)=>{
  if(m.guild.id!==target || m.pending || !getMember(m.id)) return;
  if(!db.prepare("SELECT 1 FROM tasks WHERE uid=? AND status='심사대기'").get(m.id)) return;
  db.prepare("UPDATE tasks SET status='대기' WHERE uid=? AND status='심사대기'").run(m.id);
});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function work(){
  for(;;){
    const job=db.prepare("SELECT job,uid FROM tasks WHERE status='대기' ORDER BY job,uid LIMIT 1").get();
    if(!job){await pause(1500);continue;}
    try {
      await forUser(job.uid,async()=>{
        const state=await restore(job.uid);
        db.prepare('UPDATE tasks SET status=? WHERE job=? AND uid=?').run(state,job.job,job.uid);
      });
      await pause(500);
    } catch(e){console.error('복구 일시정지. 작업',job.job,'오류',e.code||e.status||'network','60초 후 재시도');await pause(60000);}
  }
}
return {commands:[...baseCommands,forget], handles:i => (i.isChatInputCommand() && [...baseCommands,forget].some(c=>c.name===i.commandName)) || (i.isButton() && i.customId==='verify')};
};
