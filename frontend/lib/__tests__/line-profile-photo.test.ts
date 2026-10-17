// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { MAX_PROFILE_PHOTO_BYTES, prepareProfilePhoto, readProfilePhoto, updateProfilePhoto } from '../cloud-api/profile-photo'
const fetchMock = vi.fn()
const token = 'private-token-not-for-browser'
const number = { phoneNumberId: '345678', wabaId: '234567' }
const photo = 'https://pps.whatsapp.net/profile/example.jpg'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset()
  vi.stubEnv('META_APP_ID', '123456'); vi.stubEnv('META_APP_SECRET', 'primary-secret-value'); vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', 'primary-verifier-value')
  vi.stubEnv('META_ADDITIONAL_APPS_JSON', JSON.stringify([{ appId: '987654', name: 'Lexora', appSecret: 'lexora-secret-value', verifyToken: 'lexora-verifier-value', wabaIds: ['234567'] }]))
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const png = () => sharp({ create: { width: 320, height: 180, channels: 4, background: 'transparent' } }).png().toBuffer()
it('normalizes a valid image to a centered square JPEG without EXIF', async () => {
  const input = await png(), result = await prepareProfilePhoto(input, 'image/png'), meta = await sharp(result).metadata()
  expect(meta).toMatchObject({ format: 'jpeg', width: 640, height: 640, hasAlpha: false })
  expect(meta.exif).toBeUndefined()
})
it('rejects empty, oversized, non-image and falsely labelled files before any Meta request', async () => {
  for (const [bytes, type] of [[Buffer.alloc(0), 'image/png'], [Buffer.alloc(MAX_PROFILE_PHOTO_BYTES + 1), 'image/png'], [Buffer.from('<svg/>'), 'image/svg+xml'], [Buffer.from('not an image'), 'image/jpeg']] as const) {
    await expect(prepareProfilePhoto(bytes, type)).rejects.toThrow()
  }
  expect(fetchMock).not.toHaveBeenCalled()
})
it('reads current and missing photos, including the nested Meta response', async () => {
  fetchMock.mockResolvedValueOnce(json({ data: [{ profile_picture_url: photo }] }))
    .mockResolvedValueOnce(json({ data: [{}] })).mockResolvedValueOnce(json({ data: [{ business_profile: { profile_picture_url: photo } }] }))
  expect(await readProfilePhoto(number.phoneNumberId, token)).toBe(photo)
  expect(await readProfilePhoto(number.phoneNumberId, token)).toBeNull()
  expect(await readProfilePhoto(number.phoneNumberId, token)).toBe(photo)
})
it.each(['javascript:alert(1)', 'http://pps.whatsapp.net/image.jpg', 'https://pps.whatsapp.net.evil.test/image.jpg', 'https://user:password@pps.whatsapp.net/image.jpg'])('rejects an unsafe photo URL: %s', async url => {
  fetchMock.mockResolvedValue(json({ data: [{ profile_picture_url: url }] }))
  await expect(readProfilePhoto(number.phoneNumberId, token)).rejects.toThrow('inválida')
})
function successfulUpload() {
  fetchMock.mockResolvedValueOnce(json({ id: 'upload:abc123?sig=private-signature' }))
    .mockResolvedValueOnce(json({ h: 'private-upload-handle' })).mockResolvedValueOnce(json({ success: true }))
    .mockResolvedValueOnce(json({ data: [{ profile_picture_url: photo }] }))
}
it('uses the correct additional app and token, then changes only this number’s photo', async () => {
  successfulUpload()
  const bytes = await prepareProfilePhoto(await png(), 'image/png')
  const result = await updateProfilePhoto(number, token, bytes)
  expect(result).toEqual({ pictureUrl: photo, refreshPending: false })
  const calls = fetchMock.mock.calls
  expect(calls[0][0]).toContain('/987654/uploads?')
  expect(new URL(calls[0][0]).searchParams.get('file_length')).toBe(String(bytes.length))
  expect(calls[1][1].headers.file_offset).toBe('0')
  expect(Buffer.from(calls[1][1].body)).toEqual(bytes)
  expect(calls[2][0]).toMatch(/\/345678\/whatsapp_business_profile$/)
  expect(JSON.parse(calls[2][1].body)).toEqual({ messaging_product: 'whatsapp', profile_picture_handle: 'private-upload-handle' })
  for (const [url, options] of calls) {
    expect(new URL(url).hostname).toBe('graph.facebook.com')
    expect(url).not.toContain(token)
    expect(options.headers.Authorization).toBe(`Bearer ${token}`)
    expect(options.redirect).toBe('error')
  }
  expect(JSON.stringify(result)).not.toMatch(/private-/)
})
it('uses the primary app for its own WABA', async () => {
  successfulUpload(); await updateProfilePhoto({ ...number, wabaId: '888888' }, token, Buffer.from('prepared image'))
  expect(fetchMock.mock.calls[0][0]).toContain('/123456/uploads?')
})
it('never retries an uncertain write or returns the upstream secret-bearing error', async () => {
  fetchMock.mockResolvedValueOnce(json({ id: 'upload:abc123' })).mockResolvedValueOnce(json({ h: 'private-upload-handle' }))
    .mockRejectedValueOnce(Error(token + ' private-upload-handle'))
  await expect(updateProfilePhoto(number, token, Buffer.from('prepared image'))).rejects.toThrow('Actualizá la foto')
  expect(fetchMock).toHaveBeenCalledTimes(3)
})
it('preserves a confirmed update when the refresh is temporarily unavailable', async () => {
  fetchMock.mockResolvedValueOnce(json({ id: 'upload:abc123' })).mockResolvedValueOnce(json({ h: 'private-upload-handle' }))
    .mockResolvedValueOnce(json({ success: true })).mockResolvedValueOnce(json({ error: { code: 190, message: token } }, 400))
  expect(await updateProfilePhoto(number, token, Buffer.from('prepared image'))).toEqual({ pictureUrl: null, refreshPending: true })
})
it.each([190, 200, 4, 100])('sanitizes Meta errors (%s) without leaking credentials', async code => {
  fetchMock.mockResolvedValue(json({ error: { code, message: token } }, 400))
  await expect(readProfilePhoto(number.phoneNumberId, token)).rejects.not.toThrow(token)
})
