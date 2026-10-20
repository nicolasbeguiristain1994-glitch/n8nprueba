// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ query: vi.fn(), get: vi.fn(), token: vi.fn(), guard: vi.fn(), phone: vi.fn(), health: vi.fn(), quality: vi.fn(), status: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
vi.mock('@/lib/campaign-risk', () => ({ raiseRiskIncident: vi.fn(), clearMetaRiskSignal: vi.fn(), assertCloudSendRiskClear: mocks.guard, CampaignRiskError: class extends Error {} }))
vi.mock('@/lib/cloud-api/token-store', () => ({ getTokenForNumber: mocks.token }))
vi.mock('@/lib/cloud-api/infrastructure/meta-http.gateway', () => ({ MetaHttpGateway: class { get = mocks.get } }))
vi.mock('@/lib/cloud-api/webhook-handlers/meta-risk.handler', () => ({ applyPhoneQualityRisk: mocks.phone, applyPhoneHealthRisk: mocks.health, handleTemplateQualityRisk: mocks.quality, handleTemplateStatusRisk: mocks.status }))

let check: typeof import('../cloud-api/meta-risk-refresh')['refreshOperationalAlertMeta']
let remote: Record<string, unknown>
let phone: Record<string, unknown>
beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  mocks.token.mockResolvedValue('private-test-token')
  mocks.query.mockImplementation(async (sql: string) => sql.includes('SELECT') ? [{ waba_id: '23456' }] : [])
  phone = { id: '12345', quality_rating: 'GREEN', health_status: { can_send_message: 'LIMITED', entities: [{ entity_type: 'PHONE_NUMBER', id: '12345', can_send_message: 'LIMITED' }] } }
  remote = { id: '34567', name: 'alerta_seguridad_campana', language: 'es_AR', status: 'APPROVED', category: 'UTILITY', quality_score: { score: 'UNKNOWN' }, components: [
    { type: 'HEADER', format: 'TEXT', text: 'Campaña pausada' }, { type: 'BODY', text: 'Revisá la alerta en el panel.' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Revisar', url: 'https://example.com/campaigns' }] },
  ] }
  mocks.get.mockImplementation(async (path: string) => path.startsWith('/12345?') ? phone : { data: [remote] })
  check = (await import('../cloud-api/meta-risk-refresh')).refreshOperationalAlertMeta
})

describe('operational WhatsApp alert preflight', () => {
  it('verifies remote ownership and approves fixed UTILITY content with pending quality and LIMITED phone health', async () => {
    await expect(check('12345', 'alerta_seguridad_campana', 'es_AR', '34567')).resolves.toEqual({ templateId: '34567', wabaId: '23456' })
    expect(mocks.get).toHaveBeenCalledWith(expect.stringMatching(/^\/23456\/message_templates\?name=alerta_seguridad_campana/))
    expect(mocks.status).toHaveBeenCalledWith(expect.objectContaining({ event: 'APPROVED' }), '23456', expect.any(String))
  })
  it.each([
    ['pending review', { status: 'PENDING' }], ['marketing reclassification', { category: 'MARKETING' }],
    ['missing quality', { quality_score: undefined }], ['low quality', { quality_score: { score: 'RED' } }],
    ['wrong language', { language: 'es' }], ['wrong ID', { id: '99999' }],
    ['dynamic body', { components: [{ type: 'BODY', text: 'Hola {{1}}' }] }],
    ['dynamic button', { components: [{ type: 'BODY', text: 'Alerta' }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Abrir', url: 'https://example.com/{{1}}' }] }] }],
    ['media header', { components: [{ type: 'BODY', text: 'Alerta' }, { type: 'HEADER', format: 'IMAGE' }] }],
  ])('blocks %s', async (_label, patch) => {
    Object.assign(remote, patch)
    await expect(check('12345', 'alerta_seguridad_campana', 'es_AR', '34567')).rejects.toThrow()
  })
  it('blocks a missing or disabled local sender before contacting Meta', async () => {
    mocks.query.mockResolvedValue([])
    await expect(check('12345', 'alerta_seguridad_campana', 'es_AR')).rejects.toThrow('no está disponible')
    expect(mocks.get).not.toHaveBeenCalled()
  })
  it.each(['YELLOW', 'RED'])('blocks phone quality %s', async quality => {
    phone.quality_rating = quality
    await expect(check('12345', 'alerta_seguridad_campana', 'es_AR')).rejects.toThrow('calidad insuficiente')
    expect(mocks.get).toHaveBeenCalledTimes(1)
  })
  it('blocks messaging health even when phone quality is GREEN', async () => {
    phone.health_status = { can_send_message: 'BLOCKED', entities: [{ entity_type: 'WABA', id: '23456', can_send_message: 'BLOCKED' }] }
    await expect(check('12345', 'alerta_seguridad_campana', 'es_AR')).rejects.toThrow('restricción')
  })
  it('caches only remote observations while a later webhook or local disable still blocks the next attempt', async () => {
    await check('12345', 'alerta_seguridad_campana', 'es_AR')
    mocks.guard.mockRejectedValueOnce(new Error('new webhook hold'))
    await expect(check('12345', 'alerta_seguridad_campana', 'es_AR')).rejects.toThrow('new webhook hold')
    expect(mocks.get).toHaveBeenCalledTimes(2)
    mocks.query.mockResolvedValue([])
    await expect(check('12345', 'alerta_seguridad_campana', 'es_AR')).rejects.toThrow('no está disponible')
  })
  it('never caches a check whose persistence failed', async () => {
    mocks.quality.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(check('12345', 'alerta_seguridad_campana', 'es_AR')).rejects.toThrow('database unavailable')
    await check('12345', 'alerta_seguridad_campana', 'es_AR')
    expect(mocks.get).toHaveBeenCalledTimes(4)
  })
  it('fails closed if the WABA list is incomplete or the template identity is duplicated', async () => {
    mocks.get.mockImplementation(async (path: string) => path.startsWith('/12345?') ? phone : { data: [remote], paging: { next: 'https://graph.facebook.com/next' } })
    await expect(check('12345', 'alerta_seguridad_campana', 'es_AR')).rejects.toThrow('lista completa')
    mocks.get.mockImplementation(async (path: string) => path.startsWith('/12345?') ? phone : { data: [remote, remote] })
    await expect(check('12345', 'alerta_seguridad_campana', 'es_AR')).rejects.toThrow('no pertenece')
  })
})
