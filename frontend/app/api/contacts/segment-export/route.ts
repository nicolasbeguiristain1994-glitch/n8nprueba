import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { visibilityClause } from '@/lib/contact-visibility'
import { getAppSetting } from '@/lib/app-settings'

const PLATAFORMA_ALLOWED = new Set(['zeus', 'bet30', 'otros'])

const ZEUS_FILTER  = `'zeus'  = ANY(platforms)`
const BET30_FILTER = `'bet30' = ANY(platforms)`
const OTROS_FILTER = `NOT 'zeus' = ANY(platforms) AND NOT 'bet30' = ANY(platforms)`

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

  const sp = req.nextUrl.searchParams
  const panel      = (sp.get('panel') || '').trim()
  const linea      = (sp.get('linea') || '').trim()
  const plataforma = (sp.get('plataforma') || '').trim()
  const segment    = (sp.get('segment') || '').trim()
  const inactDiasRaw = sp.get('inactividad_dias') || ''
  const inactividadDias = inactDiasRaw && /^\d+$/.test(inactDiasRaw) ? Number(inactDiasRaw) : 0

  if (plataforma && !PLATAFORMA_ALLOWED.has(plataforma)) {
    return NextResponse.json({ error: `Plataforma inválida "${plataforma}"` }, { status: 400 })
  }

  const plataformaFilter = plataforma === 'zeus'  ? ` AND ${ZEUS_FILTER}`
                          : plataforma === 'bet30' ? ` AND ${BET30_FILTER}`
                          : plataforma === 'otros' ? ` AND (${OTROS_FILTER})`
                          : ''

  const inactividadFilter = inactividadDias > 0
    ? ` AND (last_activity_at IS NULL OR last_activity_at < NOW() - INTERVAL '${inactividadDias} days')`
    : ''

  const agentAllowed = (
    user.role !== 'admin' &&
    Array.isArray(user.allowed_agents) &&
    user.allowed_agents.length > 0
  ) ? user.allowed_agents : null

  const params: unknown[] = ['']
  let p = 1
  let panelFilter = ''
  if (panel) { panelFilter = ` AND panel = $${++p}`; params.push(panel) }
  let lineaFilter = ''
  if (linea) { lineaFilter = ` AND linea::text = $${++p}`; params.push(linea) }
  let segmentFilter = ''
  if (segment) {
    segmentFilter = ` AND segment::text = $${++p}`
    params.push(segment)
  }

  const vis = visibilityClause(user.role, user.user_id, params.length)
  let agentFilter = ''
  if (agentAllowed) {
    agentFilter = ` AND panel = ANY($${params.length + vis.params.length + 1}::text[])`
  }
  const allParams = [...params, ...vis.params, ...(agentAllowed ? [agentAllowed] : [])]

  try {
    const rows = await query<{
      phone_number: string; first_name: string; last_name: string
      panel: string; linea: number | null; segment: string
      total_deposits: number | null; last_activity_at: string | null
    }>(
      `SELECT phone_number, first_name, last_name, panel, linea, segment::text AS segment,
              total_deposits, last_activity_at
       FROM contacts
       WHERE ($1 = '' OR phone_number ILIKE $1)
         ${panelFilter}${lineaFilter}${segmentFilter}
         ${vis.sql}${agentFilter}${plataformaFilter}${inactividadFilter}
       ORDER BY last_activity_at ASC NULLS FIRST
       LIMIT 100000`,
      allParams,
    )

    const headers = ['Teléfono', 'Nombre', 'Oficina', 'Línea', 'Segmento', 'Cargas', 'Días inactivo']
    const lines = [
      '\uFEFF' + headers.join(','),
      ...rows.map(r => {
        const dias = r.last_activity_at
          ? Math.floor((Date.now() - new Date(r.last_activity_at).getTime()) / 86400000)
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
    console.error('[/api/contacts/segment-export GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
