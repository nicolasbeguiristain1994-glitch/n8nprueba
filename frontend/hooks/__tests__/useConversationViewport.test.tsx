import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationViewport } from '../useConversationViewport'

let visual: EventTarget & { height: number; offsetTop: number; scale: number }
let mobile: { matches: boolean }
beforeEach(() => {
  visual = Object.assign(new EventTarget(), { height: 740, offsetTop: 0, scale: 1 })
  mobile = { matches: true }
  vi.stubGlobal('visualViewport', visual)
  vi.stubGlobal('innerHeight', 740)
  vi.stubGlobal('matchMedia', () => mobile)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('conversation viewport on mobile Safari', () => {
  it('fits the visible area when the keyboard opens and restores navigation when it closes', async () => {
    const { result } = renderHook(() => useConversationViewport(true))
    act(() => { visual.height = 400; visual.offsetTop = 45; visual.dispatchEvent(new Event('resize')) })
    await waitFor(() => expect(result.current).toEqual({ height: 400, top: 45, keyboardOpen: true }))
    act(() => { visual.offsetTop = 60; visual.dispatchEvent(new Event('scroll')) })
    await waitFor(() => expect(result.current?.top).toBe(60))
    act(() => { visual.height = 740; visual.offsetTop = 0; visual.dispatchEvent(new Event('resize')) })
    await waitFor(() => expect(result.current).toBeNull())
  })

  it('does not treat browser zoom or desktop resizing as a mobile keyboard', async () => {
    const { result } = renderHook(() => useConversationViewport(true))
    act(() => { visual.height = 400; visual.dispatchEvent(new Event('resize')) })
    await waitFor(() => expect(result.current?.keyboardOpen).toBe(true))
    act(() => { visual.scale = 2; visual.dispatchEvent(new Event('resize')) })
    await waitFor(() => expect(result.current).toBeNull())
    act(() => { visual.scale = 1; mobile.matches = false; visual.dispatchEvent(new Event('resize')) })
    await waitFor(() => expect(result.current).toBeNull())
  })

  it('removes listeners and viewport overrides when leaving conversations', async () => {
    const remove = vi.spyOn(visual, 'removeEventListener')
    const { result, rerender } = renderHook(({ enabled }) => useConversationViewport(enabled), { initialProps: { enabled: true } })
    act(() => { visual.height = 400; visual.dispatchEvent(new Event('resize')) })
    await waitFor(() => expect(result.current?.keyboardOpen).toBe(true))
    rerender({ enabled: false })
    expect(result.current).toBeNull()
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function))
  })
})
