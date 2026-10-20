// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ query: vi.fn(), tx: vi.fn(), execute: vi.fn(), emit: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: m.query, withTransaction: async (fn: (db: unknown) => unknown) => fn({ query: m.tx }) }))
vi.mock('@/lib/cloud-api/use-cases/send-message.use-case', () => ({ sendMessageUseCase: { execute: m.execute } }))
vi.mock('@/lib/sse-events', () => ({ sseEmitter: { emit: m.emit } }))
vi.mock('@/lib/campaign-risk', () => ({ CampaignRiskError: class extends Error { name = 'CampaignRiskError' } }))
import { CampaignRiskError } from '@/lib/campaign-risk'
import { processAutomationJobs } from '@/lib/automation-engine'
const job = { id: 'job', event_key: 'event', automation_id: 'rule', automation_name: 'Rule', phone: '5491100000001',
  provider: 'cloud', source_id: 'phone', body: 'Respuesta', step: 0, handoff: false, legacy_message_id: null, agent_code: 'royal' }
let claimed: boolean
beforeEach(() => {
  vi.clearAllMocks()
  claimed = false
  m.query.mockImplementation(async (sql: string) => {
    if (sql.includes('WITH next AS')) { if (claimed) return []; claimed = true; return [{ ...job }] }
    if (sql.includes('SELECT a.type')) return [{ type: 'reply', trigger_config: {} }]
    if (sql.includes('FROM cloud_numbers cn')) return [{}]
    return []
  })
  m.tx.mockResolvedValue({ rows: [{ id: job.id }] })
})
it('finishes a risk-blocked automatic reply as a known skip and never reclaims it', async () => {
  m.execute.mockRejectedValue(new CampaignRiskError())
  expect(await processAutomationJobs()).toBe(1)
  expect(m.tx).toHaveBeenCalledWith(expect.stringContaining('UPDATE automation_message_jobs'),
    [job.id, 'skipped', expect.stringContaining('no se contactó al proveedor')])
  expect(m.tx).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['uncertain']))
  expect(await processAutomationJobs()).toBe(0)
  expect(m.execute).toHaveBeenCalledTimes(1)
  expect(m.emit).not.toHaveBeenCalled()
})
it('keeps a provider timeout uncertain rather than claiming a safe skip', async () => {
  m.execute.mockRejectedValue(new Error('Timeout after provider dispatch'))
  expect(await processAutomationJobs()).toBe(1)
  expect(m.tx).toHaveBeenCalledWith(expect.stringContaining('UPDATE automation_message_jobs'),
    [job.id, 'uncertain', expect.stringContaining('Envío no confirmado')])
})
