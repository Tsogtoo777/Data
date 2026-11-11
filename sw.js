/* Offline app shell: never cache Supabase auth or database requests. */
const CACHE='data-event-offline-shell-20261111';
const CORE=['/','/index.html','/offline-store.js','/offline-integration.js','/manifest.webmanifest','/icon-192.png','/icon-512.png'];
const LIBRARIES=['https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2','https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js'];
self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    for(const url of CORE.concat(LIBRARIES)){
      try{
        const req=new Request(url,{mode:url.startsWith('https:')?'no-cors':'same-origin',credentials:'omit'});
        const res=await fetch(req);
        if(res&&(res.ok||res.type==='opaque'))await cache.put(req,res);
      }catch(_){}
    }
    await self.skipWaiting();
  })());
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const names=await caches.keys();
    await Promise.all(names.filter(k=>k.startsWith('data-event-offline-shell-')&&k!==CACHE).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',event=>{
  const req=event.request;if(req.method!=='GET')return;
  const u=new URL(req.url);
  if(u.hostname.endsWith('.supabase.co')||u.pathname.startsWith('/api/'))return;
  const local=u.origin===self.location.origin,library=LIBRARIES.some(x=>req.url.startsWith(x));
  if(!local&&!library)return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    try{
      const fresh=await fetch(req);
      if(fresh&&(fresh.ok||fresh.type==='opaque'))await cache.put(req,fresh.clone());
      return fresh;
    }catch(_){
      const prior=await cache.match(req,{ignoreSearch:local});
      if(prior)return prior;
      if(req.mode==='navigate'){
        const fallback=await cache.match('/index.html');
        if(fallback)return fallback;
      }
      return Response.error();
    }
  })());
});
