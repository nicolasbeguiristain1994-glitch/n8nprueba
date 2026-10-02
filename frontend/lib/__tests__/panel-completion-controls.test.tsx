// @vitest-environment happy-dom
import { render,screen,cleanup,waitFor } from '@testing-library/react'
import { afterEach,it,expect,vi } from 'vitest'
import { Select,SelectTrigger,SelectValue,SelectContent,SelectItem } from '@/components/ui/select'
const mocks=vi.hoisted(()=>({fetch:vi.fn()}))
vi.mock('@/lib/fetchJson',()=>({fetchJson:mocks.fetch}))
import { LtvTab } from '@/components/settings/LtvTab'
afterEach(()=>{cleanup();vi.resetAllMocks()})
it('closed selectors display the supplied label without opening the popup',()=>{
 render(<Select value="__all"><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="__all">Todas las campañas</SelectItem><SelectItem value="completed">Completadas</SelectItem></SelectContent></Select>)
 expect(screen.getByRole('combobox').textContent).toContain('Todas las campañas')
 expect(screen.getByRole('combobox').textContent).not.toContain('__all')
})
it('LTV load errors are visible and do not masquerade as an empty distribution',async()=>{
 mocks.fetch.mockRejectedValue(new Error('failed'))
 render(<LtvTab isAdmin/>)
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('No se pudo cargar LTV'))
 expect(screen.queryByText(/Sin datos de LTV/)).toBeNull()
 expect((screen.getByRole('button',{name:'Recalcular LTV'}) as HTMLButtonElement).disabled).toBe(true)
 expect(screen.getByRole('button',{name:'Reintentar'})).toBeTruthy()
})
