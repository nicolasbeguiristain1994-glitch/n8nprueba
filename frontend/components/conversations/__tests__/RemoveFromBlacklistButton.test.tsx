import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemoveFromBlacklistButton } from '../RemoveFromBlacklistButton'
const mocks = vi.hoisted(() => ({ permissions: {blacklist:['manage']} as Record<string,string[]>, fetch:vi.fn() }))
vi.mock('@/lib/useCurrentUser', () => ({useCurrentUser:()=>({permissions:mocks.permissions})}))
const phone='5491100000001'
beforeEach(()=>{mocks.permissions={blacklist:['manage']};mocks.fetch.mockReset();vi.stubGlobal('fetch',mocks.fetch)})
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
function confirm() {
  fireEvent.click(screen.getByRole('button',{name:'Quitar de blacklist'}))
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.change(screen.getByRole('textbox',{name:'Motivo de reactivación'}),{target:{value:'El contacto confirmó por WhatsApp que tocó BAJA por error'}})
}
it('requires confirmation, records the selected agent and refreshes without sending a message',async()=>{
  const refresh=vi.fn();mocks.fetch.mockResolvedValue(Response.json({ok:true}))
  render(<RemoveFromBlacklistButton phone={phone} agent="royal" onRemoved={refresh}/>)
  fireEvent.click(screen.getByRole('button',{name:'Quitar de blacklist'}))
  expect(screen.getByText(/para el agente royal/)).toBeInTheDocument()
  const submit=screen.getByRole('button',{name:'Confirmar reactivación'})
  expect(submit).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox'));expect(submit).toBeDisabled()
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'Confirmó por WhatsApp que la baja fue accidental'}})
  fireEvent.click(submit)
  await waitFor(()=>expect(refresh).toHaveBeenCalledOnce())
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  expect(mocks.fetch).toHaveBeenCalledWith(`/api/conversations/${phone}/blacklist`,expect.objectContaining({method:'PATCH',body:JSON.stringify({agent_code:'royal',consent_confirmed:true,consent_note:'Confirmó por WhatsApp que la baja fue accidental'})}))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
it('preserves the blocked state and shows the server error on failure',async()=>{
  const refresh=vi.fn();mocks.fetch.mockResolvedValue(Response.json({error:'Existe un bloqueo global'},{status:409}))
  render(<RemoveFromBlacklistButton phone={phone} agent="royal" onRemoved={refresh}/>);confirm()
  fireEvent.click(screen.getByRole('button',{name:'Confirmar reactivación'}))
  expect(await screen.findByRole('alert')).toHaveTextContent('Existe un bloqueo global')
  expect(refresh).not.toHaveBeenCalled();expect(screen.getByRole('dialog')).toBeInTheDocument()
})
it('does not repeat a pending removal or permit closing before its result',async()=>{
  let finish!:(response:Response)=>void;mocks.fetch.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  render(<RemoveFromBlacklistButton phone={phone} agent="royal"/>);confirm()
  fireEvent.click(screen.getByRole('button',{name:'Confirmar reactivación'}))
  expect(screen.getByRole('button',{name:'Quitando…'})).toBeDisabled()
  expect(screen.getByRole('button',{name:'Cancelar'})).toBeDisabled()
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  await act(async()=>finish(Response.json({ok:true})))
})
it('does not expose the action to operators without blacklist permission',()=>{
  mocks.permissions={conversations:['read','update']}
  render(<RemoveFromBlacklistButton phone={phone} agent="royal"/>)
  expect(screen.queryByRole('button')).not.toBeInTheDocument();expect(mocks.fetch).not.toHaveBeenCalled()
})
it('requires an identified agent and resets consent when changing the selected conversation',()=>{
  const view=render(<RemoveFromBlacklistButton key="unknown" phone={phone}/>);
  fireEvent.click(screen.getByRole('button',{name:'Quitar de blacklist'}))
  expect(screen.getByRole('link',{name:'Revisar en Blacklist'})).toHaveAttribute('href','/blacklist')
  expect(screen.queryByRole('button',{name:'Confirmar reactivación'})).not.toBeInTheDocument()
  view.rerender(<RemoveFromBlacklistButton key="royal" phone={phone} agent="royal"/>);confirm()
  view.rerender(<RemoveFromBlacklistButton key="bigwin" phone={phone} agent="bigwin"/>)
  fireEvent.click(screen.getByRole('button',{name:'Quitar de blacklist'}))
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  expect(screen.getByRole('textbox')).toHaveValue('');expect(mocks.fetch).not.toHaveBeenCalled()
})
