import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Conv, Message } from '@/lib/scoring/conversation-scoring'
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/lib/fetchJson', () => ({ fetchJson: mocks.fetch }))
vi.mock('../useRealTime', () => ({ useRealTime: () => 'connected' }))
vi.mock('../useDesktopNotifications', () => ({ useDesktopNotifications: () => ({ permission: 'default', request: vi.fn(), notify: vi.fn() }) }))
import { useConversations } from '../useConversations'

const phone = '5491100000001'
const incoming = (id: string): Message => ({id,view_key:'wamid.'+id,phone_number:phone,message_body:'Gracias',direction:'inbound',status:'received',created_at:'2026-10-15T12:00:00Z'})
const conversation = (id: string): Conv => ({phone_number:phone,last_message:'Gracias',last_direction:'inbound',last_status:'received',last_at:'2026-10-15T12:00:00Z',last_message_id:id,last_message_key:'wamid.'+id,is_unread:true})
let inbox: Conv[], messages: Message[], hidden: ReturnType<typeof vi.spyOn>
let acknowledge: (body: {messageId:string}) => Promise<unknown>
const viewCalls = () => mocks.fetch.mock.calls.filter(([url]) => url === '/api/conversations/viewed')
beforeEach(() => {
  vi.useFakeTimers()
  hidden = vi.spyOn(document,'hidden','get').mockReturnValue(false)
  inbox = [conversation('1')]; messages = [incoming('1')]
  acknowledge = async ({messageId}) => ({ok:true,message_key:'wamid.'+messageId})
  mocks.fetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/conversations/viewed') return acknowledge(JSON.parse(String(init?.body)))
    if (url.includes('phone=')) return Promise.resolve({messages:[...messages]})
    return Promise.resolve({conversations:[...inbox],total:inbox.length})
  })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks() })
async function setup(visible = true) {
  const hook = renderHook(useConversations)
  const element = document.createElement('div')
  vi.spyOn(element,'getClientRects').mockReturnValue((visible ? [{}] : []) as unknown as DOMRectList)
  hook.result.current.messagesEndRef.current = element
  await act(async () => {})
  await act(async () => hook.result.current.setFilter('unread'))
  return hook
}
it('removes an opened chat from the pending list and counter while keeping it open, even after a stale list refresh', async () => {
  const {result} = await setup()
  expect(result.current.visible).toHaveLength(1)
  await act(async () => result.current.openConv(phone))
  expect(viewCalls()).toHaveLength(1)
  expect(result.current.visible).toHaveLength(0)
  expect(result.current.selectedConv?.last_direction).toBe('inbound')
  expect(result.current.messages).toHaveLength(1)
  await act(async () => result.current.refreshConversations())
  expect(result.current.convs[0].is_unread).toBe(false)
  await act(async () => vi.advanceTimersByTimeAsync(9000))
  expect(viewCalls()).toHaveLength(1)
})
it('does not acknowledge messages in hidden tabs or an invisible mobile chat panel', async () => {
  const {result} = await setup(false)
  await act(async () => result.current.openConv(phone))
  expect(viewCalls()).toHaveLength(0)
  vi.mocked(result.current.messagesEndRef.current!.getClientRects).mockReturnValue([{}] as unknown as DOMRectList)
  hidden.mockReturnValue(true)
  await act(async () => result.current.refreshMessages(phone))
  expect(viewCalls()).toHaveLength(0)
  hidden.mockReturnValue(false)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(viewCalls()).toHaveLength(1)
})
it('keeps a newer arrival pending when an earlier acknowledgement finishes late', async () => {
  let finish!: (value: unknown) => void
  acknowledge = () => new Promise(resolve => { finish = resolve })
  const {result} = await setup()
  await act(async () => result.current.openConv(phone))
  hidden.mockReturnValue(true)
  inbox = [conversation('2')]
  await act(async () => result.current.refreshConversations())
  await act(async () => finish({ok:true,message_key:'wamid.1'}))
  expect(result.current.visible).toHaveLength(1)
  expect(result.current.convs[0].last_message_id).toBe('2')
})
it('leaves the message pending on failure and retries when the open chat refreshes', async () => {
  acknowledge = async () => { throw new Error('network') }
  const {result} = await setup()
  await act(async () => result.current.openConv(phone))
  expect(result.current.visible).toHaveLength(1)
  expect(result.current.viewError).toContain('No se pudo marcar')
  acknowledge = async () => ({ok:true,message_key:'wamid.1'})
  await act(async () => vi.advanceTimersByTimeAsync(3000))
  expect(result.current.visible).toHaveLength(0)
  expect(result.current.viewError).toBeNull()
})
it('does not mark a chat whose messages failed to load', async () => {
  const {result} = await setup()
  mocks.fetch.mockImplementationOnce(() => Promise.reject(new Error('load failed')))
  await act(async () => result.current.openConv(phone))
  expect(viewCalls()).toHaveLength(0)
  expect(result.current.visible).toHaveLength(1)
})
