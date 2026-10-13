import sharp from 'sharp'
import { META_BASE_URL } from '../types/domain'

const MAX_BYTES = 10 * 1024 * 1024
const MAX_AUDIO_BYTES = 16 * 1024 * 1024
const MEDIA_HOSTS = new Set(['lookaside.fbsbx.com', 'lookaside.facebook.com'])

export class MediaUnavailableError extends Error {
  constructor() { super('El archivo ya no está disponible en WhatsApp.') }
}

// Never follow a provider-supplied redirect with the account's bearer token.
function mediaUrl(value: unknown): URL {
  const url = new URL(typeof value === 'string' ? value : '')
  if (url.protocol !== 'https:' || !MEDIA_HOSTS.has(url.hostname)
    || url.username || url.password || url.port) throw new Error('Invalid media URL')
  return url
}

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new Error('Media too large')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty media')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error('Media too large')
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  return Buffer.concat(chunks)
}

// Identify audio containers from bytes, not a provider-controlled Content-Type.
function audioMime(bytes: Buffer): string {
  if (bytes.subarray(0, 4).toString('ascii') === 'OggS'
    && (bytes.subarray(0, 512).includes(Buffer.from('OpusHead')) || bytes.subarray(0, 512).includes(Buffer.from('\x01vorbis')))) return 'audio/ogg'
  if (bytes.subarray(0, 9).toString('ascii') === '#!AMR-WB\n') return 'audio/amr-wb'
  if (bytes.subarray(0, 6).toString('ascii') === '#!AMR\n') return 'audio/amr'
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'audio/mp4'
  if (bytes.length >= 7 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return 'audio/aac'
  if (bytes.length >= 10 && (bytes.subarray(0, 3).toString('ascii') === 'ID3'
    || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0))) return 'audio/mpeg'
  throw new Error('Unsupported audio format')
}

export async function downloadInboundMedia(mediaId: string, phoneNumberId: string, token: string, type: 'image' | 'sticker' | 'audio' = 'image') {
  if (!/^\d+$/.test(mediaId) || !/^\d+$/.test(phoneNumberId)) throw new Error('Invalid media ID')
  const options: RequestInit = {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  }
  // Resolve afresh: Meta's download URLs expire and must never be stored in the browser.
  const info = await fetch(`${META_BASE_URL}/${mediaId}?phone_number_id=${phoneNumberId}`, options)
  if ([400, 404, 410].includes(info.status)) throw new MediaUnavailableError()
  if (!info.ok) throw new Error('Media lookup failed')
  const metadata = JSON.parse((await readBounded(info, 64 * 1024)).toString('utf8'))
  const limit = type === 'audio' ? MAX_AUDIO_BYTES : MAX_BYTES
  if (Number(metadata.file_size) > limit) throw new Error('Media too large')
  const response = await fetch(mediaUrl(metadata.url), options)
  if ([404, 410].includes(response.status)) throw new MediaUnavailableError()
  if (!response.ok) throw new Error('Media download failed')
  const bytes = await readBounded(response, limit)
  if (type === 'audio') return { bytes, mime: audioMime(bytes) }
  // Detect the actual raster format, never serve HTML/SVG supplied as an image.
  const image = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata()
  const mime = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[image.format as string]
  if (!mime) throw new Error('Unsupported media format')
  // Keep the original bytes so animated stickers retain every frame.
  return { bytes, mime }
}
