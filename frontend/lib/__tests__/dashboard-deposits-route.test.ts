import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/db',()=>({query:vi.fn()}))
vi.mock('@/lib/permissions',()=>({checkPermission:vi.fn()}))
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { GET } from '@/app/api/dashboard/casino/deposits/route'
beforeEach(()=>vi.resetAllMocks())
describe('deposits API errors and permissions',()=>{
 it('returns 500 for a query failure instead of empty metrics',async()=>{
  vi.mocked(query).mockRejectedValue(Error('database'))
  const r=await GET(new Request('http://localhost/'));expect(r.status).toBe(500)
  expect(await r.json()).not.toHaveProperty('total')
 })
 it('checks dashboard access before querying',async()=>{
  vi.mocked(checkPermission).mockResolvedValue(new NextResponse(null,{status:403}))
  expect((await GET(new Request('http://localhost/'))).status).toBe(403);expect(query).not.toHaveBeenCalled()
 })
})
