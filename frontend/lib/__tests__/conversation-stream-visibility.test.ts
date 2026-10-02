// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { EventEmitter } from 'node:events'
const mocks = vi.hoisted(() => ({auth: vi.fn(), canRead: vi.fn(), lines: vi.fn(), query: vi.fn()}))
vi.mock('@/lib/permissions', () => ({checkPermissionWithUser: mocks.auth}))
vi.mock('@/lib/db', () => ({query: mocks.query}))
vi.mock('@/lib/line-visibility', () => ({getAccessibleLineIds: mocks.lines}))
vi.mock('@/lib/conversation-access', () => ({canReadConversation: mocks.canRead, conversationPhone: (p:string) => p.replace(/^\+/, '')}))
vi.mock('@/lib/sse-events', () => ({sseEmitter: new EventEmitter()}))
import { sseEmitter } from '@/lib/sse-events'
import { GET } from '@/app/api/conversations/stream/route'
const user = {user_id:'operator',role:'operator',allowed_agents:['royal']}
let abort: AbortController
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ok:true,user});mocks.lines.mockResolvedValue(['line'])
  mocks.canRead.mockImplementation(async (_,phone) => phone === 'visible')
  mocks.query.mockResolvedValue([{has_new:false}]);abort=new AbortController()
})
afterEach(() => {abort.abort();sseEmitter.removeAllListeners();vi.useRealTimers()})
const connect = async () => {
  const res = await GET(new NextRequest('http://localhost/api/conversations/stream',{signal:abort.signal}))
  const reader = res.body!.getReader();await reader.read();return reader
}
it('only sends visible phone events and preserves the update type', async () => {
  const reader=await connect()
  sseEmitter.emit('update',{phone:'hidden',type:'note'})
  sseEmitter.emit('update',{phone:'+visible',type:'status'})
  const {value}=await reader.read()
  expect(new TextDecoder().decode(value)).toContain('"type":"update","source":"status","phone":"visible"')
  expect(mocks.canRead.mock.calls.map(c=>c[1])).toEqual(['hidden','visible'])
})
it('does not broadcast global events and polls only scoped messages', async () => {
  const reader=await connect();sseEmitter.emit('update',{source:'message'})
  await vi.advanceTimersByTimeAsync(3000)
  expect(mocks.query.mock.calls[0][0]).toContain('operator_contact_visibility')
  expect(mocks.query.mock.calls[0][1]).toEqual([['line'],expect.any(String),'operator',['royal']])
  expect(mocks.canRead).not.toHaveBeenCalled()
  await reader.cancel();expect(sseEmitter.listenerCount('update')).toBe(0)
})
it('closes on current permission revocation before forwarding any event', async () => {
  const reader=await connect();mocks.auth.mockResolvedValue({ok:false,response:new Response(null,{status:401})})
  sseEmitter.emit('update',{phone:'visible',type:'note'})
  expect((await reader.read()).done).toBe(true)
  expect(mocks.canRead).not.toHaveBeenCalled();expect(sseEmitter.listenerCount('update')).toBe(0)
})
it('rechecks current permissions during polling even with no events', async () => {
  const reader=await connect();mocks.auth.mockResolvedValue({ok:false,response:new Response(null,{status:403})})
  await vi.advanceTimersByTimeAsync(3000)
  expect((await reader.read()).done).toBe(true);expect(mocks.query).not.toHaveBeenCalled()
})
