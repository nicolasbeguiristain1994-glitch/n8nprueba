import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { contactFilters, ContactFilterError } from '@/lib/contact-filters'
import { getAppSetting } from '@/lib/app-settings'

function escapeCsv(val: string | number | null | undefined): string {
  if (val == null) return ''
  const str = String(val)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

// GET /api/contacts/segment-export
// Filtros: panel (oficina), linea, plataforma, segment (puede repetirse, ej. ?segment=vip&segment=alto),
//          inactividad_dias (mínimo de días sin actividad)
export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth

  const exportGlobal = await getAppSetting<boolean>('perms_contacts_export_global', true)
  if (!exportGlobal) {
    return NextResponse.json({ error: 'La descarga de contactos está deshabilitada por el administrador' }, { status: 403 })
  }
  if (!user.can_download_contacts) {
    return NextResponse.json({ error: 'Sin permiso para descargar contactos' }, { status: 403 })
  }

  try {
    const { sql, params } = contactFilters(req.nextUrl.searchParams, user)
    const rows = await query<{
      phone_number: string; first_name: string; last_name: string
      panel: string; linea: number | null; segment: string
      total_deposits: number | null; last_deposit_at: string | null
    }>(
      `SELECT phone_number, first_name, last_name, panel, linea, segment::text AS segment,
              total_deposits, last_deposit_at
       FROM contacts
       WHERE ${sql}
       ORDER BY last_deposit_at ASC NULLS FIRST, id
       LIMIT 100001`,
      params,
    )
    if (rows.length > 100000) return NextResponse.json({ error: 'La exportación supera 100.000 contactos. Acotá los filtros.' }, { status: 422 })

    const headers = ['Teléfono', 'Nombre', 'Oficina', 'Línea', 'Segmento', 'Cargas', 'Días inactivo']
    const lines = [
      '\uFEFF' + headers.join(','),
      ...rows.map(r => {
        const dias = r.last_deposit_at
          ? Math.floor((Date.now() - new Date(r.last_deposit_at).getTime()) / 86400000)
          : ''
        return [
          escapeCsv(r.phone_number),
          escapeCsv([r.first_name, r.last_name].filter(Boolean).join(' ')),
          escapeCsv(r.panel),
          escapeCsv(r.linea),
          escapeCsv(r.segment),
          escapeCsv(r.total_deposits),
          escapeCsv(dias),
        ].join(',')
      }),
    ]

    return new NextResponse(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="segmentacion_${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    })
  } catch (e) {
    if (e instanceof ContactFilterError) return NextResponse.json({ error: e.message }, { status: 400 })
    console.error('[/api/contacts/segment-export GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
