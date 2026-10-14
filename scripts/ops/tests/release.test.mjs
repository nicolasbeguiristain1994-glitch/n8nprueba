import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync,spawnSync}from'node:child_process';
import {ROOT,sourceIdentity,prepare,verifyArtifact}from'../release.mjs';import{sha256,loadCatalog}from'../migration-engine.mjs';
test('deployment ignore rules preserve all tracked source files and still exclude private runtime files',()=>{
 const files=execFileSync('git',['ls-files','-z'],{cwd:ROOT});
 const result=spawnSync('git',['check-ignore','--no-index','--stdin','-z'],{cwd:ROOT,input:files});
 assert.equal(result.status,1,`Tracked source would be omitted from upload: ${result.stdout.toString().replaceAll('\0',', ')}`);
 const privateFiles=['logs/runtime.txt','frontend/logs/runtime.txt','.env','.local-tools/session.json'];
 const excluded=spawnSync('git',['check-ignore','--no-index','--stdin'],{cwd:ROOT,input:privateFiles.join('\n')+'\n',encoding:'utf8'});
 assert.equal(excluded.status,0);assert.deepEqual(excluded.stdout.trim().split('\n'),privateFiles);
});
test('release requires clean exact validated commit and detects any artifact mutation',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'release-test-')),output=root+'-artifact';const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
 try{
  git('init');git('config','user.email','test@example.invalid');git('config','user.name','Test');
  fs.mkdirSync(path.join(root,'db/migrations'),{recursive:true});fs.mkdirSync(path.join(root,'db/schema'));fs.mkdirSync(path.join(root,'.local-tools'));
  fs.writeFileSync(path.join(root,'.gitignore'),'.local-tools/\n');fs.writeFileSync(path.join(root,'db/schema/init.sql'),'SELECT 1;');
  fs.writeFileSync(path.join(root,'db/migrations/baseline.json'),JSON.stringify({through:1,files:{'db/schema/init.sql':sha256('SELECT 1;')}}));git('add','.');git('commit','-m','fixture');
  const identity=sourceIdentity(root);const proof={...identity,ok:true,at:new Date().toISOString(),catalogDigest:loadCatalog(root).digest};fs.writeFileSync(path.join(root,'.local-tools/release-validation.json'),JSON.stringify(proof));
  fs.writeFileSync(path.join(root,'unexpected.txt'),'uncommitted');assert.throws(()=>prepare(root,output,'active'),/clean/);fs.unlinkSync(path.join(root,'unexpected.txt'));
  const manifest=prepare(root,output,'active');assert.equal(verifyArtifact(output).commit,identity.commit);assert.equal(manifest.expectedActive,'active');
  fs.writeFileSync(path.join(output,'db/schema/init.sql'),'SELECT 2;');assert.throws(()=>verifyArtifact(output),/modified/);
  fs.rmSync(output,{recursive:true,force:true});proof.commit='b'.repeat(40);fs.writeFileSync(path.join(root,'.local-tools/release-validation.json'),JSON.stringify(proof));assert.throws(()=>prepare(root,output,'active'),/Validation/);
 }finally{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(output,{recursive:true,force:true});}
});
