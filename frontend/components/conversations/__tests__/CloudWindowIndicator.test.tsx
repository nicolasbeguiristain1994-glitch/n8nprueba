import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { CloudWindowIndicator, windowLabel } from '../CloudWindowIndicator'
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
it('counts down, warns in the last hour and closes exactly at expiry',()=>{
 const now=Date.parse('2026-10-06T12:00:00Z')
 expect(windowLabel('2026-10-06T14:15:00Z',now).text).toContain('2 h 15 min')
 expect(windowLabel('2026-10-06T12:59:00Z',now).urgent).toBe(true)
 expect(windowLabel('2026-10-06T12:00:00Z',now).closed).toBe(true)
 expect(windowLabel(null,now).closed).toBe(true)
})
it('uses server time and clears the prior contact when switching chats',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({window:{lineName:'Cloud 1',expiresAt:'2026-10-06T14:15:00Z'},serverNow:'2026-10-06T12:00:00Z'})}).mockResolvedValueOnce({ok:true,json:async()=>({window:null,serverNow:new Date().toISOString()})}))
 const view=render(<CloudWindowIndicator phone="5491100000001"/>);expect(await screen.findByText(/2 h 15 min/)).toBeInTheDocument()
 view.rerender(<CloudWindowIndicator phone="5491100000002"/>);await waitFor(()=>expect(screen.queryByText(/2 h 15 min/)).not.toBeInTheDocument())
})
