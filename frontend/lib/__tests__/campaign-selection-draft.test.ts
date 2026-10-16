import { afterEach, expect, it, vi } from 'vitest'
import { saveCampaignSelection, readCampaignSelection, clearCampaignSelection } from '../campaign-selection-draft'
const ids = ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222']
afterEach(() => { sessionStorage.clear(); vi.useRealTimers() })
it('preserves a fixed unique selection across navigation and reload, scoped to the account', () => {
  const token = saveCampaignSelection('owner', [...ids,ids[0]])
  expect(readCampaignSelection(token,'owner')?.contactIds).toEqual(ids)
  expect(readCampaignSelection(token,'another')).toBeNull()
  clearCampaignSelection(token); expect(readCampaignSelection(token,'owner')).toBeNull()
})
it('rejects invalid and expired drafts instead of silently using another audience', () => {
  expect(() => saveCampaignSelection('owner',[])).toThrow()
  expect(() => saveCampaignSelection('owner',['invalid'])).toThrow()
  expect(readCampaignSelection('invalid','owner')).toBeNull()
  vi.useFakeTimers();const token = saveCampaignSelection('owner',ids)
  vi.advanceTimersByTime(25*60*60*1000);expect(readCampaignSelection(token,'owner')).toBeNull()
})
it('surfaces storage failures so navigation never loses the selection silently', () => {
  expect(() => saveCampaignSelection('owner',ids,{setItem:()=>{throw Error('quota')}} as unknown as Storage)).toThrow('quota')
})
