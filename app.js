'use strict';
// ekincare AI Auditor – zero-dependency Node.js (v22.5+) server. Run: node server.js
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
try{for(const l of fs.readFileSync(path.join(__dirname,'..','.env'),'utf8').split(/\r?\n/)){const m=l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);if(m&&!(m[1] in process.env))process.env[m[1]]=m[2].replace(/^"|"$/g,'')}}catch{}
const E=process.env,ADMIN=(E.ADMIN_EMAIL||'saikiran.k@ekincare.com').toLowerCase();
const CFG=require('./params.json');
const REDIS_URL=E.UPSTASH_REDIS_REST_URL||E.KV_REST_API_URL,REDIS_TOKEN=E.UPSTASH_REDIS_REST_TOKEN||E.KV_REST_API_TOKEN;
let store;
if(REDIS_URL){ // hosted (Vercel + Upstash Redis REST) – no npm packages needed
const cmd=async a=>{const r=await fetch(REDIS_URL,{method:'POST',headers:{Authorization:'Bearer '+REDIS_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(a)});const j=await r.json();if(j.error)throw new Error(j.error);return j.result};
const hall=async k=>{let a=await cmd(['HGETALL',k])||[];if(!Array.isArray(a))a=Object.entries(a).flat();const o=[];for(let i=1;i<a.length;i+=2)o.push(JSON.parse(a[i]));return o};
store={all:async c=>(await hall('kv:'+c)).sort((a,b)=>(a.ts||0)-(b.ts||0)),get:async(c,i)=>{const v=await cmd(['HGET','kv:'+c,i]);return v?JSON.parse(v):null},put:async(c,i,o)=>{await cmd(['HSET','kv:'+c,i,JSON.stringify(o)])},
addAudit:async a=>{await cmd(['HSETNX','kv:audits',a.id,JSON.stringify(a)])},dup:async(ch,emp,tx)=>(await hall('kv:audits')).some(a=>a.ch===ch&&a.emp===emp&&a.tx===tx),
log:async(who,act,info)=>{await cmd(['LPUSH','log',JSON.stringify({ts:Date.now(),who,act,info:String(info).slice(0,300)})]);await cmd(['LTRIM','log',0,299])},logs:async()=>((await cmd(['LRANGE','log',0,299]))||[]).map(x=>JSON.parse(x)),
mailGet:async k=>{const v=await cmd(['HGET','mail',k]);return v?JSON.parse(v):null},mailPut:async r=>{await cmd(['HSET','mail',r.key,JSON.stringify(r)])},mails:async()=>(await hall('mail')).sort((a,b)=>b.ts-a.ts).slice(0,200)}}
else { // local file database (Node 22.5+)
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(E.DB_FILE||path.join(__dirname,'..','data.db'));
db.exec(`CREATE TABLE IF NOT EXISTS kv(coll TEXT,id TEXT,json TEXT,upd INTEGER,PRIMARY KEY(coll,id));CREATE TABLE IF NOT EXISTS log(ts INTEGER,who TEXT,act TEXT,info TEXT);CREATE TABLE IF NOT EXISTS mail(key TEXT PRIMARY KEY,ts INTEGER,rcpt TEXT,subj TEXT,status TEXT,err TEXT);`);
store={all:async c=>db.prepare('SELECT json FROM kv WHERE coll=? ORDER BY upd').all(c).map(r=>JSON.parse(r.json)),get:async(c,i)=>{const r=db.prepare('SELECT json FROM kv WHERE coll=? AND id=?').get(c,i);return r?JSON.parse(r.json):null},
put:async(c,i,o)=>{db.prepare('INSERT OR REPLACE INTO kv VALUES(?,?,?,?)').run(c,i,JSON.stringify(o),Date.now())},addAudit:async a=>{db.prepare('INSERT INTO kv VALUES(?,?,?,?)').run('audits',a.id,JSON.stringify(a),a.ts)},
dup:async(ch,emp,tx)=>!!db.prepare("SELECT 1 FROM kv WHERE coll='audits' AND json_extract(json,'$.ch')=? AND json_extract(json,'$.emp')=? AND json_extract(json,'$.tx')=? LIMIT 1").get(ch,emp,tx),
log:async(who,act,info)=>{db.prepare('INSERT INTO log VALUES(?,?,?,?)').run(Date.now(),who,act,String(info).slice(0,300))},logs:async()=>db.prepare('SELECT * FROM log ORDER BY ts DESC LIMIT 300').all(),
mailGet:async k=>db.prepare('SELECT * FROM mail WHERE key=?').get(k)||null,mailPut:async r=>{db.prepare('INSERT OR REPLACE INTO mail VALUES(?,?,?,?,?,?)').run(r.key,r.ts,r.rcpt,r.subj,r.status,r.err)},mails:async()=>db.prepare('SELECT * FROM mail ORDER BY ts DESC LIMIT 200').all()}}
const {all,get,put,log}=store;
const sid=s=>s.toLowerCase().replace(/[^a-z0-9]/g,'_');
const okEm=s=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s||'');
// secrets & passwords
let SECRET=E.SESSION_SECRET||null;
async function init(){if(SECRET)return;let v=(await get('sys','secret'))?.v;if(!v){v=crypto.randomBytes(32).toString('hex');await put('sys','secret',{v});v=(await get('sys','secret')).v}SECRET=v}
const hashPw=pw=>{const s=crypto.randomBytes(16).toString('hex');return s+':'+crypto.scryptSync(pw,s,64).toString('hex')};
const checkPw=(pw,h)=>{const[s,x]=(h||':').split(':');try{return crypto.timingSafeEqual(Buffer.from(x,'hex'),crypto.scryptSync(pw,s,64))}catch{return false}};
const sign=v=>crypto.createHmac('sha256',SECRET).update(v).digest('hex');
const mkTok=em=>{const b=Buffer.from(em+'|'+(Date.now()+12*3600e3)).toString('base64url');return b+'.'+sign(b)};
const readTok=async t=>{if(!t)return null;const[b,s]=t.split('.');if(!s||sign(b)!==s)return null;const[em,exp]=Buffer.from(b,'base64url').toString().split('|');if(+exp<Date.now())return null;const u=await get('users',sid(em));return u&&u.active?u:null};
const cookie=(req,n)=>((req.headers.cookie||'').split(/;\s*/).find(c=>c.startsWith(n+'='))||'').slice(n.length+1);
const setSess=(res,em)=>res.setHeader('Set-Cookie',`sid=${mkTok(em)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${E.BASE_URL?.startsWith('https')?'; Secure':''}`);
const tries={};const throttled=k=>{const t=(tries[k]=(tries[k]||[]).filter(x=>Date.now()-x<6e5));return t.length>=8};
// scoring (same rule as the Excel audit sheets)
function calc(ch,res){let ea=0,sc=0,f=0,nf=0;const errs=[];
for(const p of CFG.channels[ch].params){const[o,r]=res[p.k];if(o==='NA')continue;sc+=p.max;if(o==='Fatal'){f++;errs.push({k:p.k,f:1,r});continue}
const v=o==='Y'?p.max:o==='N'?0:+o;ea+=v;if(v<p.max){nf++;errs.push({k:p.k,f:0,r})}}
const earned=f?0:Math.max(0,ea);return{score:sc?earned/sc*100:0,earned,sc,f,nf,errs}}
// Microsoft Graph mail
const mailOn=()=>E.TENANT_ID&&E.CLIENT_ID&&E.CLIENT_SECRET&&E.MAIL_SENDER;
async function gToken(){const r=await fetch(`https://login.microsoftonline.com/${E.TENANT_ID}/oauth2/v2.0/token`,{method:'POST',body:new URLSearchParams({client_id:E.CLIENT_ID,client_secret:E.CLIENT_SECRET,scope:'https://graph.microsoft.com/.default',grant_type:'client_credentials'})});const j=await r.json();if(!j.access_token)throw new Error(j.error_description||'token failed');return j.access_token}
async function sendMail(key,to,cc,subject,html){
{const m0=await store.mailGet(key);if(m0&&m0.status==='sent')return'duplicate'}
const rec=(st,er='')=>store.mailPut({key,ts:Date.now(),rcpt:[to,...cc].join(';'),subj:subject,status:st,err:er});
if(!okEm(to)){await rec('skipped','invalid or missing email');return'skipped'}
if(!mailOn()){await rec('skipped','Microsoft Graph not configured');return'skipped'}
try{const mk=a=>({emailAddress:{address:a}});const r=await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(E.MAIL_SENDER)}/sendMail`,{method:'POST',headers:{Authorization:'Bearer '+await gToken(),'Content-Type':'application/json'},body:JSON.stringify({message:{subject,body:{contentType:'HTML',content:html},toRecipients:[mk(to)],ccRecipients:cc.map(mk)},saveToSentItems:true})});
if(r.status!==202)throw new Error('Graph '+r.status+' '+(await r.text()).slice(0,200));await rec('sent');return'sent'}catch(x){await rec('failed',x.message);return'failed'}}
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const notifyOn=async()=>((await get('settings','cfg'))||{}).notify!==false;
async function notifyAgent(a){if(!await notifyOn())return;const z=a.score===0,h=a.score>=99.999;if(!z&&!h)return;
const ag=await get('agents',sid(a.emp));const det=`<ul><li>Employee ID: ${esc(a.emp)}</li><li>Employee Name: ${esc(a.empName)}</li><li>Channel: ${a.ch}</li><li>Transaction ID: ${esc(a.tx)}</li><li>Audit Date: ${a.auditDate}</li><li>Auditor Name: ${esc(a.auditor)}</li><li>Quality Score: ${z?'0%':'100%'}</li>${z?`<li>Fatal Reason: ${esc(a.fr)}</li><li>Remarks: ${esc(a.rem)}</li>`:''}</ul>`;
const subj=z?`Immediate Attention Required – QA Audit Score 0% – ${a.empName}`:`Congratulations – Excellent QA Performance – ${a.empName}`;
const body=z?`<p>Dear ${esc(a.empName)},</p><p>Your recent QA audit has resulted in a Quality Score of 0%.</p><p>Audit Details:</p>${det}<p>Please review the audit observations and connect with your Team Leader for the required corrective action and guidance.</p><p>Regards,<br>QA Team</p>`:`<p>Dear ${esc(a.empName)},</p><p>Congratulations!</p><p>You have achieved a perfect Quality Score of 100% in your recent QA audit.</p><p>Audit Details:</p>${det}<p>Keep up the excellent work and continue maintaining these quality standards.</p><p>Regards,<br>QA Team</p>`;
await sendMail(a.id+':'+(z?'zero':'hundred'),ag?.active?ag.email:'',[],subj,body)}
// End-of-day summary
const istDay=ts=>new Date(ts+5.5*3600e3).toISOString().slice(0,10);
const trainFor=k=>(CFG.training.find(t=>new RegExp(t[0],'i').test(k))||[0,'SOP and process adherence'])[1];
function top(arr,n=3){const m={};arr.forEach(x=>m[x]=(m[x]||0)+1);return Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,n).map(([k,v])=>`${esc(k)} (${v})`).join(', ')||'None'}
async function eod(day,force){const key='eod:'+day;{const m0=await store.mailGet(key);if(m0&&m0.status==='sent')return'duplicate'}
const A=(await all('audits')).filter(a=>istDay(a.ts)===day);if(!A.length){await log('system','eod-skipped',day+' no audits');return'no audits'}
const sum=(l,k)=>l.reduce((t,x)=>t+x[k],0),q=l=>sum(l,'sc')?(sum(l,'earned')/sum(l,'sc')*100).toFixed(1)+'%':'N/A',pc=n=>(n/A.length*100).toFixed(1)+'%';
const ags={};A.forEach(a=>{(ags[a.emp]=ags[a.emp]||{n:a.empName,l:[]}).l.push(a)});
const rank=Object.values(ags).map(g=>({n:g.n,s:sum(g.l,'earned')/Math.max(1,sum(g.l,'sc'))*100})).sort((a,b)=>b.s-a.s);
const errs=A.flatMap(a=>a.errs||[]);
const chRows=Object.keys(CFG.channels).map(c=>{const l=A.filter(a=>a.ch===c);return`<tr><td>${c}</td><td>${l.length}</td><td>${l.length?q(l):'N/A'}</td><td>${sum(l,'f')}</td><td>${sum(l,'nf')}</td></tr>`}).join('');
const d=new Date(day+'T00:00:00Z'),dd=`${String(d.getUTCDate()).padStart(2,'0')}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]}-${d.getUTCFullYear()}`;
const html=`<p>Dear Team,</p><p>Please find below the Daily QA Audit Summary for ${dd}.</p><h3>Overall Audit Summary</h3><ul><li>Total Audits Completed: ${A.length}</li><li>Total Agents Audited: ${Object.keys(ags).length}</li>${Object.keys(CFG.channels).map(c=>`<li>${c} Audits: ${A.filter(a=>a.ch===c).length}</li>`).join('')}<li>Overall Quality Score: ${q(A)}</li><li>Total Fatal Errors: ${sum(A,'f')}</li><li>Fatal Error Percentage: ${pc(A.filter(a=>a.f).length)}</li><li>Total Non-Fatal Errors: ${sum(A,'nf')}</li><li>Non-Fatal Error Percentage: ${pc(A.filter(a=>a.nf).length)}</li></ul>
<h3>Channel-Wise Performance</h3><table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>Channel</th><th>Total Audits</th><th>Quality Score</th><th>Fatal Errors</th><th>Non-Fatal Errors</th></tr>${chRows}</table>
<h3>Key Observations</h3><ul><li>Top-performing agents: ${rank.slice(0,3).map(x=>esc(x.n)+' ('+x.s.toFixed(1)+'%)').join(', ')}</li><li>Agents requiring improvement: ${rank.filter(x=>x.s<80).slice(-3).map(x=>esc(x.n)+' ('+x.s.toFixed(1)+'%)').join(', ')||'None below 80%'}</li><li>Most frequent fatal errors: ${top(errs.filter(e=>e.f).map(e=>e.k))}</li><li>Most frequent non-fatal errors: ${top(errs.filter(e=>!e.f).map(e=>e.k))}</li><li>Major training opportunities: ${top(errs.map(e=>trainFor(e.k)),3)}</li></ul><p>Please refer to the QA Dashboard for detailed audit information.</p><p>Regards,<br>QA Team</p>`;
const r=await sendMail(key,E.EOD_TO||'saikiran.k@ekincare.com',[E.EOD_CC||'neerajkumar.m@ekincare.com'],`Daily QA Audit Summary – ${dd}`,html);await log('system','eod',day+' '+r);return r}
// HTTP
const MIME={'.html':'text/html; charset=utf-8','.json':'application/json','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
const J=(res,c,o)=>{res.writeHead(c,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(o))};
const body=req=>req.body!==undefined&&req.body!==null?Promise.resolve(typeof req.body==='string'?JSON.parse(req.body||'{}'):Buffer.isBuffer(req.body)?JSON.parse(req.body.toString()||'{}'):req.body):new Promise((ok,no)=>{let b='';req.on('data',d=>{b+=d;if(b.length>1e6){req.destroy();no()}});req.on('end',()=>{try{ok(b?JSON.parse(b):{})}catch{no()}})});
const pub=u=>{const{h,...r}=u;return r};
const msOn=()=>E.CLIENT_ID&&E.CLIENT_SECRET&&E.TENANT_ID&&E.BASE_URL;
async function handle(req,res){await init();try{const url=new URL(req.url,'http://x'),p=url.pathname,me=await readTok(cookie(req,'sid'));
if(p==='/api/config')return J(res,200,{...CFG,ms:!!msOn(),setup:!(await all('users')).length,mail:!!mailOn()});
if(p==='/auth/microsoft'&&msOn()){const st=crypto.randomBytes(16).toString('hex');res.writeHead(302,{'Set-Cookie':`st=${st}; HttpOnly; Path=/; Max-Age=600`,Location:`https://login.microsoftonline.com/${E.TENANT_ID}/oauth2/v2.0/authorize?`+new URLSearchParams({client_id:E.CLIENT_ID,response_type:'code',redirect_uri:E.BASE_URL+'/auth/callback',scope:'openid profile email',state:st,response_mode:'query'})});return res.end()}
if(p==='/auth/callback'&&msOn()){if(!url.searchParams.get('code')||url.searchParams.get('state')!==cookie(req,'st')){res.writeHead(400);return res.end('Invalid sign-in state')}
const r=await fetch(`https://login.microsoftonline.com/${E.TENANT_ID}/oauth2/v2.0/token`,{method:'POST',body:new URLSearchParams({client_id:E.CLIENT_ID,client_secret:E.CLIENT_SECRET,code:url.searchParams.get('code'),redirect_uri:E.BASE_URL+'/auth/callback',grant_type:'authorization_code'})});const j=await r.json();
const c=j.id_token?JSON.parse(Buffer.from(j.id_token.split('.')[1],'base64url')):{},em=(c.email||c.preferred_username||'').toLowerCase(),u=await get('users',sid(em));
if(!u||!u.active){await log(em||'?','ms-login-denied');res.writeHead(403);return res.end('Your Microsoft account has not been granted access. Contact the admin.')}
setSess(res,em);await log(em,'login','microsoft');res.writeHead(302,{Location:'/'});return res.end()}
if(p==='/api/cron/eod'){if(!E.CRON_SECRET||req.headers.authorization!=='Bearer '+E.CRON_SECRET)return J(res,401,{error:'Unauthorized'});return J(res,200,{result:await eod(istDay(Date.now()))})}
if(p.startsWith('/api/')){
if(p==='/api/setup'&&req.method==='POST'){const b=await body(req);if((await all('users')).length)return J(res,403,{error:'Already set up'});if((b.email||'').toLowerCase()!==ADMIN||(b.password||'').length<8)return J(res,400,{error:'Use the admin email and a password of 8+ characters'});
await put('users',sid(ADMIN),{email:ADMIN,name:b.name||'Super Admin',role:'admin',ch:Object.keys(CFG.channels),active:true,h:hashPw(b.password)});log(ADMIN,'setup');setSess(res,ADMIN);return J(res,200,{ok:1})}
if(p==='/api/login'&&req.method==='POST'){const b=await body(req),em=(b.email||'').toLowerCase().trim(),k=em+req.socket.remoteAddress;if(throttled(k))return J(res,429,{error:'Too many attempts. Try again in a few minutes.'});
const u=await get('users',sid(em));if(!u||!u.active||!checkPw(b.password||'',u.h)){tries[k].push(Date.now());await log(em,'login-failed');return J(res,401,{error:'Invalid credentials or inactive account'})}
setSess(res,em);await log(em,'login');return J(res,200,{ok:1})}
if(p==='/api/logout'){res.setHeader('Set-Cookie','sid=; Max-Age=0; Path=/');return J(res,200,{ok:1})}
if(!me)return J(res,401,{error:'Not signed in'});
if(p==='/api/me')return J(res,200,pub(me));
if(p==='/api/password'&&req.method==='POST'){const b=await body(req);if(!checkPw(b.old||'',me.h)||(b.pw||'').length<8)return J(res,400,{error:'Current password is wrong, or the new one is shorter than 8 characters'});await put('users',sid(me.email),{...me,h:hashPw(b.pw)});await log(me.email,'password-changed');return J(res,200,{ok:1})}
if(p==='/api/data'){const A=await all('audits'),ag=await all('agents');const r={cfg:await get('settings','cfg')||{good:90,neu:80,min:1,notify:true}};
if(me.role==='admin'){r.users=(await all('users')).map(pub);r.agents=ag;r.audits=A;r.mail=await store.mails();r.log=await store.logs()}
else if(me.role==='tl'){r.agents=ag.filter(x=>x.tl===me.email);const ids=new Set(r.agents.map(x=>x.id));r.audits=A.filter(a=>ids.has(a.emp));r.users=[]}
else{r.agents=ag.filter(x=>x.active).map(x=>({id:x.id,name:x.name,active:1}));r.audits=A.filter(a=>a.aEmail===me.email);r.users=[]}return J(res,200,r)}
if(p==='/api/audit'&&req.method==='POST'){if(!['admin','auditor'].includes(me.role))return J(res,403,{error:'Not allowed'});
const b=await body(req),ch=CFG.channels[b.ch];if(!ch)return J(res,400,{error:'Unknown channel'});if(me.role!=='admin'&&!(me.ch||[]).includes(b.ch))return J(res,403,{error:'Channel not assigned to you'});
const ag=await get('agents',sid(b.emp||''));if(!ag||!ag.active)return J(res,400,{error:'Agent not found or inactive'});
if(!(b.tx||'').trim()||!CFG.serviceLines.includes(b.svc)||!/^\d{4}-\d\d-\d\d$/.test(b.auditDate||''))return J(res,400,{error:`${ch.tx}, service line and audit date are mandatory`});
const res2={};for(const q of ch.params){const v=(b.res||{})[q.k];if(!v||!q.opts.includes(v[0]))return J(res,400,{error:'Missing observation: '+q.k});const o=v[0];const need=o==='Fatal'||o==='N'||(!isNaN(+o)&&+o<q.max);if(need&&!(v[1]||'').trim())return J(res,400,{error:'Failure reason required: '+q.k});res2[q.k]=[o,(v[1]||'').trim()]}
const k=calc(b.ch,res2),id='A'+Date.now().toString(36).toUpperCase()+crypto.randomBytes(2).toString('hex').toUpperCase();
const a={id,ch:b.ch,emp:ag.id,empName:ag.name,tl:ag.tl||'',tx:b.tx.trim(),svc:b.svc,disp:b.disp||'',callDate:b.callDate||'',auditDate:b.auditDate,ts:Date.now(),auditor:me.name,aEmail:me.email,res:res2,...k,
fr:k.errs.filter(e=>e.f).map(e=>e.k+': '+e.r).join(' | '),nfr:k.errs.filter(e=>!e.f&&res2[e.k][0]!=='Y').map(e=>e.k+': '+e.r).join(' | '),rem:b.rem||''};
if(await store.dup(b.ch,ag.id,a.tx))return J(res,409,{error:'Duplicate: this transaction is already audited for this agent'});
await store.addAudit(a);await log(me.email,'audit-submit',id);await notifyAgent(a).catch(x=>log('system','notify-error',x.message));return J(res,200,{id,score:k.score})}
if(me.role!=='admin')return J(res,403,{error:'Admin only'});
let m;if(p==='/api/eod'&&req.method==='POST')return J(res,200,{result:await eod(istDay(Date.now()))});
if(m=p.match(/^\/api\/doc\/(users|agents|settings)\/([^/]+)$/)){const[,c,id]=m,b=await body(req),old=await get(c,id)||{};let o={...old,...b};
if(c==='users'){if(!okEm(o.email)||!['admin','tl','auditor'].includes(o.role))return J(res,400,{error:'Invalid user'});o.email=o.email.toLowerCase();if(b.password){if(b.password.length<8)return J(res,400,{error:'Password must be 8+ characters'});o.h=hashPw(b.password)}delete o.password;if(!o.h)return J(res,400,{error:'Password required'});if(o.email===ADMIN)o={...o,role:'admin',active:true}}
if(c==='agents'&&(!o.id||!o.name||!okEm(o.email)))return J(res,400,{error:'Emp ID, name and valid email are required'});
await put(c,c==='users'?sid(o.email):c==='agents'?sid(o.id):id,o);await log(me.email,'update-'+c,id);return J(res,200,{ok:1})}
return J(res,404,{error:'Not found'})}
const f=path.join(__dirname,'..','public',p==='/'?'index.html':p.replace(/\.\./g,''));
if(fs.existsSync(f)&&fs.statSync(f).isFile()){res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});return fs.createReadStream(f).pipe(res)}
res.writeHead(404);res.end('Not found')}catch(x){try{J(res,500,{error:'Server error'})}catch{}}}
module.exports={handle,eod,istDay,log:store.log};
