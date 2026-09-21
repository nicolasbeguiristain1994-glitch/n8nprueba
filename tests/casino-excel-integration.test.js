const {Client}=require('pg')
const fs=require('fs'),os=require('os'),path=require('path')
const {spawnSync}=require('child_process')
const XLSX=require('xlsx')
const integration=process.env.CASINO_TEST_DATABASE_URL ? test : test.skip
integration('migration, duplicate-safe import, identity matching and campaign segments',async()=>{
  const schema='import_test_'+Date.now()
  const url=new URL(process.env.CASINO_TEST_DATABASE_URL)
  // Integration tests must never be pointed at the production database.
  if (!['localhost','127.0.0.1'].includes(url.hostname)) throw new Error('Local test database required')
  const c=new Client({connectionString:url.toString()});await c.connect()
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'casino-integration-'))
  try {
    await c.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`)
    await c.query(fs.readFileSync('db/migrations/028_casino_transactions.sql','utf8'))
    await c.query(fs.readFileSync('db/migrations/025_casino_players.sql','utf8'))
    await c.query(`ALTER TABLE casino_transactions ADD fecha_hora_utc timestamptz;
      ALTER TABLE casino_players ADD platform text;
      ALTER TABLE casino_players DROP CONSTRAINT casino_players_seg_actividad_check;
      CREATE TYPE contact_segment AS ENUM ('bajo','medio','vip','vip_medio','vip_alto','super_vip');
      CREATE TABLE contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),first_name text,last_name text,
      casino_accounts jsonb NOT NULL DEFAULT '[]',platforms text[] DEFAULT '{}',deleted_at timestamptz,
      segment contact_segment,updated_at timestamptz,total_deposits int,total_withdrawals int,last_deposit_at timestamptz);
      CREATE TABLE contact_tags(id uuid,contact_id uuid,tag text,added_by text,added_at timestamptz,UNIQUE(contact_id,tag));
      INSERT INTO contacts(first_name) VALUES ('sameuser'),('uniqueuser');
      INSERT INTO contacts(first_name,segment) VALUES ('unrelated','medio');
      INSERT INTO contacts(first_name,casino_accounts) VALUES ('explicituser','[{"username":"sameuser","platform":"argenbet"}]'),
      ('linkeduser','[{"username":"linkeduser","panel":"royal"}]');`)
    await c.query(fs.readFileSync('db/migrations/126_casino_excel_import.sql','utf8'))
    function workbook(platform,rows){
      const w=XLSX.utils.book_new();XLSX.utils.book_append_sheet(w,XLSX.utils.aoa_to_sheet([
        ['ID','Fecha','Hora','Jugador','Tipo','Monto'],...rows.map(([id,u,n])=>[id,'01/08/2026','23:59:59',u,'Depósito',n]),
      ]),'Movimientos');XLSX.writeFile(w,path.join(dir,`${platform}_adminroyal_2026-08.xlsx`))
    }
    workbook('ganamos',[['1','sameuser',1000],['2','uniqueuser',600000],['3','uniqueuser',600000]])
    workbook('argenbet',[['1','sameuser',150000.67],['uuid-source','linkeduser',500000.25]])
    url.searchParams.set('options',`-c search_path=${schema},public`)
    const env={...process.env,DATABASE_URL:url.toString()}
    const run=(script,args=[])=>{const r=spawnSync(process.execPath,[script,...args],{env,encoding:'utf8',timeout:30000});if(r.status!==0)throw new Error(r.stdout+r.stderr);return r.stdout}
    expect(run('scripts/import-casino-excel.js',['--apply',`--report=${dir}/report.json`,dir])).toContain('"inserted":5')
    expect(run('scripts/import-casino-excel.js',['--apply',`--report=${dir}/report.json`,dir])).toContain('"inserted":0')
    expect((await c.query('SELECT count(*)::int n,sum(monto)::text total FROM casino_transactions')).rows[0]).toEqual({n:5,total:'1851000.92'})
    expect((await c.query("SELECT segment FROM contacts WHERE first_name='unrelated'")).rows[0].segment).toBe('medio')
    run('scripts/segmentar-casino-players.js')
    const result=(await c.query('SELECT first_name,segment,platforms,total_deposits FROM contacts ORDER BY first_name')).rows
    expect(result.find(r=>r.first_name==='sameuser').segment).toBeNull()
    expect(result.find(r=>r.first_name==='uniqueuser')).toMatchObject({segment:'vip_medio',platforms:['ganamos'],total_deposits:2})
    expect(result.find(r=>r.first_name==='explicituser')).toMatchObject({segment:'medio',platforms:['argenbet']})
    expect(result.find(r=>r.first_name==='linkeduser')).toMatchObject({segment:'vip',platforms:['argenbet']})
    await c.query("UPDATE contacts SET platforms='{}' WHERE first_name='uniqueuser'")
    expect((await c.query("SELECT platforms FROM contacts WHERE first_name='uniqueuser'")).rows[0].platforms).toEqual(['ganamos'])
    workbook('ganamos',[['1','sameuser',999],['4','newuser',100]])
    expect(()=>run('scripts/import-casino-excel.js',['--apply',`--report=${dir}/conflict.json`,dir])).toThrow('Conflicto con registros existentes')
    expect((await c.query('SELECT count(*)::int n,sum(monto)::text total FROM casino_transactions')).rows[0]).toEqual({n:5,total:'1851000.92'})
  } finally {
    await c.query(`DROP SCHEMA ${schema} CASCADE`);await c.end();fs.rmSync(dir,{recursive:true,force:true})
  }
},60000)
