/* Offline status registration bridge. SQL is installed separately after review. */
(function(){
'use strict';
const store=window.DataOffline;if(!store)return;
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
const display=t=>new Date(t).toLocaleString('mn-MN',{timeZone:'Asia/Ulaanbaatar',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const user=()=>activeSession?.user?.id||null;
const onlineSession=()=>!!activeSession?.user?.id && !!activeSession.access_token && activeSession.access_token!=='offline-only' && !authNeedsLogin;
let busy=false,opened=false,preparing=false;
// Local view only. This must not overwrite the authoritative Supabase equipment state.
let visualUser=null,visualRows=new Map();
function latestServerEventTime(equipmentId){
  let latest=0;
  for(const ev of events){
    if(String(ev.equipment_id)!==String(equipmentId))continue;
    const t=Date.parse(ev.start_time);
    if(Number.isFinite(t)&&t>latest)latest=t;
  }
  return latest;
}
function visualStatusHtml(item){
  const row=visualUser===user()?visualRows.get(String(item.id)):null;
  const fallback=item.current_status||'Бэлэн нөөцөнд зогсож байна | ЭЦС';
  const serverNewer=!!row&&latestServerEventTime(item.id)>=Date.parse(row.recordedAt);
  const status=row&&!serverNewer?row.status:fallback;
  const chip='<span class="status-chip '+esc(statusClass(status))+'">'+esc(status)+'</span>';
  if(!row)return chip;
  const conflict=['conflict','needs-review'].includes(row.state);
  const note=serverNewer?'⚠ Хожуу серверийн төлөв байна · Offline бүртгэлээ шалга'
    :conflict?'⚠ Синк зөрчилтэй · Жагсаалтаар шалга':'⏳ Синк хүлээж байна';
  const info='Утсанд хадгалсан '+display(row.recordedAt)+'. Серверт баталгаажаагүй.';
  return chip+'<div class="offline-status-note'+(conflict||serverNewer?' offline-status-warning':'')+'" title="'+esc(info)+'" role="status">'+note+'</div>';
}
function paintVisualStatuses(uid,rows){
  if(uid!==user())return;
  visualUser=uid;
  const next=new Map();
  // Queue is chronologically sorted. Show the most recently captured status per machine.
  for(const row of rows){
    if(!row||!row.equipmentId||row.kind!=='status')continue;
    const key=String(row.equipmentId),old=next.get(key);
    if(!old||row.recordedAt>=old.recordedAt)next.set(key,row);
  }
  visualRows=next;
  for(const node of document.querySelectorAll('[data-offline-status-for]')){
    const eq=equipment.find(x=>String(x.id)===node.dataset.offlineStatusFor);
    if(eq)node.innerHTML=visualStatusHtml(eq);
  }
}
const coreShell=['/','/index.html','/offline-store.js','/offline-integration.js'];
async function cachedShellReady(){
  if(!('caches' in window))return false;
  try{
    const entries=await Promise.all(coreShell.map(path=>caches.match(path)));
    return entries.every(Boolean);
  }catch(_){return false;}
}
async function prepareOffline(){
  if(preparing)return;
  if(!navigator.onLine)return toast('Offline бэлдэхэд интернэт хэрэгтэй.');
  if(!user())return toast('Эхлээд Data Event-д нэвтэрнэ үү.');
  preparing=true;await renderQueue();
  try{
    await loadData();
    const snap=await store.getSnapshot(user());
    if(!snap?.data?.equipment?.length||!snap.data.statuses?.length)throw Error('Техник, төлөвийн жагсаалт хадгалагдаагүй.');
    if(!('serviceWorker' in navigator)||!('caches' in window))throw Error('Энэ браузер offline page cache дэмжихгүй байна.');
    const registration=await navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'});
    await navigator.serviceWorker.ready;
    // Prime the same-origin shell in the active versioned cache as well as the SW install step.
    const cache=await caches.open('data-event-offline-shell-20261111');
    for(const path of coreShell){
      const res=await fetch(path,{cache:'reload'});
      if(!res.ok)throw Error('Offline файл татагдсангүй: '+path);
      await cache.put(path,res.clone());
    }
    for(const url of ['https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
                       'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js']){
      try{
        const req=new Request(url,{mode:'no-cors',credentials:'omit'});
        const res=await fetch(req);
        if(res?.type==='opaque'||res?.ok)await cache.put(req,res);
      }catch(_){/* Readable offline shell remains usable for status input. */}
    }
    if(!(await cachedShellReady()))throw Error('Offline веб файлууд бүрэн хадгалагдсангүй.');
    toast('Offline бэлэн: техник ба төлөв хадгалагдлаа.');
  }catch(e){alert('Offline бэлтгэл дуусаагүй: '+e.message);}
  finally{preparing=false;await renderQueue();}
}
const css=document.createElement('style');
css.textContent='#offlineQBar{position:fixed;left:12px;bottom:12px;z-index:70;background:#252c35;color:white;border:1px solid #fa9d3b;border-radius:9px;padding:8px 10px;font-size:13px;box-shadow:0 5px 20px #0006}#offlineQBar button{margin-left:7px}#offlineQPanel{position:fixed;inset:0;z-index:90;background:#000c;display:flex;align-items:center;justify-content:center;padding:12px}#offlineQPanel[hidden]{display:none}#offlineQContent{background:#242b33;color:white;border-radius:12px;border:1px solid #555;width:min(580px,100%);padding:14px;max-height:85vh;overflow:auto}#offlineQRows article{border-top:1px solid #4c5965;padding:10px 0}#offlineQRows .offline-error{color:#ffc28a;white-space:pre-wrap}';
css.textContent+='.current .offline-status-note{display:inline-block;margin-top:6px;font-size:11px;line-height:1.4;font-weight:600;color:#e6bc75;background:rgba(101,70,32,.18);border:1px solid rgba(242,167,62,.35);border-radius:6px;padding:3px 7px}.current .offline-status-warning{color:#ffa19a;background:rgba(110,37,37,.24);border-color:rgba(248,123,110,.55)}';
css.textContent+='#offlineQBar{left:auto;bottom:auto;top:calc(86px + env(safe-area-inset-top,0px));right:8px;width:auto;max-width:180px;padding:4px 5px;border-radius:24px;opacity:.96}#offlineQBar button{margin:0;background:transparent;border:0;color:inherit;min-height:34px;padding:4px 9px;font-weight:700;font-size:12px;white-space:nowrap}body:has(#statusModal.open) #offlineQBar{display:none!important}';
document.head.append(css);
const bar=document.createElement('div');bar.id='offlineQBar';bar.setAttribute('role','status');document.body.append(bar);
const panel=document.createElement('div');panel.id='offlineQPanel';panel.hidden=true;
panel.innerHTML='<div id="offlineQContent"><div style="display:flex;gap:12px;justify-content:space-between"><h2>Offline бүртгэлүүд</h2><button id="offlineQClose">Хаах</button></div><p>Эдгээр бүртгэл серверт баталгаажаагүй. Синк дуустал браузерын өгөгдөл цэвэрлэж болохгүй.</p><p id="offlineQReadyNote" style="font-size:12px;color:#ffd69e"></p><div id="offlineQPreparePanel"></div><div id="offlineQRows"></div><button type="button" id="offlineQRetry">Дахин илгээх</button></div>';
document.body.append(panel);
$('offlineQClose').onclick=()=>{opened=false;panel.hidden=true};
panel.onclick=e=>{if(e.target===panel){opened=false;panel.hidden=true}};
$('offlineQRetry').onclick=()=>void retryPending();
async function retryPending(){
  if(!navigator.onLine){toast('Дахин илгээхэд интернэт хэрэгтэй.');return;}
  const uid=user();if(!uid){toast('Эхлээд нэвтэрнэ үү.');return;}
  for(const row of await store.list(uid)){
    if(row.state==='setup-required'){
      row.state='pending';row.error='';
      await store.updateRecord(row);
    }
  }
  await sync();
}
async function renderQueue(){
  let rows=[];
  try{if(user())rows=await store.list(user());}catch(e){bar.textContent='Offline санах ой алдаа: '+e.message;return;}
  paintVisualStatuses(user(),rows);
  let snap=null;try{if(user())snap=await store.getSnapshot(user());}catch(_){}
  const dataReady=!!(snap?.data?.equipment?.length&&snap?.data?.statuses?.length);
  const shellReady=await cachedShellReady();
  const ready=dataReady&&shellReady;
  const label=navigator.onLine?(ready?'● Online · Offline бэлэн':'● Online · Offline бэлтгэлгүй'):(ready?'● Offline · Хадгалсан мэдээлэл':'● Offline · Бэлтгэлгүй');
  bar.innerHTML='<button type="button" id="offlineQOpen" aria-label="Offline бүртгэлийн жагсаалт, илгээгдээгүй '+rows.length+'">'+(navigator.onLine?'● Online':'● Offline')+' · '+rows.length+'</button>';
  $('offlineQOpen').onclick=()=>{opened=true;panel.hidden=false;void renderQueue();};
  const note=$('offlineQReadyNote');if(note)note.textContent=label+' · Илгээгдээгүй: '+rows.length;
  const tools=$('offlineQPreparePanel');
  if(tools){tools.innerHTML=!ready&&navigator.onLine?'<button type="button" id="offlineQPrepare">Offline бэлдэх</button>':'';const btn=$('offlineQPrepare');if(btn){btn.disabled=preparing;btn.onclick=()=>void prepareOffline();}}
  if(!opened)return;
  $('offlineQRows').innerHTML=rows.length?rows.map(row=>'<article><b>'+esc(row.equipmentName)+' · '+esc(row.status)+'</b><div>'+display(row.recordedAt)+' (УБ цаг)</div><small>Оператор: '+esc(row.operator||'—')+'</small><p>'+esc(row.comment||'')+'</p>'+(row.smu!==null||row.km!==null?'<p>SMU: '+esc(row.smu??'—')+' · KM: '+esc(row.km??'—')+'</p>':'')+'<div class="offline-error">'+esc(row.error||'Серверт илгээгээгүй')+'</div><button type="button" data-offline-delete="'+esc(row.requestId)+'">Утсан дээрх бүртгэлийг устгах</button></article>').join(''):'<p>Хүлээгдсэн бүртгэл алга.</p>';
  for(const b of $('offlineQRows').querySelectorAll('[data-offline-delete]'))b.onclick=async()=>{
    if(!confirm('Серверт ороогүй энэ бүртгэлийг бүрмөсөн устгах уу?'))return;
    await store.deleteRecord(b.dataset.offlineDelete);
  };
}
async function queueStatus(equipmentId,status,details){
  if(!statusEditorU5()||!user())throw Error('Энэ утсанд өмнө нь нэвтэрсэн бүртгэгч шаардлагатай.');
  const eq=equipment.find(e=>String(e.id)===String(equipmentId));
  if(!eq)throw Error('Техникийн лавлах хадгалагдаагүй.');
  const smu=MeterCoreQ6.parseValue(details?.smu),km=MeterCoreQ6.parseValue(details?.km);
  const row=await store.addStatus(user(),{equipmentId,equipmentName:eq.name,status,operator:getOperator(equipmentId),comment:String(details?.comment||'').trim(),smu,km});
  closeStatusModal();toast('Утсанд хадгаллаа: '+display(row.recordedAt)+' · Серверт ороогүй');
  await renderQueue();return row;
}
async function syncNow(){
  if(busy||!navigator.onLine||!onlineSession())return;
  const uid=user();busy=true;let count=0;
  try{
    const rows=await store.list(uid);
    for(const row of rows){
      if(!navigator.onLine||!onlineSession()||user()!==uid)break;
      if(['conflict','needs-review'].includes(row.state))continue;
      // Missing RPC can be installed later; retry with the SAME UUID (never create a duplicate).
      if(row.state==='setup-required'&&Date.now()-Date.parse(row.lastAttemptAt||'1970-01-01')<300000)continue;
      if(row.smu!==null||row.km!==null){
        row.state='needs-review';row.error='Энэ төлөвийн мотоцаг/км заалтыг тусад нь тулгаж шалгах хэрэгтэй. Автоматаар илгээсэнгүй.';
        await store.updateRecord(row);continue;
      }
      try{
        row.lastAttemptAt=new Date().toISOString();
        await store.updateRecord(row);
        const result=await apiRpc('ets_offline_status_v1',{
          p_request:row.requestId,p_equipment:row.equipmentId,p_status:row.status,
          p_recorded_at:row.recordedAt,p_operator:row.operator||null,p_comment:row.comment||null
        });
        if(result?.ok&&result?.event_id){await store.deleteRecord(row.requestId);count++;continue;}
        row.state=result?.code==='CONFLICT'?'conflict':'needs-review';
        row.error=String(result?.message||'Серверээс хадгалсан баталгаа алга.');
        await store.updateRecord(row);
      }catch(e){
        const msg=String(e?.message||e);
        row.state=e?.status===404||/could not find the function|ets_offline_status_v1/i.test(msg)?'setup-required':'pending';
        row.error=row.state==='setup-required'?'Offline sync SQL серверт суулгагдаагүй.':msg;
        await store.updateRecord(row);break;
      }
    }
    if(count){try{await loadData()}catch(_){}toast(count+' offline бүртгэл серверт баталгаажлаа.');}
  }finally{busy=false;await renderQueue();}
}
async function sync(){
  if(!navigator.onLine)return renderQueue();
  if(activeSession?.access_token==='offline-only'){
    try{
      const {data,error}=await authClient.auth.getSession();
      if(error||!data?.session){needsDataLogin();return;}
      await applySession(data.session);
    }catch(_){return;}
  }
  if(navigator.locks?.request){
    await navigator.locks.request('data-event-offline-sync',{ifAvailable:true},async lock=>{if(lock)await syncNow()});
  }else await syncNow();
}
window.DataEventOfflineBridge={queueStatus,sync,renderQueue,visualStatusHtml};
window.addEventListener('data-offline-queue-changed',()=>void renderQueue());
document.addEventListener('data-offline-snapshot-saved',()=>void renderQueue());
document.addEventListener('data-offline-snapshot-loaded',()=>void renderQueue());
window.addEventListener('offline',()=>void renderQueue());
window.addEventListener('online',()=>void sync());
window.addEventListener('focus',()=>void sync());
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void sync()});
setInterval(()=>{if(!document.hidden)void sync()},30000);
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).catch(()=>{});
void renderQueue();setTimeout(()=>void sync(),1500);
})();
