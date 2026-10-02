'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSource}=require('../source.cjs');
const {safeCode}=require('../daily.cjs');
test('daily source requires renewable login, uses expected hosts and redacts errors',async()=>{
 assert.throws(()=>createSource('zeus',{}),/AUTO_LOGIN_REQUIRED/);
 const env=Object.fromEntries(['API_KEY','ADMIN_USER','ADMIN_PASSWORD','LOGIN_CLIENT_ID','LOGIN_CLIENT_SECRET'].map(k=>['ZEUS_'+k,'fixture']));
 const source=createSource('zeus',env),previous=global.fetch;
 try{
  global.fetch=async(url,options)=>{assert.equal(new URL(url).hostname,'admin.zeuscasino.fun');assert.equal(options.redirect,'error');return new Response(JSON.stringify({access_token:'fixture-token'}));};
  await source.authenticate();assert.equal(source.playerToken,'fixture-token');
  global.fetch=async()=>{throw Error('password=private-value');};
  await assert.rejects(source.authenticate(),/AUTH_NETWORK_FAILED/);
  assert.equal(safeCode(Error('password=private-value')),'DAILY_FAILED');
 }finally{global.fetch=previous;}
});
