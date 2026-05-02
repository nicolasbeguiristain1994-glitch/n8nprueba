import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

type ExportRow = {
  phone_number_raw: string
  phone_number_normalized: string
  reason: string | null
  source: string
  added_by_name: string | null
  added_at: string
  removed_at: string | null
}

const SOURCE_LABELS: Record<string, string> = {
  manual:    'Manual',
  automatic: 'Automático',
  import:    'Importado',
}

function escapeCsv(val: string | null | undefined): string {
  if (val == null) return ''
  const str = String(val)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'blacklist', 'read')
  if (!auth.ok) return auth.response

  const { searchParams } = new URL(req.url)
  const status = searchParams.get('status') ?? 'active'
  const source = searchParams.get('source') ?? ''

  const conditions: string[] = []
  const params: unknown[] = []
  let p = 0

  if (status === 'active') {
    conditions.push('b.removed_at IS NULL')
  } else if (status === 'removed') {
    conditions.push('b.removed_at IS NOT NULL')
  }

  if (source && ['manual', 'automatic', 'import'].includes(source)) {
    conditions.push(`b.source = $${++p}`)
    params.push(source)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  try {
    const rows = await query<ExportRow>(
      `SELECT
         b.phone_number_raw, b.phone_number_normalized,
         b.reason, b.source, b.added_at, b.removed_at,
         ua.name AS added_by_name
       FROM blacklist b
       LEFT JOIN users ua ON ua.id = b.added_by
       ${where}
       ORDER BY b.added_at DESC
       LIMIT 100000`,
      params,
    )

    const headers = [
      'Número (raw)',
      'Número (normalizado)',
      'Motivo',
      'Origen',
      'Agregado por',
      'Fecha de agregado',
      'Fecha de remoción',
    ]

    const lines = [
      '\uFEFF' + headers.join(','),
      ...rows.map(r => [
        escapeCsv(r.phone_number_raw),
        escapeCsv(r.phone_number_normalized),
        escapeCsv(r.reason),
        escapeCsv(SOURCE_LABELS[r.source] ?? r.source),
        escapeCsv(r.added_by_name),
        escapeCsv(r.added_at ? new Date(r.added_at).toLocaleString('es-AR') : ''),
        escapeCsv(r.removed_at ? new Date(r.removed_at).toLocaleString('es-AR') : ''),
      ].join(',')),
    ]

    return new NextResponse(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="blacklist_${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    })
  } catch (e) {
    console.error('[/api/blacklist/export GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
