#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadCatalog, sha256 } from './migration-engine.mjs';
import { requireGithubValidation } from './github-validation.mjs';

export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
export function sourceIdentity(root){
 if(git(root,'status','--porcelain','--untracked-files=all'))throw Error('Release requires a clean Git checkout, including untracked files');
 return {commit:git(root,'rev-parse','HEAD'),tree:git(root,'rev-parse','HEAD^{tree}')};
}
export function inventory(root){
 const out={};function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=path.join(dir,e.name),name=path.relative(root,p).split(path.sep).join('/');
  if(e.isSymbolicLink())throw Error(`Symlinks are not allowed in release artifacts: ${name}`);
  if(e.isDirectory())walk(p);else if(e.isFile()&&name!=='release-manifest.json')out[name]=sha256(fs.readFileSync(p));
 }}walk(root);return out;
}
function assertSafeFiles(files){for(const name of Object.keys(files)){
 if(/(^|\/)(?:\.git|node_modules|\.next|\.local-tools)(?:\/|$)|(^|\/)\.env(?:$|\.)|\.(?:pem|key|p12|pfx)$|(^|\/)(?:credentials|secrets)\.json$/.test(name)&&!name.endsWith('/.env.example')&&name!=='.env.example')throw Error(`Private/generated file in Git release: ${name}`);
}}
export function prepare(root,output,expectedActive){
 const identity=sourceIdentity(root),catalog=loadCatalog(root);
 if(!expectedActive)throw Error('--expect-active deployment ID is required');
 const proof=JSON.parse(fs.readFileSync(path.join(root,'.local-tools/release-validation.json'),'utf8'));
 if(proof.commit!==identity.commit||proof.tree!==identity.tree||proof.catalogDigest!==catalog.digest||proof.ok!==true)throw Error('Validation does not match this exact Git commit/tree/catalog');
 if(fs.existsSync(output))throw Error('Artifact destination already exists');
 fs.mkdirSync(output,{recursive:true});
 try{
  const archive=execFileSync('git',['archive','--format=tar',identity.commit],{cwd:root,maxBuffer:64*1024*1024});
  execFileSync('tar',['-xf','-','-C',output],{input:archive});
  assertSafeFiles(inventory(output));
  const release={...identity,catalogDigest:catalog.digest,expectedActive,validatedAt:proof.at};
  fs.mkdirSync(path.join(output,'frontend/public'),{recursive:true});
  fs.writeFileSync(path.join(output,'frontend/public/release.json'),JSON.stringify(release)+'\n');
  const files=inventory(output);const manifest={...release,files,digest:sha256(JSON.stringify(files))};
  fs.writeFileSync(path.join(output,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
 }catch(e){fs.rmSync(output,{recursive:true,force:true});throw e;}
}
export function verifyArtifact(dir){
 const m=JSON.parse(fs.readFileSync(path.join(dir,'release-manifest.json'),'utf8'));const files=inventory(dir);assertSafeFiles(files);
 if(JSON.stringify(files)!==JSON.stringify(m.files)||sha256(JSON.stringify(files))!==m.digest)throw Error('Release artifact was modified after preparation');
 if(!/^[a-f0-9]{40}$/.test(m.commit)||!m.expectedActive||loadCatalog(dir).digest!==m.catalogDigest)throw Error('Invalid release identity/catalog');
 const published=JSON.parse(fs.readFileSync(path.join(dir,'frontend/public/release.json'),'utf8'));
 if(published.commit!==m.commit||published.tree!==m.tree||published.catalogDigest!==m.catalogDigest)throw Error('Public release identity mismatch');
 return m;
}
function run(command,args,cwd=ROOT,env=process.env){const r=spawnSync(command,args,{cwd,env,stdio:'inherit'});if(r.error)throw r.error;if(r.status!==0)throw Error(`${path.basename(command)} failed (${r.status})`);}
export function validate(root=ROOT){
 const identity=sourceIdentity(root),catalog=loadCatalog(root);
 if(Number(process.versions.node.split('.')[0])!==20)throw Error('Validation must use Node.js 20, matching production');
 if(!process.env.OPS_TEST_DATABASE_URL)throw Error('OPS_TEST_DATABASE_URL is required for migration integration tests (localhost only)');
 const steps=[
  [process.execPath,['--test','tests/contacts-segmentation.integration.cjs'],root,{...process.env,CONTACTS_TEST_DATABASE_URL:process.env.OPS_TEST_DATABASE_URL}],
  [process.execPath,['--test',...fs.readdirSync(path.join(root,'scripts/ops/tests')).filter(f=>f.endsWith('.test.mjs')).map(f=>`scripts/ops/tests/${f}`)],root],
  ['npm',['test'],path.join(root,'frontend'),{...process.env,CONTACTS_TEST_DATABASE_URL:process.env.OPS_TEST_DATABASE_URL}],
  [process.execPath,['node_modules/vitest/vitest.mjs','run','lib/__tests__/dashboard-account-history-postgres.test.ts','lib/__tests__/dashboard-financial-ledger-postgres.test.ts','lib/__tests__/dashboard-latest-history-postgres.test.ts'],path.join(root,'frontend'),{...process.env,RUN_DASHBOARD_PG_TESTS:'1',DATABASE_URL:process.env.OPS_TEST_DATABASE_URL}],
  [process.execPath,['node_modules/vitest/vitest.mjs','run','lib/__tests__/cloud-conversations-postgres.test.ts','lib/__tests__/sticker-favorites-postgres.test.ts','lib/__tests__/priority-broadcasts-postgres.test.ts'],path.join(root,'frontend'),{...process.env,RUN_CAMPAIGN_PG_TESTS:'1',DATABASE_URL:process.env.OPS_TEST_DATABASE_URL}],
  [process.execPath,['node_modules/vitest/vitest.mjs','run','lib/__tests__/missing-contacts-postgres.test.ts'],path.join(root,'frontend'),{...process.env,RUN_MISSING_CONTACTS_PG_TESTS:'1',DATABASE_URL:process.env.OPS_TEST_DATABASE_URL}],
  [process.execPath,['node_modules/next/dist/bin/next','typegen'],path.join(root,'frontend')],
  [process.execPath,['node_modules/typescript/bin/tsc','--noEmit','--incremental','false'],path.join(root,'frontend')],
  ['npm',['run','build'],path.join(root,'frontend')],
 ];
 for(const [cmd,args,cwd,env] of steps)run(cmd,args,cwd,env??process.env);
 const after=sourceIdentity(root);if(after.commit!==identity.commit||after.tree!==identity.tree)throw Error('Source changed during validation');
 const proof={...identity,catalogDigest:catalog.digest,ok:true,at:new Date().toISOString(),node:process.versions.node,steps:steps.map(([cmd,args])=>[path.basename(cmd),...args])};
 fs.mkdirSync(path.join(root,'.local-tools'),{recursive:true});fs.writeFileSync(path.join(root,'.local-tools/release-validation.json'),JSON.stringify(proof,null,2)+'\n');return proof;
}
async function deploy(dir){
 const manifest=verifyArtifact(dir),identity=sourceIdentity(ROOT);
 if(identity.commit!==manifest.commit||identity.tree!==manifest.tree)throw Error('Deploy tooling must run from the validated source commit');
 // An artifact is accepted only if Git itself produces the same source files.
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'verify-release-'));
 try{
  const archive=execFileSync('git',['archive','--format=tar',manifest.commit],{cwd:ROOT,maxBuffer:64*1024*1024});execFileSync('tar',['-xf','-','-C',temp],{input:archive});
  const source=inventory(temp);for(const [name,hash]of Object.entries(source))if(manifest.files[name]!==hash)throw Error(`Artifact does not match Git: ${name}`);
  if(Object.keys(manifest.files).some(name=>!(name in source)&&name!=='frontend/public/release.json'))throw Error('Unexpected file in release');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
 const config=JSON.parse(fs.readFileSync(path.join(ROOT,'releases/production.json'),'utf8'));
 const githubValidation=requireGithubValidation(config,manifest.commit);
 console.log(JSON.stringify({githubValidation}));
 const cli=process.env.RAILWAY_CLI??'railway';const scope=['--project',config.project,'--service',config.service,'--environment',config.environment];
 const active=()=>{const rows=JSON.parse(execFileSync(cli,['deployment','list',...scope,'--limit','30','--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:45000}));const live=rows.filter(x=>x.status==='SUCCESS');if(live.length!==1)throw Error('Cannot identify a unique active deployment');return live[0].id;};
 if(active()!==manifest.expectedActive)throw Error('Production changed since release preparation; rebase and revalidate');
 const response=await fetch(new URL('/release.json',config.origin),{signal:AbortSignal.timeout(15000),redirect:'manual'});
 if(response.ok){const live=await response.json();if(!/^[a-f0-9]{40}$/.test(live.commit))throw Error('Invalid active release identity');try{git(ROOT,'merge-base','--is-ancestor',live.commit,manifest.commit);}catch{throw Error('Release is not a descendant of the active production commit');}}
 else if(manifest.expectedActive!==loadCatalog(ROOT).baseline.deploymentId)throw Error('Active release identity is unavailable');
 run(process.execPath,['scripts/ops/run-migrations.mjs','--root',dir,'--apply','--commit',manifest.commit,'--yes-i-know-this-is-production']);
 run(process.execPath,['scripts/ops/run-migrations.mjs','--root',dir,'--check']);
 if(active()!==manifest.expectedActive)throw Error('Production changed while checking migrations; deployment cancelled');
 // Re-check after migrations: a newer failed or pending rerun must block upload.
 requireGithubValidation(config,manifest.commit);
 verifyArtifact(dir);
 // Run inside the archive without a path argument: Railway treats an explicit
 // relative path as a different archive prefix and can fail before upload.
 run(cli,['up',...scope,'--detach','--message',`git:${manifest.commit} tree:${manifest.tree} catalog:${manifest.catalogDigest}`],dir);
 return {submitted:true,commit:manifest.commit,expectedActive:manifest.expectedActive};
}
async function main(){
 const [cmd,...args]=process.argv.slice(2);const value=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
 let result;
 if(cmd==='validate')result=validate();
 else if(cmd==='check-ci')result=requireGithubValidation(JSON.parse(fs.readFileSync(path.join(ROOT,'releases/production.json'),'utf8')),sourceIdentity(ROOT).commit);
 else if(cmd==='prepare') {const dest=value('--output');if(!dest)throw Error('--output required');result=prepare(ROOT,path.resolve(dest),value('--expect-active'));result={commit:result.commit,digest:result.digest,files:Object.keys(result.files).length,output:path.resolve(dest)};}
 else if(cmd==='verify')result=verifyArtifact(path.resolve(value('--artifact')??'')),result={commit:result.commit,digest:result.digest,verified:true};
 else if(cmd==='deploy') {if(!value('--artifact'))throw Error('--artifact required');result=await deploy(path.resolve(value('--artifact')));}
 else throw Error('Usage: release.mjs validate | check-ci | prepare --output DIR --expect-active ID | verify/deploy --artifact DIR');
 console.log(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
