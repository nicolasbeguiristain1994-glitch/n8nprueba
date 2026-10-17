import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser, canAccess } from '@/lib/permissions'
import { getAccessibleLineIds } from '@/lib/line-visibility'
import { getTokenForNumber } from '@/lib/cloud-api/token-store'
import { TokenExpiredError } from '@/lib/cloud-api/errors'
import { MAX_PROFILE_PHOTO_BYTES, ProfilePhotoError, prepareProfilePhoto, readProfilePhoto, updateProfilePhoto } from '@/lib/cloud-api/profile-photo'
import { audit } from '@/lib/audit'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store' }
type Context = { params: Promise<{ id: string }> }
type PhotoLine = { id: string; owner_user_id: string | null; line_type: string; phoneNumberId: string | null; wabaId: string | null; cloud_status: string | null }
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers })

async function authorize(req: NextRequest, context: Context, update = false) {
  const auth = await checkPermissionWithUser(req, 'lines', update ? 'update' : 'read')
  if (!auth.ok) return { response: auth.response }
  const { id } = await context.params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return { response: reply({ error: 'Línea inválida.' }, 400) }
  const ids = await getAccessibleLineIds(auth.user)
  if (ids !== null && !ids.includes(id)) return { response: reply({ error: 'No se encontró una línea accesible.' }, 404) }
  const rows = await query<PhotoLine>(`SELECT l.id,l.owner_user_id,l.line_type,cn.phone_number_id AS "phoneNumberId",
    cn.waba_id AS "wabaId",cn.status AS cloud_status FROM whatsapp_lines l
    LEFT JOIN cloud_numbers cn ON cn.whatsapp_line_id=l.id WHERE l.id=$1`, [id])
  if (rows.length !== 1) return { response: reply({ error: 'No se encontró una conexión única para esta línea.' }, 404) }
  const line = rows[0]
  const canEdit = canAccess(auth.user, 'lines', 'update') && (auth.user.role === 'admin' || auth.user.is_super_admin || line.owner_user_id === auth.user.user_id)
  if (update && !canEdit) return { response: reply({ error: 'Solo el propietario o un administrador puede cambiar esta foto.' }, 403) }
  if (line.line_type !== 'cloud' || !line.phoneNumberId || !line.wabaId || line.cloud_status !== 'active') {
    return { response: reply({ error: 'La foto requiere una línea activa conectada a la API oficial de WhatsApp.' }, 409) }
  }
  return { line: { ...line, phoneNumberId: line.phoneNumberId, wabaId: line.wabaId }, canEdit }
}
function failure(error: unknown) {
  if (error instanceof ProfilePhotoError) return reply({ error: error.message }, error.status)
  if (error instanceof TokenExpiredError) return reply({ error: 'La conexión con Meta venció. Volvé a conectar esta línea.' }, 422)
  return reply({ error: 'No se pudo acceder a la foto de esta línea. Volvé a intentar.' }, 502)
}

export async function GET(req: NextRequest, context: Context) {
  try {
    const access = await authorize(req, context)
    if (access.response) return access.response
    const token = await getTokenForNumber(access.line!.phoneNumberId)
    return reply({ pictureUrl: await readProfilePhoto(access.line!.phoneNumberId, token), canEdit: access.canEdit })
  } catch (error) { return failure(error) }
}

async function readImage(req: NextRequest) {
  const type = req.headers.get('content-type') || ''
  if (!type.startsWith('multipart/form-data;')) throw new ProfilePhotoError('Seleccioná una imagen para subir.', 400)
  // Bound the actual stream too: Content-Length can be absent or inaccurate.
  const limit = MAX_PROFILE_PHOTO_BYTES + 64 * 1024
  if (Number(req.headers.get('content-length')) > limit) throw new ProfilePhotoError('La imagen debe pesar hasta 5 MB.', 413)
  const reader = req.body?.getReader()
  if (!reader) throw new ProfilePhotoError('Seleccioná una imagen para subir.', 400)
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break
      size += part.value.byteLength
      if (size > limit) { await reader.cancel(); throw new ProfilePhotoError('La imagen debe pesar hasta 5 MB.', 413) }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  let form: FormData
  try { form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': type } }).formData() }
  catch { throw new ProfilePhotoError('No se pudo leer el archivo enviado.', 400) }
  const files = form.getAll('file'), file = files[0]
  if (files.length !== 1 || !file || typeof file === 'string') throw new ProfilePhotoError('Seleccioná una sola imagen para subir.', 400)
  return prepareProfilePhoto(Buffer.from(await file.arrayBuffer()), file.type)
}
export async function POST(req: NextRequest, context: Context) {
  if (req.headers.get('sec-fetch-site') === 'cross-site') return reply({ error: 'Abrí esta acción desde el módulo de Líneas.' }, 403)
  try {
    const access = await authorize(req, context, true)
    if (access.response) return access.response
    const image = await readImage(req)
    const token = await getTokenForNumber(access.line!.phoneNumberId)
    const result = await updateProfilePhoto(access.line!, token, image)
    void audit({ req, action: 'update', resource: 'lines', resource_id: access.line!.id, metadata: { changedFields: ['profile_picture'], bytes: image.length } })
    return reply({ ...result, success: true })
  } catch (error) { return failure(error) }
}
