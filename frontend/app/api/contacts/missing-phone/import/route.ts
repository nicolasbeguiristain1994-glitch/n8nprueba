import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { importMissingContacts, validateMissingContactRows } from '@/lib/missing-contacts'

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'create')
  if (!auth.ok) return auth.response
  const read = await checkPermissionWithUser(req, 'contacts', 'read')
  if (!read.ok) return read.response
  let rows, dryRun: boolean
  try {
    const text = await req.text()
    if (text.length > 25 * 1024 * 1024) return NextResponse.json({ error: 'El archivo es demasiado grande.' }, { status: 413 })
    const body = JSON.parse(text)
    rows = validateMissingContactRows(body.rows)
    if (typeof body.dryRun !== 'boolean') throw new Error('Indicá si querés revisar o importar el archivo.')
    dryRun = body.dryRun
  } catch (error) { return NextResponse.json({ error: error instanceof SyntaxError ? 'Archivo inválido.' : (error as Error).message }, { status: 400 }) }
  try {
    const result = await importMissingContacts(auth.user, rows, dryRun)
    if (!dryRun) void audit({ req, action: 'contacts.missing_phone.import', resource: 'contacts', metadata: {
      total: result.total, inserted: result.inserted, linked: result.linked, unchanged: result.unchanged, blank: result.blank, errors: result.errors.length,
    } })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[contacts/missing-phone/import]', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'No se pudo completar la carga. No se guardaron cambios. Volvé a revisar el archivo.' }, { status: 500 })
  }
}
