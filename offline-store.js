/* IndexedDB queue for offline Data Event status drafts; no session tokens stored. */
(function(root){
'use strict';
const DB_NAME='DataEventOfflineV1';
let promise;
function db(){
  if(!root.indexedDB) return Promise.reject(Error('IndexedDB боломжгүй'));
  if(!promise)promise=new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,1);
    request.onupgradeneeded=()=>{
      const d=request.result;
      if(!d.objectStoreNames.contains('queue')) d.createObjectStore('queue',{keyPath:'requestId'});
      if(!d.objectStoreNames.contains('snapshots'))d.createObjectStore('snapshots');
      if(!d.objectStoreNames.contains('users'))d.createObjectStore('users');
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>{promise=null;reject(request.error||Error('IndexedDB алдаа'));};
  });
  return promise;
}
async function tx(name,mode,run){
  const d=await db();
  return new Promise((resolve,reject)=>{
    const t=d.transaction(name,mode),store=t.objectStore(name);let value;
    let req;try{req=run(store)}catch(e){t.abort();reject(e);return;}
    if(req)req.onsuccess=()=>{value=req.result};
    t.oncomplete=()=>resolve(value);
    t.onerror=()=>reject(t.error||Error('IndexedDB алдаа'));
    t.onabort=()=>reject(t.error||Error('Бүртгэл хадгалагдсангүй'));
  });
}
const read=(s,k)=>tx(s,'readonly',o=>o.get(k));
const write=(s,k,v)=>tx(s,'readwrite',o=>o.put(v,k));
function notify(){root.dispatchEvent(new CustomEvent('data-offline-queue-changed'));}
async function list(uid){
  const all=await tx('queue','readonly',o=>o.getAll());
  return (all||[]).filter(x=>x.userId===String(uid)).sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)||a.requestId.localeCompare(b.requestId));
}
async function addStatus(uid,d){
  if(!uid||!d.equipmentId||!d.status)throw Error('Техник, төлөв, хэрэглэгч дутуу');
  const row={
    requestId:crypto.randomUUID(),userId:String(uid),kind:'status',
    equipmentId:String(d.equipmentId),equipmentName:String(d.equipmentName||d.equipmentId),
    status:String(d.status),operator:String(d.operator||''),comment:String(d.comment||''),
    smu:d.smu==null?null:Number(d.smu),km:d.km==null?null:Number(d.km),
    recordedAt:new Date().toISOString(),state:'pending',error:''
  };
  await tx('queue','readwrite',o=>o.add(row));notify();return row;
}
async function updateRecord(r){await tx('queue','readwrite',o=>o.put(r));notify();}
async function deleteRecord(id){await tx('queue','readwrite',o=>o.delete(id));notify();}
async function rememberUser(u){
  if(u?.id)await write('users','latest',{id:String(u.id),app_metadata:{role:String(u.app_metadata?.role||'')}});
}
const lastUser=()=>read('users','latest');
const forgetUser=()=>tx('users','readwrite',o=>o.delete('latest'));
const saveSnapshot=(uid,data)=>write('snapshots',String(uid),{savedAt:new Date().toISOString(),data});
const getSnapshot=uid=>uid?read('snapshots',String(uid)):Promise.resolve(null);
root.DataOffline={list,addStatus,updateRecord,deleteRecord,rememberUser,lastUser,forgetUser,saveSnapshot,getSnapshot};
})(window);
