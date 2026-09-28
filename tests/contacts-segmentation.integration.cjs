// Run against an isolated local PostgreSQL server only:
// CONTACTS_TEST_DATABASE_URL=postgresql://localhost:55438/postgres node --test tests/contacts-segmentation.integration.cjs
const { describe, it, before, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { Client } = require('../frontend/node_modules/pg')
const { prepareSegmentation, applySegmentation, activitySQL, amountSQL } = require('../frontend/lib/casino-segmentation')
const connection = process.env.CONTACTS_TEST_DATABASE_URL

describe('Contact segmentation with real PostgreSQL', { skip: !connection }, () => {
  let c
  const schema = 'contacts_audit_' + process.pid
  before(async () => {
    const u = new URL(connection)
    if (!['localhost','127.0.0.1'].includes(u.hostname) || u.search) throw new Error('Isolated localhost database required, without URL options')
    c = new Client({ host: u.hostname, port: Number(u.port || 5432), user: u.username || process.env.USER, database: u.pathname.slice(1), password: u.password })
    await c.connect()
    await c.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`)
    await c.query(fs.readFileSync('db/migrations/028_casino_transactions.sql','utf8'))
    await c.query(fs.readFileSync('db/migrations/025_casino_players.sql','utf8'))
    await c.query(`ALTER TABLE casino_transactions ADD fecha_hora_utc timestamptz;
      ALTER TABLE casino_players ADD platform text;
      ALTER TABLE casino_players DROP CONSTRAINT casino_players_seg_monto_check;
      ALTER TABLE casino_players DROP CONSTRAINT casino_players_seg_actividad_check;
      CREATE TYPE contact_segment AS ENUM ('bajo','medio','vip','vip_medio','vip_alto','super_vip','casual','regular');
      CREATE TABLE contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),first_name text,last_name text,
        casino_accounts jsonb NOT NULL DEFAULT '[]',platforms text[] DEFAULT '{}',deleted_at timestamptz,
        segment contact_segment,updated_at timestamptz,total_deposits int,total_withdrawals int,last_deposit_at timestamptz);
      CREATE TABLE contact_tags(id uuid,contact_id uuid,tag text,added_by text,added_at timestamptz,UNIQUE(contact_id,tag));`)
    await c.query(fs.readFileSync('db/migrations/126_casino_excel_import.sql','utf8'))
  })
  beforeEach(async () => { await c.query('TRUNCATE contacts,contact_tags,casino_transactions,casino_players') })
  after(async () => { if (c) { await c.query('ROLLBACK'); await c.query(`DROP SCHEMA ${schema} CASCADE`); await c.end() } })
  const contact = async (name, accounts = []) => (await c.query('INSERT INTO contacts(first_name,casino_accounts) VALUES ($1,$2) RETURNING id',[name,JSON.stringify(accounts)])).rows[0].id
  const tx = async (username, amount, { platform='zeus', days=2, imported=false } = {}) => {
    await c.query(`INSERT INTO casino_transactions(username,agente,tipo,monto,fecha,platform,source_id,fecha_hora_utc)
      VALUES($1,'royal','carga',$2,current_date-$3::int,$4,$5,now())`,[username,amount,days,platform,imported ? username+'-'+platform+'-'+days : null])
  }
  const player = async (username, { amount=6000000, days=2, firstDays=180, count=180 } = {}) => {
    await c.query(`INSERT INTO casino_players(username,agente,platform,total_cargas,cant_cargas,fecha_primera,fecha_ultima)
      VALUES($1,'royal','zeus',$2,$3,current_date-$4::int,current_date-$5::int)`,[username,amount,count,firstDays,days])
  }
  const run = async (opts={}) => {
    await c.query('BEGIN')
    try { const summary=await prepareSegmentation(c,opts); await applySegmentation(c); await c.query('COMMIT'); return summary }
    catch(e) { await c.query('ROLLBACK'); throw e }
  }
  const state = async id => (await c.query(`SELECT c.segment,c.total_deposits,c.last_deposit_at::date::text,
    (SELECT array_agg(tag ORDER BY tag) FROM contact_tags WHERE contact_id=c.id) tags FROM contacts c WHERE id=$1`,[id])).rows[0]

  it('uses exact activity boundaries and treats unknown as unknown',async()=>{
    const result=await c.query(`SELECT days,${activitySQL('current_date-365','current_date-days','365')} activity
      FROM (VALUES (NULL::int),(2),(30),(31),(60),(61),(75),(76),(180),(181)) v(days)`)
    assert.deepEqual(result.rows.map(r=>r.activity),[null,'frecuente','frecuente','en_riesgo','en_riesgo','inactivo','inactivo','inactivo','inactivo','perdido'])
  })
  it('does not round across monetary thresholds',async()=>{
    const result=await c.query(`SELECT ${amountSQL('n')} AS segment FROM (VALUES (99999.99),(100000),(499999.99),(500000),(999999.99),(1000000),(1499999.99),(1500000),(3199999.99),(3200000)) v(n)`)
    assert.deepEqual(result.rows.map(r=>r.segment),['bajo','medio','medio','vip','vip','vip_medio','vip_medio','vip_alto','vip_alto','super_vip'])
  })
  it('does not divide the historical total by the months of a partial import',async()=>{
    const id=await contact('partial');await player('partial');await tx('partial',500000)
    await run();assert.equal((await state(id)).segment,'vip')
  })
  it('retains recent historical activity when another player has transactions',async()=>{
    const id=await contact('historical');await player('historical');await player('otheruser');await tx('otheruser',1000)
    await run();assert.ok((await state(id)).tags.includes('casino:actividad:frecuente'))
  })
  it('uses one latest date for tags and last_deposit_at even when historical date is stale',async()=>{
    const id=await contact('reactivated');await player('reactivated',{days:100});await tx('reactivated',5000,{days:2})
    await run();const result=await state(id)
    assert.ok(result.tags.includes('casino:actividad:frecuente'))
    assert.equal(result.last_deposit_at,(await c.query('SELECT (current_date-2)::text date_value')).rows[0].date_value)
  })
  it('does not mark players with no known dates lost or assign an invented level',async()=>{
    const id=await contact('unknownuser')
    await c.query("INSERT INTO casino_players(username,agente,platform,total_cargas) VALUES('unknownuser','royal','zeus',5000000)")
    await run();const result=await state(id);assert.equal(result.segment,null);assert.equal(result.tags,null)
  })
  it('separates namesakes by platform and leaves ambiguous contact unclassified',async()=>{
    const a=await contact('personA',[{username:'sameuser',platform:'ganamos'}])
    const b=await contact('personB',[{username:'sameuser',platform:'argenbet'}])
    const ambiguous=await contact('sameuser')
    await tx('sameuser',600000,{platform:'ganamos',imported:true});await tx('sameuser',1000,{platform:'argenbet',imported:true})
    await run();assert.equal((await state(a)).segment,'vip');assert.equal((await state(b)).segment,'bajo');assert.equal((await state(ambiguous)).segment,null)
  })
  it('sums multiple accounts but counts a shared active month only once',async()=>{
    const id=await contact('person',[{username:'firstuser',platform:'ganamos'},{username:'seconduser',platform:'argenbet'}])
    await tx('firstuser',300000,{platform:'ganamos',imported:true});await tx('seconduser',300000,{platform:'argenbet',imported:true})
    await run();assert.equal((await state(id)).segment,'vip');assert.equal((await state(id)).total_deposits,2)
  })
  it('clears stale casino families when an account link disappears, preserving custom tags',async()=>{
    const id=await contact('orphan')
    await c.query("UPDATE contacts SET segment='vip',total_deposits=99,last_deposit_at=now() WHERE id=$1",[id])
    for(const tag of ['casino:actividad:inactivo','casino:valor_riesgo:critico','casino:antiguedad:leal','casino:monto:vip','manual']) await c.query('INSERT INTO contact_tags(contact_id,tag) VALUES($1,$2)',[id,tag])
    await run();const result=await state(id);assert.equal(result.segment,null);assert.equal(result.last_deposit_at,null);assert.deepEqual(result.tags,['manual'])
  })
  it('keeps import scope isolated and repeated segmentation is idempotent',async()=>{
    const a=await contact('scoped');const b=await contact('untouched');await player('scoped');await tx('scoped',500000)
    await c.query("UPDATE contacts SET segment='medio' WHERE id=$1",[b])
    await run({contactIds:[a]});const first=await state(a);await run({contactIds:[a]})
    assert.deepEqual(await state(a),first);assert.equal((await state(b)).segment,'medio')
  })
  it('uses calendar months for a historical estimate when no movements exist',async()=>{
    const id=await contact('historicalspan')
    await c.query(`INSERT INTO casino_players(username,agente,platform,total_cargas,cant_cargas,fecha_primera,fecha_ultima)
      VALUES('historicalspan','royal','zeus',6000000,60,(date_trunc('month',current_date)-INTERVAL '5 months')::date,current_date)`)
    const summary=await run();assert.equal((await state(id)).segment,'vip_medio');assert.equal(summary.estimated_levels,1)
  })
  it('an imported-only run retains other accounts of that person and leaves unrelated contacts untouched',async()=>{
    const id=await contact('mixedperson',[{username:'importedaccount',platform:'ganamos'},{username:'legacyaccount',platform:'zeus'}])
    const other=await contact('untouched')
    await c.query("UPDATE contacts SET segment='medio' WHERE id=$1",[other])
    await tx('importedaccount',300000,{platform:'ganamos',imported:true});await player('legacyaccount');await tx('legacyaccount',300000)
    await run({importedOnly:true});assert.equal((await state(id)).segment,'vip');assert.equal((await state(other)).segment,'medio')
  })
  it('skip-activity preserves activity while updating the risk to match the new level',async()=>{
    const id=await contact('skipactivity');await player('skipactivity');await tx('skipactivity',1000)
    await c.query("INSERT INTO contact_tags(contact_id,tag) VALUES($1,'casino:actividad:inactivo'),($1,'casino:valor_riesgo:critico')",[id])
    await c.query('BEGIN')
    try { await prepareSegmentation(c);await applySegmentation(c,{skipActivity:true});await c.query('COMMIT') }
    catch(e) { await c.query('ROLLBACK');throw e }
    const result=await state(id);assert.equal(result.segment,'bajo')
    assert.ok(result.tags.includes('casino:actividad:inactivo'));assert.ok(result.tags.includes('casino:valor_riesgo:bajo'))
    assert.ok(!result.tags.includes('casino:valor_riesgo:critico'))
  })
  it('dry-run CLI leaves persisted data unchanged',async()=>{
    const id=await contact('dryrunuser');await player('dryrunuser');await tx('dryrunuser',500000)
    const childUrl=new URL(connection);childUrl.searchParams.set('options',`-c search_path=${schema},public`)
    const {spawnSync}=require('node:child_process')
    const result=spawnSync(process.execPath,['scripts/segmentar-casino-players.js','--dry-run'],{
      env:{...process.env,DATABASE_URL:childUrl.toString()},encoding:'utf8',timeout:30000,
    })
    assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/DRY RUN/)
    assert.equal((await state(id)).segment,null);assert.equal((await state(id)).tags,null)
  })
  it('rolls back every write if tagging fails',async()=>{
    const id=await contact('rollbackuser');await player('rollbackuser');await tx('rollbackuser',500000)
    await c.query("ALTER TABLE contact_tags ADD CONSTRAINT reject_tags CHECK (tag='manual')")
    try { await assert.rejects(run());assert.equal((await state(id)).segment,null) }
    finally { await c.query('ALTER TABLE contact_tags DROP CONSTRAINT reject_tags') }
  })
})
