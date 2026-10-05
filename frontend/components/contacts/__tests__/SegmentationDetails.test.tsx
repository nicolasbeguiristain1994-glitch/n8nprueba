import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react'
import {afterEach,describe,it,expect,vi} from 'vitest'
import {SegmentationDetails} from '../SegmentationDetails'
import type {SegmentationProfile} from '@/lib/contact-segmentation'
afterEach(cleanup)
describe('Segmentation explanations',()=>{
 it('keeps missing history separate from inactivity',()=>{
  render(<SegmentationDetails onAutomatic={vi.fn()}/>)
  expect(screen.getByText('Sin historial vinculado')).toBeInTheDocument()
  expect(screen.getByText(/No se interpreta como un contacto inactivo/)).toBeInTheDocument()
  expect(screen.queryByText(/Depósitos en 30 días/)).not.toBeInTheDocument()
 })
 it('explains partial, stale and manually chosen values and restores only on request',async()=>{
  const onAutomatic=vi.fn().mockResolvedValue(undefined)
  const profile={monthly_average:500000,active_months:2,partial_history:true,as_of:'2026-10-05',calculated_at:'2026-10-05',accounts:[{platform:'ganamos',username:'fixture',last_sync_at:null}]} as SegmentationProfile
  render(<SegmentationDetails profile={profile} quality="parcial" manual onAutomatic={onAutomatic}/>)
  expect(onAutomatic).not.toHaveBeenCalled()
  expect(screen.getByText(/Nivel elegido manualmente/)).toBeInTheDocument()
  expect(screen.getByText(/Revisar actualización de ganamos/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'Usar nivel calculado'}))
  await waitFor(()=>expect(onAutomatic).toHaveBeenCalledOnce())
 })
 it('shows restoration failures without claiming success',async()=>{
  render(<SegmentationDetails manual onAutomatic={vi.fn().mockRejectedValue(new Error('Sin permiso'))}/>)
  fireEvent.click(screen.getByRole('button',{name:'Usar nivel calculado'}))
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Sin permiso'))
 })
})
