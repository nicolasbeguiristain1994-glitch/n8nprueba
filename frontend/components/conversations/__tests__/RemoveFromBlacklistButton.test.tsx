import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemoveFromBlacklistButton } from '../RemoveFromBlacklistButton'
const mocks = vi.hoisted(() => ({ permissions: {blacklist:['manage']} as Record<string,string[]>, fetch:vi.fn() }))
vi.mock('@/lib/useCurrentUser', () => ({useCurrentUser:()=>({permissions:mocks.permissions})}))
const phone='5491100000001'
const entry={id:'00000000-0000-4000-8000-000000000001',scope_key:'agent:royal',agent_code:'royal',reason:'Baja solicitada por el contacto',line_name:null}
beforeEach(()=>{
  mocks.permissions={blacklist:['manage']};mocks.fetch.mockReset()
  mocks.fetch.mockImplementation((_url,options)=>Promise.resolve(Response.json(options?.method==='PATCH'?{ok:true}:{entries:[entry]})))
  vi.stubGlobal('fetch',mocks.fetch)
})
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
async function open() {
  fireEvent.click(screen.getByRole('button',{name:'Quitar de blacklist'}))
  await screen.findByRole('combobox')
}
async function confirm() {
  await open()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.change(screen.getByRole('textbox',{name:'Motivo de reactivación'}),{target:{value:'El contacto confirmó por WhatsApp que tocó BAJA por error'}})
}
it('removes an exact block from an agentless chat with consent, without sending messages',async()=>{
  const refresh=vi.fn()
  render(<RemoveFromBlacklistButton phone={phone} onRemoved={refresh}/>)
  await open()
  expect(screen.getByRole('combobox')).toHaveValue(entry.id)
  expect(screen.getByText(/Motivo de la baja: Baja solicitada/)).toBeInTheDocument()
  const submit=screen.getByRole('button',{name:'Confirmar reactivación'})
  expect(submit).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox'));expect(submit).toBeDisabled()
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'Confirmó por WhatsApp que la baja fue accidental'}})
  fireEvent.click(submit)
  await waitFor(()=>expect(refresh).toHaveBeenCalledOnce())
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  expect(mocks.fetch).toHaveBeenLastCalledWith(`/api/conversations/${phone}/blacklist`,expect.objectContaining({method:'PATCH',body:JSON.stringify({entry_id:entry.id,consent_confirmed:true,consent_note:'Confirmó por WhatsApp que la baja fue accidental'})}))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
it('requires choosing a block if several exist and resets consent on scope changes',async()=>{
  mocks.fetch.mockResolvedValue(Response.json({entries:[entry,{...entry,id:'global-id',agent_code:null,scope_key:'global'},{...entry,id:'source-id',agent_code:null,scope_key:'source:cloud:1',line_name:'Commando BD'}]}))
  render(<RemoveFromBlacklistButton phone={phone}/>);await open()
  const select=screen.getByRole('combobox')
  expect(select).toHaveValue('');expect(screen.getByRole('checkbox')).toBeDisabled()
  expect(screen.getByRole('option',{name:'Línea Commando BD'})).toBeInTheDocument()
  fireEvent.change(select,{target:{value:entry.id}})
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'Confirmó por WhatsApp la reactivación'}})
  fireEvent.change(select,{target:{value:'global-id'}})
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  expect(screen.getByRole('textbox')).toHaveValue('')
  expect(screen.getByRole('button',{name:'Confirmar reactivación'})).toBeDisabled()
})
it('preselects the current agent when several blocks exist',async()=>{
  mocks.fetch.mockResolvedValue(Response.json({entries:[{...entry,id:'other',agent_code:'bigwin',scope_key:'agent:bigwin'},entry]}))
  render(<RemoveFromBlacklistButton phone={phone} agent="royal"/>);await open()
  expect(screen.getByRole('combobox')).toHaveValue(entry.id)
})
it('preserves the blocked state and shows the server error on failure',async()=>{
  const refresh=vi.fn()
  render(<RemoveFromBlacklistButton phone={phone} agent="royal" onRemoved={refresh}/>);await confirm()
  mocks.fetch.mockResolvedValue(Response.json({error:'Esta baja ya no está activa'},{status:404}))
  fireEvent.click(screen.getByRole('button',{name:'Confirmar reactivación'}))
  expect(await screen.findByRole('alert')).toHaveTextContent('Esta baja ya no está activa')
  expect(refresh).not.toHaveBeenCalled();expect(screen.getByRole('dialog')).toBeInTheDocument()
})
it('does not repeat a pending removal or permit closing before its result',async()=>{
  render(<RemoveFromBlacklistButton phone={phone} agent="royal"/>);await confirm()
  let finish!:(response:Response)=>void;mocks.fetch.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  const submit=screen.getByRole('button',{name:'Confirmar reactivación'})
  fireEvent.click(submit);fireEvent.click(submit)
  expect(screen.getByRole('button',{name:'Quitando…'})).toBeDisabled()
  expect(screen.getByRole('button',{name:'Cancelar'})).toBeDisabled()
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  await act(async()=>finish(Response.json({ok:true})))
})
it('does not expose the action to operators without blacklist permission',()=>{
  mocks.permissions={conversations:['read','update']}
  render(<RemoveFromBlacklistButton phone={phone} agent="royal"/>)
  expect(screen.queryByRole('button')).not.toBeInTheDocument();expect(mocks.fetch).not.toHaveBeenCalled()
})
it('resets consent when changing the selected conversation',async()=>{
  const view=render(<RemoveFromBlacklistButton key="royal" phone={phone} agent="royal"/>);await confirm()
  view.rerender(<RemoveFromBlacklistButton key="bigwin" phone={phone} agent="bigwin"/>);await open()
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  expect(screen.getByRole('textbox')).toHaveValue('')
})
it('allows retrying a failed lookup without enabling removal',async()=>{
  mocks.fetch.mockRejectedValueOnce(new Error('Sin conexión'))
  render(<RemoveFromBlacklistButton phone={phone}/>)
  fireEvent.click(screen.getByRole('button',{name:'Quitar de blacklist'}))
  expect(await screen.findByRole('alert')).toHaveTextContent('Sin conexión')
  expect(screen.queryByRole('button',{name:'Confirmar reactivación'})).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'Reintentar'}))
  expect(await screen.findByRole('combobox')).toHaveValue(entry.id)
})
it('handles already removed entries without presenting a removal form',async()=>{
  mocks.fetch.mockResolvedValue(Response.json({entries:[]}))
  render(<RemoveFromBlacklistButton phone={phone}/>)
  fireEvent.click(screen.getByRole('button',{name:'Quitar de blacklist'}))
  expect(await screen.findByText(/No quedan bajas activas/)).toBeInTheDocument()
  expect(screen.queryByRole('button',{name:'Confirmar reactivación'})).not.toBeInTheDocument()
})
