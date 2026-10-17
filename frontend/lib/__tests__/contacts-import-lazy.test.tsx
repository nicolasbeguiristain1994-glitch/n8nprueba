import userEvent from '@testing-library/user-event'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
vi.mock('@/lib/fetchJson', () => ({ fetchJson: vi.fn().mockResolvedValue({ contacts: [], total: 0, lists: [] }) }))
vi.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: () => ({ user: { role: 'admin' }, permissions: { contacts: ['read', 'create'] } }) }))
import Contacts from '@/app/(protected)/contacts/page'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('still reads an Excel file after loading the parser on demand', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ total: 0, by_panel: {} }) })
  vi.stubGlobal('fetch', fetcher)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ telefono: '+5491111111111', nombre: 'Prueba' }]), 'Contactos')
  const file = new File([XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })], 'prueba.xlsx')
  const { container } = render(<Contacts />)
  const input = container.querySelector('input[type="file"]')!
  fireEvent.change(input, { target: { files: [file] } })
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/contacts/import/check', expect.objectContaining({ body: JSON.stringify({ phones: ['+5491111111111'] }) })))
})

it('explains line reassignment and submits the selected line even when preserving existing data', async () => {
  const fetcher = vi.fn().mockImplementation(async (url: string) => ({ok:true,json:async()=>url.endsWith('/check')
    ? {total:1,by_panel:{royal:1}} : {inserted:0,updated:1,skipped:0}}))
  vi.stubGlobal('fetch',fetcher)
  const user=userEvent.setup()
  const {container}=render(<Contacts />)
  const file=new File(['phone,name\n+5491111111111,account1'],'contacts.csv',{type:'text/csv'})
  fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[file]}})
  await screen.findByText('Omitir la misma cuenta; crear las de otros agentes o usuarios')
  await user.click(screen.getByText('Omitir la misma cuenta; crear las de otros agentes o usuarios'))
  await user.click(screen.getByRole('combobox',{name:'Línea de importación'}))
  await user.click(screen.getByRole('option',{name:/^Línea 1$/}))
  expect(within(screen.getByRole('dialog', { name: 'Importar contactos' })).getByRole('status')).toHaveTextContent('Todos los contactos de esta importación pasarán a la Línea 1, incluidos los existentes.')
  expect(screen.getByText('Conservar datos existentes; actualizar solo la línea')).toBeInTheDocument()
  await user.click(screen.getByRole('button',{name:'Importar 1 contactos'}))
  await waitFor(()=>expect(fetcher).toHaveBeenCalledWith('/api/contacts/import',expect.objectContaining({
    body:JSON.stringify({contacts:[{phone:'+5491111111111',name:'account1',segment:undefined}],panels:[],linea:1,conflict_mode:'skip',row_offset:0})
  })))
})
