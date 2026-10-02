import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversations } from '../useConversations'
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/lib/fetchJson', () => ({ fetchJson: mocks.fetch }))
vi.mock('../useRealTime', () => ({ useRealTime: () => 'connected' }))
vi.mock('../useDesktopNotifications', () => ({ useDesktopNotifications: () => ({ permission: 'default', request: vi.fn(), notify: vi.fn() }) }))
beforeEach(() => { mocks.fetch.mockReset() })
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.unstubAllGlobals() })

describe('Inbox loading and error states', () => {
  const conv = (phone: string) => ({ phone_number: phone, last_message: 'Hola', last_direction: 'inbound', last_status: 'received', last_at: '2026-10-01T18:00:00Z' })

  it('keeps campaign and level filters on pagination and refresh, without dropping loaded pages', async () => {
    const firstPage = Array.from({ length: 200 }, (_, i) => conv(String(i)))
    mocks.fetch.mockImplementation((url: string) => Promise.resolve({
      conversations: url.includes('offset=200') ? [conv('200')] : firstPage, total: 201,
      campaigns: [{ id: 'campaign-a', name: 'Extra Royal', count: 201 }],
    }))
    const { result } = renderHook(() => useConversations())
    await waitFor(() => expect(result.current.convs).toHaveLength(200))
    act(() => { result.current.setCampaign('campaign-a'); result.current.setLevel('vip_alto') })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mocks.fetch).toHaveBeenCalledWith('/api/conversations?campaign=campaign-a&level=vip_alto', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    act(() => result.current.loadMoreConvs())
    await waitFor(() => expect(result.current.convs).toHaveLength(201))
    expect(mocks.fetch).toHaveBeenCalledWith('/api/conversations?campaign=campaign-a&level=vip_alto&offset=200', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    mocks.fetch.mockClear()
    act(() => result.current.refreshConversations())
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(result.current.convs).toHaveLength(201)
    expect(result.current.hasMore).toBe(false)
  })

  it('ignores a stale campaign response and keeps the open contact identified when filtering', async () => {
    let finishOld!: (value: unknown) => void
    mocks.fetch.mockImplementation((url: string) => {
      if (url.includes('phone=')) return Promise.resolve({ messages: [] })
      if (url.includes('campaign=old')) return new Promise(resolve => { finishOld = resolve })
      if (url.includes('campaign=new')) return Promise.resolve({ conversations: [conv('new')], total: 1 })
      return Promise.resolve({ conversations: [{ ...conv('current'), first_name: 'Ana', segment: 'vip_alto' }], total: 1 })
    })
    const { result } = renderHook(() => useConversations())
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.openConv('current'))
    act(() => result.current.setCampaign('old'))
    act(() => result.current.setCampaign('new'))
    await waitFor(() => expect(result.current.convs[0]?.phone_number).toBe('new'))
    await act(async () => finishOld({ conversations: [conv('old')], total: 1 }))
    expect(result.current.convs[0].phone_number).toBe('new')
    expect(result.current.selectedConv?.first_name).toBe('Ana')
  })

  it('clears a send error when another chat is opened', async () => {
    mocks.fetch.mockResolvedValue({ conversations: [], total: 0, messages: [] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ results: [{ status: 'error', error: 'Ventana cerrada' }] })))
    const { result } = renderHook(() => useConversations())
    act(() => { result.current.openConv('first'); result.current.setReply('Hola') })
    await act(async () => result.current.sendReply())
    expect(result.current.sendError).toBe('Ventana cerrada')
    act(() => result.current.openConv('second'))
    expect(result.current.sendError).toBeNull()
  })

  it.each(['sent', 'error'])('keeps the new chat and draft when an earlier send resolves with %s', async status => {
    mocks.fetch.mockResolvedValue({ conversations: [], total: 0, messages: [] })
    let complete!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { complete = resolve })))
    const { result } = renderHook(() => useConversations())
    act(() => { result.current.openConv('first'); result.current.setReply('Para el primero') })
    let pending!: Promise<void>
    act(() => { pending = result.current.sendReply() })
    act(() => { result.current.openConv('second'); result.current.setReply('Borrador del segundo') })
    await act(async () => { complete(Response.json({ results: [{ status, error: 'Ventana cerrada' }] })); await pending })
    expect(result.current.selected).toBe('second')
    expect(result.current.reply).toBe('Borrador del segundo')
    expect(result.current.sendError).toBeNull()
  })

  it('distinguishes a failed initial request from an empty inbox and recovers on retry', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useConversations())
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.loadError).toMatch(/No se pudieron cargar/)
    mocks.fetch.mockResolvedValue({ conversations: [], total: 0 })
    act(() => result.current.refreshConversations())
    await waitFor(() => expect(result.current.loadError).toBeNull())
    expect(result.current.convs).toEqual([])
  })

  it('does not display the previous conversation or a stale response after switching contacts', async () => {
    let finishFirst!: (value: unknown) => void
    mocks.fetch.mockImplementation((url: string) => {
      if (url === '/api/conversations') return Promise.resolve({ conversations: [], total: 0 })
      if (url.includes('phone=first')) return new Promise(resolve => { finishFirst = resolve })
      return Promise.resolve({ messages: [{ id: 'second-message', message_body: 'Second conversation' }] })
    })
    const { result } = renderHook(() => useConversations())
    act(() => result.current.openConv('first'))
    expect(result.current.messagesLoading).toBe(true)
    act(() => result.current.openConv('second'))
    await waitFor(() => expect(result.current.messages[0]?.id).toBe('second-message'))
    await act(async () => finishFirst({ messages: [{ id: 'first-message' }] }))
    expect(result.current.messages[0].id).toBe('second-message')
    expect(result.current.messagesLoading).toBe(false)
  })
})
