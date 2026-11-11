/* Offline status registration bridge. SQL is installed separately after review. */
(function(){
'use strict';
const store=window.DataOffline;if(!store)return;
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
const display=t=>new Date(t).toLocaleString('mn-MN',{timeZone:'Asia/Ulaanbaatar',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const user=()=>activeSession?.user?.id||null;
const onlineSession=()=>!!activeSession?.user?.id && !!activeSession.access_token && activeSession.access_token!=='offline-only' && !authNeedsLogin;
let busy=false,opened=false;
const css=document.createElement('style');
css.textContent='#offlineQBar{position:fixed;left:12px;bottom:12px;z-index:70;background:#252c35;color:white;border:1px solid #fa9d3b;border-radius:9px;padding:8px 10px;font-size:13px;box-shadow:0 5px 20px #0006}#offlineQBar button{margin-left:7px}#offlineQPanel{position:fixed;inset:0;z-index:90;background:#000c;display:flex;align-items:center;justify-content:center;padding:12px}#offlineQPanel[hidden]{display:none}#offlineQContent{background:#242b33;color:white;border-radius:12px;border:1px solid #555;width:min(580px,100%);padding:14px;max-height:85vh;overflow:auto}#offlineQRows article{border-top:1px solid #4c5965;padding:10px 0}#offlineQRows .offline-error{color:#ffc28a;white-space:pre-wrap}';
document.head.append(css);
const bar=document.createElement('div');bar.id='offlineQBar';bar.setAttribute('role','status');document.body.append(bar);
const panel=document.createElement('div');panel.id='offlineQPanel';panel.hidden=true;
panel.innerHTML='<div id="offlineQContent"><div style="display:flex;gap:12px;justify-content:space-between"><h2>Offline бүртгэлүүд</h2><button id="offlineQClose">Хаах</button></div><p>Эдгээр бүртгэл серверт баталгаажаагүй. Синк дуустал браузерын өгөгдөл цэвэрлэж болохгүй.</p><div id="offlineQRows"></div><button type="button" id="offlineQRetry">Дахин илгээх</button></div>';
document.body.append(panel);
$('offlineQClose').onclick=()=>{opened=false;panel.hidden=true};
panel.onclick=e=>{if(e.target===panel){opened=false;panel.hidden=true}};
$('offlineQRetry').onclick=()=>void sync();
async function renderQueue(){
  let rows=[];
  try{if(user())rows=await store.list(user());}catch(e){bar.textContent='Offline санах ой алдаа: '+e.message;return;}
  bar.innerHTML='<span>'+(navigator.onLine?'● Online':'● Offline')+' · Илгээгээгүй: <strong>'+rows.length+'</strong></span><button type="button" id="offlineQOpen">Жагсаалт</button>';
  $('offlineQOpen').onclick=()=>{opened=true;panel.hidden=false;void renderQueue();};
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
      if(['conflict','needs-review','setup-required'].includes(row.state))continue;
      if(row.smu!==null||row.km!==null){
        row.state='needs-review';row.error='Энэ төлөвийн мотоцаг/км заалтыг тусад нь тулгаж шалгах хэрэгтэй. Автоматаар илгээсэнгүй.';
        await store.updateRecord(row);continue;
      }
      try{
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
window.DataEventOfflineBridge={queueStatus,sync,renderQueue};
window.addEventListener('data-offline-queue-changed',()=>void renderQueue());
window.addEventListener('offline',()=>void renderQueue());
window.addEventListener('online',()=>void sync());
window.addEventListener('focus',()=>void sync());
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void sync()});
setInterval(()=>{if(!document.hidden)void sync()},30000);
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).catch(()=>{});
void renderQueue();setTimeout(()=>void sync(),1500);
})();
