import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useConversations } from '../useConversations'
import type { Conv, Message } from '@/lib/scoring/conversation-scoring'
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/lib/fetchJson', () => ({ fetchJson: mocks.fetch }))
vi.mock('../useRealTime', () => ({ useRealTime: () => 'connected' }))
vi.mock('../useDesktopNotifications', () => ({ useDesktopNotifications: () => ({ permission: 'default', request: vi.fn(), notify: vi.fn() }) }))
const before = '2026-10-15T17:00:00Z', recent = '2026-10-15T18:00:00Z', sentAt = '2026-10-15T19:00:00Z'
const conv = (phone: string, at: string): Conv => ({ phone_number: phone, first_name: 'Ana ' + phone,
  last_at: at, last_message: 'Anterior', last_direction: 'inbound', last_status: 'received', last_message_key: 'old-' + phone })
let rows: Conv[], messages: Message[]
beforeEach(() => {
  rows = [conv('2', recent), conv('1', before)]; messages = []
  mocks.fetch.mockReset().mockImplementation((url: string) => Promise.resolve(url.includes('phone=') ? { messages } : { conversations: rows, total: rows.length }))
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ results: [{ status: 'sent', id: 'sent-1', sent_at: sentAt }] })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function ready() {
  const hook = renderHook(useConversations)
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  return hook
}
async function open(hook: Awaited<ReturnType<typeof ready>>, phone = '1') {
  await act(async () => { hook.result.current.openConv(phone) })
  act(() => hook.result.current.setReply('Nueva respuesta'))
}
it('moves an older replied chat to the top using server time, including search results', async () => {
  const hook = await ready(); await open(hook)
  act(() => hook.result.current.setSearch('Ana'))
  await act(async () => { await hook.result.current.sendReply() })
  expect(hook.result.current.visible.map(c => c.phone_number)).toEqual(['1', '2'])
  expect(hook.result.current.visible[0]).toMatchObject({ last_at: sentAt, last_message: 'Nueva respuesta', last_status: 'sent', last_direction: 'outbound', is_unread: false })
  expect(hook.result.current.selected).toBe('1')
})
it('does not roll a confirmed reply back when an earlier inbox read completes later', async () => {
  const hook = await ready(); await open(hook)
  let finish!: (data: unknown) => void
  mocks.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  act(() => hook.result.current.refreshConversations())
  await act(async () => { await hook.result.current.sendReply() })
  await act(async () => finish({ conversations: rows, total: 2 }))
  expect(hook.result.current.visible[0]).toMatchObject({ phone_number: '1', last_at: sentAt, last_message: 'Nueva respuesta' })
  await act(async () => hook.result.current.refreshConversations())
  expect(hook.result.current.visible[0].phone_number).toBe('1')
})
it('updates the previous chat after sending even if another chat is now selected', async () => {
  const hook = await ready(); await open(hook)
  let finish!: (data: Response) => void
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  let pending!: Promise<void>
  act(() => { pending = hook.result.current.sendReply() })
  await open(hook, '2'); act(() => hook.result.current.setReply('Borrador del segundo'))
  await act(async () => { finish(Response.json({ results: [{ status: 'sent', id: 'sent-1', sent_at: sentAt }] })); await pending })
  expect(hook.result.current.visible[0].phone_number).toBe('1')
  expect(hook.result.current.selected).toBe('2')
  expect(hook.result.current.reply).toBe('Borrador del segundo')
})
it('promotes a confirmed sticker immediately through stale refreshes', async () => {
  const hook = await ready(); await open(hook)
  await act(async () => { expect(await hook.result.current.sendSticker('data:image/webp;base64,test', 'token')).toBe(true) })
  expect(hook.result.current.visible[0]).toMatchObject({ phone_number: '1', last_message: '[Sticker]', last_at: sentAt })
})
it.each([{ results: [{ status: 'error', error: 'Ventana cerrada' }] }, {}])('does not promote an unconfirmed send: %j', async body => {
  const hook = await ready(); await open(hook)
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(body))
  await act(async () => { await hook.result.current.sendReply() })
  expect(hook.result.current.visible.map(c => c.phone_number)).toEqual(['2', '1'])
  expect(hook.result.current.reply).toBe('Nueva respuesta')
  expect(hook.result.current.sendError).toBeTruthy()
})
it('reorders a new inbound message loaded by the open-chat poll before the inbox poll', async () => {
  const hook = await ready(); await open(hook)
  messages = [{ id: 'new-inbound', view_key: 'new-inbound', phone_number: '1', message_body: 'Nueva consulta', direction: 'inbound', status: 'received', created_at: sentAt }]
  await act(async () => hook.result.current.refreshMessages('1'))
  expect(hook.result.current.visible[0]).toMatchObject({ phone_number: '1', last_at: sentAt, last_message: 'Nueva consulta', is_unread: true })
  await act(async () => hook.result.current.refreshConversations())
  expect(hook.result.current.visible[0].last_message).toBe('Nueva consulta')
})
it('accepts newer inbound activity and delivery status after a reply', async () => {
  const hook = await ready(); await open(hook)
  await act(async () => { await hook.result.current.sendReply() })
  rows = [conv('2', '2026-10-15T20:00:00Z'), { ...conv('1', sentAt), last_message: 'Nueva respuesta', last_message_key: 'sent-1', last_direction: 'outbound', last_status: 'delivered' }]
  await act(async () => hook.result.current.refreshConversations())
  expect(hook.result.current.visible.map(c => c.phone_number)).toEqual(['2', '1'])
  expect(hook.result.current.visible[1].last_status).toBe('delivered')
})
it('keeps older VIPs below newer activity with a stable phone tie-breaker', async () => {
  rows = [{ ...conv('3', before), segment: 'super_vip' }, conv('2', recent), conv('1', recent)]
  const hook = await ready()
  expect(hook.result.current.visible.map(c => c.phone_number)).toEqual(['1', '2', '3'])
})
it('does not promote a chat when it is merely opened', async () => {
  const hook = await ready(); await open(hook)
  expect(hook.result.current.visible.map(c => c.phone_number)).toEqual(['2', '1'])
})
