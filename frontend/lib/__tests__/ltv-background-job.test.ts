// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
const mocks=vi.hoisted(()=>({query:vi.fn(),end:vi.fn(),pool:vi.fn(),connect:vi.fn()}))
vi.mock('@/lib/db',()=>({query:mocks.pool,getLongRunningClient:mocks.connect}))
import { LtvRepository } from '@/lib/ltv/LtvRepository'
beforeEach(()=>{
 vi.resetAllMocks()
 mocks.connect.mockResolvedValue({query:mocks.query,end:mocks.end})
 mocks.query.mockImplementation(async(sql:string)=>sql.includes('SELECT refresh_player_ltv')?
  {rows:[{result:{rows_processed:258802,duration_ms:630000,calculated_at:'2026-10-27T17:00:00Z'}}]}:{rows:[]})
})
it('runs ranking and materialized refresh on the background connection and closes it',async()=>{
 const result=await new LtvRepository().refreshAll()
 expect(result.rowsProcessed).toBe(258802)
 expect(mocks.pool).not.toHaveBeenCalled()
 expect(mocks.query.mock.calls.map(c=>c[0])).toEqual(["SET statement_timeout = '20min'",'SELECT refresh_player_ltv() AS result','REFRESH MATERIALIZED VIEW CONCURRENTLY mv_player_ltv'])
 expect(mocks.end).toHaveBeenCalledOnce()
})
it.each(['ranking','view'])('does not report success after %s fails and still closes the connection',async(stage)=>{
 const implementation=mocks.query.getMockImplementation()!
 mocks.query.mockImplementation(async(sql:string)=>{
  if((stage==='ranking'&&sql.startsWith('SELECT'))||(stage==='view'&&sql.startsWith('REFRESH')))throw Error('database failure')
  return implementation(sql)
 })
 await expect(new LtvRepository().refreshAll()).rejects.toThrow('database failure')
 expect(mocks.end).toHaveBeenCalledOnce()
})
it('rejects incomplete database metrics and never refreshes the view',async()=>{
 mocks.query.mockResolvedValue({rows:[{result:{}}]})
 await expect(new LtvRepository().refreshAll()).rejects.toThrow('inválida')
 expect(mocks.query.mock.calls.some(c=>c[0].startsWith('REFRESH'))).toBe(false)
 expect(mocks.end).toHaveBeenCalledOnce()
})
