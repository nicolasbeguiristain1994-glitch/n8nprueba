import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@/lib/fetchJson',()=>({fetchJson:vi.fn()}))
vi.mock('@/lib/useCurrentUser',()=>({useCurrentUser:()=>({user:{id:'owner',role:'admin'},permissions:{contacts:['read','create']}})}))
import { fetchJson } from '@/lib/fetchJson'
import Contacts from '@/app/(protected)/contacts/page'
const a='11111111-1111-4111-8111-000000000011',b='11111111-1111-4111-8111-000000000012'
afterEach(()=>{cleanup();vi.useRealTimers();vi.clearAllMocks();localStorage.clear()})
it('filters before selection, clears the previous selection and separates review of other lines',async()=>{
  vi.useFakeTimers()
  const lines=[{id:a,name:'Lexora',phone:'+5491100000011'},{id:b,name:'Lexora 2',phone:'+5491100000012'}]
  vi.mocked(fetchJson).mockImplementation(async input=>{
    const url=String(input)
    if(url==='/api/contacts/sending-lines')return {lines}
    if(url.startsWith('/api/contacts/history'))return {history:[]}
    if(url.startsWith('/api/contacts?')){
      const sp=new URL(url,'http://local.test').searchParams
      const sender=sp.get('sending_line')===b&&sp.get('sending_mode')!=='other'?lines[1]:lines[0]
      return {contacts:[{id:'contact-one',first_name:'Cuenta visible',phone_number:'+5491100000001',sending_line:sender}],total:1}
    }
    return {lists:[]}
  })
  render(<Contacts/>);await act(async()=>{})
  expect(screen.getAllByText('Lexora').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByLabelText('Seleccionar todas las filas de esta página'))
  await act(async()=>{})
  fireEvent.change(screen.getByLabelText('Línea de envío'),{target:{value:b}})
  await act(async()=>{await vi.advanceTimersByTimeAsync(250)})
  expect(screen.getByLabelText('Seleccionar todas las filas de esta página')).not.toBeChecked()
  const calls=vi.mocked(fetchJson).mock.calls.filter(([u])=>String(u).startsWith('/api/contacts?'))
  expect(String(calls.at(-1)![0])).toContain('sending_line='+b)
  expect(screen.getAllByText('+5491100000012').length).toBeGreaterThan(0)
  fireEvent.change(screen.getByLabelText('Asignación de línea de envío'),{target:{value:'other'}})
  await act(async()=>{await vi.advanceTimersByTimeAsync(250)})
  expect(screen.getByRole('button',{name:'Crear campaña (1)'})).toBeDisabled()
  expect(screen.getByText(/Estás revisando contactos asignados a otras líneas/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'Quitar filtro de envío'}))
  await act(async()=>{await vi.advanceTimersByTimeAsync(250)})
  expect(screen.getByLabelText('Línea de envío')).toHaveValue('')
  expect(screen.queryByLabelText('Asignación de línea de envío')).not.toBeInTheDocument()
})
