import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CampaignRoutingPreview } from '@/components/campaigns/CampaignRoutingPreview'
const result=(name:string)=>({calculated_at:'2026-10-15T20:00:00Z',eligible:10,excluded:1,assigned:10,unassigned:0,pending:3,hidden_line_contacts:0,has_variable_schedule:false,
  lines:[{id:'1',name,phone:null,assigned:10,habitual:8,new:2,remaining_hour:7,remaining_day:100,pending:3,reason:null}]})
afterEach(()=>vi.unstubAllGlobals())
it('clears stale allocation when the template changes and ignores the old response',async()=>{
  let resolveOld!:(response:Response)=>void
  const fetch=vi.fn().mockImplementationOnce(()=>new Promise<Response>(resolve=>{resolveOld=resolve})).mockResolvedValueOnce(Response.json(result('Lexora')))
  vi.stubGlobal('fetch',fetch)
  const {rerender}=render(<CampaignRoutingPreview audience={{list_id:'list'}} messageType="template" templateId="nexus" scheduled={false}/>)
  rerender(<CampaignRoutingPreview audience={{list_id:'list'}} messageType="template" templateId="lexora" scheduled={false}/>)
  await screen.findByText('Lexora')
  await act(async()=>resolveOld(Response.json(result('Nexus'))))
  expect(screen.queryByText('Nexus')).not.toBeInTheDocument()
  expect(screen.getByText('Habituales: 8 · Nuevos: 2')).toBeInTheDocument()
  expect(screen.getByText('3 pendientes; conservan esta línea.')).toBeInTheDocument()
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({list_id:'list',message_type:'template',template_id:'lexora'})
})
it('shows a recoverable preview error without retaining previous counts',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(Response.json(result('Lexora'))).mockResolvedValueOnce(Response.json({error:'Consulta no disponible'},{status:503})).mockResolvedValueOnce(Response.json(result('Lexora 2')))
  vi.stubGlobal('fetch',fetch)
  render(<CampaignRoutingPreview audience={{contact_ids:['contact']}} messageType="text" scheduled={true}/>)
  await screen.findByText('Lexora')
  fireEvent.click(screen.getByRole('button',{name:'Actualizar reparto'}))
  await screen.findByRole('alert');expect(screen.queryByText('Lexora')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'Actualizar reparto'}))
  await screen.findByText('Lexora 2')
  await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(3))
  expect(screen.getByText(/La programación usa las líneas/)).toBeInTheDocument()
})
