// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
const mocks=vi.hoisted(()=>({ permission:vi.fn(),query:vi.fn() }))
vi.mock('@/lib/permissions',()=>({ checkPermission:mocks.permission }))
vi.mock('@/lib/db',()=>({ query:mocks.query,withTransaction:vi.fn() }))
import { GET } from '@/app/api/cloud/config/route'

beforeEach(()=>{
  vi.resetAllMocks();mocks.permission.mockResolvedValue(null);mocks.query.mockResolvedValue([])
  vi.stubEnv('META_APP_ID','12345');vi.stubEnv('META_APP_SECRET','legacy-secret')
  vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN','legacy-verifier');vi.stubEnv('TOKEN_ENCRYPTION_KEY','secret-encryption-key'.repeat(2))
  vi.stubEnv('META_ADDITIONAL_APPS_JSON',JSON.stringify([{appId:'98765',name:'Nexus',appSecret:'nexus-secret-test',verifyToken:'nexus-verify-test',wabaIds:['87654']}]))
})
afterEach(()=>vi.unstubAllEnvs())
const request=()=>new NextRequest('https://panel.test/api/cloud/config')

it('requires line management permission before exposing app inventory',async()=>{
  mocks.permission.mockResolvedValue(NextResponse.json({error:'Forbidden'},{status:403}))
  expect((await GET(request())).status).toBe(403)
  expect(mocks.query).not.toHaveBeenCalled()
})
it('returns each app callback with independent readiness and no credential values',async()=>{
  vi.stubEnv('META_APP_SECRET','')
  const response=await GET(request())
  expect(response.headers.get('cache-control')).toBe('no-store')
  const body=await response.json()
  expect(body.apps[0].checks.appSecret).toBe(false)
  expect(body.apps[1]).toMatchObject({appId:'98765',name:'Nexus',webhookPath:'/api/cloud/webhook/98765',checks:{appSecret:true,database:true}})
  for(const secret of ['legacy-verifier','nexus-secret-test','nexus-verify-test','secret-encryption-key']) expect(JSON.stringify(body)).not.toContain(secret)
})
it('returns a safe configuration error instead of the secret JSON',async()=>{
  vi.stubEnv('META_ADDITIONAL_APPS_JSON','{"credential":"private-value"')
  const response=await GET(request())
  expect(response.status).toBe(503);expect(await response.text()).not.toContain('private-value')
})
