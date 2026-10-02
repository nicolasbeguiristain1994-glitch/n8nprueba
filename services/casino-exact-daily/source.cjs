'use strict';
const {setTimeout:delay}=require('node:timers/promises');
function fail(code){throw Object.assign(new Error(code),{code});}
function createSource(platform,env=process.env){
 if(!['zeus','bet30'].includes(platform))fail('PLATFORM_INVALID');
 const prefix=platform.toUpperCase(),domain=platform==='zeus'?'zeuscasino.fun':'bet30.world';
 const required=['API_KEY','ADMIN_USER','ADMIN_PASSWORD','LOGIN_CLIENT_ID','LOGIN_CLIENT_SECRET'];
 if(required.some(k=>!env[prefix+'_'+k]?.trim()))fail('AUTO_LOGIN_REQUIRED');
 const config={timezone:'-03',endpoint:'/api/records/movimiento-fichas'};
 const origin=`https://panel-skin5.${domain}`;
 const source={config,baseUrl:`https://local-admin2.${domain}`,apiKey:env[prefix+'_API_KEY'].trim(),playerToken:null,
  async authenticate(){
   const params=new URLSearchParams({username:env[prefix+'_ADMIN_USER'].trim(),password:env[prefix+'_ADMIN_PASSWORD'].trim(),client_id:env[prefix+'_LOGIN_CLIENT_ID'],client_secret:env[prefix+'_LOGIN_CLIENT_SECRET'],grant_type:'password',source:'pn'});
   let r;try{r=await fetch(`https://admin.${domain}/oauth/v2/token?${params}`,{redirect:'error',headers:{Accept:'application/json',Origin:origin,Referer:origin+'/'},signal:AbortSignal.timeout(30000)});}catch{fail('AUTH_NETWORK_FAILED');}
   if(!r.ok)fail('AUTH_HTTP_'+r.status);
   let body;try{body=await r.json();}catch{fail('AUTH_RESPONSE_INVALID');}
   if(typeof body.access_token!=='string'||!body.access_token)fail('AUTH_RESPONSE_INVALID');
   source.playerToken=body.access_token;
  },
  async _fetchWithRetry(url,options){
   for(let i=0;i<3;i++){
    options.signal.throwIfAborted();let r;
    try{r=await fetch(url,{...options,redirect:'error'});}catch{if(i===2)fail('SOURCE_NETWORK_FAILED');}
    if(r?.ok)return r;
    if(r){const status=r.status;await r.body?.cancel();if(status<500&&status!==429||i===2)fail('SOURCE_HTTP_'+status);}
    await delay(1000*2**i,undefined,{signal:options.signal});
   }
   fail('SOURCE_NETWORK_FAILED');
  }
 };
 return source;
}
module.exports={createSource};
