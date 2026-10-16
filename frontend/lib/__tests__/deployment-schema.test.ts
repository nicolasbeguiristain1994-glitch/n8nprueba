// @vitest-environment node
import {afterEach,describe,expect,it,vi} from 'vitest'
import {NextRequest} from 'next/server'
const state=vi.hoisted(()=>({ready:vi.fn(),session:vi.fn()}))
vi.mock('@/lib/deployment-schema',()=>({deploymentSchemaReady:state.ready}))
vi.mock('@/lib/auth',()=>({getSessionFromRequest:state.session}))
import {middleware} from '../../middleware'
afterEach(()=>vi.resetAllMocks())
describe('schema transition admission gate',()=>{
 it.each(['/api/cloud/webhook','/api/webhook/evolution','/api/cron/campaigns','/api/contacts/import'])('rejects %s before its handler can acknowledge or write',async path=>{
  state.ready.mockResolvedValue(false)
  const res=await middleware(new NextRequest('http://localhost'+path,{method:'POST'}))
  expect(res.status).toBe(503)
  expect(res.headers.get('Retry-After')).toBe('30')
  expect(res.headers.get('x-middleware-next')).toBeNull()
  expect(state.session).not.toHaveBeenCalled()
 })
 it('preserves authentication when the version is compatible',async()=>{
  state.ready.mockResolvedValue(true);state.session.mockReturnValue(null)
  expect((await middleware(new NextRequest('http://localhost/api/contacts'))).status).toBe(401)
  expect((await middleware(new NextRequest('http://localhost/api/cloud/webhook',{method:'POST'}))).headers.get('x-middleware-next')).toBe('1')
 })
 it.each(['/login','/release.json'])('keeps %s available during the transition',async path=>{
  state.ready.mockResolvedValue(false)
  expect((await middleware(new NextRequest('http://localhost'+path))).headers.get('x-middleware-next')).toBe('1')
  expect(state.ready).not.toHaveBeenCalled()
 })
})
