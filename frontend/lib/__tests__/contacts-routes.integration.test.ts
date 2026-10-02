// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
const db = vi.hoisted(() => ({ query: vi.fn(), getLongRunningClient: vi.fn() }))
vi.mock('@/lib/db', () => db)
vi.mock('@/lib/permissions', () => ({ checkPermission: async () => null, checkPermissionWithUser: async () => ({ ok: true, user: { role: 'admin', user_id: 'audit', can_download_contacts: true } }) }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/app-settings', () => ({ getAppSetting: async () => true }))
import { POST as importContacts } from '@/app/api/contacts/import/route'
import { GET as stats } from '@/app/api/contacts/[id]/casino-stats/route'
import { GET as list } from '@/app/api/contacts/route'
const url = process.env.CONTACTS_TEST_DATABASE_URL

describe.skipIf(!url)('Contact endpoints on real local PostgreSQL', () => {
  let c: Client
  const schema = `contacts_routes_${process.pid}`
  beforeAll(async () => {
    const u = new URL(url!)
    if (!['localhost', '127.0.0.1'].includes(u.hostname) || u.search) throw new Error('Local database without URL overrides required')
    c = new Client({ host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1), user: u.username || process.env.USER, password: u.password })
    await c.connect()
    await c.query("SET TIME ZONE 'America/Argentina/Buenos_Aires'")
    await c.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public`)
    await c.query(readFileSync('../db/migrations/028_casino_transactions.sql', 'utf8'))
    await c.query(readFileSync('../db/migrations/025_casino_players.sql', 'utf8'))
    await c.query(`ALTER TABLE casino_transactions ADD fecha_hora_utc timestamptz;
      ALTER TABLE casino_players ADD platform text;
      ALTER TABLE casino_players DROP CONSTRAINT casino_players_seg_monto_check;
      ALTER TABLE casino_players DROP CONSTRAINT casino_players_seg_actividad_check;
      CREATE TYPE contact_segment AS ENUM ('bajo','medio','vip','vip_medio','vip_alto','super_vip');
      CREATE TABLE contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_id text,phone_number text UNIQUE,
        first_name text,last_name text,email text,panel text,panels_assigned text[] DEFAULT '{}',
        casino_accounts jsonb NOT NULL DEFAULT '[]',platforms text[] DEFAULT '{}',deleted_at timestamptz,
        segment contact_segment,linea int,linea_sub text,status text,gaming text,opt_in_marketing bool,opt_in_sms bool,
        platform_source text,created_at timestamptz,updated_at timestamptz,total_deposits int,total_withdrawals int,last_deposit_at timestamptz);
      CREATE TABLE contact_tags(id uuid,contact_id uuid,tag text,added_by text,added_at timestamptz,UNIQUE(contact_id,tag));
      CREATE TABLE contact_list_members(contact_id uuid,list_id uuid);`)
    await c.query(readFileSync('../db/migrations/126_casino_excel_import.sql','utf8'))
    await c.query(readFileSync('../db/migrations/133_contact_movement_lookup.sql','utf8').split('-- Run outside')[0])
    db.query.mockImplementation(async (sql, params) => (await c.query(sql, params)).rows)
    db.getLongRunningClient.mockImplementation(async () => ({ query: c.query.bind(c), end: async () => {} }))
  })
  beforeEach(async () => { await c.query('TRUNCATE contacts,contact_tags,contact_list_members,casino_players,casino_transactions') })
  afterAll(async () => { if (c) { await c.query('ROLLBACK'); await c.query(`DROP SCHEMA ${schema} CASCADE`); await c.end() } })
  const request = (body: object) => new NextRequest('http://localhost/api/contacts/import',{ method:'POST',body:JSON.stringify(body) })
  const transaction = (username: string, platform: string, amount: number) => c.query(`INSERT INTO casino_transactions(username,platform,agente,tipo,monto,fecha,source_id)
    VALUES($1::text,$2::text,'royal','carga',$3,current_date-2,$1::text || $2::text)`,[username,platform,amount])

  it('imports explicit username and computes matching level and tags',async()=>{
    await transaction('realaccount','zeus',500000.25)
    const res=await importContacts(request({panel:'royal',contacts:[{phone:'+5491111111111',name:'Nombre visible',casino_username:'realaccount'}]}))
    expect(res.status).toBe(200)
    const contact=(await c.query('SELECT * FROM contacts')).rows[0]
    expect(contact.segment).toBe('vip')
    expect(contact.casino_accounts).toContainEqual({panel:'royal',username:'realaccount',platform:'zeus'})
    expect((await c.query('SELECT tag FROM contact_tags ORDER BY tag')).rows.map(r=>r.tag)).toContain('casino:monto:vip')
  })
  it('skip mode does not retag or edit existing contacts',async()=>{
    await c.query("INSERT INTO contacts(first_name,phone_number,segment) VALUES('original','+5491111111111','medio')")
    const res=await importContacts(request({conflict_mode:'skip',contacts:[{phone:'+5491111111111',name:'replacement'}]}))
    expect(res.status).toBe(200)
    expect((await c.query('SELECT first_name,segment FROM contacts')).rows[0]).toEqual({first_name:'original',segment:'medio'})
  })
  it('rolls back imported contacts when segmentation fails',async()=>{
    await transaction('realaccount','zeus',500000)
    await c.query("ALTER TABLE contact_tags ADD CONSTRAINT reject_tag CHECK(tag='manual')")
    try {
      const res=await importContacts(request({contacts:[{phone:'+5491111111111',name:'realaccount'}]}))
      expect(res.status).toBe(500)
      expect((await c.query('SELECT COUNT(*) FROM contacts')).rows[0].count).toBe('0')
    } finally { await c.query('ALTER TABLE contact_tags DROP CONSTRAINT reject_tag') }
  })
  it('stats separates homonyms and sums multiple linked accounts on the same platform',async()=>{
    await transaction('sameuser','ganamos',123.45);await transaction('sameuser','argenbet',900000)
    await transaction('seconduser','ganamos',200)
    const {rows:[{id}]}=await c.query(`INSERT INTO contacts(first_name,casino_accounts) VALUES('Persona',
      '[{"username":"sameuser","platform":"ganamos"},{"username":"seconduser","platform":"ganamos"}]') RETURNING id`)
    const res=await stats(new NextRequest(`http://localhost/api/contacts/${id}/casino-stats`),{params:Promise.resolve({id})})
    expect(res.status).toBe(200)
    const data=await res.json()
    expect(data.platforms).toHaveLength(1)
    expect(data.platforms[0]).toMatchObject({platform:'ganamos',monto_cargas_mes:323.45})
  })
  it('list and selection return identical audiences for combined list and tag filters',async()=>{
    const {rows}=await c.query(`INSERT INTO contacts(first_name,phone_number) VALUES('match','+5491111111111'),('wrongtag','+5491111111112'),('wronglist','+5491111111113') RETURNING id,first_name`)
    const id=(name:string)=>rows.find(r=>r.first_name===name).id
    const listId='11111111-1111-4111-8111-111111111111'
    await c.query('INSERT INTO contact_list_members(contact_id,list_id) VALUES($1,$3),($2,$3)',[id('match'),id('wrongtag'),listId])
    await c.query("INSERT INTO contact_tags(contact_id,tag) VALUES($1,'target'),($2,'target')",[id('match'),id('wronglist')])
    const criteria=`list_id=${listId}&tag=target`
    const listed=await (await list(new NextRequest(`http://localhost/api/contacts?${criteria}`))).json()
    const selected=await (await list(new NextRequest(`http://localhost/api/contacts?select_all=true&${criteria}`))).json()
    expect(listed.total).toBe(1);expect(listed.contacts.map((r:{id:string})=>r.id)).toEqual([id('match')])
    expect(selected.ids).toEqual([id('match')])
  })
  it.each(['', '&movimiento_modo=periodo'])('preserves movement range parity across list/count/download/selection %s', async mode => {
    await c.query(`INSERT INTO casino_transactions(username,platform,agente,tipo,monto,fecha,source_id) VALUES
      ('old','zeus','royal','carga',100,current_date-20,'old'),
      ('recent','zeus','royal','carga',100,current_date-20,'recent-old'),
      ('recent','zeus','royal','retiro',20,current_date-2,'recent-new'),
      ('elsewhere','bet30','royal','carga',100,current_date-20,'other')`)
    await c.query(`INSERT INTO contacts(first_name,phone_number,platforms,casino_accounts) VALUES
      ('old','+5491111111101',ARRAY['zeus'],'[{"username":"old","platform":"zeus"}]'),
      ('recent','+5491111111102',ARRAY['zeus'],'[{"username":"recent","platform":"zeus"}]'),
      ('elsewhere','+5491111111103',ARRAY['bet30'],'[{"username":"elsewhere","platform":"bet30"}]')`)
    const criteria=`plataforma=zeus&inactividad_desde=10&inactividad_hasta=30${mode}`
    const listed=await (await list(new NextRequest(`http://localhost/api/contacts?${criteria}`))).json()
    const downloaded=await (await list(new NextRequest(`http://localhost/api/contacts?download=true&${criteria}`))).json()
    const selected=await (await list(new NextRequest(`http://localhost/api/contacts?select_all=true&${criteria}`))).json()
    const expected=mode ? ['+5491111111101','+5491111111102'] : ['+5491111111101']
    expect(listed.total).toBe(expected.length)
    expect(listed.contacts.map((v: {phone_number:string})=>v.phone_number).sort()).toEqual(expected)
    expect(downloaded.contacts).toEqual(listed.contacts)
    expect(selected.phones.sort()).toEqual(expected)
  })
  it.each(['inactividad_desde=30&inactividad_hasta=10','movimiento_modo=invalid','inactividad_dias=-1'])('rejects invalid movement ranges: %s', async criteria => {
    expect((await list(new NextRequest(`http://localhost/api/contacts?${criteria}`))).status).toBe(400)
  })

  it('keeps ambiguity global when another platform has no movements inside the period', async () => {
    await c.query(`INSERT INTO casino_transactions(username,platform,agente,tipo,monto,fecha,source_id) VALUES
      ('namesake99','ganamos','royal','carga',100,current_date-20,'old'),
      ('namesake99','argenbet','royal','carga',100,current_date-2,'recent')`)
    await c.query(`INSERT INTO contacts(first_name,phone_number,platforms) VALUES('namesake99','+5491111111191',ARRAY['ganamos'])`)
    const path='http://localhost/api/contacts?plataforma=ganamos&inactividad_desde=15&inactividad_hasta=60&movimiento_modo=periodo'
    expect((await (await list(new NextRequest(path))).json()).total).toBe(0)
    await c.query(`UPDATE contacts SET casino_accounts='[{"username":"namesake99","platform":"ganamos"}]'`)
    expect((await (await list(new NextRequest(path))).json()).total).toBe(1)
  })
  it('keeps the exclusive lower and inclusive upper date boundaries', async () => {
    for (const days of [15,16,60,61]) {
      await c.query(`INSERT INTO casino_transactions(username,platform,agente,tipo,monto,fecha,source_id) VALUES($1::text,'ganamos','royal','retiro',100,current_date-$2::int,$1::text)`,['boundary'+days,days])
      await c.query(`INSERT INTO contacts(first_name,phone_number,platforms) VALUES($1,$2,ARRAY['ganamos'])`,['boundary'+days,'+54911111111'+days])
    }
    const result=await (await list(new NextRequest('http://localhost/api/contacts?inactividad_desde=15&inactividad_hasta=60&movimiento_modo=periodo'))).json()
    expect(result.contacts.map((r:{first_name:string})=>r.first_name).sort()).toEqual(['boundary16','boundary60'])
  })
  it('does not replace an unmatched explicit agent with a name-only match', async () => {
    await transaction('restricted99','ganamos',100)
    await c.query(`INSERT INTO contacts(first_name,casino_accounts) VALUES('restricted99','[{"username":"restricted99","panel":"wrong-agent"}]')`)
    const result=await (await list(new NextRequest('http://localhost/api/contacts?inactividad_desde=0&inactividad_hasta=30&movimiento_modo=periodo'))).json()
    expect(result.total).toBe(0)
  })

  it('preserves last-movement semantics when a source has a future-dated row', async () => {
    await transaction('future99','ganamos',100)
    await c.query(`INSERT INTO casino_transactions(username,platform,agente,tipo,monto,fecha,source_id) VALUES('future99','ganamos','royal','retiro',10,current_date+1,'future')`)
    await c.query(`INSERT INTO contacts(first_name) VALUES('future99')`)
    const url='http://localhost/api/contacts?inactividad_desde=0&inactividad_hasta=30'
    expect((await (await list(new NextRequest(url))).json()).total).toBe(0)
    expect((await (await list(new NextRequest(url+'&movimiento_modo=periodo'))).json()).total).toBe(1)
  })

})
