// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import { readFileSync } from 'fs'
import { NextRequest } from 'next/server'
import sharp from 'sharp'
const mocks=vi.hoisted(()=>({query:vi.fn(),client:vi.fn(),auth:vi.fn()}))
vi.mock('@/lib/db',()=>({query:mocks.query,getDbClient:mocks.client}))
vi.mock('@/lib/permissions',()=>({checkPermissionWithUser:mocks.auth}))
import { GET, POST, DELETE } from '@/app/api/conversations/stickers/favorites/route'
import { signStickerToken, verifyStickerToken } from '../conversation-stickers'
const user='00000000-0000-4000-8000-000000000901', other='00000000-0000-4000-8000-000000000902'
const request=(method='GET',data?:unknown,suffix='')=>new NextRequest('https://panel.test/api/conversations/stickers/favorites'+suffix,{method,...(data?{body:JSON.stringify(data),headers:{'Content-Type':'application/json'}}:{})})
describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS!=='1')('private sticker favorites with real migration',()=>{
 let db:Client,url:string
 const schema=`favorites_test_${process.pid}`
 beforeAll(async()=>{
  const connection=new URL(process.env.DATABASE_URL!)
  if(!['127.0.0.1','localhost'].includes(connection.hostname))throw Error('LOCAL_ONLY')
  db=new Client({connectionString:connection.toString(),ssl:false});await db.connect()
  await db.query(`CREATE SCHEMA ${schema};SET search_path=${schema},public;CREATE TABLE users(id uuid PRIMARY KEY);INSERT INTO users VALUES('${user}'),('${other}');`)
  await db.query(readFileSync('../db/migrations/144_conversation_sticker_favorites.sql','utf8').replaceAll('public.',schema+'.'))
  mocks.query.mockImplementation(async(sql,params)=>(await db.query(sql,params)).rows)
  mocks.client.mockResolvedValue({query:(sql:string,params:unknown[])=>db.query(sql,params),release:()=>{}})
  process.env.AUTH_SECRET='test-favorites-only'
  url='data:image/webp;base64,'+(await sharp({create:{width:512,height:512,channels:4,background:'blue'}}).webp().toBuffer()).toString('base64')
 })
 beforeEach(async()=>{await db.query('TRUNCATE conversation_sticker_favorites');mocks.auth.mockResolvedValue({ok:true,user:{user_id:user}})})
 afterAll(async()=>{if(db){await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end()}})
 const save=()=>POST(request('POST',{url,token:signStickerToken(url,user),name:'Regalo'}))
 it('persists, deduplicates and renews authorization when selecting a favorite',async()=>{
  expect((await save()).status).toBe(201);expect((await save()).status).toBe(200)
  const list=await (await GET(request())).json();expect(list.favorites).toHaveLength(1);expect(list.favorites[0].data_uri).toBeUndefined()
  const selected=await (await GET(request('GET',undefined,'?slot=1'))).json()
  expect(selected.url).toBe(url);expect(verifyStickerToken(selected.token,url,user)).toBe(true)
  await DELETE(request('DELETE',undefined,'?slot=1'));expect((await (await GET(request())).json()).favorites).toEqual([])
 })
 it('cannot read or remove another user’s favorite',async()=>{
  await save();mocks.auth.mockResolvedValue({ok:true,user:{user_id:other}})
  expect((await (await GET(request())).json()).favorites).toEqual([])
  expect((await GET(request('GET',undefined,'?slot=1'))).status).toBe(404)
  await DELETE(request('DELETE',undefined,'?slot=1'))
  expect((await db.query('SELECT count(*) FROM conversation_sticker_favorites')).rows[0].count).toBe('1')
  expect((await POST(request('POST',{url,token:signStickerToken(url,user),name:'No'}))).status).toBe(400)
 })
 it('caps storage at 24 and enables RLS without public policies',async()=>{
  await db.query(`INSERT INTO conversation_sticker_favorites(user_id,slot,digest,name,data_uri,preview) SELECT $1,n,lpad(n::text,64,'0'),'Test',$2,$2 FROM generate_series(1,24) n`,[user,url])
  expect((await save()).status).toBe(409)
  const {rows}=await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='conversation_sticker_favorites'::regclass")
  expect(rows[0].relrowsecurity).toBe(true)
  expect((await db.query('SELECT * FROM pg_policies WHERE schemaname=$1',[schema])).rows).toHaveLength(0)
 })
})
