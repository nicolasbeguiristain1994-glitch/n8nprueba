import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentesTableWidget } from '../widgets/AgentesTableWidget'
import { CajaWidget } from '../widgets/CajaWidget'
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
const range={preset:'custom' as const,from:'2026-09-01',to:'2026-09-24'}
it('renders normal agent stats from the shared dashboard response without another API call',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher)
 const {rerender}=render(<AgentesTableWidget platform="consolidado" agentFilter="" dateRange={range} revision={0} agentes={[]} loading={false}/>)
 rerender(<AgentesTableWidget platform="bet30" agentFilter="" dateRange={range} revision={0} agentes={[]} loading={false}/>)
 await new Promise(r=>setTimeout(r,250));expect(fetcher).not.toHaveBeenCalled()
})
const august={preset:'custom' as const,from:'2026-08-01',to:'2026-09-01'}
const requestedDays=(fetcher:ReturnType<typeof vi.fn>,path:string)=>{
 const call=fetcher.mock.calls.filter(([u])=>String(u).startsWith(path)).at(0)!
 const q=new URL(String(call[0]),'http://localhost').searchParams;return [q.get('from'),q.get('to')]
}
it('Caja queries the included days of a custom exclusive range and labels both midnights',async()=>{
 const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({rows:[],total:0,totals:null})});vi.stubGlobal('fetch',fetcher)
 render(<CajaWidget platform="consolidado" agent="" dateRange={august} revision={0} enabled/>)
 await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1))
 expect(requestedDays(fetcher,'/api/dashboard/caja?')).toEqual(['2026-08-01','2026-08-31'])
 expect(screen.getByText(/01\/08\/2026 00:00 → 01\/09\/2026 00:00/)).toBeInTheDocument()
})
it('Caja keeps preset end days inclusive',async()=>{
 const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({rows:[],total:0,totals:null})});vi.stubGlobal('fetch',fetcher)
 render(<CajaWidget platform="consolidado" agent="" dateRange={{preset:'7d',from:'2026-09-18',to:'2026-09-24'}} revision={0} enabled/>)
 await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1))
 expect(requestedDays(fetcher,'/api/dashboard/caja?')).toEqual(['2026-09-18','2026-09-24'])
})
it.each([
 ['custom exclusive range',august,['2026-08-01','2026-08-31']],
 ['inclusive preset',{preset:'7d' as const,from:'2026-09-18',to:'2026-09-24'},['2026-09-18','2026-09-24']],
])('agent comparison period A requests the same days as the dashboard (%s)',async(_,dateRange,expected)=>{
 const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({agentes:[]})});vi.stubGlobal('fetch',fetcher)
 render(<AgentesTableWidget platform="consolidado" agentFilter="" dateRange={dateRange} revision={0} agentes={[]} loading={false}/>)
 fireEvent.click(screen.getByRole('button',{name:/Comparar/}))
 await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2))
 const periods=fetcher.mock.calls.map(([u])=>{const q=new URL(String(u),'http://localhost').searchParams;return [q.get('from'),q.get('to')]})
 expect(periods).toContainEqual(expected)
})
it('defers Caja until the main load finishes, then makes one request',async()=>{
 const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({rows:[],total:0,totals:null})});vi.stubGlobal('fetch',fetcher)
 const p={platform:'consolidado' as const,agent:'',dateRange:range,revision:0}
 const {rerender}=render(<CajaWidget {...p} enabled={false}/>)
 expect(fetcher).not.toHaveBeenCalled();rerender(<CajaWidget {...p} enabled/>)
 await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1))
})
