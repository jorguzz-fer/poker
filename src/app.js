(function(){
'use strict';
/*__PRESETS__*/

const KEY='pokerclock.v1', UIKEY='pokerclock.ui';
const MAX_LEVELS=50, MAX_WIN=100, PRIZE_PAGE=4, PRIZE_SECS=6;
const HANDS=['Carta alta','Par','Dois pares','Trinca','Sequência','Flush','Full house','Quadra','Straight flush','Royal straight flush'];
const DEFAULT_LEAGUE='Poker & Beer Confraria', DEFAULT_MOTTO='vera amicitia';
const app=document.getElementById('app');

/* ---------- state ---------- */
let S={tournaments:[],players:[],games:[],live:null,settings:{leagueName:DEFAULT_LEAGUE,motto:DEFAULT_MOTTO,logoUrl:'',logoId:''}};
let UI={selectedId:null,sound:true,rankFilter:'',migrateIgnored:false,pin:''};
let view='home', draft=null, editTab='settings', dialog=null, helpOpen=false, sliderHeld=false;
let prep=null, closing=null, gameId=null, lastPhaseKey=null, wakeLock=null, pendingRender=false, toastTimer=null;
let DB=null, ASSETS=null, USER=null, SRV=false, pinRequired=false, srvPersistent=true, mode='local', ready=false, canWrite=true;
const firstSnap={t:false,p:false,g:false,l:false,s:false};

function uid(){return Math.random().toString(36).slice(2,10)+Date.now().toString(36)}
function clone(o){return JSON.parse(JSON.stringify(o))}
function today(){const d=new Date();return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())}
function winPresetFor(presetIdx,n){const tiers=PRESETS.win[presetIdx].tiers;let t=tiers.find(x=>n<=x.max)||tiers[tiers.length-1];return t.pct.slice()}
function defaultScoring(){return{pos:[10,7,5,3,2],base:1,ko:1}}
/* gerador de estrutura de blinds: progressão padrão de salas a partir do SB inicial */
const LADDER=[10,15,25,50,75,100,150,200,300,400,500,600,800,1000,1500,2000,3000,4000,5000,6000,8000,10000,15000,20000,30000,40000,50000,60000,80000,100000];
function genBlinds(o){const sb0=Math.max(1,Math.round(+o.sb||100)),bb0=Math.max(1,Math.round(+o.bb||sb0*2));const n=Math.min(MAX_LEVELS,Math.max(1,Math.round(+o.rounds||20)));const rep=Math.max(1,Math.round(+o.repeatFirst||1));const mins=Math.max(1,Math.round(+o.minutes||20));const anteFrom=Math.max(0,Math.round(+o.anteFrom||0));const brkEvery=Math.max(0,Math.round(+o.breakEvery||0)),brkMin=Math.max(0,Math.round(+o.breakMin||0));
  let idx=LADDER.indexOf(sb0);let seq=idx>=0?LADDER.slice(idx):LADDER.map(v=>Math.max(1,Math.round(v*sb0/LADDER[0])));while(seq.length<n+1)seq.push(seq[seq.length-1]*2);
  const ratio=bb0/sb0;const out=[];for(let i=0;i<n;i++){const sb=i<rep?sb0:seq[Math.min(seq.length-1,i-rep+1)];const bb=Math.round(sb*ratio);const l={sb,bb,ante:0,time:mins,brk:0};if(anteFrom>0&&i+1>=anteFrom)l.ante=bb;if(brkEvery>0&&(i+1)%brkEvery===0&&i<n-1)l.brk=brkMin;out.push(l)}return out}
const CONFRARIA_PRESET={sb:100,bb:200,rounds:20,minutes:20,repeatFirst:2,anteFrom:6,breakEvery:5,breakMin:10};
function newTournament(name){return{id:uid(),name,createdAt:Date.now(),buyInCost:100,buyInChips:1000,reBuyEnabled:false,reBuyCost:0,reBuyChips:0,reBuyLevel:5,addOnEnabled:false,addOnCost:0,addOnChips:0,addCashEnabled:false,addCash:0,currency:'R$',numPlayers:10,winStruct:[50,30,20],blindStruct:genBlinds(CONFRARIA_PRESET),scoring:defaultScoring()}}
function uniqueName(base){let n=base,i=2;while(S.tournaments.some(t=>t.name===n)){n=base+' ('+(i++)+')'}return n}
function seed(){const t=newTournament('Home game de sexta');t.buyInCost=50;t.buyInChips=5000;t.reBuyEnabled=true;t.reBuyCost=50;t.reBuyChips=5000;t.reBuyLevel=4;t.addOnEnabled=true;t.addOnCost=50;t.addOnChips=8000;t.numPlayers=9;t.winStruct=[50,30,20];t.blindStruct=PRESETS.blind[0].levels.slice(2,14).map(l=>({...l}));t.blindStruct[3].brk=10;t.blindStruct[7].brk=10;return t}
function tById(id){return S.tournaments.find(t=>t.id===id)}
function selected(){return tById(UI.selectedId)||S.tournaments[0]||null}
function pById(id){return S.players.find(p=>p.id===id)}
function pName(id){const p=pById(id);return p?p.name:'—'}
function addPlayer(name){name=(name||'').trim();if(!name)return null;const ex=S.players.find(p=>p.name.toLowerCase()===name.toLowerCase());if(ex)return ex.id;const p={id:uid(),name,createdAt:Date.now()};S.players.push(p);putP(p);return p.id}
function sortedPlayers(){return S.players.slice().sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'))}

/* ---------- storage: local (one device) or shared db (many devices) ---------- */
function loadUI(){try{const o=JSON.parse(localStorage.getItem(UIKEY)||'null');if(o)UI=Object.assign(UI,o)}catch(e){}}
function saveUI(){try{localStorage.setItem(UIKEY,JSON.stringify(UI))}catch(e){}}
function loadLocal(){try{const raw=localStorage.getItem(KEY);if(raw){const o=JSON.parse(raw);if(o&&Array.isArray(o.tournaments))return o}}catch(e){}return null}
function saveLocal(){if(mode!=='local')return;try{localStorage.setItem(KEY,JSON.stringify({tournaments:S.tournaments,players:S.players,games:S.games,live:S.live,settings:S.settings}))}catch(e){}}
const chains={};
function dbWrite(path,fn){if(!DB)return;chains[path]=(chains[path]||Promise.resolve()).then(fn).catch(e=>{const code=e&&e.code;if(code==='invalid_argument'&&!canWriteKnown){canWrite=false;toast('Sem permissão para alterar os dados compartilhados.')}else if(code==='quota_exceeded')toast('Base cheia: exclua partidas antigas.');else toast('Não foi possível salvar: '+(e&&e.message||'erro'))})}
let canWriteKnown=false;
/* servidor próprio (server.js): REST + Server-Sent Events */
function srvFetch(method,path,body,isBlob){const h={'X-Admin-Pin':UI.pin||''};if(body!=null&&!isBlob)h['Content-Type']='application/json';return fetch(path,{method,headers:isBlob?Object.assign(h,{'Content-Type':body.type||'application/octet-stream'}):h,body:body==null?undefined:(isBlob?body:JSON.stringify(body)),cache:'no-store'})}
function srvWrite(key,method,path,body){chains[key]=(chains[key]||Promise.resolve()).then(async()=>{let r=await srvFetch(method,path,body);if(r.status===401){await askPin();r=await srvFetch(method,path,body)}if(r.status===401){toast('PIN incorreto: alteração não salva.');return}if(!r.ok)throw new Error('HTTP '+r.status)}).catch(e=>{toast('Não foi possível salvar no servidor: '+(e&&e.message||'erro'))})}
function askPin(){return new Promise(res=>{showDialog('Esta instalação pede um PIN para alterar os dados.',[{label:'Cancelar',fn(){dialog=null;render();res()}},{label:'Entrar',kind:'primary',fn(){UI.pin=document.getElementById('pinInput').value.trim();saveUI();dialog=null;render();res()}}],`<div class="field"><label for="pinInput">PIN</label><input id="pinInput" type="password" inputmode="numeric" autocomplete="current-password"></div>`,()=>{const i=document.getElementById('pinInput');if(i){i.focus();i.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();document.querySelector('.dialog .btn.primary').click()}})}})})}
function putT(t){const i=S.tournaments.findIndex(x=>x.id===t.id);if(i>=0)S.tournaments[i]=t;else S.tournaments.push(t);if(DB)dbWrite('t/'+t.id,()=>DB.collection('tournaments').doc(t.id).set(clone(t)));else if(SRV)srvWrite('t/'+t.id,'PUT','/api/tournaments/'+t.id,t);else saveLocal()}
function delT(id){S.tournaments=S.tournaments.filter(x=>x.id!==id);if(DB)dbWrite('t/'+id,()=>DB.collection('tournaments').doc(id).delete());else if(SRV)srvWrite('t/'+id,'DELETE','/api/tournaments/'+id);else saveLocal()}
function putP(p){const i=S.players.findIndex(x=>x.id===p.id);if(i>=0)S.players[i]=p;else S.players.push(p);if(DB)dbWrite('p/'+p.id,()=>DB.collection('players').doc(p.id).set(clone(p)));else if(SRV)srvWrite('p/'+p.id,'PUT','/api/players/'+p.id,p);else saveLocal()}
function delP(id){S.players=S.players.filter(x=>x.id!==id);if(DB)dbWrite('p/'+id,()=>DB.collection('players').doc(id).delete());else if(SRV)srvWrite('p/'+id,'DELETE','/api/players/'+id);else saveLocal()}
function putG(g){const i=S.games.findIndex(x=>x.id===g.id);if(i>=0)S.games[i]=g;else S.games.push(g);if(DB)dbWrite('g/'+g.id,()=>DB.collection('games').doc(g.id).set(clone(g)));else if(SRV)srvWrite('g/'+g.id,'PUT','/api/games/'+g.id,g);else saveLocal()}
function delG(id){S.games=S.games.filter(x=>x.id!==id);if(DB)dbWrite('g/'+id,()=>DB.collection('games').doc(id).delete());else if(SRV)srvWrite('g/'+id,'DELETE','/api/games/'+id);else saveLocal()}
function putLive(){if(DB)dbWrite('live',()=>S.live?DB.doc('live/current').set(clone(S.live)):DB.doc('live/current').delete());else if(SRV)srvWrite('live',S.live?'PUT':'DELETE','/api/live',S.live?S.live:null);else saveLocal()}
function putSettings(){if(DB)dbWrite('settings',()=>DB.doc('settings/app').set(clone(S.settings)));else if(SRV)srvWrite('settings','PUT','/api/settings',S.settings);else saveLocal()}
function applyServerState(o){S.tournaments=(o.tournaments||[]).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));S.players=o.players||[];S.games=o.games||[];S.tournaments.forEach(t=>{if(!t.scoring)t.scoring=defaultScoring()});if(o.settings&&Object.keys(o.settings).length)S.settings=Object.assign({},S.settings,o.settings);pinRequired=!!o.pinRequired;srvPersistent=o.persistent!==false;const l=o.live||null;if(l){if(!l.roster)l.roster=[];if(!l.elims)l.elims=[]}if(ready)applyLive(l);else S.live=l;srvRev=o.rev||0}
let srvRev=0,es=null;
function srvRefresh(){return fetch('/api/state',{cache:'no-store'}).then(r=>r.json()).then(o=>{applyServerState(o);requestRender()}).catch(()=>{})}
function openEvents(){if(es)es.close();es=new EventSource('/api/events');es.onmessage=ev=>{let e;try{e=JSON.parse(ev.data)}catch(x){return}if(e.kind==='hello'){if(e.rev!==srvRev)srvRefresh();return}srvRev=e.rev;if(e.col==='live'){const l=e.kind==='set'?e.data:null;if(l){if(!l.roster)l.roster=[];if(!l.elims)l.elims=[]}applyLive(l);return}if(e.col==='settings'){const ns=Object.assign({},S.settings,e.data||{});if(JSON.stringify(ns)===JSON.stringify(S.settings))return;S.settings=ns;requestRender();return}const arr=S[e.col];if(!arr)return;const i=arr.findIndex(x=>x.id===e.id);if(e.kind==='set'&&i>=0&&JSON.stringify(arr[i])===JSON.stringify(e.data))return;if(e.kind==='del'&&i<0)return;if(e.kind==='set'){if(!e.data.scoring&&e.col==='tournaments')e.data.scoring=defaultScoring();if(i>=0)arr[i]=e.data;else arr.push(e.data);if(e.col==='tournaments')arr.sort((a,b)=>(a.createdAt||0)-(b.createdAt||0))}else if(i>=0)arr.splice(i,1);if(!(e.col==='games'&&view==='close'))requestRender()};es.onerror=()=>{}}
async function probeServer(){if(!/^https?:$/.test(location.protocol))return null;try{const c=new AbortController();const t=setTimeout(()=>c.abort(),4000);const r=await fetch('/api/state',{cache:'no-store',signal:c.signal});clearTimeout(t);if(!r.ok)return null;const o=await r.json();return o&&Array.isArray(o.tournaments)?o:null}catch(e){return null}}
function toast(msg){let el=document.getElementById('toast');if(!el){el=document.createElement('div');el.id='toast';el.className='toast';document.body.appendChild(el)}el.textContent=msg;el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.hidden=true},3500)}
function markReady(){if(ready)return;if(mode==='shared'&&!(firstSnap.t&&firstSnap.p&&firstSnap.g&&firstSnap.l&&firstSnap.s))return;ready=true;if(S.live&&view==='home'&&location.hash!=='#tv')view='clock';requestRender()}
function applyLive(l){const prev=S.live;S.live=l;if(l&&(!prev||prev.tid!==l.tid))lastPhaseKey=null;if(view==='clock'||view==='tv'){const sig=l?[l.tid,l.roster.join(','),l.elims.length,l.dealer,l.running].join('|'):'none';if(sig!==liveSig){liveSig=sig;requestRender()}else updateClockFields()}else if(l&&!prev&&ready&&!dialog&&view==='home'){view='clock';requestRender()}else if(!l&&prev&&(view==='close'))requestRender();else requestRender();syncWake()}
let liveSig='';
function subscribeAll(){const err=e=>{if(e&&e.code==='revoked'){toast('Conexão com os dados compartilhados encerrada.')}};
  DB.collection('tournaments').onSnapshot(s=>{S.tournaments=s.docs.map(d=>d.data()).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));firstSnap.t=true;markReady();if(ready&&view!=='edit')requestRender()},err);
  DB.collection('players').onSnapshot(s=>{S.players=s.docs.map(d=>d.data());firstSnap.p=true;markReady();if(ready)requestRender()},err);
  DB.collection('games').onSnapshot(s=>{S.games=s.docs.map(d=>d.data());firstSnap.g=true;markReady();if(ready&&view!=='close')requestRender()},err);
  DB.doc('settings/app').onSnapshot(s=>{if(s.exists)S.settings=Object.assign({},S.settings,s.data());firstSnap.s=true;markReady();if(ready)requestRender()},err);
  DB.doc('live/current').onSnapshot(s=>{const l=s.exists?s.data():null;firstSnap.l=true;const was=ready;markReady();if(was)applyLive(l);else S.live=l},err)}
async function initStore(){loadUI();const use=window.claude&&window.claude.use;if(use){try{DB=await window.claude.use('db')}catch(e){DB=null}}
  if(DB){mode='shared';subscribeAll();window.claude.use('assets').then(a=>{ASSETS=a;if(dialog&&dialog.league)render()}).catch(()=>{});window.claude.use('user').then(u=>{USER=u;if(u){u.can('data.write').then(v=>{if(v===false){canWrite=false;canWriteKnown=true;requestRender()}else if(v===true){canWriteKnown=true}}).catch(()=>{})}}).catch(()=>{});setTimeout(()=>{if(!ready){toast('Os dados compartilhados estão demorando a carregar…')}},8000)}
  else if(!use&&(await probeServer().then(o=>{if(!o)return false;mode='server';SRV=true;applyServerState(o);ready=true;if(S.live&&location.hash!=='#tv')view='clock';render();syncWake();openEvents();return true}))){/* servidor próprio */}
  else{const saved=loadLocal();if(saved){S.tournaments=saved.tournaments||[];S.players=saved.players||[];S.games=saved.games||[];S.live=saved.live||null;if(saved.settings)S.settings=Object.assign(S.settings,saved.settings);S.tournaments.forEach(t=>{if(!t.scoring)t.scoring=defaultScoring()});if(S.live){if(!tById(S.live.tid))S.live=null;else{if(!S.live.roster)S.live.roster=[];if(!S.live.elims)S.live.elims=[]}}}else{const t=seed();S.tournaments=[t];UI.selectedId=t.id;saveLocal()}ready=true;if(S.live&&location.hash!=='#tv')view='clock';render();syncWake()}}
function localBackup(){if(mode==='local')return null;const o=loadLocal();return o&&o.tournaments&&o.tournaments.length?o:null}

/* ---------- tournament math (same rules as the original clock) ---------- */
function schedule(t){let acc=0;return t.blindStruct.map((l,i)=>{const start=acc,playEnd=start+(+l.time||0)*60,end=playEnd+(+l.brk||0)*60;acc=end;return{i,start,playEnd,end,l}})}
function phaseAt(t,time){const sc=schedule(t);if(!sc.length)return null;for(const s of sc){if(time<s.end){if(time<s.playEnd)return{level:s.i,kind:'play',remaining:s.playEnd-time,start:s.start,len:s.playEnd-s.start,sched:sc};return{level:s.i,kind:'break',remaining:s.end-time,start:s.playEnd,len:s.end-s.playEnd,sched:sc}}}const last=sc[sc.length-1];return{level:sc.length-1,kind:'overtime',remaining:0,over:time-last.end,start:last.end,len:0,sched:sc}}
function nextBreak(t,time){for(const s of schedule(t)){if(s.l.brk>0&&s.playEnd>time)return{inSecs:s.playEnd-time,mins:+s.l.brk,level:s.i}}return null}
function totalCash(t,live){let c=(+t.numPlayers||0)*(+t.buyInCost||0);if(t.addCashEnabled)c+=(+t.addCash||0);if(t.reBuyEnabled)c+=live.reBuys*(+t.reBuyCost||0);if(t.addOnEnabled)c+=live.addOns*(+t.addOnCost||0);return c}
function totalChips(t,live){let c=(+t.numPlayers||0)*(+t.buyInChips||0);if(t.reBuyEnabled)c+=live.reBuys*(+t.reBuyChips||0);if(t.addOnEnabled)c+=live.addOns*(+t.addOnChips||0);return c}
function prizes(t,live){const tot=totalCash(t,live),out=[];let lastNZ=-1;const n=Math.min(t.winStruct.length,+t.numPlayers||0);for(let i=0;i<n;i++){const p=+t.winStruct[i]||0;out.push(Math.floor(tot*p/100));if(p)lastNZ=i}return out.slice(0,lastNZ+1)}
function totalPct(ws){return Math.round(ws.reduce((a,b)=>a+(+b||0),0)*100)/100}
function evenOut(ws){if(ws.length<1)return ws;if(ws.length===1)return[100];let tot=ws.reduce((a,b)=>a+(+b||0),0)||1;let r=ws.map(v=>Math.round((+v||0)*100/tot));let i=0;while(r.reduce((a,b)=>a+b,0)>100){r[r.length-1-i]--;i=(i+1)%r.length}i=0;while(r.reduce((a,b)=>a+b,0)<100){r[i]++;i=(i+1)%r.length}return r}
function pointsFor(scoring,pos,kos){const sc=scoring||defaultScoring();return(pos>0&&sc.pos[pos-1]!=null?+sc.pos[pos-1]:0)+(+sc.base||0)+(+sc.ko||0)*(kos||0)}
/* live time is anchored to a wall-clock moment, so every device derives the same value without periodic writes */
function curTime(L){if(!L)return 0;return L.running&&L.lastTick?L.time+Math.max(0,Math.floor((Date.now()-L.lastTick)/1000)):L.time}

/* ---------- formatting ---------- */
function pad(n){return (n<10?'0':'')+n}
function fmtClock(s){s=Math.max(0,Math.round(s));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return h?h+':'+pad(m)+':'+pad(x):pad(m)+':'+pad(x)}
function fmtLong(s){s=Math.max(0,Math.round(s));return Math.floor(s/3600)+':'+pad(Math.floor(s%3600/60))+':'+pad(s%60)}
function fmtN(n){return (+n||0).toLocaleString('pt-BR')}
function fmtDate(iso){if(!iso)return '';const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(iso);return m?m[3]+'/'+m[2]+'/'+m[1]:iso}
function money(t,n){return (t.currency?t.currency+' ':'')+fmtN(n)}
function ord(i){return i+'º'}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function cardsHtml(s){return esc(s||'').replace(/([♥♦])/g,'<span class="red">$1</span>')}

/* ---------- audio (synthesized, no files) ---------- */
let AC=null;
function ac(){if(!AC){try{AC=new (window.AudioContext||window.webkitAudioContext)()}catch(e){}}if(AC&&AC.state==='suspended'){AC.resume().catch(()=>{})}return AC}
function tone(freq,dur,at,gain){const c=ac();if(!c)return;const o=c.createOscillator(),g=c.createGain();o.type='triangle';o.frequency.value=freq;g.gain.setValueAtTime(0.0001,c.currentTime+at);g.gain.exponentialRampToValueAtTime(gain||0.5,c.currentTime+at+0.01);g.gain.exponentialRampToValueAtTime(0.0001,c.currentTime+at+dur);o.connect(g);g.connect(c.destination);o.start(c.currentTime+at);o.stop(c.currentTime+at+dur+0.05)}
const SFX={oneMinute(){tone(880,.18,0);tone(1174,.3,.2)},tick(){tone(1000,.09,0,.35)},change(){tone(659,.18,0);tone(880,.18,.2);tone(1318,.5,.4)}}
function sfx(name){if(UI.sound&&!!AC)SFX[name]()}
document.addEventListener('pointerdown',()=>{ac()},{capture:true});
document.addEventListener('keydown',()=>{ac()},{capture:true});

/* ---------- live clock ---------- */
function startClock(t,roster,dealer){if(roster&&roster.length){t.numPlayers=roster.length;putT(t)}S.live={tid:t.id,time:0,running:false,lastTick:null,players:+t.numPlayers||1,reBuys:0,addOns:0,roster:roster||[],dealer:dealer||'',elims:[],date:today(),startedAt:Date.now()};UI.selectedId=t.id;saveUI();lastPhaseKey=null;prep=null;putLive();view='clock';render()}
function togglePlay(){const L=S.live;if(!L)return;if(L.running){L.time=curTime(L);L.running=false;L.lastTick=null}else{L.running=true;L.lastTick=Date.now()}putLive();syncWake();render()}
function setTime(sec){const L=S.live;L.time=Math.max(0,Math.round(sec));L.lastTick=L.running?Date.now():null;putLive()}
let lastShown=-1;
function tick(){const L=S.live;if(!L||(view!=='clock'&&view!=='tv'))return;const t=tById(L.tid);if(!t)return;const now=curTime(L);if(now!==lastShown){const ph=phaseAt(t,now);if(ph){const key=ph.level+':'+ph.kind;if(lastPhaseKey!==null&&key!==lastPhaseKey&&L.running)sfx('change');lastPhaseKey=key;if(L.running&&ph.kind!=='overtime'&&lastShown>=0){if(ph.remaining===60)sfx('oneMinute');else if(ph.remaining>=1&&ph.remaining<=5)sfx('tick')}}lastShown=now}updateClockFields()}
setInterval(tick,250);
function syncWake(){const want=!!(S.live&&S.live.running&&(view==='clock'||view==='tv'));if(want&&!wakeLock&&navigator.wakeLock){navigator.wakeLock.request('screen').then(w=>{wakeLock=w;w.addEventListener('release',()=>{wakeLock=null})}).catch(()=>{})}else if(!want&&wakeLock){wakeLock.release().catch(()=>{});wakeLock=null}}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')syncWake()});
function alive(L){const dead=new Set(L.elims.map(e=>e.pid));return L.roster.filter(p=>!dead.has(p))}

/* ---------- actions: tournaments ---------- */
function showDialog(msg,btns,extraHtml,onOpen,extra){dialog=Object.assign({msg,btns,extraHtml,onOpen},extra||{});render()}
function closeDialog(){dialog=null;render()}
function go(v){view=v;helpOpen=false;if(v==='tv'){if(location.hash!=='#tv')location.hash='tv'}else if(location.hash==='#tv'){history.replaceState(null,'',location.pathname+location.search)}render()}
function createT(){draft=newTournament(uniqueName('Novo torneio'));draft._new=true;editTab='settings';view='edit';render()}
function copyT(){const t=selected();if(!t)return;const c=clone(t);c.id=uid();c.createdAt=Date.now();c.name=uniqueName('Cópia de '+t.name);putT(c);UI.selectedId=c.id;saveUI();render()}
function editT(tab){const t=selected();if(!t)return;draft=clone(t);if(!draft.scoring)draft.scoring=defaultScoring();editTab=typeof tab==='string'?tab:'settings';view='edit';render()}
function deleteT(){const t=selected();if(!t)return;showDialog('Excluir o torneio "'+t.name+'"? As partidas já salvas continuam no histórico.',[{label:'Cancelar',fn:closeDialog},{label:'Excluir',kind:'danger',fn(){delT(t.id);if(S.live&&S.live.tid===t.id){S.live=null;putLive()}UI.selectedId=(S.tournaments[0]||{}).id||null;saveUI();closeDialog()}}])}
function startT(){const t=selected();if(!t)return;if(totalPct(t.winStruct)>100){showDialog('Não dá para iniciar: a premiação soma mais de 100%. Reduza as porcentagens em Configurações.',[{label:'Ok',fn:closeDialog}]);return}if(!t.blindStruct.length){showDialog('Não dá para iniciar: crie pelo menos um round na estrutura de blinds.',[{label:'Ok',fn:closeDialog}]);return}if(S.live&&S.live.tid!==t.id){showDialog('Já existe uma partida em andamento ("'+(tById(S.live.tid)||{}).name+'"). Descartar a atual e preparar esta?',[{label:'Cancelar',fn:closeDialog},{label:'Descartar e continuar',kind:'danger',fn(){S.live=null;putLive();dialog=null;openPrep(t)}}]);return}dialog=null;openPrep(t)}
function openPrep(t){const last=S.games.filter(g=>g.tid===t.id).sort((a,b)=>(b.date||'').localeCompare(a.date||''))[0];prep={tid:t.id,roster:last?last.results.map(r=>r.pid).filter(pid=>pById(pid)):[],dealer:'',newName:''};view='prep';render()}
function endT(){const L=S.live;if(!L)return;showDialog('Encerrar o relógio e fechar a partida? Você vai conferir colocações, prêmios e pontos antes de salvar.',[{label:'Não',fn:closeDialog},{label:'Sim, fechar partida',kind:'primary',fn(){dialog=null;if(L.running){L.time=curTime(L);L.running=false;L.lastTick=null;putLive()}openClose()}}])}
function saveDraft(){const d=draft;d.numPlayers=Math.max(1,Math.round(+d.numPlayers||1));d.winStruct=d.winStruct.map(v=>Math.max(0,+v||0));d.blindStruct=d.blindStruct.map(l=>({sb:+l.sb||0,bb:+l.bb||0,ante:+l.ante||0,time:Math.max(0,+l.time||0),brk:Math.max(0,+l.brk||0)}));d.reBuyLevel=Math.min(Math.max(1,Math.round(+d.reBuyLevel||1)),Math.max(1,d.blindStruct.length));delete d.scoring._cleared;d.scoring.pos=d.scoring.pos.map(v=>+v||0);d.scoring.base=+d.scoring.base||0;d.scoring.ko=+d.scoring.ko||0;if(!d.name.trim())d.name='Sem nome';const tot=totalPct(d.winStruct);if(d.winStruct.length&&tot!==100){showDialog('A premiação soma '+fmtN(tot)+'% e não 100%. Quer que eu ajuste proporcionalmente para fechar em 100%?',[{label:'Voltar',fn:closeDialog},{label:'Salvar assim mesmo',fn(){dialog=null;commitDraft()}},{label:'Ajustar e salvar',kind:'primary',fn(){draft.winStruct=evenOut(draft.winStruct);dialog=null;commitDraft()}}]);return}commitDraft()}
function commitDraft(){const d=draft;delete d._new;putT(d);UI.selectedId=d.id;saveUI();if(S.live&&S.live.tid===d.id){S.live.players=Math.min(S.live.players,d.numPlayers);putLive()}draft=null;view=(S.live&&S.live.tid===d.id)?'clock':'home';render()}
function cancelDraft(){const orig=tById(draft.id);const changed=draft._new?true:JSON.stringify(orig)!==JSON.stringify(draft);const back=()=>{dialog=null;draft=null;view=(S.live&&orig&&S.live.tid===orig.id)?'clock':'home';render()};if(!changed){back();return}showDialog('As alterações no torneio serão perdidas. Descartar?',[{label:'Continuar editando',fn:closeDialog},{label:'Descartar',kind:'danger',fn:back}])}

/* ---------- actions: game close / history ---------- */
function buildGameFromLive(){const L=S.live,t=tById(L.tid);const time=curTime(L);const ph=phaseAt(t,time);const pz=prizes(t,L);const n=L.roster.length;const results=L.roster.map(pid=>({pid,name:pName(pid),pos:0,koBy:null,rank:'',cards:'',prize:0,points:0}));L.elims.forEach((e,i)=>{const r=results.find(x=>x.pid===e.pid);if(r){r.pos=n-i;r.koBy=e.byPid||null;r.rank=e.rank||'';r.cards=e.cards||''}});const al=results.filter(r=>!r.pos);if(al.length===1)al[0].pos=1;const g={id:uid(),date:L.date||today(),tid:t.id,tournamentName:t.name,currency:t.currency,dealer:L.dealer||'',entries:+t.numPlayers,reBuys:t.reBuyEnabled?L.reBuys:null,addOns:t.addOnEnabled?L.addOns:null,total:totalCash(t,L),levels:(ph?ph.level:0)+1,time,scoring:clone(t.scoring||defaultScoring()),prizeTable:pz,results,finalHand:{rank:'',cards:''},_fromLive:true};recalc(g);return g}
function recalc(g){g.results.forEach(r=>{const kos=g.results.filter(x=>x.koBy===r.pid).length;r.points=pointsFor(g.scoring,r.pos,kos);if(r.pos>0)r.prize=g.prizeTable[r.pos-1]||0;else r.prize=0})}
function openClose(){closing=buildGameFromLive();view='close';render()}
function editGame(id){const g=S.games.find(x=>x.id===id);if(!g)return;closing=clone(g);closing._edit=true;view='close';render()}
function validateClose(g){const errs=[];const used={};g.results.forEach(r=>{if(!r.name.trim())errs.push('Há um jogador sem nome.');if(!r.pos)errs.push(r.name+' está sem colocação.');else if(used[r.pos])errs.push('Colocação '+ord(r.pos)+' repetida ('+used[r.pos]+' e '+r.name+').');else used[r.pos]=r.name});return errs}
function saveClose(){const g=closing;g.results.forEach(r=>{r.name=r.name.trim();if(!r.pid||!pById(r.pid)||pName(r.pid)!==r.name)r.pid=addPlayer(r.name)||r.pid});const errs=validateClose(g);if(errs.length){showDialog('Ainda não dá para salvar:\n'+errs.slice(0,6).join('\n'),[{label:'Ok',fn:closeDialog}]);return}const w=g.results.find(r=>r.pos===1);g.finalHand.winnerPid=w?w.pid:null;delete g._fromLive;const wasEdit=g._edit;delete g._edit;g.savedAt=Date.now();putG(g);if(!wasEdit){S.live=null;putLive();syncWake()}closing=null;gameId=g.id;view='game';render()}
function discardLive(){showDialog('Descartar a partida sem salvar no histórico?',[{label:'Voltar',fn:closeDialog},{label:'Descartar',kind:'danger',fn(){S.live=null;putLive();closing=null;dialog=null;syncWake();go('home')}}])}
function deleteGame(id){const g=S.games.find(x=>x.id===id);if(!g)return;showDialog('Excluir a partida de '+fmtDate(g.date)+' ("'+g.tournamentName+'") do histórico?',[{label:'Cancelar',fn:closeDialog},{label:'Excluir',kind:'danger',fn(){delG(id);dialog=null;go('games')}}])}

/* ---------- ranking ---------- */
function ranking(filterName){const map={};const games=S.games.filter(g=>!filterName||g.tournamentName===filterName);games.forEach(g=>{g.results.forEach(r=>{const k=r.pid||('n:'+r.name.toLowerCase());const m=map[k]||(map[k]={pid:r.pid,name:r.name,points:0,games:0,wins:0,podiums:0,kos:0,prize:0,best:null,cur:''});m.name=r.pid&&pById(r.pid)?pName(r.pid):r.name;m.points+=+r.points||0;m.games++;if(r.pos===1)m.wins++;if(r.pos>=1&&r.pos<=3)m.podiums++;m.kos+=g.results.filter(x=>x.koBy===r.pid&&r.pid).length;m.prize+=+r.prize||0;m.cur=g.currency||m.cur;if(r.pos&&(m.best==null||r.pos<m.best))m.best=r.pos})});return Object.values(map).sort((a,b)=>b.points-a.points||b.wins-a.wins||b.prize-a.prize||a.name.localeCompare(b.name,'pt-BR'))}

/* ---------- rendering helpers ---------- */
function requestRender(){const ae=document.activeElement;const typing=ae&&/INPUT|TEXTAREA|SELECT/.test(ae.tagName)&&ae.type!=='range';if(dialog||typing||(view==='edit')||(view==='close')||(view==='prep')){pendingRender=true;return}render()}
let pointerDown=false;
function flushRender(){if(pendingRender&&!dialog&&!pointerDown&&!(document.activeElement&&/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)&&document.activeElement.type!=='range'))render()}
document.addEventListener('pointerdown',()=>{pointerDown=true},{capture:true});
document.addEventListener('pointerup',()=>{pointerDown=false;if(pendingRender)setTimeout(flushRender,0)},{capture:true});
document.addEventListener('pointercancel',()=>{pointerDown=false},{capture:true});
document.addEventListener('focusout',()=>{if(pendingRender&&!dialog)setTimeout(flushRender,80)});
function render(){pendingRender=false;app.innerHTML='';let el;switch(view){case 'edit':el=draft?viewEdit():viewHome();break;case 'prep':el=prep&&tById(prep.tid)?viewPrep():viewHome();break;case 'clock':el=(S.live&&tById(S.live.tid))?viewClock(false):viewHome();break;case 'tv':el=viewTV();break;case 'close':el=closing?viewClose():viewHome();break;case 'game':el=S.games.find(g=>g.id===gameId)?viewGame():viewGames();break;case 'games':el=viewGames();break;case 'players':el=viewPlayers();break;case 'ranking':el=viewRanking();break;default:view='home';el=viewHome()}app.appendChild(el);if(dialog){app.appendChild(viewDialog());if(dialog.onOpen)dialog.onOpen()}if(view==='clock'||view==='tv'){liveSig=S.live?[S.live.tid,S.live.roster.join(','),S.live.elims.length,S.live.dealer,S.live.running].join('|'):'none';updateClockFields()}}
function h(html){const t=document.createElement('template');t.innerHTML=html.trim();return t.content.firstElementChild}
function on(root,sel,ev,fn){root.querySelectorAll(sel).forEach(e=>e.addEventListener(ev,fn))}
function logoHtml(cls){const s=S.settings;return s.logoUrl?`<img class="${cls||''}" src="${esc(s.logoUrl)}" alt="${esc(s.leagueName)}">`:`<div class="mono" aria-hidden="true">${esc((s.leagueName||'PB').split(/\s+/).filter(w=>/^[A-Za-z0-9]/.test(w)).map(w=>w[0]).join('').slice(0,3).toUpperCase()||'PB')}</div>`}
function navHtml(active){const L=S.live;const items=[['home','Torneios'],['players','Jogadores'],['games','Partidas'],['ranking','Ranking']];return `<div class="row spread"><div class="brand">${logoHtml()}<div><div class="eyebrow">${esc(S.settings.motto||'')}&nbsp;</div><h1>${esc(S.settings.leagueName||DEFAULT_LEAGUE)}</h1><div class="mode ${mode==='shared'?'on':''}">${mode==='shared'?(ready?'Dados compartilhados · em tempo real':'Conectando aos dados compartilhados…'):mode==='server'?'Dados no servidor · em tempo real':'Dados só neste navegador'}</div></div></div><div class="row">${L?`<button class="btn primary" data-go="clock">▶ Partida em andamento</button>`:''}<button class="btn ghost" data-go="tv">Modo TV</button><button class="btn ghost" id="btnLeague">Liga</button><button class="btn ghost" id="btnHelp">Ajuda</button><button class="btn ghost" id="btnData">Exportar / importar</button></div></div><nav class="nav">${items.map(([v,l])=>`<button data-go="${v}" class="${active===v?'on':''}">${l}</button>`).join('')}</nav>${migrateHtml()}${SRV&&!srvPersistent?'<div class="banner" style="border-color:var(--danger)"><span><b>Atenção:</b> o servidor está rodando sem volume persistente em /data. Tudo que for salvo some no próximo deploy. No Coolify, adicione um Persistent Storage montado em <code>/data</code>.</span><a class="btn small" href="/api/backup" download>Baixar backup agora</a></div>':''}${canWrite?'':'<div class="banner"><span>Você está vendo os dados compartilhados em modo somente leitura.</span></div>'}`}
function migrateHtml(){const b=localBackup();if(!b||UI.migrateIgnored||!ready||S.tournaments.length||S.games.length)return '';return `<div class="banner"><span>Encontrei ${b.tournaments.length} torneio(s)${(b.games||[]).length?', '+(b.games||[]).length+' partida(s)':''} salvos só neste navegador pela versão anterior.</span><span class="row"><button class="btn small" id="migIgnore">Ignorar</button><button class="btn small primary" id="migDo">Importar para a base compartilhada</button></span></div>`}
function bindNav(root){on(root,'[data-go]','click',e=>go(e.currentTarget.dataset.go));on(root,'#btnHelp','click',()=>{helpOpen=!helpOpen;render()});on(root,'#btnData','click',dataDialog);on(root,'#btnLeague','click',leagueDialog);on(root,'#migIgnore','click',()=>{UI.migrateIgnored=true;saveUI();render()});on(root,'#migDo','click',()=>{const b=localBackup();if(!b)return;importData(b);toast('Dados importados para a base compartilhada.')})}
function playerOptions(sel,ids,emptyLabel){return (emptyLabel!=null?`<option value="">${esc(emptyLabel)}</option>`:'')+ids.map(id=>`<option value="${id}" ${id===sel?'selected':''}>${esc(pName(id))}</option>`).join('')}
function rankOptions(sel){return `<option value="">—</option>`+HANDS.map(x=>`<option ${x===sel?'selected':''}>${x}</option>`).join('')}
function suitsHtml(target){return `<span class="suits">${['♠','♥','♦','♣'].map(s=>`<button type="button" data-suit="${s}" data-target="${target}" class="${s==='♥'||s==='♦'?'red':''}" aria-label="Inserir ${s}">${s}</button>`).join('')}</span>`}
function bindSuits(root){on(root,'[data-suit]','click',e=>{const inp=root.querySelector('#'+e.currentTarget.dataset.target)||document.getElementById(e.currentTarget.dataset.target);if(!inp)return;const s=e.currentTarget.dataset.suit;const st=inp.selectionStart==null?inp.value.length:inp.selectionStart;inp.value=inp.value.slice(0,st)+s+inp.value.slice(inp.selectionEnd==null?st:inp.selectionEnd);inp.dispatchEvent(new Event('input',{bubbles:true}));inp.focus()})}

/* ---------- league settings (name, motto, logo) ---------- */
function leagueDialog(){const s=S.settings;const canUpload=mode==='local'||SRV||!!ASSETS;showDialog('Identidade da liga',[{label:'Fechar',fn:closeDialog},{label:'Salvar',kind:'primary',fn(){s.leagueName=document.getElementById('lgName').value.trim()||DEFAULT_LEAGUE;s.motto=document.getElementById('lgMotto').value.trim();putSettings();dialog=null;render()}}],`<div class="fgrid"><div class="field"><label for="lgName">Nome</label><input id="lgName" type="text" value="${esc(s.leagueName)}" maxlength="60"></div><div class="field"><label for="lgMotto">Lema</label><input id="lgMotto" type="text" value="${esc(s.motto||'')}" maxlength="60"></div><div class="field"><label>Logo</label><div class="row">${logoHtml()}${canUpload?`<input id="lgFile" type="file" accept="image/*" style="max-width:220px">`:'<span class="note">Só o editor do artefato pode trocar o logo.</span>'}${s.logoUrl?`<button class="btn small" id="lgRemove">Remover</button>`:''}</div><span class="note">PNG ou SVG com fundo transparente fica melhor. A imagem é reduzida para no máximo 600 px.</span></div></div>`,()=>{const f=document.getElementById('lgFile');if(f)f.addEventListener('change',()=>{const file=f.files&&f.files[0];if(file)setLogo(file)});const r=document.getElementById('lgRemove');if(r)r.addEventListener('click',()=>{const old=S.settings.logoId;S.settings.logoUrl='';S.settings.logoId='';if(SRV){srvWrite('logo','DELETE','/api/logo')}else{putSettings();if(ASSETS&&old)ASSETS.delete(old).catch(()=>{})}leagueDialog()})},{league:true})}
function shrinkImage(file){return new Promise((res,rej)=>{if(file.type==='image/svg+xml'){res(file);return}const img=new Image();const url=URL.createObjectURL(file);img.onload=()=>{const max=600;let w=img.naturalWidth,hh=img.naturalHeight;const k=Math.min(1,max/Math.max(w,hh));w=Math.round(w*k);hh=Math.round(hh*k);const c=document.createElement('canvas');c.width=w;c.height=hh;c.getContext('2d').drawImage(img,0,0,w,hh);URL.revokeObjectURL(url);c.toBlob(b=>b?res(b):rej(new Error('canvas')),'image/png')};img.onerror=()=>{URL.revokeObjectURL(url);rej(new Error('img'))};img.src=url})}
async function setLogo(file){try{const blob=await shrinkImage(file);if(SRV){let r=await srvFetch('POST','/api/logo',blob,true);if(r.status===401){await askPin();r=await srvFetch('POST','/api/logo',blob,true)}if(!r.ok)throw new Error('HTTP '+r.status);const o=await r.json();S.settings.logoUrl=o.url;S.settings.logoId='server'}else if(ASSETS){const r=await ASSETS.upload(blob);const old=S.settings.logoId;S.settings.logoUrl=r.url;S.settings.logoId=r.id;putSettings();if(old&&old!==r.id)ASSETS.delete(old).catch(()=>{})}else{const dataUrl=await new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.onerror=rej;fr.readAsDataURL(blob)});S.settings.logoUrl=dataUrl;S.settings.logoId='';putSettings()}toast('Logo atualizado.');leagueDialog()}catch(e){toast('Não consegui usar essa imagem: '+(e&&e.message||'erro'))}}

/* ---------- home ---------- */
function viewHome(){const t=selected();const L=S.live;const root=h(`<div class="page">
  ${navHtml('home')}
  <div class="home">
    <section class="panel" style="display:flex;flex-direction:column;gap:12px">
      <div class="row spread"><h2>Torneios</h2><span class="note">${ready?S.tournaments.length+' salvo'+(S.tournaments.length===1?'':'s'):'carregando…'}</span></div>
      ${S.tournaments.length?`<ul class="tlist">${S.tournaments.map(x=>`<li><button data-id="${x.id}" class="${t&&x.id===t.id?'sel':''}"><span class="nm">${esc(x.name)}${L&&L.tid===x.id?' <span class="chip on">em andamento</span>':''}</span><span class="meta num">${x.numPlayers} jog. · ${x.blindStruct.length} rounds</span></button></li>`).join('')}</ul>`:ready?`<p class="muted">Nenhum torneio ainda. Clique em <b>Criar</b> para montar o primeiro: buy-in, blinds, premiação e pontuação.</p>`:'<p class="muted">Carregando os torneios…</p>'}
      <div class="toolbar">
        <button class="btn primary" id="btnCreate" ${canWrite?'':'disabled'}>Criar</button>
        <button class="btn" id="btnCopy" ${t&&canWrite?'':'disabled'}>Copiar</button>
        <button class="btn" id="btnEdit" ${t&&canWrite?'':'disabled'}>Editar</button>
        <button class="btn" id="btnBlinds" ${t&&canWrite?'':'disabled'}>Blinds por round</button>
        <button class="btn danger" id="btnDelete" ${t&&canWrite?'':'disabled'}>Excluir</button>
      </div>
    </section>
    <section class="panel" style="display:flex;flex-direction:column;gap:14px">
      ${t?summaryHtml(t):'<p class="muted">Selecione um torneio para ver o resumo.</p>'}
      ${t?`<button class="btn primary" id="btnStart" style="align-self:flex-start;font-size:18px" ${canWrite||(L&&L.tid===t.id)?'':'disabled'}>${L&&L.tid===t.id?'Abrir relógio':'Iniciar partida'}</button>`:''}
    </section>
  </div>
  ${helpOpen?helpHtml():''}
</div>`);
  bindNav(root);
  on(root,'.tlist button','click',e=>{UI.selectedId=e.currentTarget.dataset.id;saveUI();render()});
  on(root,'#btnCreate','click',createT);on(root,'#btnCopy','click',copyT);on(root,'#btnEdit','click',()=>editT('settings'));on(root,'#btnBlinds','click',()=>editT('blinds'));on(root,'#btnDelete','click',deleteT);
  on(root,'#btnStart','click',()=>{if(L&&L.tid===t.id){go('clock')}else startT()});
  return root}

function summaryHtml(t){const sc=schedule(t);const total=sc.length?sc[sc.length-1].end:0;const breaks=t.blindStruct.filter(l=>l.brk>0).length;const first=t.blindStruct[0];const scg=t.scoring||defaultScoring();const played=S.games.filter(g=>g.tid===t.id).length;return `<div><div class="eyebrow">Resumo</div><h2>${esc(t.name)}</h2></div>
  <dl class="kv">
    <dt>Buy-in</dt><dd class="num">${money(t,t.buyInCost)} · ${fmtN(t.buyInChips)} fichas</dd>
    <dt>Re-buy</dt><dd class="num">${t.reBuyEnabled?money(t,t.reBuyCost)+' · '+fmtN(t.reBuyChips)+' fichas · até o round '+t.reBuyLevel:'não'}</dd>
    <dt>Add-on</dt><dd class="num">${t.addOnEnabled?money(t,t.addOnCost)+' · '+fmtN(t.addOnChips)+' fichas':'não'}</dd>
    <dt>Dinheiro extra</dt><dd class="num">${t.addCashEnabled?money(t,t.addCash):'não'}</dd>
    <dt>Jogadores</dt><dd class="num">${t.numPlayers}</dd>
    <dt>Blinds</dt><dd class="num">${t.blindStruct.length} rounds${first?', começa em '+fmtN(first.sb)+' / '+fmtN(first.bb):''}${breaks?', '+breaks+' intervalo'+(breaks>1?'s':''):''}</dd>
    <dt>Duração prevista</dt><dd class="num">${fmtLong(total)}</dd>
    <dt>Premiação</dt><dd class="num">${t.winStruct.length} posição${t.winStruct.length===1?'':'ões'} (${fmtN(totalPct(t.winStruct))}%)</dd>
    <dt>Pontuação</dt><dd class="num">${scg.pos.slice(0,5).join(' / ')}${scg.pos.length>5?' …':''} + ${scg.base} por partida + ${scg.ko} por eliminação</dd>
    <dt>Pote inicial</dt><dd class="num">${money(t,totalCash(t,{reBuys:0,addOns:0}))}</dd>
    <dt>Partidas salvas</dt><dd class="num">${played}</dd>
  </dl>`}

function helpHtml(){return `<section class="panel help">
  <h2 style="margin-bottom:10px">Como usar</h2>
  <p><b>TV e celular.</b> Abra este mesmo link na TV e clique em <b>Modo TV</b>: ela mostra só o placar. No celular, use a tela normal para dar play, pausar e registrar eliminações. Os dois aparelhos veem a mesma partida em tempo real${mode==='local'?' (neste navegador os dados estão locais; use o endereço do servidor ou o artefato logado para compartilhar)':''}.</p>
  <p><b>Torneios.</b> Um torneio é o formato: buy-in, blinds, premiação e pontuação. Crie, copie e edite quantos quiser.</p>
  <p><b>Partida.</b> Ao iniciar, escolha quem está jogando e quem é o dealer da rodada. A cada eliminação, clique em − em Jogadores e registre quem caiu, quem derrubou e com qual mão. Ao final, clique em Encerrar: você confere colocações, prêmios e pontos e salva a partida no histórico.</p>
  <p><b>Botões do relógio.</b></p>
  <ul>
    <li><b>Entradas</b>: jogadores que entraram. Com lista de jogadores, o + registra uma entrada tardia.</li>
    <li><b>Jogadores</b>: quem ainda está na mesa. O − registra a eliminação; o + desfaz a última.</li>
    <li><b>Re-buys</b> e <b>Add-ons</b>: clique em + a cada compra.</li>
    <li><b>Round − / +</b> e a <b>barra de tempo</b> ajustam o relógio. <kbd>Espaço</kbd> dá play e pausa.</li>
  </ul>
  <p><b>Pontuação.</b> Cada torneio tem pontos por colocação, por participação e por eliminação. Ajuste pontos e prêmios de cada jogador ao fechar a partida. O Ranking soma tudo que está no histórico.</p>
  <p><b>Sinais sonoros.</b> Um sinal a um minuto do fim do round, contagem nos últimos cinco segundos e um sinal na troca. O botão de som vale só para este aparelho.</p>
</section>`}

function importData(o){const list=Array.isArray(o)?o:(o.tournaments||[]);let n=0;list.forEach(x=>{if(!x||!x.name||!Array.isArray(x.blindStruct))return;const c=newTournament(uniqueName(x.name));Object.keys(c).forEach(k=>{if(k!=='id'&&k!=='createdAt'&&x[k]!==undefined)c[k]=x[k]});c.blindStruct=x.blindStruct.map(l=>({sb:+l.sb||+l.smallBlind||0,bb:+l.bb||+l.bigBlind||0,ante:+l.ante||0,time:+l.time||0,brk:+l.brk||+l.breakTime||0}));if(!c.scoring)c.scoring=defaultScoring();putT(c);n++});const pmap={};(o.players||[]).forEach(p=>{if(p&&p.name)pmap[p.id]=addPlayer(p.name)});let gn=0;(o.games||[]).forEach(g=>{if(!g||!Array.isArray(g.results))return;const c=clone(g);c.id=uid();c.results.forEach(r=>{r.pid=pmap[r.pid]||addPlayer(r.name)||null;if(r.koBy)r.koBy=pmap[r.koBy]||null});if(c.finalHand&&c.finalHand.winnerPid)c.finalHand.winnerPid=pmap[c.finalHand.winnerPid]||null;putG(c);gn++});if(o.settings&&o.settings.leagueName&&!S.settings.logoUrl){S.settings=Object.assign({},S.settings,{leagueName:o.settings.leagueName,motto:o.settings.motto||S.settings.motto});putSettings()}render();return{n,gn}}
function dataDialog(){const json=JSON.stringify({tournaments:S.tournaments,players:S.players,games:S.games,settings:{leagueName:S.settings.leagueName,motto:S.settings.motto}});showDialog('Copie o texto abaixo para guardar torneios, jogadores e partidas, ou cole um texto exportado para importar.',[{label:'Fechar',fn:closeDialog},{label:'Copiar',fn(){const ta=document.getElementById('dataTA');const p=navigator.clipboard&&navigator.clipboard.writeText?navigator.clipboard.writeText(ta.value):Promise.reject();p.then(()=>{ta.select()}).catch(()=>{ta.focus();ta.select()})}},{label:'Importar',kind:'primary',fn(){try{const o=JSON.parse(document.getElementById('dataTA').value);dialog=null;const r=importData(o);showDialog('Importado: '+r.n+' torneio(s), '+r.gn+' partida(s).',[{label:'Ok',fn:closeDialog}])}catch(e){showDialog('Não consegui ler esse texto. Cole exatamente o conteúdo exportado por este app.',[{label:'Ok',fn:dataDialog}])}}}],`<textarea id="dataTA" spellcheck="false">${esc(json)}</textarea>`)}

/* ---------- edit tournament ---------- */
function viewEdit(){const d=draft;const live=S.live&&S.live.tid===d.id;const root=h(`<div class="page">
  <div class="row spread">
    <div><div class="eyebrow">${d._new?'Novo torneio':live?'Editando torneio em andamento':'Editar torneio'}</div><h1>${esc(d.name)||'&nbsp;'}</h1></div>
    <div class="row"><button class="btn" id="btnCancel">Cancelar</button><button class="btn primary" id="btnSave">Salvar</button></div>
  </div>
  <div class="tabs"><button class="${editTab==='settings'?'on':''}" data-tab="settings">Configurações</button><button class="${editTab==='blinds'?'on':''}" data-tab="blinds">Estrutura de blinds</button><button class="${editTab==='scoring'?'on':''}" data-tab="scoring">Pontuação</button></div>
  ${editTab==='settings'?settingsHtml(d):editTab==='blinds'?blindsHtml(d):scoringHtml(d)}
</div>`);
  on(root,'#btnCancel','click',cancelDraft);on(root,'#btnSave','click',saveDraft);
  on(root,'.tabs button','click',e=>{editTab=e.currentTarget.dataset.tab;render()});
  if(editTab==='settings')bindSettings(root,d);else if(editTab==='blinds')bindBlinds(root,d);else bindScoring(root,d);
  return root}

function numInput(id,label,val,attrs){return `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="number" inputmode="decimal" value="${esc(val)}" ${attrs||''}></div>`}
function settingsHtml(d){const tot=totalPct(d.winStruct);return `<div style="display:grid;gap:20px">
  <section class="panel" style="display:grid;gap:14px">
    <h3>Torneio</h3>
    <div class="fgrid">
      <div class="field" style="grid-column:1/-1"><label for="fName">Título</label><input id="fName" type="text" value="${esc(d.name)}" maxlength="60"></div>
      ${numInput('fPlayers','Jogadores previstos',d.numPlayers,'min="1" step="1"')}
      <div class="field"><label for="fCur">Moeda</label><input id="fCur" type="text" value="${esc(d.currency)}" maxlength="4"></div>
    </div>
  </section>
  <section class="panel" style="display:grid;gap:14px">
    <h3>Buy-in, re-buy e add-on</h3>
    <div class="fgrid">${numInput('fBuyCost','Buy-in (valor)',d.buyInCost,'min="0"')}${numInput('fBuyChips','Buy-in (fichas)',d.buyInChips,'min="0"')}</div>
    <label class="check"><input type="checkbox" id="fRbOn" ${d.reBuyEnabled?'checked':''}> Permitir re-buy</label>
    <div class="sub ${d.reBuyEnabled?'':'off'}"><div class="fgrid">${numInput('fRbCost','Re-buy (valor)',d.reBuyCost,'min="0"')}${numInput('fRbChips','Re-buy (fichas)',d.reBuyChips,'min="0"')}${numInput('fRbLevel','Re-buy até o round',d.reBuyLevel,'min="1" step="1" max="'+Math.max(1,d.blindStruct.length)+'"')}</div></div>
    <label class="check"><input type="checkbox" id="fAoOn" ${d.addOnEnabled?'checked':''}> Permitir add-on</label>
    <div class="sub ${d.addOnEnabled?'':'off'}"><div class="fgrid">${numInput('fAoCost','Add-on (valor)',d.addOnCost,'min="0"')}${numInput('fAoChips','Add-on (fichas)',d.addOnChips,'min="0"')}</div></div>
    <label class="check"><input type="checkbox" id="fAcOn" ${d.addCashEnabled?'checked':''}> Dinheiro extra no pote (garantido, patrocínio)</label>
    <div class="sub ${d.addCashEnabled?'':'off'}"><div class="fgrid">${numInput('fAc','Valor extra',d.addCash,'min="0"')}</div></div>
  </section>
  <section class="panel" style="display:grid;gap:14px">
    <div class="row spread"><h3>Premiação</h3><span class="total ${tot===100?'ok':'bad'} num">Total ${fmtN(tot)}%</span></div>
    <p class="note" style="margin:0">Porcentagem do pote para cada colocação. Os presets escolhem a tabela pelo número de jogadores (${d.numPlayers}). O total precisa fechar em 100%. Na hora de fechar a partida você pode ajustar o prêmio de cada jogador.</p>
    <div class="toolbar">${PRESETS.win.map((p,i)=>`<button class="btn small" data-wpreset="${i}">Preset ${p.name}</button>`).join('')}<button class="btn small" id="wAdd" ${d.winStruct.length>=MAX_WIN?'disabled':''}>+ Posição</button><button class="btn small" id="wEven" ${d.winStruct.length?'':'disabled'}>Ajustar para 100%</button><button class="btn small" id="wClear" ${d.winStruct.length?'':'disabled'}>Limpar</button></div>
    ${d.winStruct.length?`<div class="twrap"><table><thead><tr><th>Colocação</th><th>% do pote</th><th>Prêmio estimado</th><th></th></tr></thead><tbody>${d.winStruct.map((p,i)=>`<tr><td>${ord(i+1)}</td><td><input type="number" inputmode="decimal" min="0" step="0.05" data-w="${i}" value="${esc(p)}"></td><td class="num">${money(d,Math.floor(totalCash(d,{reBuys:0,addOns:0})*(+p||0)/100))}</td><td><span class="rowbtns"><button data-wins="${i}" title="Inserir abaixo">+</button><button data-wdel="${i}" title="Excluir">×</button></span></td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">Nenhuma posição premiada.</p>'}
  </section>
</div>`}
function bindSettings(root,d){const num=(id,k,int)=>on(root,'#'+id,'input',e=>{d[k]=int?Math.round(+e.target.value||0):(+e.target.value||0)});
  on(root,'#fName','input',e=>{d.name=e.target.value;root.querySelector('h1').textContent=d.name||' '});
  on(root,'#fCur','input',e=>{d.currency=e.target.value});
  on(root,'#fPlayers','change',e=>{d.numPlayers=Math.max(1,Math.round(+e.target.value||1));render()});
  num('fBuyCost','buyInCost');num('fBuyChips','buyInChips');num('fRbCost','reBuyCost');num('fRbChips','reBuyChips');num('fRbLevel','reBuyLevel',true);num('fAoCost','addOnCost');num('fAoChips','addOnChips');num('fAc','addCash');
  on(root,'#fRbOn','change',e=>{d.reBuyEnabled=e.target.checked;render()});on(root,'#fAoOn','change',e=>{d.addOnEnabled=e.target.checked;render()});on(root,'#fAcOn','change',e=>{d.addCashEnabled=e.target.checked;render()});
  on(root,'[data-wpreset]','click',e=>{d.winStruct=winPresetFor(+e.currentTarget.dataset.wpreset,d.numPlayers);render()});
  on(root,'#wAdd','click',()=>{d.winStruct.push(0);render()});
  on(root,'#wEven','click',()=>{d.winStruct=evenOut(d.winStruct);render()});
  on(root,'#wClear','click',()=>{d.winStruct=[];render()});
  on(root,'[data-w]','change',e=>{d.winStruct[+e.target.dataset.w]=Math.max(0,+e.target.value||0);render()});
  on(root,'[data-wins]','click',e=>{if(d.winStruct.length>=MAX_WIN)return;d.winStruct.splice(+e.currentTarget.dataset.wins+1,0,0);render()});
  on(root,'[data-wdel]','click',e=>{d.winStruct.splice(+e.currentTarget.dataset.wdel,1);render()})}

function blindsHtml(d){const sc=schedule(d);const total=sc.length?sc[sc.length-1].end:0;return `<div style="display:grid;gap:20px">
  <section class="panel" style="display:grid;gap:14px">
    <div class="row spread"><h3>Rounds</h3><span class="note num">${d.blindStruct.length} de ${MAX_LEVELS} rounds · duração total ${fmtLong(total)}</span></div>
    <p class="note" style="margin:0">Cada round tem small blind, big blind, ante, duração em minutos e, se houver, um intervalo (em minutos) após o round. Edite qualquer valor direto na tabela.${d.reBuyEnabled?' Os rounds marcados em dourado aceitam re-buy.':''}</p>
    <div class="toolbar"><button class="btn small primary" id="bGen">Gerar estrutura…</button><button class="btn small" id="bConf">Preset Confraria (20 rounds, 100/200)</button>${PRESETS.blind.map((p,i)=>`<button class="btn small" data-bpreset="${i}">Preset ${p.name}</button>`).join('')}<button class="btn small" id="bAdd" ${d.blindStruct.length>=MAX_LEVELS?'disabled':''}>+ Round</button><button class="btn small" id="bClear" ${d.blindStruct.length?'':'disabled'}>Limpar</button></div>
    ${d.blindStruct.length?`<div class="row"><span class="note">Ante igual ao big blind a partir do round</span><input id="bAnteFrom" type="number" inputmode="numeric" min="1" max="${d.blindStruct.length}" value="${Math.min(6,d.blindStruct.length)}" style="width:72px;border:1px solid var(--line);background:var(--panel);border-radius:6px;padding:6px;min-height:36px"><button class="btn small" id="bAnte">Aplicar</button><button class="btn small" id="bAnteClear">Zerar antes</button></div>`:''}
    ${d.blindStruct.length?`<div class="twrap"><table><thead><tr><th>Round</th><th>Small</th><th>Big</th><th>Ante</th><th>Minutos</th><th>Intervalo</th><th>Começa em</th><th></th></tr></thead><tbody>${d.blindStruct.map((l,i)=>`<tr class="${d.reBuyEnabled&&i<d.reBuyLevel?'rb':''}"><td>${i+1}</td><td><input type="number" inputmode="numeric" min="0" data-b="${i}" data-k="sb" value="${esc(l.sb)}"></td><td><input type="number" inputmode="numeric" min="0" data-b="${i}" data-k="bb" value="${esc(l.bb)}"></td><td><input type="number" inputmode="numeric" min="0" data-b="${i}" data-k="ante" value="${esc(l.ante)}"></td><td><input class="narrow" type="number" inputmode="numeric" min="0" data-b="${i}" data-k="time" value="${esc(l.time)}"></td><td><input class="narrow" type="number" inputmode="numeric" min="0" data-b="${i}" data-k="brk" value="${esc(l.brk)}"></td><td class="num muted">${fmtLong(sc[i].start)}</td><td><span class="rowbtns"><button data-bins="${i}" title="Inserir abaixo">+</button><button data-bdel="${i}" title="Excluir">×</button></span></td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">Nenhum round. Escolha um preset ou adicione rounds.</p>'}
  </section>
</div>`}
function genDialog(d){const first=d.blindStruct[0]||{};const g=Object.assign({},CONFRARIA_PRESET,{sb:first.sb||100,bb:first.bb||200,minutes:first.time||20});const f=(id,label,val,extra)=>`<div class="field"><label for="${id}">${label}</label><input id="${id}" type="number" inputmode="numeric" value="${val}" ${extra||''}></div>`;
  showDialog('Gerar estrutura de blinds',[{label:'Cancelar',fn:closeDialog},{label:'Gerar',kind:'primary',fn(){const v=id=>+document.getElementById(id).value;d.blindStruct=genBlinds({sb:v('gSb'),bb:v('gBb'),rounds:v('gRounds'),minutes:v('gMin'),repeatFirst:v('gRep'),anteFrom:v('gAnte'),breakEvery:v('gBrkEvery'),breakMin:v('gBrkMin')});d.reBuyLevel=Math.max(1,Math.min(d.reBuyLevel,d.blindStruct.length));dialog=null;render()}}],
  `<p class="note" style="margin:0">Os blinds sobem na progressão padrão de sala (100/200, 150/300, 200/400, 300/600, 400/800…). A tabela gerada substitui a atual e continua editável round a round.</p><div class="fgrid" style="grid-template-columns:1fr 1fr">${f('gSb','Small blind inicial',g.sb,'min="1"')}${f('gBb','Big blind inicial',g.bb,'min="1"')}${f('gRounds','Quantidade de rounds',g.rounds,'min="1" max="'+MAX_LEVELS+'"')}${f('gMin','Minutos por round',g.minutes,'min="1"')}${f('gRep','Repetir o 1º round (vezes)',g.repeatFirst,'min="1"')}${f('gAnte','Ante = BB a partir do round (0 = sem ante)',g.anteFrom,'min="0"')}${f('gBrkEvery','Intervalo a cada N rounds (0 = nenhum)',g.breakEvery,'min="0"')}${f('gBrkMin','Minutos de intervalo',g.breakMin,'min="0"')}</div>`)}
function bindBlinds(root,d){
  on(root,'#bGen','click',()=>genDialog(d));
  on(root,'#bConf','click',()=>{d.blindStruct=genBlinds(CONFRARIA_PRESET);d.reBuyLevel=Math.max(1,Math.min(d.reBuyLevel,d.blindStruct.length));render()});
  on(root,'#bAnte','click',()=>{const from=Math.max(1,Math.round(+root.querySelector('#bAnteFrom').value||1));d.blindStruct.forEach((l,i)=>{if(i+1>=from)l.ante=l.bb});render()});
  on(root,'#bAnteClear','click',()=>{d.blindStruct.forEach(l=>{l.ante=0});render()});
  on(root,'[data-bpreset]','click',e=>{d.blindStruct=clone(PRESETS.blind[+e.currentTarget.dataset.bpreset].levels);d.reBuyLevel=Math.min(d.reBuyLevel,d.blindStruct.length);render()});
  on(root,'#bAdd','click',()=>{const last=d.blindStruct[d.blindStruct.length-1];if(!last){d.blindStruct.push({sb:100,bb:200,ante:0,time:20,brk:0});render();return}const li=LADDER.indexOf(last.sb);const sb=li>=0&&li<LADDER.length-1?LADDER[li+1]:last.sb*2;const bb=Math.round(sb*(last.bb/(last.sb||1)||2));d.blindStruct.push({sb,bb,ante:last.ante?bb:0,time:last.time,brk:0});render()});
  on(root,'#bClear','click',()=>{d.blindStruct=[];render()});
  on(root,'[data-b]','change',e=>{const l=d.blindStruct[+e.target.dataset.b];l[e.target.dataset.k]=Math.max(0,+e.target.value||0);render()});
  on(root,'[data-bins]','click',e=>{if(d.blindStruct.length>=MAX_LEVELS)return;const i=+e.currentTarget.dataset.bins;const l=d.blindStruct[i];d.blindStruct.splice(i+1,0,{sb:l.sb,bb:l.bb,ante:l.ante,time:l.time,brk:0});render()});
  on(root,'[data-bdel]','click',e=>{d.blindStruct.splice(+e.currentTarget.dataset.bdel,1);d.reBuyLevel=Math.max(1,Math.min(d.reBuyLevel,d.blindStruct.length));render()})}

function scoringTarget(d){return Math.min(MAX_WIN,Math.max(S.players.length,+d.numPlayers||0,1))}
function extendScoring(d){const s=d.scoring;const n=scoringTarget(d);while(s.pos.length<n){const last=s.pos.length?+s.pos[s.pos.length-1]||0:scoringTarget(d)+1;s.pos.push(Math.max(1,last-1))}}
function scoringHtml(d){const s=d.scoring;if(!s._cleared)extendScoring(d);const n=scoringTarget(d);return `<div style="display:grid;gap:20px">
  <section class="panel" style="display:grid;gap:14px">
    <div class="row spread"><h3>Pontos por colocação</h3><span class="note num">${S.players.length} jogador${S.players.length===1?'':'es'} cadastrado${S.players.length===1?'':'s'} · ${s.pos.length} colocaç${s.pos.length===1?'ão':'ões'}</span></div>
    <p class="note" style="margin:0">Uma linha para cada colocação possível: a tabela é completada automaticamente até o número de jogadores cadastrados (${n}), em ordem decrescente, e você ajusta os pontos de cada lugar. Colocações além da lista rendem só os pontos de participação.</p>
    <div class="toolbar"><button class="btn small" id="scAdd" ${s.pos.length>=MAX_WIN?'disabled':''}>+ Colocação</button><button class="btn small" id="scPreset2">Preset decrescente (${n} … 1)</button><button class="btn small" id="scPreset1">Preset 10 / 7 / 5 / 3 / 2 + 1</button><button class="btn small" id="scClear" ${s.pos.length?'':'disabled'}>Limpar</button></div>
    ${s.pos.length?`<div class="twrap"><table><thead><tr><th>Colocação</th><th>Pontos</th><th></th></tr></thead><tbody>${s.pos.map((p,i)=>`<tr><td>${ord(i+1)}</td><td><input type="number" inputmode="decimal" step="0.5" data-sp="${i}" value="${esc(p)}"></td><td><span class="rowbtns"><button data-spdel="${i}" title="Excluir">×</button></span></td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">Nenhuma colocação pontua.</p>'}
  </section>
  <section class="panel" style="display:grid;gap:14px">
    <h3>Outros pontos</h3>
    <div class="fgrid">${numInput('scBase','Por participação',s.base,'step="0.5"')}${numInput('scKo','Por eliminação (bounty)',s.ko,'step="0.5"')}</div>
    <p class="note" style="margin:0">Exemplo com esta tabela: campeão com 2 eliminações = ${fmtN(pointsFor(s,1,2))} pontos; 4º lugar sem eliminações = ${fmtN(pointsFor(s,4,0))} pontos.</p>
  </section>
</div>`}
function bindScoring(root,d){const s=d.scoring;
  on(root,'#scAdd','click',()=>{s.pos.push(Math.max(0,(+s.pos[s.pos.length-1]||1)-1));delete s._cleared;render()});
  on(root,'#scPreset1','click',()=>{s.pos=[10,7,5,3,2];extendScoring(d);render()});
  on(root,'#scPreset2','click',()=>{const n=scoringTarget(d);s.pos=Array.from({length:n},(_,i)=>n-i);render()});
  on(root,'#scClear','click',()=>{s.pos=[];s._cleared=true;render()});
  on(root,'[data-sp]','change',e=>{s.pos[+e.target.dataset.sp]=+e.target.value||0;render()});
  on(root,'[data-spdel]','click',e=>{s.pos.splice(+e.currentTarget.dataset.spdel,1);render()});
  on(root,'#scBase','input',e=>{s.base=+e.target.value||0});on(root,'#scKo','input',e=>{s.ko=+e.target.value||0})}

/* ---------- prepare game ---------- */
function viewPrep(){const t=tById(prep.tid);const ps=sortedPlayers();const root=h(`<div class="page">
  <div class="row spread"><div><div class="eyebrow">Preparar partida</div><h1>${esc(t.name)}</h1></div><button class="btn" id="pCancel">Cancelar</button></div>
  <section class="panel" style="display:grid;gap:14px">
    <div class="row spread"><h3>Quem está jogando</h3><span class="note num">${prep.roster.length} selecionado${prep.roster.length===1?'':'s'}</span></div>
    ${ps.length?`<div class="chips">${ps.map(p=>`<button type="button" class="pchip ${prep.roster.includes(p.id)?'on':''}" data-pid="${p.id}">${esc(p.name)}</button>`).join('')}</div>`:'<p class="muted">Nenhum jogador cadastrado ainda. Adicione abaixo.</p>'}
    <div class="row"><div class="field grow"><label for="pNew">Novo jogador</label><input id="pNew" type="text" placeholder="Nome" value="${esc(prep.newName)}"></div><button class="btn" id="pAdd" style="align-self:flex-end">Adicionar e selecionar</button></div>
    <p class="note" style="margin:0">A ordem de entrada não importa. Se preferir só contar jogadores sem nomes, deixe tudo desmarcado.</p>
  </section>
  <section class="panel" style="display:grid;gap:14px">
    <h3>Rodada</h3>
    <div class="fgrid">
      <div class="field"><label for="pDealer">Dealer da rodada</label><input id="pDealer" type="text" list="dealerList" value="${esc(prep.dealer)}" placeholder="Nome"><datalist id="dealerList">${ps.map(p=>`<option value="${esc(p.name)}">`).join('')}</datalist></div>
      <div class="field"><label>Entradas no relógio</label><div class="num" style="min-height:42px;display:flex;align-items:center;font-weight:600">${prep.roster.length||t.numPlayers} jogador${(prep.roster.length||t.numPlayers)===1?'':'es'}</div></div>
    </div>
  </section>
  <div class="toolbar"><button class="btn primary" id="pStart" style="font-size:18px">${prep.roster.length?'Iniciar partida com '+prep.roster.length+' jogador'+(prep.roster.length===1?'':'es'):'Iniciar sem nomes ('+t.numPlayers+' entradas)'}</button></div>
</div>`);
  on(root,'#pCancel','click',()=>{prep=null;go('home')});
  on(root,'[data-pid]','click',e=>{const id=e.currentTarget.dataset.pid;const i=prep.roster.indexOf(id);if(i>=0)prep.roster.splice(i,1);else prep.roster.push(id);render()});
  on(root,'#pNew','input',e=>{prep.newName=e.target.value});
  on(root,'#pNew','keydown',e=>{if(e.key==='Enter'){e.preventDefault();root.querySelector('#pAdd').click()}});
  on(root,'#pAdd','click',()=>{const id=addPlayer(prep.newName);if(id){if(!prep.roster.includes(id))prep.roster.push(id);prep.newName='';render();setTimeout(()=>{const i=document.getElementById('pNew');if(i)i.focus()},0)}});
  on(root,'#pDealer','input',e=>{prep.dealer=e.target.value});
  on(root,'#pStart','click',()=>{if(prep.roster.length===1){showDialog('Só um jogador selecionado. Selecione pelo menos dois, ou nenhum para rodar sem nomes.',[{label:'Ok',fn:closeDialog}]);return}startClock(t,prep.roster.slice(),prep.dealer.trim())});
  return root}

/* ---------- clock (controls) and TV (display) ---------- */
function clockStageHtml(t,L,tv){const hasRoster=L.roster.length>0;return `<div class="stage">
    <div class="timerbox" id="cBox">
      <div class="lvl" id="cLevel">Round 1</div>
      <div class="big num" id="cTimer">00:00</div>
      <div class="phase" id="cPhase"></div>
      <div class="blinds">
        <div class="b"><span class="eyebrow">Blinds</span><div class="v num" id="cBlinds">–</div></div>
        <div class="b"><span class="eyebrow">Próximo round</span><div class="v num" id="cNext">–</div></div>
      </div>
    </div>
    <aside class="side">
      <div class="stats">
        <div class="stat"><span class="eyebrow">Entradas</span><span class="v num" id="sEntries">0</span>${tv?'':`<div class="ctl"><button data-act="entry-" aria-label="Menos uma entrada">−</button><button data-act="entry+" aria-label="Mais uma entrada">+</button></div>`}</div>
        <div class="stat"><span class="eyebrow">Jogadores</span><span class="v num" id="sPlayers">0</span>${tv?'':`<div class="ctl"><button data-act="player-" aria-label="Eliminar jogador" title="${hasRoster?'Registrar eliminação':'Eliminar jogador'}">−</button><button data-act="player+" aria-label="Repor jogador" title="${hasRoster?'Desfazer última eliminação':'Repor jogador'}">+</button></div>`}</div>
        ${t.reBuyEnabled?`<div class="stat"><span class="eyebrow">Re-buys <span class="chip" id="sRbChip"></span></span><span class="v num" id="sRebuys">0</span>${tv?'':`<div class="ctl"><button data-act="rebuy-" aria-label="Menos um re-buy">−</button><button data-act="rebuy+" aria-label="Mais um re-buy">+</button></div>`}</div>`:''}
        ${t.addOnEnabled?`<div class="stat"><span class="eyebrow">Add-ons</span><span class="v num" id="sAddons">0</span>${tv?'':`<div class="ctl"><button data-act="addon-" aria-label="Menos um add-on">−</button><button data-act="addon+" aria-label="Mais um add-on">+</button></div>`}</div>`:''}
        <div class="stat"><span class="eyebrow">Pote total</span><span class="v num" id="sPot">0</span></div>
        <div class="stat"><span class="eyebrow">Stack médio</span><span class="v num" id="sAvg">0</span></div>
      </div>
      <div class="prizes"><div class="row spread"><span class="eyebrow">Premiação</span><span class="note num" id="pPage"></span></div><ol id="pList"></ol></div>
      ${hasRoster?`<div class="prizes" style="flex:0 0 auto;min-height:0"><div class="row spread"><span class="eyebrow">Eliminações</span><span class="note num" id="eCount"></span></div><ul class="elist" id="eList"></ul></div>`:''}
    </aside>
  </div>`}
function headHtml(t,L,tv){return `<header class="chead">
    <div class="brand">${logoHtml()}<div class="name">${esc(t.name)}${L.dealer?` <span class="chip">Dealer: ${esc(L.dealer)}</span>`:''}</div></div>
    <div class="row">
      <span class="lab num" title="Tempo total de jogo">Tempo total <b id="cElapsed" class="num">0:00:00</b></span>
      <button class="btn icon ghost" id="cSound" title="${UI.sound?'Som ligado':'Som desligado'}" aria-label="Som">${UI.sound?'🔔':'🔕'}</button>
      <button class="btn icon ghost" id="cFull" title="Tela cheia" aria-label="Tela cheia">⛶</button>
      ${tv?`<button class="btn ghost exit" id="cExitTV">Sair do modo TV</button>`:`<button class="btn ghost" id="cTV">Modo TV</button><button class="btn ghost" id="cHome">Torneios</button>`}
    </div>
  </header>`}
function bindHead(root){on(root,'#cSound','click',()=>{UI.sound=!UI.sound;saveUI();ac();render()});
  on(root,'#cFull','click',()=>{if(document.fullscreenElement){document.exitFullscreen().catch(()=>{})}else if(document.documentElement.requestFullscreen){document.documentElement.requestFullscreen().catch(()=>{})}});
  on(root,'#cHome','click',()=>go('home'));on(root,'#cTV','click',()=>go('tv'));on(root,'#cExitTV','click',()=>go(S.live?'clock':'home'))}
function viewClock(){const L=S.live,t=tById(L.tid);const root=h(`<div class="clock">
  ${headHtml(t,L,false)}
  ${clockStageHtml(t,L,false)}
  <div class="deck">
    <div class="row"><button class="btn" data-act="level-" aria-label="Round anterior">◀ Round</button><button class="btn" data-act="level+" aria-label="Próximo round">Round ▶</button></div>
    <div class="mid"><span class="lab">Tempo</span><input type="range" id="cSlider" min="0" max="100" value="0" aria-label="Ajustar tempo restante"><span class="lab num" id="cSliderLab"></span></div>
    <div class="row"><button class="btn primary play" id="cPlay">${L.running?'❚❚ Pausar':'▶ Iniciar'}</button><button class="btn" id="cEdit">Editar</button><button class="btn danger" id="cEnd">Encerrar</button></div>
  </div>
</div>`);
  bindHead(root);
  on(root,'[data-act]','click',e=>act(e.currentTarget.dataset.act));
  on(root,'#cPlay','click',togglePlay);on(root,'#cEdit','click',editT);on(root,'#cEnd','click',endT);
  const sl=root.querySelector('#cSlider');
  sl.addEventListener('pointerdown',()=>{sliderHeld=true});sl.addEventListener('pointerup',()=>{sliderHeld=false});sl.addEventListener('pointercancel',()=>{sliderHeld=false});sl.addEventListener('keydown',()=>{sliderHeld=true});sl.addEventListener('keyup',()=>{sliderHeld=false});
  let slideT=null;
  sl.addEventListener('input',e=>{const ph=phaseAt(t,curTime(L));if(!ph||ph.kind==='overtime')return;const v=ph.start+(+e.target.value);L.time=v;L.lastTick=L.running?Date.now():null;clearTimeout(slideT);slideT=setTimeout(()=>putLive(),400);updateClockFields()});
  sl.addEventListener('change',()=>{sliderHeld=false});
  return root}
function viewTV(){const L=S.live;const t=L&&tById(L.tid);if(!t){const rk=ranking('').slice(0,5);const root=h(`<div class="tv"><div class="wait">${logoHtml()}<div><h2>${esc(S.settings.leagueName||DEFAULT_LEAGUE)}</h2><div class="motto">${esc(S.settings.motto||'')}</div></div><p class="muted" style="font-size:20px;margin:0">${ready?'Aguardando o início da partida…':'Conectando…'}</p>${rk.length?`<div class="twrap" style="width:100%;max-width:720px"><table><thead><tr><th>#</th><th>Ranking</th><th>Pontos</th><th>Vitórias</th></tr></thead><tbody>${rk.map((m,i)=>`<tr><td class="${i<3?'pod':''}">${i+1}</td><td style="text-align:left;font-weight:600">${esc(m.name)}</td><td class="num">${fmtN(m.points)}</td><td class="num">${m.wins}</td></tr>`).join('')}</tbody></table></div>`:''}<div class="row"><button class="btn icon ghost" id="cFull" title="Tela cheia" aria-label="Tela cheia">⛶</button><button class="btn ghost exit" id="cExitTV">Sair do modo TV</button></div></div></div>`);bindHead(root);return root}
  const root=h(`<div class="tv">${headHtml(t,L,true)}${clockStageHtml(t,L,true)}</div>`);bindHead(root);return root}

function act(a){const L=S.live,t=tById(L.tid);if(!t)return;const now=curTime(L);const ph=phaseAt(t,now);const hasRoster=L.roster.length>0;let tChanged=false;
  switch(a){
    case 'entry-':if(hasRoster){removeEntryDialog();return}t.numPlayers=Math.max(1,t.numPlayers-1);L.players=Math.max(1,Math.min(L.players,t.numPlayers));tChanged=true;break;
    case 'entry+':if(hasRoster){addEntryDialog();return}t.numPlayers++;L.players++;tChanged=true;break;
    case 'player-':if(hasRoster){elimDialog();return}L.players=Math.max(1,L.players-1);break;
    case 'player+':if(hasRoster){undoElimDialog();return}L.players=Math.min(t.numPlayers,L.players+1);break;
    case 'rebuy-':L.reBuys=Math.max(0,L.reBuys-1);break;
    case 'rebuy+':L.reBuys++;break;
    case 'addon-':L.addOns=Math.max(0,L.addOns-1);break;
    case 'addon+':L.addOns++;break;
    case 'level-':{if(!ph)break;const sc=ph.sched;let v;if(ph.kind==='break'||ph.kind==='overtime'){v=ph.kind==='overtime'?sc[sc.length-1].start:sc[ph.level].start}else if(ph.level>0){const p=sc[ph.level-1];v=p.l.brk>0?p.playEnd:p.start}else v=0;L.time=v;L.lastTick=L.running?Date.now():null;lastPhaseKey=null;break}
    case 'level+':{if(!ph)break;const sc=ph.sched;let v=null;if(ph.kind==='play'&&sc[ph.level].l.brk>0)v=sc[ph.level].playEnd;else if(ph.level<sc.length-1)v=sc[ph.level+1].start;if(v!=null){L.time=v;L.lastTick=L.running?Date.now():null}lastPhaseKey=null;break}
  }
  if(tChanged)putT(t);putLive();updateClockFields()}

function handFieldsHtml(prefix,rank,cards){return `<div class="field"><label for="${prefix}Rank">Mão vencedora</label><select id="${prefix}Rank">${rankOptions(rank||'')}</select></div><div class="field"><label for="${prefix}Cards">Cartas (opcional)</label><div class="row"><input id="${prefix}Cards" type="text" class="grow" value="${esc(cards||'')}" placeholder="Ex.: A♠ K♠ · mesa 10♠ J♠ Q♠" maxlength="40">${suitsHtml(prefix+'Cards')}</div></div>`}
function elimDialog(){const L=S.live,t=tById(L.tid);const al=alive(L);if(al.length<=1){showDialog('Só resta um jogador. Encerre a partida para registrar o campeão.',[{label:'Ok',fn:closeDialog}]);return}const ph=phaseAt(t,curTime(L));const pos=L.roster.length-L.elims.length;showDialog('Registrar eliminação ('+ord(pos)+' lugar)',[{label:'Cancelar',fn:closeDialog},{label:'Registrar',kind:'primary',fn(){const pid=document.getElementById('elPid').value;if(!pid)return;const byPid=document.getElementById('elBy').value||null;L.elims.push({pid,byPid,rank:document.getElementById('elRank').value,cards:document.getElementById('elCards').value.trim(),level:(ph?ph.level:0)+1,time:curTime(L)});L.players=alive(L).length;dialog=null;putLive();render()}}],`<div class="fgrid"><div class="field"><label for="elPid">Quem foi eliminado</label><select id="elPid">${playerOptions('',al,'Escolha…')}</select></div><div class="field"><label for="elBy">Eliminado por</label><select id="elBy">${playerOptions('',al,'— não registrar —')}</select></div>${handFieldsHtml('el','','')}</div>`,()=>{const root=document.querySelector('.dialog');bindSuits(root);const p=document.getElementById('elPid');p.addEventListener('change',()=>{const by=document.getElementById('elBy');Array.from(by.options).forEach(o=>{o.disabled=o.value&&o.value===p.value});if(by.value===p.value)by.value=''})})}
function undoElimDialog(){const L=S.live;if(!L.elims.length){showDialog('Nenhuma eliminação para desfazer.',[{label:'Ok',fn:closeDialog}]);return}const e=L.elims[L.elims.length-1];showDialog('Desfazer a última eliminação ('+pName(e.pid)+(e.byPid?', por '+pName(e.byPid):'')+')? O jogador volta para a mesa.',[{label:'Cancelar',fn:closeDialog},{label:'Desfazer',kind:'primary',fn(){L.elims.pop();L.players=alive(L).length;dialog=null;putLive();render()}}])}
function addEntryDialog(){const L=S.live,t=tById(L.tid);const avail=sortedPlayers().filter(p=>!L.roster.includes(p.id)).map(p=>p.id);showDialog('Entrada tardia: quem está entrando?',[{label:'Cancelar',fn:closeDialog},{label:'Adicionar',kind:'primary',fn(){let pid=document.getElementById('aePid').value;const nn=document.getElementById('aeNew').value.trim();if(nn)pid=addPlayer(nn);if(!pid||L.roster.includes(pid))return;L.roster.push(pid);t.numPlayers=L.roster.length;L.players=alive(L).length;dialog=null;putT(t);putLive();render()}}],`<div class="fgrid"><div class="field"><label for="aePid">Jogador cadastrado</label><select id="aePid">${playerOptions('',avail,'Escolha…')}</select></div><div class="field"><label for="aeNew">Ou um nome novo</label><input id="aeNew" type="text" placeholder="Nome"></div></div>`)}
function removeEntryDialog(){const L=S.live,t=tById(L.tid);const al=alive(L);if(al.length<=2){showDialog('Não dá para remover: restariam menos de dois jogadores.',[{label:'Ok',fn:closeDialog}]);return}showDialog('Remover uma entrada (jogador que não chegou a jogar). Não conta como eliminação.',[{label:'Cancelar',fn:closeDialog},{label:'Remover',kind:'danger',fn(){const pid=document.getElementById('rePid').value;if(!pid)return;L.roster=L.roster.filter(x=>x!==pid);t.numPlayers=L.roster.length;L.players=alive(L).length;dialog=null;putT(t);putLive();render()}}],`<div class="field"><label for="rePid">Jogador</label><select id="rePid">${playerOptions('',al,'Escolha…')}</select></div>`)}

function setText(id,v){const e=document.getElementById(id);if(e&&e.textContent!==String(v))e.textContent=v}
function updateClockFields(){const L=S.live;if(!L)return;const t=tById(L.tid);if(!t)return;const now=curTime(L);const ph=phaseAt(t,now);const box=document.getElementById('cBox');if(!box)return;
  const lv=ph?t.blindStruct[ph.level]:null;const nx=ph&&t.blindStruct[ph.level+1];
  setText('cElapsed',fmtLong(now));
  setText('cLevel',ph?'Round '+(ph.level+1)+' de '+t.blindStruct.length:'Sem rounds');
  box.classList.toggle('brk',!!ph&&ph.kind==='break');box.classList.toggle('ot',!!ph&&ph.kind==='overtime');
  if(!ph){setText('cTimer','--:--');setText('cPhase','')}
  else if(ph.kind==='overtime'){setText('cTimer',fmtClock(ph.over));setText('cPhase','O/T · último round encerrado, relógio segue contando')}
  else if(ph.kind==='break'){setText('cTimer',fmtClock(ph.remaining));setText('cPhase',(L.running?'Intervalo':'Pausado no intervalo')+' · próximo round em '+fmtClock(ph.remaining))}
  else{setText('cTimer',fmtClock(ph.remaining));const nb=nextBreak(t,now);setText('cPhase',L.running?(nb?'Intervalo em '+fmtClock(nb.inSecs)+' · '+nb.mins+' min':'Sem intervalos à frente'):'Pausado'+(nb?' · intervalo em '+fmtClock(nb.inSecs):''))}
  setText('cBlinds',lv?fmtN(lv.sb)+' / '+fmtN(lv.bb)+(lv.ante?'  ·  ante '+fmtN(lv.ante):''):'–');
  const nextEl=document.getElementById('cNext');if(nextEl){const html=nx?`${fmtN(nx.sb)} / ${fmtN(nx.bb)}${nx.ante?'  ·  ante '+fmtN(nx.ante):''}<small>${nx.time} min</small>`:'<small>Último round</small>';if(nextEl.innerHTML!==html)nextEl.innerHTML=html}
  setText('sEntries',t.numPlayers);setText('sPlayers',L.players);setText('sRebuys',L.reBuys);setText('sAddons',L.addOns);
  const chip=document.getElementById('sRbChip');if(chip){const open=ph&&ph.kind!=='overtime'&&ph.level<t.reBuyLevel;chip.textContent=open?'abertos':'encerrados';chip.classList.toggle('on',!!open)}
  setText('sPot',money(t,totalCash(t,L)));setText('sAvg',fmtN(Math.floor(totalChips(t,L)/Math.max(1,L.players))));
  const pz=prizes(t,L);const pages=Math.max(1,Math.ceil(pz.length/PRIZE_PAGE));const pg=pz.length?Math.floor(now/PRIZE_SECS)%pages:0;const list=document.getElementById('pList');
  if(list){const html=pz.length?pz.slice(pg*PRIZE_PAGE,pg*PRIZE_PAGE+PRIZE_PAGE).map((v,i)=>`<li><span>${ord(pg*PRIZE_PAGE+i+1)}</span><span>${money(t,v)}</span></li>`).join(''):'<li class="muted" style="font-size:16px;font-weight:400">Defina a premiação em Editar.</li>';if(list.innerHTML!==html)list.innerHTML=html;setText('pPage',pages>1?(pg+1)+'/'+pages:'')}
  const el=document.getElementById('eList');if(el){const n=L.roster.length;const html=L.elims.length?L.elims.slice(-4).reverse().map(e=>{const i=L.elims.indexOf(e);return `<li><b>${ord(n-i)}</b><span>${esc(pName(e.pid))}${e.byPid?' <span class="muted">por</span> '+esc(pName(e.byPid)):''}${e.rank||e.cards?' <span class="muted">·</span> <span class="cards">'+esc(e.rank)+(e.cards?' '+cardsHtml(e.cards):'')+'</span>':''}</span></li>`}).join(''):'<li class="muted" style="font-size:14px">Nenhuma ainda.</li>';if(el.innerHTML!==html)el.innerHTML=html;setText('eCount',L.elims.length+' de '+(n-1))}
  const sl=document.getElementById('cSlider');if(sl&&ph){if(ph.kind==='overtime'){sl.disabled=true;setText('cSliderLab','O/T')}else{sl.disabled=false;const elp=now-ph.start;if(String(sl.max)!==String(ph.len))sl.max=ph.len;if(!sliderHeld&&+sl.value!==elp)sl.value=elp;setText('cSliderLab','falta '+fmtClock(ph.remaining))}}
  const play=document.getElementById('cPlay');if(play){const txt=L.running?'❚❚ Pausar':'▶ Iniciar';if(play.textContent!==txt)play.textContent=txt}
  if(ph&&lastPhaseKey===null)lastPhaseKey=ph.level+':'+ph.kind}

/* ---------- close game ---------- */
function viewClose(){const g=closing;const n=g.results.length;const ids=g.results.map(r=>r.pid).filter(Boolean);const sorted=g.results.map((r,i)=>({r,i})).sort((a,b)=>(a.r.pos||99)-(b.r.pos||99)||a.i-b.i);const w=g.results.find(r=>r.pos===1);const cur={currency:g.currency};const root=h(`<div class="page">
  <div class="row spread"><div><div class="eyebrow">${g._edit?'Editar partida salva':'Fechar partida'}</div><h1>${esc(g.tournamentName)}</h1></div><div class="row">${g._fromLive?`<button class="btn danger" id="clDiscard">Descartar partida</button><button class="btn" id="clBack">Voltar ao relógio</button>`:`<button class="btn" id="clCancel">Cancelar</button>`}<button class="btn primary" id="clSave">Salvar partida</button></div></div>
  <section class="panel" style="display:grid;gap:14px">
    <h3>Rodada</h3>
    <div class="fgrid">
      <div class="field"><label for="clDate">Data</label><input id="clDate" type="date" value="${esc(g.date)}"></div>
      <div class="field"><label for="clDealer">Dealer da rodada</label><input id="clDealer" type="text" list="dealerList2" value="${esc(g.dealer)}" placeholder="Nome"><datalist id="dealerList2">${sortedPlayers().map(p=>`<option value="${esc(p.name)}">`).join('')}</datalist></div>
      <div class="field"><label>Pote</label><div class="num" style="min-height:42px;display:flex;align-items:center;font-weight:600">${money(cur,g.total)}</div></div>
      <div class="field"><label>Duração</label><div class="num" style="min-height:42px;display:flex;align-items:center;font-weight:600">${fmtLong(g.time)} · ${g.levels} rounds</div></div>
    </div>
  </section>
  <section class="panel" style="display:grid;gap:14px">
    <div class="row spread"><h3>Resultado por jogador</h3><div class="toolbar"><button class="btn small" id="clRecalc">Recalcular prêmios e pontos</button><button class="btn small" id="clAddRow">+ Jogador</button></div></div>
    <p class="note" style="margin:0">Colocação, quem eliminou e a mão vêm do relógio; confira e complete. Prêmio e pontos são calculados pela tabela do torneio e podem ser ajustados à mão.</p>
    ${n?`<div class="twrap"><table><thead><tr><th>Colocação</th><th>Jogador</th><th>Eliminado por</th><th>Mão</th><th>Cartas</th><th>Prêmio</th><th>Pontos</th><th></th></tr></thead><tbody>${sorted.map(({r,i})=>`<tr class="${r.pos===1?'rank1':''}"><td><select data-r="${i}" data-k="pos"><option value="0" ${!r.pos?'selected':''}>—</option>${Array.from({length:n},(_,k)=>`<option value="${k+1}" ${r.pos===k+1?'selected':''}>${ord(k+1)}</option>`).join('')}</select></td><td><input class="wide" type="text" data-r="${i}" data-k="name" value="${esc(r.name)}" list="dealerList2"></td><td><select data-r="${i}" data-k="koBy">${playerOptions(r.koBy,ids.filter(x=>x!==r.pid),'—')}</select></td><td><select data-r="${i}" data-k="rank">${rankOptions(r.rank)}</select></td><td><input class="wide cards" type="text" data-r="${i}" data-k="cards" value="${esc(r.cards)}" maxlength="40"></td><td><input type="number" inputmode="decimal" min="0" data-r="${i}" data-k="prize" value="${esc(r.prize)}"></td><td><input class="pts" type="number" inputmode="decimal" step="0.5" data-r="${i}" data-k="points" value="${esc(r.points)}"></td><td><span class="rowbtns"><button data-rdel="${i}" title="Remover">×</button></span></td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">Esta partida rodou sem nomes. Adicione os jogadores para registrar colocações e pontos, ou salve só o resumo.</p>'}
  </section>
  <section class="panel" style="display:grid;gap:14px">
    <h3>Mão final</h3>
    <p class="note" style="margin:0">A mão com que ${w?'<b>'+esc(w.name)+'</b>':'o campeão'} fechou o torneio.</p>
    <div class="fgrid">${handFieldsHtml('fh',g.finalHand.rank,g.finalHand.cards)}</div>
  </section>
</div>`);
  const upd=(e)=>{const r=g.results[+e.target.dataset.r];const k=e.target.dataset.k;let v=e.target.value;if(k==='pos')v=+v||0;else if(k==='prize'||k==='points')v=+v||0;else if(k==='koBy')v=v||null;r[k]=v;if(k==='pos'||k==='name')render()};
  on(root,'[data-r]','change',upd);on(root,'input[data-r][data-k="name"],input[data-r][data-k="cards"]','input',e=>{g.results[+e.target.dataset.r][e.target.dataset.k]=e.target.value});
  on(root,'[data-rdel]','click',e=>{g.results.splice(+e.currentTarget.dataset.rdel,1);render()});
  on(root,'#clAddRow','click',()=>{g.results.push({pid:null,name:'',pos:0,koBy:null,rank:'',cards:'',prize:0,points:0});render()});
  on(root,'#clRecalc','click',()=>{g.results.forEach(r=>{if(r.name&&(!r.pid||pName(r.pid)!==r.name.trim()))r.pid=addPlayer(r.name)});recalc(g);render()});
  on(root,'#clDate','change',e=>{g.date=e.target.value});on(root,'#clDealer','input',e=>{g.dealer=e.target.value});
  on(root,'#fhRank','change',e=>{g.finalHand.rank=e.target.value});on(root,'#fhCards','input',e=>{g.finalHand.cards=e.target.value});
  bindSuits(root);
  on(root,'#clSave','click',saveClose);on(root,'#clDiscard','click',discardLive);on(root,'#clCancel','click',()=>{closing=null;go('game')});on(root,'#clBack','click',()=>{closing=null;go('clock')});
  return root}

/* ---------- games history & detail ---------- */
function champion(g){const w=g.results.find(r=>r.pos===1);return w?w.name:null}
function viewGames(){const games=S.games.slice().sort((a,b)=>(b.date||'').localeCompare(a.date||'')||(b.savedAt||0)-(a.savedAt||0));const root=h(`<div class="page">
  ${navHtml('games')}
  <section class="panel" style="display:grid;gap:12px">
    <div class="row spread"><h2>Partidas</h2><span class="note num">${games.length} salva${games.length===1?'':'s'}</span></div>
    ${games.length?`<ul class="glist">${games.map(g=>`<li><button data-g="${g.id}"><span class="d">${fmtDate(g.date)}</span><span class="w">${champion(g)?'🏆 '+esc(champion(g)):'<span class="muted">sem campeão registrado</span>'} <span class="muted">· ${esc(g.tournamentName)}</span></span><span class="s num">${g.results.length||g.entries} jog.${g.dealer?' · dealer '+esc(g.dealer):''}</span></button></li>`).join('')}</ul>`:'<p class="muted">Nenhuma partida salva. Ao encerrar um torneio no relógio, a partida é fechada e guardada aqui.</p>'}
  </section>
  ${helpOpen?helpHtml():''}
</div>`);bindNav(root);on(root,'[data-g]','click',e=>{gameId=e.currentTarget.dataset.g;go('game')});return root}

function viewGame(){const g=S.games.find(x=>x.id===gameId);const cur={currency:g.currency};const rows=g.results.slice().sort((a,b)=>(a.pos||99)-(b.pos||99));const w=g.results.find(r=>r.pos===1);const kos=g.results.filter(r=>r.koBy);const root=h(`<div class="page">
  <div class="row spread"><div><div class="eyebrow">Partida de ${fmtDate(g.date)}</div><h1>${esc(g.tournamentName)}</h1></div><div class="row"><button class="btn" id="gBack">Partidas</button><button class="btn" id="gEdit" ${canWrite?'':'disabled'}>Editar</button><button class="btn danger" id="gDel" ${canWrite?'':'disabled'}>Excluir</button></div></div>
  <section class="panel" style="display:grid;gap:16px">
    ${w?`<div><div class="eyebrow">Campeão</div><div class="bigname">🏆 ${esc(w.name)}</div>${g.finalHand&&(g.finalHand.rank||g.finalHand.cards)?`<div class="cards" style="font-size:20px;margin-top:4px">${esc(g.finalHand.rank)}${g.finalHand.cards?' · '+cardsHtml(g.finalHand.cards):''}</div>`:''}</div>`:''}
    <div class="rgrid">
      <div class="stat"><span class="eyebrow">Dealer</span><span class="v" style="font-size:22px">${esc(g.dealer)||'—'}</span></div>
      <div class="stat"><span class="eyebrow">Entradas</span><span class="v num">${g.entries}</span></div>
      <div class="stat"><span class="eyebrow">Re-buys</span><span class="v num">${g.reBuys==null?'—':g.reBuys}</span></div>
      <div class="stat"><span class="eyebrow">Add-ons</span><span class="v num">${g.addOns==null?'—':g.addOns}</span></div>
      <div class="stat"><span class="eyebrow">Rounds</span><span class="v num">${g.levels}</span></div>
      <div class="stat"><span class="eyebrow">Duração</span><span class="v num">${fmtLong(g.time)}</span></div>
      <div class="stat"><span class="eyebrow">Pote total</span><span class="v num">${money(cur,g.total)}</span></div>
    </div>
    ${rows.length?`<div class="twrap"><table><thead><tr><th>Colocação</th><th>Jogador</th><th>Eliminado por</th><th>Mão</th><th>Prêmio</th><th>Pontos</th></tr></thead><tbody>${rows.map(r=>`<tr class="${r.pos===1?'rank1':''}"><td class="${r.pos<=3?'pod':''}">${r.pos?ord(r.pos):'—'}</td><td style="text-align:left">${esc(r.name)}</td><td style="text-align:left">${r.koBy?esc(pName(r.koBy)):'<span class="muted">—</span>'}</td><td style="text-align:left" class="cards">${r.rank||r.cards?esc(r.rank)+(r.cards?' '+cardsHtml(r.cards):''):'<span class="muted">—</span>'}</td><td class="num">${r.prize?money(cur,r.prize):'<span class="muted">—</span>'}</td><td class="num">${fmtN(r.points)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">Partida salva sem jogadores nomeados.</p>'}
    ${kos.length?`<div><h3 style="margin-bottom:8px">Quem derrubou quem</h3><ul class="elist">${rows.filter(r=>r.koBy).map(r=>`<li><b>${r.pos?ord(r.pos):'—'}</b><span><b style="font-family:inherit;font-size:inherit;color:inherit">${esc(pName(r.koBy))}</b> derrubou ${esc(r.name)}${r.rank||r.cards?' <span class="muted">com</span> <span class="cards">'+esc(r.rank)+(r.cards?' '+cardsHtml(r.cards):'')+'</span>':''}</span></li>`).join('')}</ul></div>`:''}
  </section>
</div>`);on(root,'#gBack','click',()=>go('games'));on(root,'#gEdit','click',()=>editGame(g.id));on(root,'#gDel','click',()=>deleteGame(g.id));return root}

/* ---------- players ---------- */
function viewPlayers(){const rk=ranking('');const stats={};rk.forEach(m=>{if(m.pid)stats[m.pid]=m});const ps=sortedPlayers();const root=h(`<div class="page">
  ${navHtml('players')}
  <section class="panel" style="display:grid;gap:12px">
    <div class="row spread"><h2>Jogadores</h2><span class="note num">${ps.length} cadastrado${ps.length===1?'':'s'}</span></div>
    <div class="row"><div class="field grow"><label for="plNew">Novo jogador</label><input id="plNew" type="text" placeholder="Nome" ${canWrite?'':'disabled'}></div><button class="btn primary" id="plAdd" style="align-self:flex-end" ${canWrite?'':'disabled'}>Adicionar</button></div>
    ${ps.length?`<div class="twrap"><table><thead><tr><th>Jogador</th><th>Partidas</th><th>Vitórias</th><th>Pontos</th><th>Prêmios</th><th></th></tr></thead><tbody>${ps.map(p=>{const m=stats[p.id]||{games:0,wins:0,points:0,prize:0,cur:''};return `<tr><td><input class="wide" type="text" data-pname="${p.id}" value="${esc(p.name)}" maxlength="40" ${canWrite?'':'disabled'}></td><td class="num">${m.games}</td><td class="num">${m.wins}</td><td class="num">${fmtN(m.points)}</td><td class="num">${m.prize?money({currency:m.cur},m.prize):'—'}</td><td><span class="rowbtns"><button data-pdel="${p.id}" title="Excluir" ${canWrite?'':'disabled'}>×</button></span></td></tr>`}).join('')}</tbody></table></div>`:'<p class="muted">Nenhum jogador. Cadastre aqui ou ao preparar uma partida.</p>'}
    <p class="note" style="margin:0">Renomear um jogador atualiza o histórico. Excluir mantém as partidas salvas, com o nome registrado na época.</p>
  </section>
  ${helpOpen?helpHtml():''}
</div>`);bindNav(root);
  const add=()=>{const i=root.querySelector('#plNew');if(addPlayer(i.value)){render();setTimeout(()=>{const n=document.getElementById('plNew');if(n)n.focus()},0)}};
  on(root,'#plAdd','click',add);on(root,'#plNew','keydown',e=>{if(e.key==='Enter'){e.preventDefault();add()}});
  on(root,'[data-pname]','change',e=>{const p=pById(e.target.dataset.pname);const nn=e.target.value.trim();if(!p||!nn)return;p.name=nn;putP(p);S.games.forEach(g=>{let ch=false;g.results.forEach(r=>{if(r.pid===p.id&&r.name!==nn){r.name=nn;ch=true}});if(ch)putG(g)});render()});
  on(root,'[data-pdel]','click',e=>{const p=pById(e.currentTarget.dataset.pdel);showDialog('Excluir "'+p.name+'" do cadastro?',[{label:'Cancelar',fn:closeDialog},{label:'Excluir',kind:'danger',fn(){delP(p.id);if(S.live&&S.live.roster.includes(p.id)){S.live.roster=S.live.roster.filter(x=>x!==p.id);putLive()}dialog=null;render()}}])});
  return root}

/* ---------- ranking ---------- */
function viewRanking(){const names=[...new Set(S.games.map(g=>g.tournamentName))].sort();if(UI.rankFilter&&!names.includes(UI.rankFilter))UI.rankFilter='';const rk=ranking(UI.rankFilter);const finals=S.games.filter(g=>!UI.rankFilter||g.tournamentName===UI.rankFilter).filter(g=>g.finalHand&&(g.finalHand.rank||g.finalHand.cards)).sort((a,b)=>(b.date||'').localeCompare(a.date||''));const root=h(`<div class="page">
  ${navHtml('ranking')}
  <section class="panel" style="display:grid;gap:12px">
    <div class="row spread"><h2>Ranking</h2><div class="field" style="min-width:200px"><label for="rkFilter">Torneio</label><select id="rkFilter"><option value="">Todos</option>${names.map(nm=>`<option ${nm===UI.rankFilter?'selected':''}>${esc(nm)}</option>`).join('')}</select></div></div>
    ${rk.length?`<div class="twrap"><table><thead><tr><th>#</th><th>Jogador</th><th>Pontos</th><th>Partidas</th><th>Vitórias</th><th>Pódios</th><th>Eliminações</th><th>Prêmios</th><th>Melhor</th></tr></thead><tbody>${rk.map((m,i)=>`<tr class="${i===0?'rank1':''}"><td class="${i<3?'pod':''}">${i+1}</td><td style="text-align:left;font-weight:600">${esc(m.name)}</td><td class="num" style="font-weight:700">${fmtN(m.points)}</td><td class="num">${m.games}</td><td class="num">${m.wins}</td><td class="num">${m.podiums}</td><td class="num">${m.kos}</td><td class="num">${m.prize?money({currency:m.cur},m.prize):'—'}</td><td class="num">${m.best?ord(m.best):'—'}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">Sem partidas salvas ainda. O ranking soma os pontos de cada partida do histórico.</p>'}
  </section>
  <section class="panel" style="display:grid;gap:12px">
    <h3>Mãos vencedoras</h3>
    ${finals.length?`<ul class="elist">${finals.map(g=>`<li><b style="flex-basis:90px">${fmtDate(g.date)}</b><span><b style="font-family:inherit;font-size:inherit;color:inherit">${esc(champion(g)||'—')}</b> <span class="muted">· ${esc(g.tournamentName)} ·</span> <span class="cards">${esc(g.finalHand.rank)}${g.finalHand.cards?' '+cardsHtml(g.finalHand.cards):''}</span></span></li>`).join('')}</ul>`:'<p class="muted">Registre a mão final ao fechar a partida e ela aparece aqui.</p>'}
  </section>
  ${helpOpen?helpHtml():''}
</div>`);bindNav(root);on(root,'#rkFilter','change',e=>{UI.rankFilter=e.target.value;saveUI();render()});return root}

/* ---------- dialog ---------- */
function viewDialog(){const d=dialog;const el=h(`<div class="overlay" role="dialog" aria-modal="true"><div class="dialog"><p style="white-space:pre-line">${esc(d.msg)}</p>${d.extraHtml||''}<div class="btns">${d.btns.map((b,i)=>`<button class="btn ${b.kind||''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div></div></div>`);on(el,'[data-i]','click',e=>{d.btns[+e.currentTarget.dataset.i].fn()});setTimeout(()=>{const f=el.querySelector('select,textarea,input,button');if(f)f.focus()},0);return el}

/* ---------- keyboard & routing ---------- */
document.addEventListener('keydown',e=>{if(e.code==='Space'&&view==='clock'&&!dialog&&!/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)&&!(e.target.tagName==='BUTTON'&&e.target.id!=='cPlay')){e.preventDefault();togglePlay()}if(e.key==='Escape'&&dialog){closeDialog()}});
window.addEventListener('hashchange',()=>{if(location.hash==='#tv'&&view!=='tv'){view='tv';render()}else if(location.hash!=='#tv'&&view==='tv'){view=S.live?'clock':'home';render()}});

/* ---------- boot ---------- */
function start(){if(location.hash==='#tv')view='tv';render();initStore()}
if(window.claude&&window.claude.hot&&window.claude.hot.ready){window.claude.hot.ready(start)}else{start()}
})();
