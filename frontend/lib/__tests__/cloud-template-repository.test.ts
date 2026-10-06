/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { query } from '@/lib/db'
import { templateRepository } from '@/lib/cloud-api/repositories/template.repository'

vi.mock('@/lib/db', () => ({ query: vi.fn() }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(query).mockResolvedValue([])
})

describe('templateRepository.updateTemplateStatus', () => {
  const scope = { wabaId: '87654', includeLegacy: false }
  it('updates the campaign template catalog by Meta ID using bound parameters', async () => {
    const metaId = "meta-id-'quoted'"
    const reason = "Rejected: 'example'"
    await templateRepository.updateTemplateStatus(metaId, 'RECHAZADA', reason, scope)

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = vi.mocked(query).mock.calls[0]
    expect(sql).toMatch(/UPDATE\s+whatsapp_templates\s+SET\s+status\s*=\s*\$1/)
    expect(sql).toMatch(/rejection_reason\s*=\s*\$2/)
    expect(sql).toMatch(/updated_at\s*=\s*NOW\(\)/)
    expect(sql).toMatch(/WHERE\s+whatsapp_template_id\s*=\s*\$3/)
    expect(sql).toContain('AND (waba_id = $4 OR ($5 AND waba_id IS NULL))')
    expect(params).toEqual(['RECHAZADA', reason, metaId, '87654', false])
    for (const value of ['RECHAZADA', reason, metaId]) expect(sql).not.toContain(value)
  })

  it('clears the previous rejection reason when an approval has no reason', async () => {
    await templateRepository.updateTemplateStatus('meta-template', 'APROBADA', null, scope)
    expect(query).toHaveBeenCalledWith(expect.any(String), ['APROBADA', null, 'meta-template', '87654', false])
  })

  it('propagates a persistence failure so webhook processing can retry it', async () => {
    const failure = new Error('Mock storage unavailable')
    vi.mocked(query).mockRejectedValue(failure)
    await expect(templateRepository.updateTemplateStatus('meta-template', 'DESHABILITADA', null, scope))
      .rejects.toBe(failure)
    expect(query).toHaveBeenCalledTimes(1)
  })
})
