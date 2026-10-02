#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadCatalog, status, fingerprint, adoptBaseline, applyMigrations, reconcile } from './migration-engine.mjs';

const args=process.argv.slice(2);
const valueFlags=new Set(['--root','--commit','--reconcile','--record-manual']);
const allowed=new Set(['--catalog','--status','--check','--dry-run','--fingerprint','--baseline','--apply','--yes-i-know-this-is-production',...valueFlags]);
for(let i=0;i<args.length;i++){if(!allowed.has(args[i]))throw Error(`Unknown option: ${args[i]}`);if(valueFlags.has(args[i])){if(!args[i+1]||args[i+1].startsWith('--'))throw Error(`Missing value for ${args[i]}`);i++;}}
const flag=name=>args.includes(name);
function value(name){const i=args.indexOf(name);if(i<0)return undefined;if(!args[i+1]||args[i+1].startsWith('--'))throw Error(`Missing value for ${name}`);return args[i+1];}
const root=path.resolve(value('--root')??path.join(path.dirname(fileURLToPath(import.meta.url)),'../..'));
const catalog=loadCatalog(root);
const commands=['--catalog','--status','--check','--dry-run','--fingerprint','--baseline','--apply','--reconcile','--record-manual'].filter(flag);
if(commands.length>1)throw Error('Choose exactly one migration command');
const command=commands[0]??'--status';
async function main(){
 if(command==='--catalog'){console.log(JSON.stringify({digest:catalog.digest,total:catalog.migrations.length,historical:catalog.migrations.filter(m=>m.historical).length,pendingFiles:catalog.migrations.filter(m=>!m.historical).map(m=>({file:m.filename,mode:m.mode}))}));return;}
 const pg=(await import('pg')).default;
 const connectionString=process.env.DATABASE_URL;
 const url=connectionString?new URL(connectionString):null;
 const host=url?.hostname??process.env.DB_POSTGRESDB_HOST??process.env.DB_HOST;
 if(!host)throw Error('DATABASE_URL or DB_POSTGRESDB_HOST is required');
 const local=['localhost','127.0.0.1','::1'].includes(host);
 const write=['--baseline','--apply','--reconcile','--record-manual'].includes(command);
 if(write&&!local&&!flag('--yes-i-know-this-is-production'))throw Error('Remote writes require --yes-i-know-this-is-production');
 const sslValue=process.env.DB_POSTGRESDB_SSL??process.env.DB_SSL;
 let ssl=local||sslValue==='false'?false:{rejectUnauthorized:process.env.DB_SSL_REJECT_UNAUTHORIZED!=='false'};
 // Explicit TLS policy must not be silently replaced by connection-string options.
 if(url)for(const key of ['sslmode','sslcert','sslkey','sslrootcert','uselibpqcompat'])url.searchParams.delete(key);
 const client=new pg.Client({...(url?{connectionString:url.toString()}:{host,port:Number(process.env.DB_POSTGRESDB_PORT??process.env.DB_PORT??5432),database:process.env.DB_POSTGRESDB_DATABASE??process.env.DB_NAME,user:process.env.DB_POSTGRESDB_USER??process.env.DB_USER,password:process.env.DB_POSTGRESDB_PASSWORD??process.env.DB_PASSWORD}),ssl,connectionTimeoutMillis:15000,application_name:'verified-migrations'});
 await client.connect();
 try{
  await client.query("SET statement_timeout='10min'; SET lock_timeout='10s'; SET idle_in_transaction_session_timeout='60s'");
  let result;
  if(command==='--fingerprint')result=await fingerprint(client);
  else if(['--status','--check','--dry-run'].includes(command)){
   result=await status(client,catalog);
   if(command==='--check'&&(!result.managed||result.pending.length))throw Error(`Migration check failed: managed=${result.managed}, pending=${result.pending.length}`);
  }else{
   const commit=value('--commit')??execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
   if(!/^[0-9a-f]{40}$/.test(commit))throw Error('A full source commit is required');
   if(command==='--baseline')result=await adoptBaseline(client,catalog,commit);
   if(command==='--apply')result=await applyMigrations(client,catalog,commit);
   if(command==='--reconcile'||command==='--record-manual')result=await reconcile(client,catalog,commit,value(command),command==='--record-manual');
  }
  console.log(JSON.stringify({...result,catalogDigest:catalog.digest}));
 }finally{await client.end();}
}
main().catch(e=>{console.error(JSON.stringify({error:e.message,code:e.code??null}));process.exitCode=1;});
