// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { metaApp, metaApps, publicAppConfiguration } from '../cloud-api/app-config'

const extra = { appId: '98765', name: 'Nexus', appSecret: 'separate-secret-test', verifyToken: 'separate-verification-test', wabaIds: ['87654'] }
beforeEach(() => {
  vi.stubEnv('META_APP_ID', '12345')
  vi.stubEnv('META_APP_SECRET', 'legacy-secret-test')
  vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', 'legacy-verify-test')
  vi.stubEnv('META_ADDITIONAL_APPS_JSON', JSON.stringify([extra]))
})
afterEach(() => vi.unstubAllEnvs())

it('keeps the original callback and reserves additional WABAs to their own app', () => {
  const [legacy, nexus] = metaApps()
  expect(legacy.webhookPath).toBe('/api/cloud/webhook')
  expect(legacy.permitsWaba('23456')).toBe(true)
  expect(legacy.permitsWaba('87654')).toBe(false)
  expect(nexus.webhookPath).toBe('/api/cloud/webhook/98765')
  expect(nexus.permitsWaba('87654')).toBe(true)
  expect(nexus.permitsWaba('23456')).toBe(false)
  expect(metaApp('unknown')).toBeUndefined()
})

it('returns only the legacy app when no additional configuration is present', () => {
  vi.stubEnv('META_ADDITIONAL_APPS_JSON', '')
  expect(metaApps()).toHaveLength(1)
  expect(metaApp()!.permitsWaba('87654')).toBe(true)
})

it.each([
  '{invalid',
  JSON.stringify([{ ...extra, appId: '12345' }]),
  JSON.stringify([{ ...extra, appSecret: 'legacy-secret-test' }]),
  JSON.stringify([{ ...extra, verifyToken: 'legacy-verify-test' }]),
  JSON.stringify([{ ...extra, wabaIds: [] }]),
  JSON.stringify([{ ...extra, wabaIds: ['87654', '87654'] }]),
  JSON.stringify([{ ...extra, wabaIds: ['not-an-id'] }]),
  JSON.stringify([extra, { ...extra, appId: '98766', appSecret: 'different-secret-test', verifyToken: 'different-verifier-test' }]),
])('fails closed without exposing malformed or ambiguous configuration: case %#', raw => {
  vi.stubEnv('META_ADDITIONAL_APPS_JSON', raw)
  expect(() => metaApps()).toThrow('Revisá la configuración de aplicaciones Meta adicionales en el servidor.')
})

it('omits all credentials from public configuration', () => {
  const publicConfig = metaApps().map(publicAppConfiguration)
  expect(publicConfig[1]).toMatchObject({ appId: extra.appId, name: 'Nexus', wabaIds: ['87654'] })
  const text = JSON.stringify(publicConfig)
  for (const secret of [extra.appSecret, extra.verifyToken, 'legacy-secret-test', 'legacy-verify-test']) expect(text).not.toContain(secret)
})
