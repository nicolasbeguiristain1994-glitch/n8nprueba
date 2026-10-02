// @vitest-environment node
import { vi,it,expect,beforeEach } from 'vitest'
import type { SessionUser } from '../auth'
const mock=vi.hoisted(()=>({find:vi.fn(),ids:vi.fn()}))
vi.mock('@/lib/cloud-api/repositories/cloud-number.repository',()=>({cloudNumberRepository:{findByPhoneNumberId:mock.find}}))
vi.mock('@/lib/line-visibility',()=>({getAccessibleLineIds:mock.ids}))
import { cloudNumberAccess } from '../cloud-api/access'
const user={user_id:'u'} as SessionUser
beforeEach(()=>vi.resetAllMocks())
it('prevents access to another user’s number',async()=>{mock.find.mockResolvedValue({whatsappLineId:'other'});mock.ids.mockResolvedValue(['own']);expect((await cloudNumberAccess(user,'12345'))?.status).toBe(403)})
it('allows an assigned line',async()=>{mock.find.mockResolvedValue({whatsappLineId:'own'});mock.ids.mockResolvedValue(['own']);expect(await cloudNumberAccess(user,'12345')).toBeNull()})
it('does not expose unassigned numbers to scoped users',async()=>{mock.find.mockResolvedValue({whatsappLineId:null});mock.ids.mockResolvedValue([]);expect((await cloudNumberAccess(user,'12345'))?.status).toBe(403)})
it('allows the unscoped administrator',async()=>{mock.find.mockResolvedValue({whatsappLineId:null});mock.ids.mockResolvedValue(null);expect(await cloudNumberAccess(user,'12345')).toBeNull()})
it('returns 404 for a missing number',async()=>{mock.find.mockResolvedValue(null);expect((await cloudNumberAccess(user,'12345'))?.status).toBe(404)})
