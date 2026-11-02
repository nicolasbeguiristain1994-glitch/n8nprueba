import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({path:'/campaigns',replace:vi.fn()}))
vi.mock('next/navigation', () => ({usePathname:() => mocks.path,useRouter:() => ({replace:mocks.replace})}))
vi.mock('@/lib/useCurrentUser', () => ({useCurrentUser:() => ({
  user:{role:'operator'},loading:false,error:null,
  permissions:{conversations:['read','send'],estadisticas:['read'],calendar:['read']},
})}))
import { ModuleGate } from '@/components/layout/ModuleGate'
afterEach(() => { cleanup(); mocks.replace.mockClear() })
it('redirects a direct URL to the first permitted module without mounting the forbidden page',async()=>{
  mocks.path='/campaigns'
  render(<ModuleGate><p>Campaign content</p></ModuleGate>)
  expect(screen.queryByText('Campaign content')).toBeNull()
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/conversations'))
})
it('shows an allowed module',()=>{
  mocks.path='/calendario'
  render(<ModuleGate><p>Calendar content</p></ModuleGate>)
  expect(screen.getByText('Calendar content')).toBeTruthy()
  expect(mocks.replace).not.toHaveBeenCalled()
})
