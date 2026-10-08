import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
vi.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: vi.fn() }))
import { useCurrentUser } from '@/lib/useCurrentUser'
import { MissingPhoneTab } from './MissingPhoneTab'
const listing = { users:[{ username:'pending',platform:'zeus',agent:'royal',last_movement:'2026-10-01',first_seen_at:null }],total:1,agents:['royal','bigwin'] }
const response = (data: unknown) => ({ok:true,json:async () => data})
beforeEach(() => {
  vi.mocked(useCurrentUser).mockReturnValue({user:{role:'admin',can_download_contacts:true},permissions:{contacts:['read','create']},loading:false,error:null} as never)
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(listing)))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('defaults to six months and applies agent/platform filters', async () => {
  render(<MissingPhoneTab onImported={vi.fn()} />)
  expect(screen.getByLabelText('Período de usuarios sin número')).toHaveValue('6')
  await screen.findByText('pending')
  fireEvent.change(screen.getByLabelText('Agente de usuarios sin número'),{target:{value:'royal'}})
  fireEvent.change(screen.getByLabelText('Plataforma de usuarios sin número'),{target:{value:'zeus'}})
  await waitFor(() => expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('agent=royal&platform=zeus&months=6'),expect.anything()))
})

it('previews the returned spreadsheet, imports valid rows and refreshes Contacts', async () => {
  const onImported = vi.fn()
  const result = { total:1,ready:1,inserted:0,linked:0,unchanged:0,blank:0,errors:[],dryRun:true }
  const fetcher = vi.fn().mockImplementation(async (url: string,init?: RequestInit) => {
    if (url.includes('/import')) {
      const body = JSON.parse(String(init?.body))
      return response({ ...result,dryRun:body.dryRun,inserted:body.dryRun?0:1,linked:body.dryRun?0:1 })
    }
    return response(listing)
  })
  vi.stubGlobal('fetch',fetcher)
  render(<MissingPhoneTab onImported={onImported} />)
  const book=XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Usuario','Plataforma','Agente','Celular'],['pending','zeus','royal','+5491123456789']]),'Usuarios sin número')
  const file=new File([XLSX.write(book,{type:'array',bookType:'xlsx'})],'royal.xlsx')
  fireEvent.change(screen.getByLabelText('Cargar planilla de celulares'),{target:{files:[file]}})
  const button=await screen.findByRole('button',{name:'Importar 1 cuentas válidas'})
  expect(onImported).not.toHaveBeenCalled()
  expect(JSON.parse(fetcher.mock.calls.find(([url]) => url.includes('/import'))![1].body).dryRun).toBe(true)
  fireEvent.click(button)
  await screen.findByText('1 cuentas incorporadas a Contactos (1 contactos nuevos).')
  expect(onImported).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button',{name:'Importar 1 cuentas válidas'})).not.toBeInTheDocument()
})

it('hides export and import without their permissions', async () => {
  vi.mocked(useCurrentUser).mockReturnValue({ user:{role:'viewer',can_download_contacts:false},permissions:{contacts:['read']} } as never)
  render(<MissingPhoneTab onImported={vi.fn()} />)
  expect(screen.queryByText('Descargar para agentes')).not.toBeInTheDocument()
  expect(screen.queryByText('Cargar celulares')).not.toBeInTheDocument()
  await screen.findByText('pending')
})

it('shows fetch errors without presenting stale results as a successful empty list', async () => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,json:async () => ({error:'No se pudo consultar'})}))
  render(<MissingPhoneTab onImported={vi.fn()} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo consultar')
  expect(screen.queryByText('No hay usuarios pendientes con estos filtros.')).not.toBeInTheDocument()
})
