import sharp from 'sharp'
import { META_BASE_URL } from './types/domain'
import { metaApps } from './app-config'

export const MAX_PROFILE_PHOTO_BYTES = 5 * 1024 * 1024
export class ProfilePhotoError extends Error {
  constructor(message: string, public readonly status = 422) { super(message) }
}

export async function prepareProfilePhoto(input: Buffer, type: string): Promise<Buffer> {
  if (!input.length || input.length > MAX_PROFILE_PHOTO_BYTES) throw new ProfilePhotoError('La imagen debe pesar hasta 5 MB.')
  if (!['image/jpeg', 'image/png'].includes(type)) throw new ProfilePhotoError('Elegí una imagen JPG o PNG.')
  try {
    const metadata = await sharp(input, { limitInputPixels: 40_000_000, animated: true }).metadata()
    if (!['jpeg', 'png'].includes(metadata.format || '') || (metadata.pages || 1) !== 1) throw new Error('format')
    // Same centered square shown in the preview; remove metadata and transparency.
    return await sharp(input, { limitInputPixels: 40_000_000 }).rotate()
      .resize(640, 640, { fit: 'cover', position: 'centre' }).flatten({ background: '#ffffff' })
      .jpeg({ quality: 90 }).toBuffer()
  } catch { throw new ProfilePhotoError('No se pudo leer la imagen. Elegí otro archivo JPG o PNG válido.') }
}

async function metaRequest(token: string, path: string, options: RequestInit = {}) {
  let response: Response
  try {
    response = await fetch(`${META_BASE_URL}/${path}`, {
      ...options, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    })
  } catch { throw new ProfilePhotoError('No se pudo confirmar la respuesta de Meta. Actualizá la foto antes de volver a guardar.', 502) }
  const data = await response.json().catch(() => null)
  if (!response.ok || !data || data.error) {
    const code = data?.error?.code
    if (code === 190) throw new ProfilePhotoError('La conexión con Meta venció. Volvé a conectar esta línea.')
    if (code === 10 || code === 200) throw new ProfilePhotoError('Meta no autorizó la solicitud. Revisá el permiso de administración de WhatsApp de esta línea.')
    if (response.status === 429 || code === 4 || code === 80007) throw new ProfilePhotoError('Meta está limitando las consultas. Volvé a intentar en unos minutos.', 503)
    // Never return upstream messages, upload handles or credentials to the browser.
    throw new ProfilePhotoError('Meta no pudo completar la solicitud de la foto. Volvé a intentar en unos minutos.', 502)
  }
  return data
}

export async function readProfilePhoto(phoneNumberId: string, token: string): Promise<string | null> {
  const result = await metaRequest(token, `${phoneNumberId}/whatsapp_business_profile?fields=profile_picture_url`)
  if (!Array.isArray(result.data) || result.data.length !== 1) throw new ProfilePhotoError('Meta no devolvió el perfil de esta línea.', 502)
  const profile = result.data[0].business_profile || result.data[0]
  if (!profile.profile_picture_url) return null
  try {
    const url = new URL(profile.profile_picture_url)
    const trusted = ['whatsapp.net', 'fbcdn.net', 'fbsbx.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))
    if (url.protocol !== 'https:' || url.username || url.password || !trusted) throw new Error('url')
    return url.href
  } catch { throw new ProfilePhotoError('Meta devolvió una dirección de foto inválida.', 502) }
}

export async function updateProfilePhoto(number: { phoneNumberId: string; wabaId: string }, token: string, image: Buffer) {
  const app = metaApps().find(candidate => candidate.permitsWaba(number.wabaId))
  if (!app || !/^\d{5,30}$/.test(app.appId)) throw new ProfilePhotoError('Falta configurar la aplicación Meta de esta línea.')
  const params = new URLSearchParams({ file_length: String(image.length), file_type: 'image/jpeg', file_name: 'whatsapp-profile.jpg' })
  const session = await metaRequest(token, `${app.appId}/uploads?${params}`, { method: 'POST' })
  if (typeof session.id !== 'string' || !session.id.startsWith('upload:') || session.id.length > 4096 || /[\r\n#]/.test(session.id)) {
    throw new ProfilePhotoError('Meta no pudo iniciar la carga de la imagen.', 502)
  }
  const uploaded = await metaRequest(token, session.id, {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg', file_offset: '0' }, body: new Uint8Array(image),
  })
  if (typeof uploaded.h !== 'string' || !uploaded.h) throw new ProfilePhotoError('Meta no pudo recibir la imagen.', 502)
  const result = await metaRequest(token, `${number.phoneNumberId}/whatsapp_business_profile`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', profile_picture_handle: uploaded.h }),
  })
  if (result.success !== true) throw new ProfilePhotoError('Meta no confirmó el cambio. Actualizá la foto antes de volver a guardar.', 502)
  // The update has succeeded even if the subsequent read fails; do not invite a duplicate write.
  try { return { pictureUrl: await readProfilePhoto(number.phoneNumberId, token), refreshPending: false } }
  catch { return { pictureUrl: null, refreshPending: true } }
}
