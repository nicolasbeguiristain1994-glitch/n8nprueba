// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ query:vi.fn(), refresh:vi.fn() }))
vi.mock('@/lib/db', () => ({ query:mocks.query }))
vi.mock('@/lib/cloud-api/infrastructure/meta-http.gateway', () => ({ generateLongLivedToken:mocks.refresh }))
import { getTokenForNumber } from '../cloud-api/token-store'

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('META_APP_ID','12345');vi.stubEnv('META_APP_SECRET','legacy-secret')
  vi.stubEnv('TOKEN_ENCRYPTION_KEY','x'.repeat(32))
  vi.stubEnv('META_ADDITIONAL_APPS_JSON',JSON.stringify([{appId:'98765',name:'Nexus',appSecret:'nexus-secret-test',verifyToken:'nexus-verify-test',wabaIds:['87654']}]))
  mocks.refresh.mockResolvedValue({ accessToken:'refreshed-token',expiresIn:3600 })
})
afterEach(() => vi.unstubAllEnvs())

it.each([['87654','98765','nexus-secret-test'],['23456','12345','legacy-secret']])('refreshes the token with the app assigned to WABA %s', async(waba,app,secret) => {
  mocks.query.mockResolvedValueOnce([{token_enc:'current-token',token_plain:null,expires_at:new Date(Date.now()+3600000),waba_id:waba}]).mockResolvedValue([])
  expect(await getTokenForNumber('34567')).toBe('refreshed-token')
  expect(mocks.refresh).toHaveBeenCalledWith(app,secret,'current-token')
  expect(mocks.query.mock.calls[1][0]).toContain('pgp_sym_encrypt')
})

it('keeps a valid token when Meta declines refresh without switching to another app', async() => {
  mocks.query.mockResolvedValue([{token_enc:'current-token',token_plain:null,expires_at:new Date(Date.now()+3600000),waba_id:'87654'}])
  mocks.refresh.mockRejectedValue(new Error('provider rejected refresh'))
  expect(await getTokenForNumber('34567')).toBe('current-token')
  expect(mocks.refresh).toHaveBeenCalledTimes(1)
  expect(mocks.query).toHaveBeenCalledTimes(1)
})
