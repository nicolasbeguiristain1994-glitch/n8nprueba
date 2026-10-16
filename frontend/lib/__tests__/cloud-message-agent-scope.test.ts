// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ execute: vi.fn(), access: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: async () => ({ ok: true, user: { user_id: 'operator' } }) }))
vi.mock('@/lib/cloud-api/access', () => ({ cloudNumberAccess: mocks.access }))
vi.mock('@/lib/cloud-api/use-cases/send-message.use-case', () => ({ sendMessageUseCase: { execute: mocks.execute } }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
import { POST } from '@/app/api/cloud/messages/route'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.access.mockResolvedValue(null)
  mocks.execute.mockResolvedValue({ wamid: 'simulated', messageId: 'local-test' })
})
const request = (extra: Record<string, unknown> = {}) => new NextRequest('http://localhost/api/cloud/messages', {
  method: 'POST', body: JSON.stringify({ phoneNumberId: '123456789', to: '+5491100000001', type: 'text', text: { body: 'Prueba local' }, ...extra }),
})

it.each([{ agentCode: 'royal' }, { campaignId: 'another-agent-campaign' }])('rejects caller-supplied consent attribution: %j', async extra => {
  expect((await POST(request(extra))).status).toBe(400)
  expect(mocks.execute).not.toHaveBeenCalled()
})

it('delegates an ordinary message with no caller-selected agent', async () => {
  expect((await POST(request())).status).toBe(200)
  expect(mocks.execute).toHaveBeenCalledWith({ enqueue: false, request: expect.objectContaining({ sentByUserId: 'operator' }) })
  const sent = mocks.execute.mock.calls[0][0].request
  expect(sent).not.toHaveProperty('agentCode')
  expect(sent).not.toHaveProperty('campaignId')
})
