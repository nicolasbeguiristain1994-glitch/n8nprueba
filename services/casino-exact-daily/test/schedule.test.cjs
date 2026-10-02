'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {plan,closedDay}=require('../schedule.cjs');
const {parseExactJson,exactCents}=require('../exact.cjs');
const {normalize}=require('../normalize.cjs');
const {validatePartitions,envelopeRows}=require('../transport.cjs');
test('Argentina midnight, initial verified floor and contiguous catch-up',()=>{
 assert.equal(closedDay(new Date('2026-09-24T02:59:59Z')),'2026-09-22');
 assert.equal(closedDay(new Date('2026-09-24T03:00:00Z')),'2026-09-23');
 assert.deepEqual(plan(null,'2026-09-23').days,['2026-09-22','2026-09-23']);
 assert.deepEqual(plan({coveredFrom:'2026-09-22',coveredThrough:'2026-09-24'},'2026-09-26').days,['2026-09-23','2026-09-24','2026-09-25','2026-09-26']);
 assert.equal(plan(null,'2026-11-01').backlog,true);
 assert.throws(()=>plan({coveredFrom:'2026-09-22',coveredThrough:'2026-09-25'},'2026-09-24'),/CURSOR_INVALID/);
});
test('preserve lexemes, large IDs, exact cents and platform-specific bonus rules',()=>{
 const raw=parseExactJson('[{"id":9007199254740993,"valor":100.49,"fecha":"2026-09-22T12:00:00Z","username":"fixture","creator_username":"imperio","detalles":"Bono"}]');
 const zeus=normalize(raw,'zeus','imperio','2026-09-22');
 assert.equal(zeus.rows[0].id_rec,'9007199254740993');assert.equal(zeus.rows[0].monto,'100.49');
 assert.deepEqual(normalize(raw,'bet30','imperio','2026-09-22').unsupportedIds,['9007199254740993']);
 assert.throws(()=>exactCents('100.001'),/SUBCENT/);
 assert.equal(normalize([{...raw[0],username:'imperio'}],'zeus','imperio','2026-09-22').rows.length,0);
});
test('truncation and mismatched partitions cannot establish coverage',()=>{
 assert.throws(()=>envelopeRows({data:[],hasMore:true}),/PAGINATION/);
 const row={id:'1',valor:'0.01',fecha:'2026-09-22T08:00:00Z',username:'fixture',creator_username:'betcoin',detalles:'Carga'};
 assert.throws(()=>validatePartitions([[row],[],[]],'2026-09-22'),/PARTITION_MISMATCH/);
 assert.throws(()=>validatePartitions([[row,row],[row],[]],'2026-09-22'),/ID_DUPLICATE/);
});
