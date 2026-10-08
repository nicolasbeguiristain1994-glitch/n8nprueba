import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { getAppSetting } from '@/lib/app-settings'
import { audit } from '@/lib/audit'
import { listMissingContacts, readMissingContactFilters } from '@/lib/missing-contacts'
import { missingContactSheetRows } from '@/lib/missing-contact-files'

export async function GET(req: NextRequest) {
  const started = performance.now()
  const auth = await checkPermissionWithUser(req, 'contacts', 'read')
  if (!auth.ok) return auth.response
  const download = req.nextUrl.searchParams.get('download') === 'true'
  if (download && (!auth.user.can_download_contacts || !await getAppSetting('perms_contacts_export_global', true))) {
    return NextResponse.json({ error: 'No tenés permiso para descargar contactos.' }, { status: 403 })
  }
  let filters
  try { filters = readMissingContactFilters(req.nextUrl.searchParams) }
  catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }) }
  try {
    const data = await listMissingContacts(auth.user, filters, download)
    if (!download) return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store', 'Server-Timing': `missing_contacts;dur=${(performance.now() - started).toFixed(1)}` } })
    const XLSX = await import('xlsx')
    const book = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet(missingContactSheetRows(data.users))
    for (let row = 1; row <= data.users.length; row++) {
      sheet[XLSX.utils.encode_cell({ r: row, c: 4 })].z = '@'
    }
    sheet['!cols'] = [25, 16, 18, 28, 24, 22, 25].map(wch => ({ wch }))
    sheet['!autofilter'] = { ref: sheet['!ref'] ?? 'A1:G1' }
    XLSX.utils.book_append_sheet(book, sheet, 'Usuarios sin número')
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ['Cómo completar la planilla'],
      ['Completá Celular con código de país (ejemplo: +5491123456789). La columna es texto.'],
      ['Nombre es opcional. No cambies Usuario, Plataforma ni Agente.'],
      ['Dejá vacío Celular si todavía no lo tenés. Ese usuario seguirá pendiente.'],
      ['Devolvé este archivo Excel. Se revisarán las filas antes de incorporarlas a Contactos.'],
      ['Último movimiento incluye cargas y retiros registrados en el período seleccionado.'],
      ['Detectado en el sistema es la primera sincronización del usuario, no su fecha de registro en la plataforma.'],
    ]), 'Instrucciones')
    void audit({ req, action: 'contacts.missing_phone.export', resource: 'contacts', metadata: { count: data.total, agent: filters.agent, months: filters.months, platform: filters.platform } })
    return new NextResponse(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="usuarios-sin-numero-${filters.agent || 'todos'}.xlsx"`,
      'Cache-Control': 'no-store',
    } })
  } catch (error) {
    console.error('[contacts/missing-phone]', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'No se pudo obtener la lista de usuarios sin número. Intentá nuevamente o acotá los filtros.' }, { status: 500 })
  }
}
